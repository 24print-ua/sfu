/**
 * 24print recording media (D005 of 24print-ua/24print-hub) with the real FFmpeg and disk.
 * Requires `ffmpeg` and `ffprobe` with libx264, libvpx and libopus on the PATH.
 */
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
const START = 1_000_000;

let root: string;

beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "sfu-d005-"));
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

function fileState(type: STREAM_TYPE, filename: string, timestamp: number) {
    return {
        tag: TIME_TAG.FILE_STATE_CHANGE,
        timestamp,
        info: { type, filename, sessionId: 1, active: true, available: true }
    };
}

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

async function makeRecordingDir(name: string) {
    const dir = path.join(root, name);
    await mkdir(path.join(dir, STREAM_TYPE.SCREEN), { recursive: true });
    await mkdir(path.join(dir, STREAM_TYPE.AUDIO), { recursive: true });
    return dir;
}

describe("R17 of D005: raw screen survives a killed writer", () => {
    test.each([
        { ext: "mkv", readable: true },
        { ext: "mp4", readable: false }
    ])(
        "R17 of D005: a raw screen .$ext cut by SIGKILL of ffmpeg is readable=$readable by ffprobe",
        async ({ ext, readable }) => {
            const { validateMediaFile } = await import("#src/recording/models/media_compiler.ts");
            const source = path.join(root, `source-${ext}.mp4`);
            await ffmpeg([
                ...["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=10"],
                ...["-c:v", "libx264", "-preset", "ultrafast", "-b:v", "2M", "-g", "30", source]
            ]);
            const output = path.join(root, `killed.${ext}`);
            // the output options of the raw recording writer, fed in real time
            const writer = spawn(
                "ffmpeg",
                [
                    ...["-loglevel", "error", "-re", "-i", source, "-map", "0:v:0", "-c:v", "copy"],
                    ...["-fps_mode", "passthrough", "-output_ts_offset", "0", output]
                ],
                { stdio: "ignore" }
            );
            const closed = new Promise((resolve) => writer.once("close", resolve));
            const deadline = Date.now() + 9_000;
            while (((await stat(output).catch(() => undefined))?.size ?? 0) < 500_000) {
                expect(Date.now()).toBeLessThan(deadline);
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            writer.kill("SIGKILL");
            await closed;
            expect(await validateMediaFile(output, "v:0", AbortSignal.timeout(30_000))).toBe(
                readable
            );
        }
    );
});

describe("R8 of D005: screen frames", () => {
    test("R8 of D005: 3 picture changes in 10 s give 3 JPEG frames named by offset in ms", async () => {
        const { compileScreenFrames } = await import("#src/recording/models/screen_frames.ts");
        const { readManifest } = await import("#src/recording/models/manifest.ts");
        const dir = await makeRecordingDir("three_changes");
        const screen = "1-1-screen.mkv";
        await ffmpeg([
            ...["-f", "lavfi", "-i", "color=c=red:s=1920x1080:r=5:d=3"],
            ...["-f", "lavfi", "-i", "color=c=green:s=1920x1080:r=5:d=3"],
            ...["-f", "lavfi", "-i", "color=c=blue:s=1920x1080:r=5:d=4"],
            ...["-filter_complex", "[0][1][2]concat=n=3:v=1:a=0"],
            ...["-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "1M"],
            path.join(dir, STREAM_TYPE.SCREEN, screen)
        ]);
        // the screen sharing starts 2 s after the recording
        const summary = await compileScreenFrames({
            workingDir: dir,
            startedAt: START,
            stoppedAt: START + 12_000,
            timeStamps: [fileState(STREAM_TYPE.SCREEN, screen, START + 2_000)],
            signal: AbortSignal.timeout(60_000)
        });

        const frames = await readZip(path.join(dir, "frames.zip"));
        expect([...frames.keys()]).toEqual(["2000.jpg", "5000.jpg", "8000.jpg"]);
        const frame = path.join(root, "frame.jpg");
        await writeFile(frame, frames.get("5000.jpg")!);
        const { stdout } = await run("ffprobe", [
            ...["-v", "error", "-show_entries", "stream=codec_name,width", "-of", "csv=p=0", frame]
        ]);
        expect(stdout.trim()).toBe("mjpeg,1280");
        const expected = {
            file: "frames.zip",
            count: 3,
            extracted: 3,
            limit: 3600,
            thinned: false
        };
        expect(summary).toEqual(expected);
        expect(await readManifest(dir)).toEqual({ frames: expected });
        expect(await readdir(dir)).not.toContain("frames_tmp");
    });

    test("R8 of D005: 5000 different frames are evenly thinned to 3600 and marked in manifest.json", async () => {
        const { compileScreenFrames } = await import("#src/recording/models/screen_frames.ts");
        const dir = await makeRecordingDir("many_changes");
        const screen = "1-1-screen.mkv";
        await ffmpeg([
            ...["-f", "lavfi", "-i", "color=c=black:s=64x48:r=1:d=5000"],
            ...["-vf", "format=yuv420p,geq=lum='mod(N*37,256)':cb=128:cr=128"],
            ...["-c:v", "libvpx", "-g", "1", "-b:v", "200k"],
            path.join(dir, STREAM_TYPE.SCREEN, screen)
        ]);
        await compileScreenFrames({
            workingDir: dir,
            startedAt: START,
            stoppedAt: START + 5_000_000,
            timeStamps: [fileState(STREAM_TYPE.SCREEN, screen, START)],
            signal: AbortSignal.timeout(60_000)
        });

        const offsets = [...(await readZip(path.join(dir, "frames.zip"))).keys()].map((name) =>
            Number(name.replace(/\.jpg$/, ""))
        );
        expect(offsets).toHaveLength(3600);
        expect(offsets[0]).toBe(0);
        expect(offsets.at(-1)).toBeGreaterThanOrEqual(4_998_000);
        const gaps = new Set(offsets.slice(1).map((offset, i) => offset - offsets[i]));
        expect(gaps).toEqual(new Set([1000, 2000]));
        const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf-8"));
        expect(manifest.frames).toEqual({
            file: "frames.zip",
            count: 3600,
            extracted: 5000,
            limit: 3600,
            thinned: true
        });
    });

    test.each([
        { frames: "1", screen: "valid", saved: ["frames.zip", "manifest.json"] },
        { frames: "1", screen: "corrupted", saved: ["manifest.json"] },
        { frames: undefined, screen: "valid", saved: [] }
    ])(
        "R8 of D005: processing with RECORDING_SCREEN_FRAMES=$frames and a $screen screen saves $saved",
        async ({ frames, screen, saved }) => {
            const restore = withMockEnv({
                RECORDING_SCREEN_FRAMES: frames,
                RECORDING_COMPILE_VIDEO: "false"
            });
            try {
                const config = await import("#src/config.ts");
                const auth = await import("#src/core/services/auth.ts");
                const { RecordingProcessor } = await import(
                    "#src/recording/models/recording_processor.ts"
                );
                const { MediaUploader } = await import("#src/recording/models/media_uploader.ts");
                auth.start();
                const folderName = `processed_${screen}_${frames}`;
                const dir = path.join(config.dir.recordings, folderName);
                await mkdir(path.join(dir, STREAM_TYPE.SCREEN), { recursive: true });
                const screenFile = path.join(dir, STREAM_TYPE.SCREEN, "1-1-screen.mkv");
                if (screen === "valid") {
                    await ffmpeg([
                        ...["-f", "lavfi", "-i", "testsrc=size=320x240:rate=5:duration=3"],
                        ...["-c:v", "libvpx", "-deadline", "realtime", screenFile]
                    ]);
                } else {
                    await writeFile(screenFile, "not a video");
                }
                const now = Date.now();
                await writeFile(
                    path.join(dir, config.recording.metadataFileName),
                    auth.encrypt(
                        JSON.stringify({
                            channelName: "test",
                            channelUUID: "uuid",
                            routingAddress: "http://odoo.test/recording",
                            channelKey: "a2V5",
                            audio: false,
                            video: true,
                            transcription: false,
                            startedAt: now - 10_000,
                            stoppedAt: now,
                            timeStamps: [
                                fileState(STREAM_TYPE.SCREEN, "1-1-screen.mkv", now - 9_000)
                            ]
                        })
                    )
                );
                let kept: string[] = [];
                const processor = new RecordingProcessor({
                    uploader: new MediaUploader({ routingTimeoutMs: 1, uploadTimeoutMs: 1 }),
                    finalizeRecordingFolder: async (recordingDir) => {
                        kept = await readdir(recordingDir);
                        await rm(recordingDir, { recursive: true });
                    }
                });
                expect(await processor.process(folderName)).toBe(true);
                expect(
                    kept.filter((name) => !["screen", "metadata.bin.processing"].includes(name))
                ).toEqual(saved);
            } finally {
                restore();
            }
        }
    );
});

describe("R9 of D005: audio mix", () => {
    async function peakDb(file: string) {
        const { stderr } = await run("ffmpeg", [
            ...["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"]
        ]);
        return Number(/max_volume: (-?[\d.]+) dB/.exec(stderr)![1]);
    }

    test.each([
        { normalize: "0", louder: true },
        { normalize: undefined, louder: false }
    ])(
        "R9 of D005: mixing two equally loud tracks with RECORDING_AUDIO_NORMALIZE=$normalize keeps their peak: $louder",
        async ({ normalize, louder }) => {
            const restore = withMockEnv({ RECORDING_AUDIO_NORMALIZE: normalize });
            try {
                const { MediaCompiler } = await import("#src/recording/models/media_compiler.ts");
                const dir = await makeRecordingDir(`mix_${normalize}`);
                // two people speaking in turn: one in the first 2 s, the other in the last 2 s
                const tracks = [
                    { name: "1-1-audio.webm", filter: "apad=whole_dur=4" },
                    { name: "1-2-audio.webm", filter: "adelay=2000,apad=whole_dur=4" }
                ];
                for (const { name, filter } of tracks) {
                    await ffmpeg([
                        ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2"],
                        ...["-af", filter, "-c:a", "libopus", path.join(dir, "audio", name)]
                    ]);
                }
                const mix = await new MediaCompiler({
                    workingDir: dir,
                    startedAt: START,
                    stoppedAt: START + 4_000,
                    timeStamps: tracks.map(({ name }) => fileState(STREAM_TYPE.AUDIO, name, START))
                }).getAudio();
                expect(path.extname(mix!)).toBe(".ogg");
                const { stdout } = await run("ffprobe", [
                    ...["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", mix!]
                ]);
                expect(stdout.trim()).toBe("opus");
                const trackPeaks = await Promise.all(
                    tracks.map(({ name }) => peakDb(path.join(dir, "audio", name)))
                );
                const mixPeak = await peakDb(mix!);
                // opus encoding moves the peak by a fraction of a dB, normalize=1 halves it (-6 dB)
                expect(trackPeaks.map((trackPeak) => mixPeak >= trackPeak - 1)).toEqual([
                    louder,
                    louder
                ]);
            } finally {
                restore();
            }
        }
    );
});
