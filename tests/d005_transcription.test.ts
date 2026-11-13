/**
 * 24print per-track transcription (R10-R12, R16, R17 of D005 of 24print-ua/24print-hub,
 * 24print-hub#232) with the real FFmpeg and disk; the recognition service (`parakeet-asr`,
 * 24print-hub#267) and Odoo are faked.
 * Requires `ffmpeg` and `ffprobe` with libopus and libvpx on the PATH.
 */
import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";

import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from "@jest/globals";

import { STREAM_TYPE } from "#src/shared/enums.ts";
import { TIME_TAG } from "#src/recording/models/recorder.ts";

import { withMockEnv } from "#tests/utils/utils.ts";

jest.setTimeout(180_000);

const run = promisify(execFile);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ASR = "https://asr.test:9444/asr";
const ASR_KEY = "test-asr-key";
const ODOO = "http://odoo.test/discuss/recording/5";
const DESTINATION = "http://odoo.test/discuss/recording/upload/token";

let root: string;
let restoreEnv: (() => void) | undefined;
const originalFetch = global.fetch;
/** the fake recognition service: a real HTTP server, as the SFU does not use `fetch` for it */
let asrServer: http.Server;
let asrUrl: string;
let asrHandler: (request: http.IncomingMessage, response: http.ServerResponse) => unknown;

beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "sfu-d005-asr-"));
    asrServer = http.createServer((request, response) => asrHandler(request, response));
    await new Promise<void>((resolve) => asrServer.listen(0, "127.0.0.1", resolve));
    asrUrl = `http://127.0.0.1:${(asrServer.address() as AddressInfo).port}/asr`;
});

afterAll(async () => {
    asrServer.closeAllConnections();
    await new Promise((resolve) => asrServer.close(resolve));
    await rm(root, { recursive: true, force: true });
});

afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    restoreEnv?.();
    restoreEnv = undefined;
});

/** speech stands for a tone, silence for noise far under the silence level */
type Part = { seconds: number; sound: boolean };

/**
 * Writes a raw audio track like the recorder does: Opus in WebM, 48 kHz.
 */
async function writeTrack(file: string, parts: Part[]) {
    // the last part started by t
    let expression = "0";
    let duration = 0;
    for (const part of parts) {
        const wave = part.sound ? "0.3*sin(2*PI*440*t)" : "0.0005*(random(0)*2-1)";
        expression = `if(gte(t,${duration}),${wave},${expression})`;
        duration += part.seconds;
    }
    await run("ffmpeg", [
        ...["-hide_banner", "-loglevel", "error", "-y"],
        ...["-f", "lavfi", "-i", `aevalsrc='${expression}':s=48000:d=${duration}`],
        ...["-c:a", "libopus", "-b:a", "32k", file]
    ]);
}

type TrackSpec = {
    filename: string;
    sessionId: number;
    /** ms from the start of the recording */
    offset: number;
    label?: string;
    userId?: number;
    parts: Part[];
};

/**
 * Writes a stopped recording in the recordings folder and returns its folder name.
 */
async function writeRecording({
    name,
    startedAt,
    stoppedAt,
    tracks,
    screen = false
}: {
    name: string;
    startedAt: number;
    stoppedAt: number;
    tracks: TrackSpec[];
    screen?: boolean;
}) {
    const config = await import("#src/config.ts");
    const auth = await import("#src/core/services/auth.ts");
    auth.start();
    const dir = path.join(config.dir.recordings, name);
    await mkdir(path.join(dir, STREAM_TYPE.AUDIO), { recursive: true });
    await mkdir(path.join(dir, STREAM_TYPE.SCREEN), { recursive: true });
    const timeStamps = [];
    for (const track of tracks) {
        await writeTrack(path.join(dir, STREAM_TYPE.AUDIO, track.filename), track.parts);
        timeStamps.push({
            tag: TIME_TAG.FILE_STATE_CHANGE,
            timestamp: startedAt + track.offset,
            info: {
                type: STREAM_TYPE.AUDIO,
                filename: track.filename,
                sessionId: track.sessionId,
                active: true,
                available: true,
                ...(track.label !== undefined ? { label: track.label } : {}),
                ...(track.userId !== undefined ? { userId: track.userId } : {})
            }
        });
    }
    if (screen) {
        await run("ffmpeg", [
            ...["-hide_banner", "-loglevel", "error", "-y"],
            ...["-f", "lavfi", "-i", "testsrc=size=320x240:rate=5:duration=3"],
            ...["-c:v", "libvpx", "-deadline", "realtime"],
            path.join(dir, STREAM_TYPE.SCREEN, "1-screen.mkv")
        ]);
        timeStamps.push({
            tag: TIME_TAG.FILE_STATE_CHANGE,
            timestamp: startedAt,
            info: {
                type: STREAM_TYPE.SCREEN,
                filename: "1-screen.mkv",
                sessionId: 1,
                active: true,
                available: true
            }
        });
    }
    await writeFile(
        path.join(dir, config.recording.metadataFileName),
        auth.encrypt(
            JSON.stringify({
                channelName: "test",
                channelUUID: "uuid",
                routingAddress: ODOO,
                channelKey: Buffer.from("channel-key").toString("base64"),
                audio: true,
                video: screen,
                transcription: false,
                startedAt,
                stoppedAt,
                timeStamps
            })
        )
    );
    return name;
}

/**
 * Reads a stored ZIP archive.
 */
async function readZip(file: string): Promise<Map<string, Buffer>> {
    const zip = await readFile(file);
    const end = zip.length - 22;
    expect(zip.readUInt32LE(end)).toBe(0x06054b50);
    const count = zip.readUInt16LE(end + 10);
    let position = zip.readUInt32LE(end + 16);
    const entries = new Map<string, Buffer>();
    for (let i = 0; i < count; i++) {
        const crc = zip.readUInt32LE(position + 16);
        const size = zip.readUInt32LE(position + 24);
        const nameLength = zip.readUInt16LE(position + 28);
        const name = zip.toString("utf8", position + 46, position + 46 + nameLength);
        const local = zip.readUInt32LE(position + 42);
        const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        const data = zip.subarray(dataStart, dataStart + size);
        expect(crc32(data)).toBe(crc);
        entries.set(name, data);
        position +=
            46 + nameLength + zip.readUInt16LE(position + 30) + zip.readUInt16LE(position + 32);
    }
    return entries;
}

type AsrRequest = { name: string; url: URL; headers: Record<string, string> };
type AsrAnswer = (name: string) => Response | Promise<Response>;

/**
 * Fakes the recognition service and Odoo. Each uploaded archive is kept by recording id.
 */
function fakeServices(answer: AsrAnswer) {
    const asrRequests: AsrRequest[] = [];
    const archives = new Map<string, string>();
    const completed: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let pendingRecording: string | undefined;
    asrHandler = async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
            chunks.push(chunk);
        }
        const form = await new Request("http://asr", {
            method: "POST",
            headers: { "content-type": request.headers["content-type"]! },
            body: Buffer.concat(chunks)
        }).formData();
        const name = (form.get("audio_file") as File).name;
        const url = new URL(request.url!, asrUrl);
        asrRequests.push({ name, url, headers: request.headers as Record<string, string> });
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
            await new Promise((resolve) => setTimeout(resolve, 5));
            const answered = await answer(name);
            response.writeHead(answered.status, { "content-type": "application/json" });
            response.end(Buffer.from(await answered.arrayBuffer()));
        } catch {
            // the service is unreachable
            request.socket.destroy();
        } finally {
            inFlight -= 1;
        }
    };
    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input.toString());
        if (url.toString().startsWith(asrUrl)) {
            return originalFetch(input, init);
        }
        if (url.pathname.endsWith("/routing")) {
            pendingRecording = url.searchParams.get("recording_id")!;
            return Response.json({
                destination: DESTINATION,
                method: "POST",
                requires_completion: true
            });
        }
        if (url.toString() === DESTINATION) {
            const chunks: Buffer[] = [];
            for await (const chunk of init!.body as unknown as AsyncIterable<Buffer>) {
                chunks.push(chunk);
            }
            const file = path.join(root, `${pendingRecording}.zip`);
            await writeFile(file, Buffer.concat(chunks));
            archives.set(pendingRecording!, file);
            return Response.json({ ok: true });
        }
        if (url.pathname.endsWith("/complete")) {
            completed.push(url.searchParams.get("recording_id")!);
            return Response.json({ ok: true });
        }
        throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    return {
        asrRequests,
        archives,
        completed,
        maxInFlight: () => maxInFlight
    };
}

/** an answer of `parakeet-asr`: the phrases of a chunk, in seconds in the chunk */
function phrases(...segments: [number, number, string][]) {
    return Response.json({
        text: segments.map(([, , text]) => text.trim()).join(" "),
        segments: segments.map(([start, end, text], id) => ({ id, start, end, text })),
        language: null
    });
}

/**
 * The answer of `parakeet-asr` behind the asr-gateway (`:9444`) to a 12-second chunk of
 * synthesized Russian and Ukrainian speech, recorded from the test SFU host on 2026-11-13.
 */
const RECORDED_PARAKEET_ANSWER = `{"text":"Добрый, давайте обсудим заказ на визитке. Тираж тысяча штук, бумага плотная. Так, я перевірю маки і надішлю рахунок сьогодні ввечері.","segments":[{"id":0,"start":0.0,"end":6.152,"text":"Добрый, давайте обсудим заказ на визитке. Тираж тысяча штук, бумага плотная."},{"id":1,"start":7.384,"end":11.896,"text":"Так, я перевірю маки і надішлю рахунок сьогодні ввечері."}],"language":null}`;

async function setup(env: Record<string, string | undefined> = {}) {
    restoreEnv = withMockEnv({
        DATA_PATH: await mkdtemp(path.join(root, "data-")),
        RECORDING_ARCHIVE: "1",
        RECORDING_TRANSCRIBE_URL: asrUrl,
        RECORDING_TRANSCRIBE_API_KEY: ASR_KEY,
        RECORDING_SCREEN_FRAMES: "1",
        RECORDING_COMPILE_VIDEO: "false",
        ...env
    });
    const config = await import("#src/config.ts");
    const { RecordingProcessor } = await import("#src/recording/models/recording_processor.ts");
    const { MediaUploader } = await import("#src/recording/models/media_uploader.ts");
    const processor = new RecordingProcessor({
        uploader: new MediaUploader({ routingTimeoutMs: 30_000, uploadTimeoutMs: 30_000 }),
        finalizeRecordingFolder: (recordingDir) => rm(recordingDir, { recursive: true })
    });
    return { config, processor };
}

async function delivered(archives: Map<string, string>, name: string) {
    const archive = await readZip(archives.get(name)!);
    return {
        archive,
        txt: archive.get("transcript.txt")!.toString(),
        json: JSON.parse(archive.get("transcript.json")!.toString()),
        manifest: JSON.parse(archive.get("manifest.json")!.toString())
    };
}

describe("D005 transcription settings", () => {
    test("off by default and without RECORDING_ARCHIVE; URL and key go together", async () => {
        for (const [env, enabled] of [
            [{}, false],
            [{ RECORDING_TRANSCRIBE_URL: ASR, RECORDING_TRANSCRIBE_API_KEY: ASR_KEY }, false],
            [
                {
                    RECORDING_TRANSCRIBE_URL: ASR,
                    RECORDING_TRANSCRIBE_API_KEY: ASR_KEY,
                    RECORDING_ARCHIVE: "1"
                },
                true
            ]
        ] as const) {
            restoreEnv = withMockEnv({
                RECORDING_TRANSCRIBE_URL: undefined,
                RECORDING_TRANSCRIBE_API_KEY: undefined,
                RECORDING_ARCHIVE: undefined,
                ...env
            });
            const config = await import("#src/config.ts");
            expect(config.recording.transcription.enabled).toBe(enabled);
            restoreEnv();
        }
        for (const env of [
            { RECORDING_TRANSCRIBE_URL: ASR, RECORDING_ARCHIVE: "1" },
            { RECORDING_TRANSCRIBE_API_KEY: ASR_KEY, RECORDING_ARCHIVE: "1" }
        ]) {
            restoreEnv = withMockEnv({
                RECORDING_TRANSCRIBE_URL: undefined,
                RECORDING_TRANSCRIBE_API_KEY: undefined,
                ...env
            });
            await expect(import("#src/config.ts")).rejects.toThrow(/RECORDING_TRANSCRIBE/);
            restoreEnv();
        }
        restoreEnv = undefined;
    });
});

describe("R10 of D005: chunks", () => {
    test("R10 of D005: a 12-minute track goes as three chunks, one at a time; the answers are joined with their shift", async () => {
        const { processor } = await setup();
        const services = fakeServices((name) => {
            const index = Number(/chunk_(\d+)/.exec(name)![1]);
            return phrases([1.25, 2.5, ` фраза ${index}`], [3, 3.5, "  "]);
        });
        const now = Date.now();
        const name = await writeRecording({
            name: "twelve_minutes",
            startedAt: now - 13 * MINUTE,
            stoppedAt: now,
            tracks: [
                {
                    filename: "1-audio.webm",
                    sessionId: 1,
                    offset: 2_000,
                    label: "Анна",
                    userId: 7,
                    parts: [{ seconds: 720, sound: true }]
                }
            ]
        });

        expect(await processor.process(name)).toBe(true);

        expect(services.asrRequests.map((request) => request.name)).toEqual([
            "1-audio.webm.chunk_0000.ogg",
            "1-audio.webm.chunk_0001.ogg",
            "1-audio.webm.chunk_0002.ogg"
        ]);
        expect(services.maxInFlight()).toBe(1);
        for (const { url, headers } of services.asrRequests) {
            expect(headers["x-api-key"]).toBe(ASR_KEY);
            expect(url.searchParams.get("output")).toBe("json");
            // the language is detected by the service
            expect(url.searchParams.has("language")).toBe(false);
        }
        const { txt, json, manifest } = await delivered(services.archives, name);
        expect(json).toEqual(
            [0, 1, 2].map((index) => ({
                start_ms: 2_000 + index * 5 * MINUTE + 1_250,
                end_ms: 2_000 + index * 5 * MINUTE + 2_500,
                user_id: 7,
                label: "Анна",
                text: `фраза ${index}`
            }))
        );
        expect(txt).toBe("[00:03] Анна: фраза 0\n[05:03] Анна: фраза 1\n[10:03] Анна: фраза 2\n");
        expect(manifest.transcription).toEqual({
            tracks: [
                {
                    file: "audio/1-audio.webm",
                    session_id: 1,
                    user_id: 7,
                    label: "Анна",
                    chunks: 3,
                    recognized: 3,
                    silent: 0
                }
            ]
        });
    });

    test("R10 of D005: a track of silence alone is not sent, nor a silent chunk; no phrase of theirs in the transcript", async () => {
        const { processor } = await setup();
        const services = fakeServices((name) => phrases([10, 12, ` сказав ${name}`]));
        const now = Date.now();
        const name = await writeRecording({
            name: "silence",
            startedAt: now - 12 * MINUTE,
            stoppedAt: now,
            tracks: [
                {
                    filename: "1-audio.webm",
                    sessionId: 1,
                    offset: 0,
                    label: "Анна",
                    parts: [{ seconds: 400, sound: false }]
                },
                {
                    filename: "2-audio.webm",
                    sessionId: 2,
                    offset: 0,
                    label: "Борис",
                    parts: [
                        { seconds: 60, sound: true },
                        { seconds: 600, sound: false }
                    ]
                }
            ]
        });

        expect(await processor.process(name)).toBe(true);

        expect(services.asrRequests.map((request) => request.name)).toEqual([
            "2-audio.webm.chunk_0000.ogg"
        ]);
        const { txt, manifest } = await delivered(services.archives, name);
        expect(txt).toBe("[00:10] Борис: сказав 2-audio.webm.chunk_0000.ogg\n");
        expect(manifest.transcription.tracks).toEqual([
            expect.objectContaining({ label: "Анна", chunks: 2, recognized: 0, silent: 2 }),
            expect.objectContaining({ label: "Борис", chunks: 3, recognized: 1, silent: 2 })
        ]);
        expect(manifest.transcription.tracks.some((track: object) => "error" in track)).toBe(false);
    });
});

describe("R11, R12 of D005: speakers", () => {
    test("R11, R12 of D005: two named tracks give txt and json by time, every line with its speaker; a track without name is an error in manifest.json", async () => {
        const { processor } = await setup();
        const answers: Record<string, Response> = {
            "1-audio.webm": phrases([0.5, 1.5, " Привіт"], [9, 10, " Як справи?"]),
            "2-audio.webm": phrases([0.5, 2, " Добрий день"])
        };
        const services = fakeServices((name) => answers[name.replace(/\.chunk_.*/, "")]);
        const now = Date.now();
        const name = await writeRecording({
            name: "speakers",
            startedAt: now - 30_000,
            stoppedAt: now,
            tracks: [
                {
                    filename: "1-audio.webm",
                    sessionId: 1,
                    offset: 1_000,
                    label: "Анна Коваль",
                    userId: 7,
                    parts: [{ seconds: 20, sound: true }]
                },
                {
                    filename: "2-audio.webm",
                    sessionId: 2,
                    offset: 5_000,
                    label: "Гість 1",
                    parts: [{ seconds: 20, sound: true }]
                },
                {
                    filename: "3-audio.webm",
                    sessionId: 3,
                    offset: 0,
                    userId: 9,
                    parts: [{ seconds: 20, sound: true }]
                }
            ]
        });

        expect(await processor.process(name)).toBe(true);

        expect(services.asrRequests.map((request) => request.name)).toEqual([
            "1-audio.webm.chunk_0000.ogg",
            "2-audio.webm.chunk_0000.ogg"
        ]);
        const { txt, json, manifest } = await delivered(services.archives, name);
        expect(txt).toBe(
            "[00:01] Анна Коваль: Привіт\n" +
                "[00:05] Гість 1: Добрий день\n" +
                "[00:10] Анна Коваль: Як справи?\n"
        );
        expect(json).toEqual([
            { start_ms: 1_500, end_ms: 2_500, user_id: 7, label: "Анна Коваль", text: "Привіт" },
            {
                start_ms: 5_500,
                end_ms: 7_000,
                user_id: null,
                label: "Гість 1",
                text: "Добрий день"
            },
            {
                start_ms: 10_000,
                end_ms: 11_000,
                user_id: 7,
                label: "Анна Коваль",
                text: "Як справи?"
            }
        ]);
        expect(manifest.transcription.tracks).toEqual([
            expect.objectContaining({ session_id: 1, recognized: 1 }),
            expect.objectContaining({ session_id: 2, recognized: 1 }),
            {
                file: "audio/3-audio.webm",
                session_id: 3,
                user_id: 9,
                chunks: 0,
                recognized: 0,
                silent: 0,
                error: "no speaker name in the session token"
            }
        ]);
        expect(manifest.transcription.tracks[0]).not.toHaveProperty("error");
        expect(manifest.transcription.tracks[1]).not.toHaveProperty("error");
    });
});

describe("R10, R12 of D005: the answers of parakeet-asr", () => {
    test("R10 of D005: a recorded parakeet-asr answer is parsed into phrases shifted by the chunk", async () => {
        const { processor } = await setup();
        const services = fakeServices(
            () =>
                new Response(RECORDED_PARAKEET_ANSWER, {
                    headers: { "content-type": "application/json" }
                })
        );
        const now = Date.now();
        const name = await writeRecording({
            name: "parakeet_answer",
            startedAt: now - 8 * MINUTE,
            stoppedAt: now,
            tracks: [
                {
                    filename: "1-audio.webm",
                    sessionId: 1,
                    offset: 2_000,
                    label: "Анна",
                    userId: 7,
                    parts: [{ seconds: 400, sound: true }]
                }
            ]
        });

        expect(await processor.process(name)).toBe(true);

        expect(services.asrRequests).toHaveLength(2);
        const { txt, json, manifest } = await delivered(services.archives, name);
        const first =
            "Добрый, давайте обсудим заказ на визитке. Тираж тысяча штук, бумага плотная.";
        const second = "Так, я перевірю маки і надішлю рахунок сьогодні ввечері.";
        expect(json).toEqual(
            [0, 5 * MINUTE].flatMap((chunkStart) => [
                {
                    start_ms: 2_000 + chunkStart,
                    end_ms: 2_000 + chunkStart + 6_152,
                    user_id: 7,
                    label: "Анна",
                    text: first
                },
                {
                    start_ms: 2_000 + chunkStart + 7_384,
                    end_ms: 2_000 + chunkStart + 11_896,
                    user_id: 7,
                    label: "Анна",
                    text: second
                }
            ])
        );
        expect(txt).toBe(
            `[00:02] Анна: ${first}\n[00:09] Анна: ${second}\n` +
                `[05:02] Анна: ${first}\n[05:09] Анна: ${second}\n`
        );
        expect(manifest.transcription.tracks[0]).toMatchObject({ chunks: 2, recognized: 2 });
        expect(manifest.transcription.tracks[0]).not.toHaveProperty("error");
        expect(manifest.transcription.tracks[0]).not.toHaveProperty("dropped");
    });

    test("R12 of D005: short phrases without a Cyrillic letter are left out of the transcript and listed in manifest.json", async () => {
        const { processor } = await setup();
        const services = fakeServices(() =>
            phrases(
                [1, 1.5, " Yeah"],
                [2, 2.5, "Um"],
                [3, 4, "Diventi, d."],
                [5, 5.5, "Так."],
                [6, 8, "Как это, Day Limit?"]
            )
        );
        const now = Date.now();
        const name = await writeRecording({
            name: "noise",
            startedAt: now - 30_000,
            stoppedAt: now,
            tracks: [
                {
                    filename: "1-audio.webm",
                    sessionId: 1,
                    offset: 1_000,
                    label: "Анна",
                    userId: 7,
                    parts: [{ seconds: 20, sound: true }]
                }
            ]
        });

        expect(await processor.process(name)).toBe(true);

        expect(services.asrRequests).toHaveLength(1);
        const { txt, json, manifest } = await delivered(services.archives, name);
        expect(txt).toBe("[00:06] Анна: Так.\n[00:07] Анна: Как это, Day Limit?\n");
        expect(json.map((segment: { text: string }) => segment.text)).toEqual([
            "Так.",
            "Как это, Day Limit?"
        ]);
        expect(manifest.transcription.tracks).toEqual([
            {
                file: "audio/1-audio.webm",
                session_id: 1,
                user_id: 7,
                label: "Анна",
                chunks: 1,
                recognized: 1,
                silent: 0,
                dropped: [
                    { start_ms: 2_000, text: "Yeah" },
                    { start_ms: 3_000, text: "Um" },
                    { start_ms: 4_000, text: "Diventi, d." }
                ]
            }
        ]);
    });
});

describe("R16, R17 of D005: failures", () => {
    test("R16 of D005: the service answers 400 on one track; the other tracks are in the transcript, the failure in manifest.json", async () => {
        const { processor } = await setup();
        const services = fakeServices((name) =>
            name.startsWith("1-")
                ? new Response('{"detail":"bad audio"}', { status: 400 })
                : phrases([1, 2, " Добрий день"])
        );
        const now = Date.now();
        const name = await writeRecording({
            name: "rejected",
            startedAt: now - 30_000,
            stoppedAt: now,
            tracks: [
                {
                    filename: "1-audio.webm",
                    sessionId: 1,
                    offset: 0,
                    label: "Анна",
                    parts: [{ seconds: 20, sound: true }]
                },
                {
                    filename: "2-audio.webm",
                    sessionId: 2,
                    offset: 0,
                    label: "Борис",
                    parts: [{ seconds: 20, sound: true }]
                }
            ]
        });

        expect(await processor.process(name)).toBe(true);

        // a final answer is not repeated
        expect(services.asrRequests.map((request) => request.name)).toEqual([
            "1-audio.webm.chunk_0000.ogg",
            "2-audio.webm.chunk_0000.ogg"
        ]);
        const { txt, archive, manifest } = await delivered(services.archives, name);
        expect(txt).toBe("[00:01] Борис: Добрий день\n");
        expect(archive.has("mix.ogg")).toBe(true);
        expect(manifest.transcription.tracks[0]).toMatchObject({
            label: "Анна",
            recognized: 0,
            error: expect.stringContaining("400")
        });
        expect(manifest.transcription.tracks[1]).not.toHaveProperty("error");
    });

    test("R16, R17 of D005: the service unreachable for 18 h; the archive goes with mix.ogg and frames.zip, the tracks failed in manifest.json", async () => {
        const { processor } = await setup();
        const services = fakeServices(() => {
            throw new TypeError("fetch failed");
        });
        const stoppedAt = Date.now();
        let now = stoppedAt;
        jest.spyOn(Date, "now").mockImplementation(() => now);
        const name = await writeRecording({
            name: "unreachable",
            startedAt: stoppedAt - 30_000,
            stoppedAt,
            screen: true,
            tracks: [
                {
                    filename: "1-audio.webm",
                    sessionId: 1,
                    offset: 0,
                    label: "Анна",
                    parts: [{ seconds: 20, sound: true }]
                },
                {
                    filename: "2-audio.webm",
                    sessionId: 2,
                    offset: 0,
                    label: "Борис",
                    parts: [{ seconds: 20, sound: true }]
                }
            ]
        });
        const config = await import("#src/config.ts");
        const statePath = path.join(config.dir.recordings, name, "transcription.json");

        const attemptTimes: number[] = [];
        const processedBeforePause: boolean[] = [];
        while (!(await processor.process(name)) && attemptTimes.length < 40) {
            attemptTimes.push(now - stoppedAt);
            // nothing is sent before the pause is over
            now = JSON.parse(await readFile(statePath, "utf-8")).nextAttemptAt - 1;
            processedBeforePause.push(await processor.process(name));
            now += 1;
        }
        attemptTimes.push(now - stoppedAt);
        expect(processedBeforePause.every((processed) => !processed)).toBe(true);

        // pauses of 1, 5, 15, 30 minutes, then every hour, up to 18 h after the stop
        expect(attemptTimes.slice(0, 7)).toEqual(
            [0, 1, 6, 21, 51, 111, 171].map((minutes) => minutes * MINUTE)
        );
        expect(attemptTimes.at(-1)).toBeLessThanOrEqual(18 * HOUR);
        expect(attemptTimes.at(-1)! + HOUR).toBeGreaterThan(18 * HOUR);
        // one request per attempt: the first chunk of the first track
        expect(services.asrRequests).toHaveLength(attemptTimes.length);
        expect(new Set(services.asrRequests.map((request) => request.name))).toEqual(
            new Set(["1-audio.webm.chunk_0000.ogg"])
        );
        const { archive, txt, json, manifest } = await delivered(services.archives, name);
        expect([...archive.keys()]).toEqual([
            "mix.ogg",
            "transcript.txt",
            "transcript.json",
            "frames.zip",
            "manifest.json"
        ]);
        expect(txt).toBe("");
        expect(json).toEqual([]);
        expect(manifest.mix).toEqual({ file: "mix.ogg" });
        expect(manifest.frames.count).toBeGreaterThan(0);
        for (const track of manifest.transcription.tracks) {
            expect(track.error).toMatch(
                /^not recognized within 18 h .*TypeError: transcription request failed/
            );
        }
        expect(
            manifest.transcription.tracks.map((track: { label: string }) => track.label)
        ).toEqual(["Анна", "Борис"]);
        await expect(stat(path.join(config.dir.recordings, name))).rejects.toThrow();
    });

    test("R17 of D005: 503 twice, then 200; the chunk is recognized at the third attempt, recognized chunks are not sent again; recording B goes while recording A waits", async () => {
        await setup();
        jest.spyOn(os, "loadavg").mockReturnValue([0, 0, 0]);
        const failures = [503, 503];
        const services = fakeServices((name) => {
            if (name === "1-audio.webm.chunk_0001.ogg" && failures.length) {
                return new Response("busy", { status: failures.shift() });
            }
            return phrases([1, 2, ` фраза ${name}`]);
        });
        const stoppedAt = Date.now();
        let now = stoppedAt;
        jest.spyOn(Date, "now").mockImplementation(() => now);
        const recordingA = await writeRecording({
            name: `${stoppedAt - 10 * MINUTE}-a`,
            startedAt: stoppedAt - 10 * MINUTE,
            stoppedAt,
            tracks: [
                {
                    filename: "1-audio.webm",
                    sessionId: 1,
                    offset: 0,
                    label: "Анна",
                    parts: [{ seconds: 400, sound: true }]
                }
            ]
        });
        const recordingB = await writeRecording({
            name: `${stoppedAt - 5 * MINUTE}-b`,
            startedAt: stoppedAt - 5 * MINUTE,
            stoppedAt,
            tracks: [
                {
                    filename: "2-audio.webm",
                    sessionId: 2,
                    offset: 0,
                    label: "Борис",
                    parts: [{ seconds: 10, sound: true }]
                }
            ]
        });
        const config = await import("#src/config.ts");
        const scheduler = await import("#src/recording/services/scheduler.ts");
        const sent = () => services.asrRequests.map((request) => request.name);

        await scheduler.__testing__.oneProcessingBatch();
        // A waits for its pause, B is delivered meanwhile
        expect(services.completed).toEqual([recordingB]);
        expect(sent().filter((chunk) => chunk.startsWith("1-"))).toEqual([
            "1-audio.webm.chunk_0000.ogg",
            "1-audio.webm.chunk_0001.ogg"
        ]);
        const metadataA = path.join(
            config.dir.recordings,
            recordingA,
            config.recording.metadataFileName
        );
        await expect(stat(metadataA)).resolves.toBeDefined();

        now += MINUTE;
        await scheduler.__testing__.oneProcessingBatch();
        expect(sent().filter((chunk) => chunk.startsWith("1-"))).toHaveLength(3);
        expect(services.completed).toEqual([recordingB]);

        // the second pause is 5 minutes
        now += 4 * MINUTE;
        await scheduler.__testing__.oneProcessingBatch();
        expect(sent().filter((chunk) => chunk.startsWith("1-"))).toHaveLength(3);

        now += MINUTE;
        await scheduler.__testing__.oneProcessingBatch();
        expect(services.completed).toEqual([recordingB, recordingA]);
        expect(sent().filter((chunk) => chunk.startsWith("1-"))).toEqual([
            "1-audio.webm.chunk_0000.ogg",
            "1-audio.webm.chunk_0001.ogg",
            "1-audio.webm.chunk_0001.ogg",
            "1-audio.webm.chunk_0001.ogg"
        ]);
        const { json } = await delivered(services.archives, recordingA);
        expect(json.map((segment: { text: string }) => segment.text)).toEqual([
            "фраза 1-audio.webm.chunk_0000.ogg",
            "фраза 1-audio.webm.chunk_0001.ogg"
        ]);
        expect(json[1].start_ms).toBe(5 * MINUTE + 1_000);
    });
});

/**
 * Caps how long Node's `fetch` (undici) waits for response headers, 300 s by default, so a
 * test can show the cap without waiting 5 minutes.
 *
 * @returns restores the default
 */
function capFetchHeadersTimeout(ms: number): () => void {
    // the global of `fetch`, outside the Jest sandbox
    const global = (originalFetch.constructor as FunctionConstructor)(
        "return globalThis"
    )() as Record<symbol, object | undefined>;
    const key = [2, 1]
        .map((version) => Symbol.for(`undici.globalDispatcher.${version}`))
        .find((symbol) => global[symbol]?.constructor.name === "Agent")!;
    const original = global[key]!;
    const Agent = original.constructor as new (options: { headersTimeout: number }) => object;
    global[key] = new Agent({ headersTimeout: ms });
    return () => {
        global[key] = original;
    };
}

describe("R10 of D005: a chunk takes minutes to recognize", () => {
    /** a 20-second track of Анна, stopped now */
    function writeShortRecording(name: string) {
        const now = Date.now();
        return writeRecording({
            name,
            startedAt: now - 30_000,
            stoppedAt: now,
            tracks: [
                {
                    filename: "1-audio.webm",
                    sessionId: 1,
                    offset: 0,
                    label: "Анна",
                    parts: [{ seconds: 20, sound: true }]
                }
            ]
        });
    }

    function slowService(delayMs: number) {
        return fakeServices(async (name) => {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            return phrases([1, 2, ` фраза ${name}`]);
        });
    }

    test("R10 of D005: an answer that comes after fetch stops waiting for headers is received (24print-hub#232)", async () => {
        const { processor } = await setup();
        const services = slowService(2_500);
        const restoreFetch = capFetchHeadersTimeout(1_000);
        try {
            // the cap applies to fetch: it fails as on the test SFU, after 300 s there
            const form = new FormData();
            form.append("audio_file", new Blob(["x"]), "probe.chunk_0000.ogg");
            const failure = await originalFetch(asrUrl, { method: "POST", body: form }).catch(
                (error: Error) => error
            );
            expect(failure).toMatchObject({
                name: "TypeError",
                cause: { code: "UND_ERR_HEADERS_TIMEOUT" }
            });

            const name = await writeShortRecording("slow_answer");
            expect(await processor.process(name)).toBe(true);
            const { txt, manifest } = await delivered(services.archives, name);
            expect(txt).toBe("[00:01] Анна: фраза 1-audio.webm.chunk_0000.ogg\n");
            expect(manifest.transcription.tracks[0]).not.toHaveProperty("error");
        } finally {
            restoreFetch();
        }
    });

    test("R10, R17 of D005: a request waits 5 minutes by default, under the gateway's 600 s", async () => {
        const { config, processor } = await setup();
        const { requestTimeout } = config.recording.transcription;
        expect(requestTimeout).toBe(5 * MINUTE);
        expect(requestTimeout).toBeLessThan(600_000);
        slowService(0);
        const timeouts = jest.spyOn(AbortSignal, "timeout");
        const name = await writeShortRecording("default_timeout");

        expect(await processor.process(name)).toBe(true);

        // the request of the chunk, the deadline 18 h away
        expect(timeouts.mock.calls.map(([ms]) => ms)).toContain(requestTimeout);
    });

    test("R10, R17 of D005: the request timeout alone ends a request, and it is retried", async () => {
        const { config, processor } = await setup();
        slowService(2_500);
        (config.recording.transcription as { requestTimeout: number }).requestTimeout = 1_000;
        const name = await writeShortRecording("request_timeout");
        const startedAt = performance.now();

        expect(await processor.process(name)).toBe(false);

        expect(performance.now() - startedAt).toBeLessThan(2_500);
        const state = JSON.parse(
            await readFile(path.join(config.dir.recordings, name, "transcription.json"), "utf-8")
        );
        expect(state).toMatchObject({ attempts: 1, error: expect.stringMatching(/^TimeoutError/) });
    });
});
