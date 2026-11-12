import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import * as config from "#src/config.ts";
import {
    COMPILATION_TIMEOUT,
    INPUT_RECOVERY_OPTIONS,
    spawnFfmpeg
} from "#src/recording/models/media_compiler.ts";
import { updateManifest, type TranscriptionTrackManifest } from "#src/recording/models/manifest.ts";
import { HttpError, isRetryable } from "#src/recording/models/media_uploader.ts";
import { TIME_TAG, type SealedMetaData } from "#src/recording/models/recorder.ts";
import type { SessionId } from "#src/core/models/session.ts";
import { STREAM_TYPE } from "#src/shared/enums.ts";
import { Logger } from "#src/utils/utils.ts";

const logger = new Logger("TRANSCRIBER");
/** retries of the transcription, kept in the recording folder across restarts */
export const TRANSCRIPTION_STATE_FILENAME = "transcription.json";
/** chunks and recognized chunks, per track, in the recording folder */
const WORK_DIRECTORY = "transcription";
const PLAN_FILENAME = "chunks.json";
const CHUNK_PATTERN = /^chunk_(\d{4})\.ogg$/;
/** seconds a silence may miss at the edges of a chunk it covers */
const SILENCE_MARGIN = 0.1;
const MAX_ERROR_BODY = 300;

type TranscriptionState = {
    /** failed requests in a row */
    attempts: number;
    /** epoch ms before which the recording is not processed again */
    nextAttemptAt: number;
    /** last failure that is retried */
    error?: string;
    /** final failure by track file */
    failed: Record<string, string>;
};

type Track = {
    /** raw file, relative to the recording folder */
    file: string;
    sessionId: SessionId;
    label?: string;
    userId?: number;
    /** ms from the start of the recording to the start of the file */
    offset: number;
};

/** chunks of a track, those without sound by index */
type ChunkPlan = { count: number; silent: number[] };

/** a phrase of a chunk, in seconds from the start of the chunk */
type Segment = { start: number; end: number; text: string };

export type TranscriptSegment = {
    start_ms: number;
    end_ms: number;
    user_id: number | null;
    label: string;
    text: string;
};

/**
 * The transcription waits for a pause before its next request; the recording goes back
 * to the queue meanwhile.
 */
export class TranscriptionPending extends Error {
    readonly nextAttemptAt: number;

    constructor(nextAttemptAt: number, cause: unknown) {
        super(`transcription retries at ${new Date(nextAttemptAt).toISOString()}: ${cause}`);
        this.nextAttemptAt = nextAttemptAt;
    }
}

export async function readTranscriptionState(directory: string): Promise<TranscriptionState> {
    return (
        (await readJson<TranscriptionState>(
            path.join(directory, TRANSCRIPTION_STATE_FILENAME)
        )) ?? {
            attempts: 0,
            nextAttemptAt: 0,
            failed: {}
        }
    );
}

/**
 * Transcribes each audio track (R10 of D005) in chunks of `chunkDuration`, one request at
 * a time, and writes `transcript.txt` and `transcript.json` in `directory` with the phrases
 * of every track, by time, each with its speaker (R11, R12). Chunks without sound are not
 * sent; recognized chunks are kept in the folder and never sent again.
 *
 * A track without speaker name, or answered with a final error, is reported in
 * `manifest.json` (`transcription.tracks[].error`) and the others go on (R16). A network
 * failure, a 5xx or a 429 is retried after `retryDelays`, then every `retryInterval`, until
 * `deadline` after the recording stopped (R17); then the chunks left are reported and
 * the transcripts keep what was recognized.
 *
 * @param unreadableFiles - full paths of raw files that cannot be read
 * @throws {TranscriptionPending} when the next request has to wait
 */
export async function transcribeRecording(
    directory: string,
    metadata: SealedMetaData,
    unreadableFiles: Set<string>
): Promise<void> {
    const settings = config.recording.transcription;
    const state = await readTranscriptionState(directory);
    const deadline = metadata.stoppedAt + settings.deadline;
    const tracks = audioTracks(metadata);
    let expired = false;
    for (const track of tracks) {
        if (
            expired ||
            unreadableFiles.has(path.join(directory, track.file)) ||
            !track.label ||
            state.failed[track.file]
        ) {
            continue;
        }
        try {
            const plan = await splitTrack(directory, track);
            for (let index = 0; index < plan.count && !expired; index++) {
                const result = resultPath(directory, track, index);
                if (plan.silent.includes(index) || (await readJson(result))) {
                    continue;
                }
                const now = Date.now();
                if (now >= deadline) {
                    expired = true;
                    break;
                }
                let segments: Segment[];
                try {
                    segments = await recognize(
                        chunkPath(directory, track, index),
                        Math.min(settings.requestTimeout, deadline - now)
                    );
                } catch (error) {
                    if (!isRetryable(error)) {
                        throw error;
                    }
                    state.attempts += 1;
                    state.error = String(error);
                    const nextAttemptAt =
                        Date.now() +
                        (settings.retryDelays[state.attempts - 1] ?? settings.retryInterval);
                    if (nextAttemptAt >= deadline) {
                        expired = true;
                        break;
                    }
                    state.nextAttemptAt = nextAttemptAt;
                    await writeJson(path.join(directory, TRANSCRIPTION_STATE_FILENAME), state);
                    throw new TranscriptionPending(nextAttemptAt, error);
                }
                await writeJson(result, segments);
                if (state.attempts) {
                    state.attempts = 0;
                    state.error = undefined;
                    await writeJson(path.join(directory, TRANSCRIPTION_STATE_FILENAME), state);
                }
            }
        } catch (error) {
            if (error instanceof TranscriptionPending) {
                throw error;
            }
            logger.error(`Failed to transcribe ${track.file} of ${directory}: ${error}`);
            state.failed[track.file] = String(error);
            await writeJson(path.join(directory, TRANSCRIPTION_STATE_FILENAME), state);
        }
    }
    await writeTranscripts(directory, tracks, state, unreadableFiles);
}

/**
 * The audio tracks of the participants, with the speaker of the session token.
 */
function audioTracks(metadata: SealedMetaData): Track[] {
    const tracks = new Map<string, Track>();
    for (const { tag, timestamp, info } of metadata.timeStamps) {
        if (
            tag !== TIME_TAG.FILE_STATE_CHANGE ||
            info?.type !== STREAM_TYPE.AUDIO ||
            !info.active ||
            timestamp >= metadata.stoppedAt ||
            tracks.has(info.filename)
        ) {
            continue;
        }
        tracks.set(info.filename, {
            file: path.join(STREAM_TYPE.AUDIO, info.filename),
            sessionId: info.sessionId,
            label: info.label?.trim() || undefined,
            userId: info.userId,
            offset: timestamp - metadata.startedAt
        });
    }
    return [...tracks.values()];
}

function workDirectory(directory: string, track: Track) {
    return path.join(directory, WORK_DIRECTORY, path.basename(track.file));
}

function chunkPath(directory: string, track: Track, index: number) {
    return path.join(
        workDirectory(directory, track),
        `chunk_${String(index).padStart(4, "0")}.ogg`
    );
}

function resultPath(directory: string, track: Track, index: number) {
    return `${chunkPath(directory, track, index)}.json`;
}

/**
 * Cuts the track into chunks of `chunkDuration` and finds the chunks without sound
 * (`silencedetect`), once: the plan is kept in the folder. Pauses of the raw file
 * (no packets) are filled with silence, so chunk time is recording time.
 */
async function splitTrack(directory: string, track: Track): Promise<ChunkPlan> {
    const settings = config.recording.transcription;
    const workDir = workDirectory(directory, track);
    const planPath = path.join(workDir, PLAN_FILENAME);
    const existing = await readJson<ChunkPlan>(planPath);
    if (existing) {
        return existing;
    }
    await rm(workDir, { recursive: true, force: true });
    await mkdir(workDir, { recursive: true });
    const silencePath = path.join(workDir, "silence.txt");
    if (/[':\\,;[\]]/.test(silencePath)) {
        throw new Error(`unsupported characters in ${silencePath}`);
    }
    const chunkSeconds = settings.chunkDuration / 1000;
    await spawnFfmpeg(
        [
            "-y",
            ...INPUT_RECOVERY_OPTIONS,
            ...["-i", path.join(directory, track.file), "-vn"],
            "-af",
            [
                "aresample=async=1:first_pts=0",
                `silencedetect=noise=${settings.silenceNoise}:d=${settings.silenceMinDuration}`,
                `ametadata=mode=print:file='${silencePath}'`
            ].join(","),
            ...settings.chunkArgs,
            ...["-f", "segment", "-segment_time", String(chunkSeconds)],
            ...["-reset_timestamps", "1", "-segment_format", "ogg"],
            path.join(workDir, "chunk_%04d.ogg")
        ],
        path.join(workDir, "split.log"),
        AbortSignal.timeout(COMPILATION_TIMEOUT)
    );
    const count = (await readdir(workDir)).filter((name) => CHUNK_PATTERN.test(name)).length;
    const silences = parseSilences(await readFile(silencePath, "utf-8").catch(() => ""));
    const silent: number[] = [];
    for (let index = 0; index < count; index++) {
        const start = index * chunkSeconds;
        const end = index === count - 1 ? Infinity : start + chunkSeconds;
        if (
            silences.some(
                (silence) =>
                    silence.start <= start + SILENCE_MARGIN && silence.end >= end - SILENCE_MARGIN
            )
        ) {
            silent.push(index);
        }
    }
    const plan = { count, silent };
    await writeJson(planPath, plan);
    return plan;
}

/**
 * Silences printed by `silencedetect` through `ametadata`, in seconds. A silence still
 * going on at the end of the file has no end.
 */
function parseSilences(printed: string): { start: number; end: number }[] {
    const silences: { start: number; end: number }[] = [];
    for (const line of printed.split("\n")) {
        const [key, value] = line.trim().split("=");
        if (key === "lavfi.silence_start") {
            silences.push({ start: Number(value), end: Infinity });
        } else if (key === "lavfi.silence_end" && silences.length) {
            silences[silences.length - 1].end = Number(value);
        }
    }
    return silences;
}

/**
 * Sends a chunk to the Whisper ASR service, language detected by the service.
 *
 * @returns the phrases with text, empty ones dropped
 */
async function recognize(file: string, timeoutMs: number): Promise<Segment[]> {
    const { url, apiKey } = config.recording.transcription;
    const endpoint = new URL(url!);
    endpoint.searchParams.set("task", "transcribe");
    endpoint.searchParams.set("encode", "true");
    endpoint.searchParams.set("output", "json");
    const form = new FormData();
    form.append(
        "audio_file",
        new Blob([await readFile(file)], { type: config.recording.audio.mimeType }),
        // track and chunk, e.g. 7-audio.webm.chunk_0002.ogg
        `${path.basename(path.dirname(file))}.${path.basename(file)}`
    );
    const response = await fetch(endpoint, {
        method: "POST",
        headers: { "X-API-Key": apiKey! },
        body: form,
        signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
        const body = (await response.text().catch(() => "")).slice(0, MAX_ERROR_BODY);
        throw new HttpError(
            `transcription service answered ${response.status}: ${body}`,
            response.status
        );
    }
    const result = (await response.json()) as { segments?: unknown };
    if (!Array.isArray(result.segments)) {
        throw new Error("transcription service answered without segments");
    }
    return result.segments.flatMap((segment: Partial<Segment>) => {
        const text = typeof segment.text === "string" ? segment.text.trim() : "";
        if (!text || !Number.isFinite(segment.start)) {
            return [];
        }
        const start = segment.start!;
        return [{ start, end: Number.isFinite(segment.end) ? segment.end! : start, text }];
    });
}

async function writeTranscripts(
    directory: string,
    tracks: Track[],
    state: TranscriptionState,
    unreadableFiles: Set<string>
) {
    const { chunkDuration, deadline } = config.recording.transcription;
    const segments: TranscriptSegment[] = [];
    const manifest: TranscriptionTrackManifest[] = [];
    for (const track of tracks) {
        const entry: TranscriptionTrackManifest = {
            file: track.file,
            session_id: track.sessionId,
            ...(track.userId !== undefined ? { user_id: track.userId } : {}),
            ...(track.label ? { label: track.label } : {}),
            chunks: 0,
            recognized: 0,
            silent: 0
        };
        manifest.push(entry);
        if (unreadableFiles.has(path.join(directory, track.file))) {
            entry.error = "unreadable";
            continue;
        }
        if (!track.label) {
            entry.error = "no speaker name in the session token";
            continue;
        }
        const plan = await readJson<ChunkPlan>(
            path.join(workDirectory(directory, track), PLAN_FILENAME)
        );
        for (let index = 0; index < (plan?.count ?? 0); index++) {
            const phrases = await readJson<Segment[]>(resultPath(directory, track, index));
            if (!phrases) {
                continue;
            }
            entry.recognized += 1;
            const chunkStart = track.offset + index * chunkDuration;
            for (const { start, end, text } of phrases) {
                segments.push({
                    start_ms: Math.max(0, Math.round(chunkStart + start * 1000)),
                    end_ms: Math.max(0, Math.round(chunkStart + end * 1000)),
                    user_id: track.userId ?? null,
                    label: track.label,
                    text
                });
            }
        }
        entry.chunks = plan?.count ?? 0;
        entry.silent = plan?.silent.length ?? 0;
        if (state.failed[track.file]) {
            entry.error = state.failed[track.file];
        } else if (!plan || entry.recognized + entry.silent < entry.chunks) {
            entry.error = `not recognized within ${
                deadline / 3_600_000
            } h after the recording stopped: ${state.error ?? "no time left"}`;
        }
    }
    segments.sort((a, b) => a.start_ms - b.start_ms);
    const lines = segments.map(({ start_ms, label, text }) => {
        const seconds = Math.floor(start_ms / 1000);
        const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
        return `[${minutes}:${String(seconds % 60).padStart(2, "0")}] ${label}: ${text}\n`;
    });
    await writeAtomic(path.join(directory, "transcript.txt"), lines.join(""));
    await writeJson(path.join(directory, "transcript.json"), segments);
    await updateManifest(directory, { transcription: { tracks: manifest } });
}

async function readJson<T = unknown>(file: string): Promise<T | undefined> {
    try {
        return JSON.parse(await readFile(file, "utf-8")) as T;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}

function writeJson(file: string, value: unknown) {
    return writeAtomic(file, JSON.stringify(value));
}

async function writeAtomic(file: string, content: string) {
    await writeFile(`${file}.partial`, content);
    await rename(`${file}.partial`, file);
}
