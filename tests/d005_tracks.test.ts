/**
 * Raw tracks of the speakers in `recording.zip` (R13, R16 of D005, 24print-ua/24print-hub#271)
 * with the real FFmpeg and disk. Requires `ffmpeg` with libopus on the PATH.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";

import { afterAll, beforeAll, describe, expect, jest, test } from "@jest/globals";

import { STREAM_TYPE } from "#src/shared/enums.ts";
import { TIME_TAG } from "#src/recording/models/recorder.ts";

import { withMockEnv } from "#tests/utils/utils.ts";

jest.setTimeout(120_000);

const run = promisify(execFile);
const ffmpeg = (args: string[]) =>
    run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const routingAddress = "http://odoo.test/discuss/recording/5";
const destination = "http://odoo.test/discuss/recording/upload/token";

let root: string;

beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "sfu-d005-tracks-"));
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

/**
 * Reads a stored ZIP archive and checks each entry against its CRC.
 */
async function readZip(file: string): Promise<Map<string, Buffer>> {
    const zip = await readFile(file);
    const end = zip.length - 22;
    expect(zip.readUInt32LE(end)).toBe(0x06054b50);
    const count = zip.readUInt16LE(end + 10);
    let position = zip.readUInt32LE(end + 16);
    const entries = new Map<string, Buffer>();
    for (let i = 0; i < count; i++) {
        expect(zip.readUInt32LE(position)).toBe(0x02014b50);
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

type Track = {
    filename: string;
    sessionId: number;
    /** activation, ms from the recording start */
    at: number;
    label?: string;
    userId?: number;
    /** not audio */
    damaged?: boolean;
};

/**
 * Records `tracks` in a recording folder, processes it like the scheduler does and
 * returns the delivered archive with the raw files.
 */
async function deliver(name: string, env: Record<string, string | undefined>, tracks: Track[]) {
    const restore = withMockEnv({
        DATA_PATH: path.join(root, name),
        RECORDING_ARCHIVE: "1",
        RECORDING_TRANSCRIBE_URL: undefined,
        RECORDING_TRANSCRIBE_API_KEY: undefined,
        RECORDING_ARCHIVE_TRACKS: undefined,
        RECORDING_ARCHIVE_MAX_MB: undefined,
        ...env
    });
    const originalFetch = global.fetch;
    try {
        const config = await import("#src/config.ts");
        const auth = await import("#src/core/services/auth.ts");
        const { RecordingProcessor } = await import("#src/recording/models/recording_processor.ts");
        const { MediaUploader } = await import("#src/recording/models/media_uploader.ts");
        auth.start();
        const folderName = `${Date.now()}-0e0d4b7c-5a4e-4d6e-9a43-5b8f6f0d2a11`;
        const dir = path.join(config.dir.recordings, folderName);
        await mkdir(path.join(dir, STREAM_TYPE.AUDIO), { recursive: true });
        const raw = new Map<string, Buffer>();
        for (const track of tracks) {
            const file = path.join(dir, STREAM_TYPE.AUDIO, track.filename);
            if (track.damaged) {
                await writeFile(file, "not audio");
            } else {
                await ffmpeg([
                    ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2"],
                    ...["-c:a", "libopus", file]
                ]);
            }
            raw.set(track.filename, await readFile(file));
        }
        await writeFile(path.join(dir, "transcript.txt"), "[00:01] Ann: hello\n");
        const startedAt = Date.now() - 4_000;
        await writeFile(
            path.join(dir, config.recording.metadataFileName),
            auth.encrypt(
                JSON.stringify({
                    channelName: "test",
                    channelUUID: "uuid",
                    routingAddress,
                    channelKey: Buffer.from("channel-key-of-odoo").toString("base64"),
                    userId: 7,
                    audio: true,
                    video: false,
                    transcription: false,
                    startedAt,
                    stoppedAt: startedAt + 4_000,
                    timeStamps: tracks.map((track) => ({
                        tag: TIME_TAG.FILE_STATE_CHANGE,
                        timestamp: startedAt + track.at,
                        info: {
                            type: STREAM_TYPE.AUDIO,
                            filename: track.filename,
                            sessionId: track.sessionId,
                            active: true,
                            available: true,
                            label: track.label,
                            userId: track.userId
                        }
                    }))
                })
            )
        );
        const uploaded = path.join(root, `${name}.zip`);
        global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = input.toString();
            if (url === destination) {
                const chunks: Buffer[] = [];
                for await (const chunk of init!.body as unknown as AsyncIterable<Buffer>) {
                    chunks.push(chunk);
                }
                await writeFile(uploaded, Buffer.concat(chunks));
            }
            if (url.includes("/routing?")) {
                return Response.json({
                    destination,
                    method: "POST",
                    requires_completion: true
                });
            }
            return Response.json({ ok: true });
        }) as typeof fetch;
        const processor = new RecordingProcessor({
            uploader: new MediaUploader({
                routingTimeoutMs: 30_000,
                uploadTimeoutMs: 30_000
            }),
            finalizeRecordingFolder: (recordingDir) => rm(recordingDir, { recursive: true })
        });

        expect(await processor.process(folderName)).toBe(true);

        const archive = await readZip(uploaded);
        const manifest = JSON.parse(archive.get("manifest.json")!.toString());
        return { archive, manifest, raw };
    } finally {
        global.fetch = originalFetch;
        restore();
    }
}

const trackNames = (archive: Map<string, Buffer>) =>
    [...archive.keys()].filter((name) => name.startsWith("tracks/"));

describe("D005 archive tracks settings", () => {
    test("off and without a limit by default; 1 and 2000 turn them on", async () => {
        let restore = withMockEnv({
            RECORDING_ARCHIVE: "1",
            RECORDING_ARCHIVE_TRACKS: undefined,
            RECORDING_ARCHIVE_MAX_MB: undefined
        });
        try {
            const config = await import("#src/config.ts");
            expect(config.recording.archive.tracks).toBe(false);
            expect(config.recording.archive.maxBytes).toBeUndefined();
        } finally {
            restore();
        }
        restore = withMockEnv({
            RECORDING_ARCHIVE: "1",
            RECORDING_ARCHIVE_TRACKS: "1",
            RECORDING_ARCHIVE_MAX_MB: "2000"
        });
        try {
            const config = await import("#src/config.ts");
            expect(config.recording.archive.tracks).toBe(true);
            expect(config.recording.archive.maxBytes).toBe(2_000_000_000);
        } finally {
            restore();
        }
        restore = withMockEnv({
            RECORDING_ARCHIVE: undefined,
            RECORDING_ARCHIVE_TRACKS: "1"
        });
        try {
            const config = await import("#src/config.ts");
            expect(config.recording.archive.tracks).toBe(false);
        } finally {
            restore();
        }
    });

    test.each(["0", "-1", "two gigabytes"])(
        "rejects RECORDING_ARCHIVE_MAX_MB=%s",
        async (value) => {
            const restore = withMockEnv({ RECORDING_ARCHIVE_MAX_MB: value });
            try {
                await expect(import("#src/config.ts")).rejects.toThrow("RECORDING_ARCHIVE_MAX_MB");
            } finally {
                restore();
            }
        }
    );
});

describe("R13, R16 of D005: raw tracks in recording.zip", () => {
    test("R13 of D005: two participants, the second reconnected: three tracks byte for byte, with name, label, user_id, start_ms in manifest.json", async () => {
        const { archive, manifest, raw } = await deliver(
            "reconnect",
            { RECORDING_ARCHIVE_TRACKS: "1", RECORDING_ARCHIVE_MAX_MB: "2000" },
            [
                {
                    filename: "1-1-audio.webm",
                    sessionId: 1,
                    at: -300,
                    label: "Попов Костянтин",
                    userId: 7
                },
                {
                    filename: "2-2-audio.webm",
                    sessionId: 2,
                    at: 500,
                    label: "Анна Коваль",
                    userId: 8
                },
                {
                    filename: "3-2-audio.webm",
                    sessionId: 2,
                    at: 2_345,
                    label: "Анна Коваль",
                    userId: 8
                }
            ]
        );
        expect(trackNames(archive)).toEqual([
            "tracks/00000000-Попов Костянтин.webm",
            "tracks/00000500-Анна Коваль.webm",
            "tracks/00002345-Анна Коваль.webm"
        ]);
        expect(archive.has("mix.ogg")).toBe(true);
        expect(manifest.tracks).toEqual([
            {
                file: "audio/1-1-audio.webm",
                session_id: 1,
                name: "tracks/00000000-Попов Костянтин.webm",
                label: "Попов Костянтин",
                user_id: 7,
                start_ms: -300,
                bytes: raw.get("1-1-audio.webm")!.length
            },
            {
                file: "audio/2-2-audio.webm",
                session_id: 2,
                name: "tracks/00000500-Анна Коваль.webm",
                label: "Анна Коваль",
                user_id: 8,
                start_ms: 500,
                bytes: raw.get("2-2-audio.webm")!.length
            },
            {
                file: "audio/3-2-audio.webm",
                session_id: 2,
                name: "tracks/00002345-Анна Коваль.webm",
                label: "Анна Коваль",
                user_id: 8,
                start_ms: 2_345,
                bytes: raw.get("3-2-audio.webm")!.length
            }
        ]);
        expect(manifest.tracks_omitted).toBeUndefined();
        for (const { file, name } of manifest.tracks) {
            expect(sha256(archive.get(name)!)).toBe(sha256(raw.get(path.basename(file))!));
        }
    });

    test("R13 of D005: unsafe characters become _, a repeated name gets -2, a session without label goes by its id", async () => {
        const { archive } = await deliver("names", { RECORDING_ARCHIVE_TRACKS: "1" }, [
            {
                filename: "1-1-audio.webm",
                sessionId: 1,
                at: 0,
                label: "Іван/Петров: тест"
            },
            {
                filename: "2-2-audio.webm",
                sessionId: 2,
                at: 1_000,
                label: "Гість 1"
            },
            {
                filename: "3-3-audio.webm",
                sessionId: 3,
                at: 1_000,
                label: "Гість 1"
            },
            { filename: "4-4-audio.webm", sessionId: 4, at: 1_500 },
            {
                filename: "5-5-audio.webm",
                sessionId: 5,
                at: 1_600,
                label: "x".repeat(80)
            }
        ]);
        expect(trackNames(archive)).toEqual([
            "tracks/00000000-Іван_Петров_ тест.webm",
            "tracks/00001000-Гість 1.webm",
            "tracks/00001000-Гість 1-2.webm",
            "tracks/00001500-4.webm",
            `tracks/00001600-${"x".repeat(64)}.webm`
        ]);
    });

    test("R13 of D005: without RECORDING_ARCHIVE_TRACKS the archive is as before, no tracks/", async () => {
        const { archive, manifest } = await deliver("off", {}, [
            {
                filename: "1-1-audio.webm",
                sessionId: 1,
                at: 0,
                label: "Попов Костянтин",
                userId: 7
            }
        ]);
        expect([...archive.keys()]).toEqual(["mix.ogg", "transcript.txt", "manifest.json"]);
        expect(manifest.tracks).toEqual([{ file: "audio/1-1-audio.webm", session_id: 1 }]);
    });

    test("R13, R16 of D005: over RECORDING_ARCHIVE_MAX_MB with the tracks, the tracks are left out and the rest goes", async () => {
        const { archive, manifest } = await deliver(
            "limit",
            { RECORDING_ARCHIVE_TRACKS: "1", RECORDING_ARCHIVE_MAX_MB: "0.001" },
            [
                {
                    filename: "1-1-audio.webm",
                    sessionId: 1,
                    at: 0,
                    label: "Попов Костянтин",
                    userId: 7
                },
                {
                    filename: "2-2-audio.webm",
                    sessionId: 2,
                    at: 0,
                    label: "Анна Коваль",
                    userId: 8
                }
            ]
        );
        expect([...archive.keys()]).toEqual(["mix.ogg", "transcript.txt", "manifest.json"]);
        expect(manifest.tracks_omitted).toBe("archive limit");
        expect(manifest.tracks.map(({ name }: { name?: string }) => name)).toEqual([
            undefined,
            undefined
        ]);
        expect(manifest.tracks.map(({ label }: { label: string }) => label)).toEqual([
            "Попов Костянтин",
            "Анна Коваль"
        ]);
    });

    test("R16 of D005: an unreadable track still goes in tracks/, marked unreadable, the mix is made without it", async () => {
        const { archive, manifest, raw } = await deliver(
            "unreadable",
            { RECORDING_ARCHIVE_TRACKS: "1" },
            [
                {
                    filename: "1-1-audio.webm",
                    sessionId: 1,
                    at: 0,
                    label: "Попов Костянтин",
                    userId: 7
                },
                {
                    filename: "2-2-audio.webm",
                    sessionId: 2,
                    at: 0,
                    label: "Анна Коваль",
                    userId: 8,
                    damaged: true
                }
            ]
        );
        expect(trackNames(archive)).toEqual([
            "tracks/00000000-Попов Костянтин.webm",
            "tracks/00000000-Анна Коваль.webm"
        ]);
        expect(archive.get("tracks/00000000-Анна Коваль.webm")).toEqual(raw.get("2-2-audio.webm"));
        expect(manifest.tracks[1]).toMatchObject({
            name: "tracks/00000000-Анна Коваль.webm",
            error: "unreadable"
        });
        expect(manifest.tracks[0].error).toBeUndefined();
        expect(manifest.mix).toEqual({ file: "mix.ogg" });
    });
});
