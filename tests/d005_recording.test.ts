/**
 * 24print recording settings (D005 of 24print-ua/24print-hub), with mocked FFmpeg and disk.
 * Every setting defaults to the upstream behaviour.
 */
import path from "node:path";
import os from "node:os";
import { PassThrough } from "node:stream";
import { once } from "node:events";

import { describe, expect, jest, test, afterEach } from "@jest/globals";
import { FakeMediaStreamTrack } from "fake-mediastreamtrack";

import { STREAM_TYPE } from "#src/shared/enums.ts";
import { STOP_CODE, TIME_TAG } from "#src/recording/models/recorder.ts";

import { recordingSetup, setupUnitTestsEnv } from "#tests/utils/testHelpers.ts";
import { waitFor, withMockEnv } from "#tests/utils/utils.ts";
import { mockFfmpeg, mockSpawn, MockChildProcess } from "#tests/utils/mockFfmpeg.ts";
import { mockNodeFS } from "#tests/utils/mockFileSystem.ts";

mockNodeFS();
mockFfmpeg();

const MINUTE = 60_000;

function fileState(type: STREAM_TYPE, filename: string, timestamp: number, active = true) {
    return {
        tag: TIME_TAG.FILE_STATE_CHANGE,
        timestamp,
        info: { type, filename, sessionId: 1, active, available: true }
    };
}

function keepWritersAlive() {
    mockSpawn.mockClear();
    mockSpawn.mockImplementation((_cmd, args) => {
        const process = new MockChildProcess("ffmpeg", args || []);
        process.stdin = new PassThrough();
        return process;
    });
}

describe("D005 settings", () => {
    test("defaults keep the upstream behaviour", async () => {
        const restore = withMockEnv({});
        try {
            const config = await import("#src/config.ts");
            expect(config.recording.maxDuration).toBe(60 * MINUTE);
            expect(config.RECORDING_CAMERAS).toBe(true);
            expect(config.RECORDING_COMPILE_VIDEO).toBe(true);
            expect(config.RECORDING_RAW_VIDEO_CONTAINER).toBeUndefined();
            expect(config.RECORDING_SCREEN_FRAMES).toBe(false);
            expect(config.RECORDING_AUDIO_NORMALIZE).toBeUndefined();
        } finally {
            restore();
        }
    });

    test("reads the 24print test values", async () => {
        const restore = withMockEnv({
            RECORDING_MAX_DURATION_MIN: "240",
            RECORDING_CAMERAS: "false",
            RECORDING_COMPILE_VIDEO: "false",
            RECORDING_RAW_VIDEO_CONTAINER: "mkv",
            RECORDING_SCREEN_FRAMES: "1",
            RECORDING_AUDIO_NORMALIZE: "0"
        });
        try {
            const config = await import("#src/config.ts");
            expect(config.recording.maxDuration).toBe(240 * MINUTE);
            expect(config.RECORDING_CAMERAS).toBe(false);
            expect(config.RECORDING_COMPILE_VIDEO).toBe(false);
            expect(config.RECORDING_RAW_VIDEO_CONTAINER).toBe("mkv");
            expect(config.RECORDING_SCREEN_FRAMES).toBe(true);
            expect(config.RECORDING_AUDIO_NORMALIZE).toBe("0");
        } finally {
            restore();
        }
    });

    test.each([
        { RECORDING_MAX_DURATION_MIN: "0" },
        { RECORDING_MAX_DURATION_MIN: "four hours" },
        { RECORDING_RAW_VIDEO_CONTAINER: "avi" },
        { RECORDING_AUDIO_NORMALIZE: "2" }
    ])("rejects %o", async (env) => {
        const restore = withMockEnv(env);
        try {
            await expect(import("#src/config.ts")).rejects.toThrow(Object.keys(env)[0]);
        } finally {
            restore();
        }
    });
});

describe("R5 of D005: recording duration", () => {
    test("R5 of D005: with RECORDING_MAX_DURATION_MIN=240 the recording stops at 240 minutes", async () => {
        const { restore, network, getChannel } = await recordingSetup({
            RECORDING: "true",
            RECORDING_MAX_DURATION_MIN: "240"
        });
        const config = await import("#src/config.ts");
        const auth = await import("#src/core/services/auth.ts");
        const { mockFs } = await import("#tests/utils/mockFileSystem.ts");
        let now = 1_000_000;
        const dateNowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
        const setTimeoutSpy = jest.spyOn(global, "setTimeout");
        try {
            const channelUUID = await network.getChannelUUID();
            const user = await network.connect(channelUUID, 1);
            await network.connect(channelUUID, 2);
            const recorder = getChannel(channelUUID)!.recorder!;
            expect(await user.sfuClient.setRecording({ audio: true })).toBe(true);
            await waitFor(() => recorder.path !== undefined);
            const recordingName = path.basename(recorder.path!).replace(/-\d+$/, "");
            const limitTimers = setTimeoutSpy.mock.calls.filter(
                ([, delay]) => delay === 240 * MINUTE
            );
            expect(limitTimers).toHaveLength(1);
            expect(recorder.isRecording).toBe(true);

            const stopped = once(recorder, "update");
            now += 240 * MINUTE;
            (limitTimers[0][0] as () => void)();
            const [update] = await stopped;
            expect(update.stopCode).toBe(STOP_CODE.RECORDING_TIMEOUT);
            await recorder.stop();
            const metadata = JSON.parse(
                auth.decrypt(
                    await mockFs.readFile(
                        path.join(
                            config.dir.recordings,
                            recordingName,
                            config.recording.metadataFileName
                        )
                    )
                )
            );
            expect(metadata.stoppedAt - metadata.startedAt).toBe(240 * MINUTE);
        } finally {
            setTimeoutSpy.mockRestore();
            dateNowSpy.mockRestore();
            await restore();
        }
    });

    test("R5 of D005: a recording shorter than 5 s is not kept for delivery", async () => {
        const { restore, network, getChannel } = await recordingSetup({
            RECORDING: "true",
            RECORDING_MAX_DURATION_MIN: "240"
        });
        const config = await import("#src/config.ts");
        const { mockFs } = await import("#tests/utils/mockFileSystem.ts");
        let now = 1_000_000;
        const dateNowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
        try {
            const channelUUID = await network.getChannelUUID();
            const user = await network.connect(channelUUID, 1);
            await network.connect(channelUUID, 2);
            const recorder = getChannel(channelUUID)!.recorder!;
            expect(await user.sfuClient.setRecording({ audio: true })).toBe(true);
            await waitFor(() => recorder.path !== undefined);
            now += 4_999;
            await recorder.stop();
            expect(await mockFs.readdir(config.dir.recordings)).toEqual([]);
        } finally {
            dateNowSpy.mockRestore();
            await restore();
        }
    });
});

describe("R11 of D005: speaker of a track", () => {
    test.each([
        { transcription: "on", speaker: { label: "Анна Коваль", userId: 7 } },
        { transcription: "off", speaker: undefined }
    ])(
        "R11 of D005: with transcription $transcription, file_state_change of an audio track carries label and user_id of its session only when on",
        async ({ speaker }) => {
            keepWritersAlive();
            const { restore, network, getChannel } = await recordingSetup({
                RECORDING: "true",
                ...(speaker
                    ? {
                          RECORDING_ARCHIVE: "1",
                          RECORDING_TRANSCRIBE_URL: "https://asr.test/asr",
                          RECORDING_TRANSCRIBE_API_KEY: "asr-key"
                      }
                    : {
                          RECORDING_TRANSCRIBE_URL: undefined,
                          RECORDING_TRANSCRIBE_API_KEY: undefined
                      })
            });
            try {
                const channelUUID = await network.getChannelUUID();
                const user1 = await network.connect(channelUUID, 1, { userId: 7 });
                await network.connect(channelUUID, 2);
                const channel = getChannel(channelUUID)!;
                // what the session token gives as `label` (src/core/services/ws.ts)
                channel.sessions.get(1)!.label = "Анна Коваль";
                const mark = jest.spyOn(channel.recorder!, "mark");
                expect(await user1.sfuClient.setRecording({ audio: true })).toBe(true);
                await waitFor(() => user1.sfuClient.recordingState.audio);
                await user1.sfuClient.updateUpload(
                    STREAM_TYPE.AUDIO,
                    new FakeMediaStreamTrack({ kind: "audio" })
                );
                await waitFor(() => channel.sessions.get(1)!.producers.audio);
                await channel.recorder!.stop();
                const marks = mark.mock.calls
                    .map(([, info]) => info)
                    .filter((info) => info.type === STREAM_TYPE.AUDIO && info.sessionId === 1);
                expect(marks.length).toBeGreaterThan(0);
                expect(marks.map(({ label, userId }) => ({ label, userId }))).toEqual(
                    marks.map(() => speaker ?? { label: undefined, userId: undefined })
                );
                expect(marks.some((info) => "label" in info || "userId" in info)).toBe(
                    Boolean(speaker)
                );
            } finally {
                await restore();
            }
        }
    );
});

describe("R13 of D005: speaker of an archived track", () => {
    test("R13 of D005: with RECORDING_ARCHIVE_TRACKS=1 and no RECORDING_TRANSCRIBE_URL, file_state_change of an audio track carries label and user_id", async () => {
        keepWritersAlive();
        const { restore, network, getChannel } = await recordingSetup({
            RECORDING: "true",
            RECORDING_ARCHIVE: "1",
            RECORDING_ARCHIVE_TRACKS: "1",
            RECORDING_TRANSCRIBE_URL: undefined,
            RECORDING_TRANSCRIBE_API_KEY: undefined
        });
        try {
            const channelUUID = await network.getChannelUUID();
            const user1 = await network.connect(channelUUID, 1, { userId: 7 });
            await network.connect(channelUUID, 2);
            const channel = getChannel(channelUUID)!;
            channel.sessions.get(1)!.label = "Анна Коваль";
            const mark = jest.spyOn(channel.recorder!, "mark");
            expect(await user1.sfuClient.setRecording({ audio: true })).toBe(true);
            await waitFor(() => user1.sfuClient.recordingState.audio);
            await user1.sfuClient.updateUpload(
                STREAM_TYPE.AUDIO,
                new FakeMediaStreamTrack({ kind: "audio" })
            );
            await waitFor(() => channel.sessions.get(1)!.producers.audio);
            await channel.recorder!.stop();
            const marks = mark.mock.calls
                .map(([, info]) => info)
                .filter((info) => info.type === STREAM_TYPE.AUDIO && info.sessionId === 1);
            expect(marks.length).toBeGreaterThan(0);
            for (const info of marks) {
                expect(info).toMatchObject({ label: "Анна Коваль", userId: 7 });
            }
        } finally {
            await restore();
        }
    });
});

describe("R7 of D005: recorded streams", () => {
    test("R7 of D005: with RECORDING_CAMERAS=false a camera is not recorded, the screen is", async () => {
        keepWritersAlive();
        const { restore, network, getChannel } = await recordingSetup({
            RECORDING: "true",
            RECORDING_CAMERAS: "false"
        });
        try {
            const channelUUID = await network.getChannelUUID();
            const user1 = await network.connect(channelUUID, 1);
            const user2 = await network.connect(channelUUID, 2);
            const channel = getChannel(channelUUID)!;
            const mark = jest.spyOn(channel.recorder!, "mark");
            expect(await user1.sfuClient.setRecording({ audio: true, video: true })).toBe(true);
            await waitFor(() => user1.sfuClient.recordingState.video);
            const outputs = () => mockSpawn.mock.calls.map(([, args]) => args.at(-1)!);
            const recordsTo = (type: STREAM_TYPE) =>
                outputs().some((output) => path.basename(path.dirname(output)) === type);

            await user1.sfuClient.updateUpload(
                STREAM_TYPE.AUDIO,
                new FakeMediaStreamTrack({ kind: "audio" })
            );
            await user1.sfuClient.updateUpload(
                STREAM_TYPE.CAMERA,
                new FakeMediaStreamTrack({ kind: "video" })
            );
            await waitFor(() => recordsTo(STREAM_TYPE.AUDIO));
            await waitFor(() => channel.sessions.get(1)!.producers.camera);
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(recordsTo(STREAM_TYPE.CAMERA)).toBe(false);

            await user2.sfuClient.updateUpload(
                STREAM_TYPE.SCREEN,
                new FakeMediaStreamTrack({ kind: "video" })
            );
            await waitFor(() => recordsTo(STREAM_TYPE.SCREEN));
            expect(recordsTo(STREAM_TYPE.CAMERA)).toBe(false);
            expect(mark.mock.calls.some(([, info]) => info.type === STREAM_TYPE.CAMERA)).toBe(
                false
            );
        } finally {
            await restore();
        }
    });

    describe("processing", () => {
        const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
        const originalFetch = global.fetch;
        let restoreEnv: (() => void) | undefined;
        let scheduler: typeof import("#src/recording/services/scheduler") | undefined;

        afterEach(async () => {
            await scheduler?.close();
            global.fetch = originalFetch;
            restoreEnv?.();
        });

        test("R7 of D005: with RECORDING_COMPILE_VIDEO=false no video is compiled, the raw screen stays", async () => {
            restoreEnv = withMockEnv({ RECORDING_COMPILE_VIDEO: "false" });
            const loadAverage = jest.spyOn(os, "loadavg").mockReturnValue([0, 0, 0]);
            const { mockFs } = await setupUnitTestsEnv();
            global.fetch = mockFetch;
            const recordingDir = "/mock/recordings/screen_session";
            const screenPath = path.join(recordingDir, "screen", "screen_1.mkv");
            mockFs.mkdir(path.join(recordingDir, "audio"), { recursive: true });
            mockFs.mkdir(path.join(recordingDir, "screen"));
            mockFs.write(path.join(recordingDir, "audio", "audio_1.webm"), "audio");
            mockFs.write(screenPath, "screen");
            mockFs.write(
                path.join(recordingDir, "metadata.bin"),
                JSON.stringify({
                    routingAddress: "http://odoo.test/recording",
                    channelKey: "key",
                    startedAt: 1000,
                    stoppedAt: Date.now() - 1000,
                    timeStamps: [
                        fileState(STREAM_TYPE.AUDIO, "audio_1.webm", 1100),
                        fileState(STREAM_TYPE.SCREEN, "screen_1.mkv", 1100)
                    ],
                    audio: true,
                    video: true,
                    transcription: false
                })
            );
            let screenAtUpload = false;
            mockFetch.mockImplementation(async (url) => {
                if (url.toString().includes("/routing")) {
                    return Response.json({ destination: "http://upload.local" });
                }
                screenAtUpload = mockFs.exists(screenPath);
                return new Response();
            });
            try {
                scheduler = await import("#src/recording/services/scheduler");
                await scheduler.start();
                const outputs = mockSpawn.mock.calls
                    .filter(([command]) => command === "ffmpeg")
                    .map(([, args]) => args.at(-1)!);
                expect(outputs).toEqual([path.join(recordingDir, "recording_1000.partial.ogg")]);
                expect(mockFetch.mock.calls[0][0]).toContain("mimetype=audio%2Fogg");
                expect(screenAtUpload).toBe(true);
            } finally {
                loadAverage.mockRestore();
            }
        });
    });
});

describe("R17 of D005: raw video container", () => {
    afterEach(() => {
        mockSpawn.mockClear();
    });

    test.each([
        { container: undefined, kind: "video", codec: "H264", ext: "mp4" },
        { container: "mkv", kind: "video", codec: "H264", ext: "mkv" },
        { container: "mkv", kind: "video", codec: "VP8", ext: "mkv" },
        { container: "mkv", kind: "audio", codec: "opus", ext: "webm" }
    ] as const)(
        "R17 of D005: RECORDING_RAW_VIDEO_CONTAINER=$container writes $kind/$codec as .$ext",
        async ({ container, kind, codec, ext }) => {
            const restore = withMockEnv({
                RECORDING_RAW_VIDEO_CONTAINER: container,
                VIDEO_CODECS: "VP8,H264"
            });
            try {
                await setupUnitTestsEnv();
                keepWritersAlive();
                const { MediaWriter } = await import("#src/recording/models/media_writer.ts");
                const writer = new MediaWriter(
                    {
                        kind,
                        codec,
                        clockRate: kind === "audio" ? 48000 : 90000,
                        payloadType: 101,
                        port: 5005,
                        channels: kind === "audio" ? 2 : undefined
                    },
                    "/raw/screen",
                    "1-1-screen"
                );
                try {
                    expect(writer.filename).toBe(`1-1-screen.${ext}`);
                    expect(mockSpawn.mock.calls[0][1].at(-1)).toBe(`/raw/screen/1-1-screen.${ext}`);
                } finally {
                    await writer.close();
                }
            } finally {
                restore();
            }
        }
    );
});

describe("R9 of D005: audio mix", () => {
    test.each([
        { normalize: undefined, filter: "amix=inputs=2:dropout_transition=0[out]" },
        { normalize: "0", filter: "amix=inputs=2:dropout_transition=0:normalize=0[out]" }
    ])(
        "R9 of D005: RECORDING_AUDIO_NORMALIZE=$normalize mixes with $filter",
        async ({ normalize, filter }) => {
            const restore = withMockEnv({ RECORDING_AUDIO_NORMALIZE: normalize });
            try {
                const { mockFs } = await setupUnitTestsEnv();
                const { MediaCompiler } = await import("#src/recording/models/media_compiler.ts");
                mockFs.mkdir("/mix/audio", { recursive: true });
                mockFs.write("/mix/audio/a.webm", "a");
                mockFs.write("/mix/audio/b.webm", "b");
                const compiler = new MediaCompiler({
                    workingDir: "/mix",
                    startedAt: 1000,
                    stoppedAt: 5000,
                    timeStamps: [
                        fileState(STREAM_TYPE.AUDIO, "a.webm", 1000),
                        fileState(STREAM_TYPE.AUDIO, "b.webm", 1000)
                    ]
                });
                expect(await compiler.getAudio()).toBe("/mix/recording_1000.ogg");
                const args = mockSpawn.mock.calls.find(([command]) => command === "ffmpeg")![1];
                const filterComplex = args[args.indexOf("-filter_complex") + 1];
                expect(filterComplex.endsWith(filter)).toBe(true);
                expect(args.at(-1)!.endsWith(".ogg")).toBe(true);
                expect(args).toEqual(expect.arrayContaining(["-c:a", "libopus"]));
            } finally {
                restore();
            }
        }
    );
});
