/**
 * 24print recording state calls and delivery retries (D005 of 24print-ua/24print-hub,
 * contract items 3-6 of spec #227), with mocked FFmpeg and disk.
 */
import path from "node:path";
import os from "node:os";
import { createHmac } from "node:crypto";

import { describe, expect, jest, test, afterEach, beforeEach } from "@jest/globals";

import { STREAM_TYPE } from "#src/shared/enums.ts";
import { TIME_TAG } from "#src/recording/models/recorder.ts";

import { recordingSetup, setupUnitTestsEnv } from "#tests/utils/testHelpers.ts";
import { waitFor, withMockEnv } from "#tests/utils/utils.ts";
import { mockFfmpeg } from "#tests/utils/mockFfmpeg.ts";
import { mockNodeFS } from "#tests/utils/mockFileSystem.ts";

mockNodeFS();
mockFfmpeg();

const MINUTE = 60_000;
const ODOO = "http://recording.local";

type StateCall = { body: Record<string, unknown>; authorization: string };

/**
 * Checks a JWT the way Odoo does (24print_call_recording/tools/sfu_token.py).
 */
function checkContractToken(authorization: string, key: Buffer, recordingId: string) {
    const [scheme, token] = authorization.split(" ");
    expect(scheme).toBe("Bearer");
    const [header, claims, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toMatchObject({
        alg: "HS256"
    });
    expect(createHmac("sha256", key).update(`${header}.${claims}`).digest("base64url")).toBe(
        signature
    );
    const decoded = JSON.parse(Buffer.from(claims, "base64url").toString());
    expect(decoded).toMatchObject({ aud: "24print-call-recording", recording_id: recordingId });
    expect(decoded).not.toHaveProperty("session_id");
    expect(Number.isInteger(decoded.iat) && Number.isInteger(decoded.exp)).toBe(true);
    expect(decoded.exp - decoded.iat).toBeLessThanOrEqual(600);
    expect(decoded.exp).toBeGreaterThan(Date.now() / 1000);
    return decoded;
}

describe("D005 delivery settings", () => {
    test("RECORDING_ALONE_GRACE_S: 0 by default, a non-negative number of seconds", async () => {
        for (const [value, grace] of [
            [undefined, 0],
            ["15", 15_000],
            ["0.5", 500]
        ] as const) {
            const restore = withMockEnv({ RECORDING_ALONE_GRACE_S: value });
            try {
                const config = await import("#src/config.ts");
                expect(config.recording.aloneGrace).toBe(grace);
            } finally {
                restore();
            }
        }
        for (const value of ["-1", "abc"]) {
            const restore = withMockEnv({ RECORDING_ALONE_GRACE_S: value });
            try {
                await expect(import("#src/config.ts")).rejects.toThrow(/RECORDING_ALONE_GRACE_S/);
            } finally {
                restore();
            }
        }
    });

    test("defaults keep the upstream behaviour, 1 turns each setting on", async () => {
        const names = ["RECORDING_STATE_CALLBACK", "RECORDING_DELIVERY_RETRY", "RECORDING_ARCHIVE"];
        for (const value of [undefined, "1"]) {
            const restore = withMockEnv(Object.fromEntries(names.map((name) => [name, value])));
            try {
                const config = await import("#src/config.ts");
                expect([
                    config.RECORDING_STATE_CALLBACK,
                    config.RECORDING_DELIVERY_RETRY,
                    config.RECORDING_ARCHIVE
                ]).toEqual(Array(3).fill(value === "1"));
            } finally {
                restore();
            }
        }
    });
});

describe("Odoo state calls", () => {
    const originalFetch = global.fetch;

    afterEach(() => {
        global.fetch = originalFetch;
    });

    /**
     * A channel of users 7 and 8 whose state calls reach a fake Odoo.
     */
    async function stateSetup(env: Record<string, string> = {}) {
        const setup = await recordingSetup({
            RECORDING: "true",
            RECORDING_STATE_CALLBACK: "1",
            ...env
        });
        const odoo = { down: false, attempts: [] as StateCall[], received: [] as StateCall[] };
        global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = input.toString();
            if (!url.startsWith(ODOO)) {
                return originalFetch(input, init);
            }
            expect(url).toBe(`${ODOO}/state`);
            const headers = init!.headers as Record<string, string>;
            expect(headers["Content-Type"]).toBe("application/json");
            const call = {
                body: JSON.parse(init!.body as string),
                authorization: headers.Authorization
            };
            odoo.attempts.push(call);
            if (odoo.down) {
                throw new TypeError("fetch failed");
            }
            odoo.received.push(call);
            return Response.json({ ok: true });
        }) as typeof fetch;
        const channelUUID = await setup.network.getChannelUUID();
        const user7 = await setup.network.connect(channelUUID, 1, { userId: 7 });
        const user8 = await setup.network.connect(channelUUID, 2, { userId: 8 });
        const channel = setup.getChannel(channelUUID)!;
        return { ...setup, odoo, channel, channelUUID, user7, user8 };
    }

    test("R4, R5, R6, R18 of D005: start and stop are posted with reason user, max_duration and alone", async () => {
        const setTimeoutSpy = jest.spyOn(global, "setTimeout");
        const { restore, odoo, channel, channelUUID, user7, user8 } = await stateSetup();
        try {
            const config = await import("#src/config.ts");
            const recorder = channel.recorder!;
            const states = () =>
                odoo.received.map(({ body }) => [body.active, body.reason, body.user_id]);

            // «Стоп» pressed by another user
            expect(await user7.sfuClient.setRecording({ audio: true })).toBe(true);
            await waitFor(() => odoo.received.length === 1);
            expect(await user8.sfuClient.setRecording({ audio: false })).toBe(true);
            await waitFor(() => odoo.received.length === 2);

            // the duration limit
            setTimeoutSpy.mockClear();
            expect(await user7.sfuClient.setRecording({ audio: true })).toBe(true);
            await waitFor(() => odoo.received.length === 3);
            const limit = setTimeoutSpy.mock.calls.find(
                ([, delay]) => delay === config.recording.maxDuration
            )!;
            (limit[0] as () => void)();
            await waitFor(() => odoo.received.length === 4);

            // one participant left
            expect(await user7.sfuClient.setRecording({ audio: true })).toBe(true);
            await waitFor(() => odoo.received.length === 5);
            user8.sfuClient.disconnect();
            await waitFor(() => odoo.received.length === 6);
            expect(recorder.isRecording).toBe(false);

            expect(states()).toEqual([
                [true, "user", 7],
                [false, "user", 8],
                [true, "user", 7],
                [false, "max_duration", null],
                [true, "user", 7],
                [false, "alone", null]
            ]);
            const ids = odoo.received.map(({ body }) => body.recording_id as string);
            for (let i = 0; i < ids.length; i += 2) {
                expect(ids[i]).toMatch(new RegExp(`^\\d+-${channelUUID}$`));
                expect(ids[i + 1]).toBe(ids[i]);
            }
            expect(new Set(ids).size).toBe(3);
            for (const { body, authorization } of odoo.received) {
                expect(body.started).toBe(true);
                expect(Object.keys(body).sort()).toEqual(
                    ["active", "reason", "recording_id", "started", "user_id"].sort()
                );
                checkContractToken(authorization, channel.key!, body.recording_id as string);
            }
        } finally {
            setTimeoutSpy.mockRestore();
            await restore();
        }
    });

    test("R4 of D005: with RECORDING_ALONE_GRACE_S, a participant back in time keeps the recording; alone after it, it stops (24print-hub#233)", async () => {
        const { restore, odoo, network, channel, channelUUID, user7 } = await stateSetup({
            RECORDING_ALONE_GRACE_S: "0.3"
        });
        try {
            const recorder = channel.recorder!;
            expect(await user7.sfuClient.setRecording({ audio: true })).toBe(true);
            await waitFor(() => odoo.received.length === 1);

            // user 8 reconnects at once, as session 116 did on the test SFU
            channel.sessions.get(2)!.close();
            await waitFor(() => channel.sessions.size === 1);
            expect(recorder.isRecording).toBe(true);
            await network.connect(channelUUID, 2, { userId: 8 });
            await waitFor(() => channel.sessions.size === 2);
            await new Promise((resolve) => setTimeout(resolve, 600));
            expect(recorder.isRecording).toBe(true);
            expect(odoo.received).toHaveLength(1);

            // user 8 leaves for good
            const leftAt = performance.now();
            channel.sessions.get(2)!.close();
            await waitFor(() => channel.sessions.size === 1);
            expect(recorder.isRecording).toBe(true);
            await waitFor(() => odoo.received.length === 2);
            expect(performance.now() - leftAt).toBeGreaterThanOrEqual(290);
            expect(recorder.isRecording).toBe(false);
            expect(odoo.received.map(({ body }) => [body.active, body.reason])).toEqual([
                [true, "user"],
                [false, "alone"]
            ]);
        } finally {
            await restore();
        }
    });

    test("R6 of D005: a start then a stop while Odoo is down arrive in order once it is back", async () => {
        const { restore, odoo, user7 } = await stateSetup();
        try {
            const { StateNotifier } = await import("#src/recording/models/state_notifier.ts");
            const pauses: number[] = [];
            const wait = jest
                .spyOn(StateNotifier.prototype, "wait")
                .mockImplementation(async (ms) => {
                    pauses.push(ms);
                    await new Promise((resolve) => setTimeout(resolve, 5));
                });
            odoo.down = true;
            expect(await user7.sfuClient.setRecording({ audio: true })).toBe(true);
            await waitFor(() => odoo.attempts.length > 0);
            expect(await user7.sfuClient.setRecording({ audio: false })).toBe(true);
            await waitFor(() => odoo.attempts.length >= 6);
            // the stop waits for the start
            expect(odoo.attempts.every(({ body }) => body.active === true)).toBe(true);
            expect(pauses.slice(0, 5)).toEqual([2_000, 10_000, 30_000, MINUTE, MINUTE]);

            odoo.down = false;
            await waitFor(() => odoo.received.length === 2);
            const [start, stop] = odoo.received.map(({ body }) => body);
            expect(start).toMatchObject({ active: true, started: true, reason: "user" });
            expect(stop).toMatchObject({ active: false, started: true, reason: "user" });
            expect(stop.recording_id).toBe(start.recording_id);
            wait.mockRestore();
        } finally {
            await restore();
        }
    });

    test("R6 of D005: a start that fails to reserve disk space posts active=false with started=false", async () => {
        const { restore, odoo, user7 } = await stateSetup({ RECORDING_RESERVATION_MB: "1" });
        try {
            const { mockFs } = await import("#tests/utils/mockFileSystem.ts");
            mockFs.setAvailableDiskSpace(0);
            expect(await user7.sfuClient.setRecording({ audio: true })).toBe(true);
            await waitFor(() => odoo.received.length === 1);
            expect(odoo.received[0].body).toMatchObject({
                active: false,
                started: false,
                reason: "error",
                user_id: null
            });
            expect(odoo.received[0].body.recording_id).toEqual(expect.any(String));
        } finally {
            await restore();
        }
    });

    test("without RECORDING_STATE_CALLBACK nothing is posted", async () => {
        const { restore, odoo, user7 } = await stateSetup({ RECORDING_STATE_CALLBACK: "" });
        try {
            expect(await user7.sfuClient.setRecording({ audio: true })).toBe(true);
            expect(await user7.sfuClient.setRecording({ audio: false })).toBe(true);
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(odoo.attempts).toEqual([]);
        } finally {
            await restore();
        }
    });
});

describe("StateNotifier retries", () => {
    const originalFetch = global.fetch;
    let restoreEnv: (() => void) | undefined;

    afterEach(() => {
        global.fetch = originalFetch;
        restoreEnv?.();
        jest.restoreAllMocks();
    });

    async function notifierWith(statuses: number[]) {
        restoreEnv = withMockEnv({});
        const { StateNotifier, RETRY_WINDOW } = await import(
            "#src/recording/models/state_notifier.ts"
        );
        let now = 1_000_000;
        jest.spyOn(Date, "now").mockImplementation(() => now);
        const pauses: number[] = [];
        const attemptsAt: number[] = [];
        jest.spyOn(StateNotifier.prototype, "wait").mockImplementation(async (ms) => {
            pauses.push(ms);
            now += ms;
        });
        global.fetch = (async () => {
            attemptsAt.push(now);
            return new Response(null, { status: statuses.shift() ?? 503 });
        }) as typeof fetch;
        const notifier = new StateNotifier(ODOO, Buffer.from("key").toString("base64"));
        const send = () =>
            notifier.send({
                recording_id: "1-uuid",
                active: true,
                started: true,
                reason: "user",
                user_id: 7
            });
        return { send, pauses, attemptsAt, start: now, RETRY_WINDOW };
    }

    test("R6 of D005: 500 and 429 are retried after 2 and 10 s", async () => {
        const { send, pauses, attemptsAt } = await notifierWith([500, 429, 200]);
        await send();
        expect(attemptsAt).toHaveLength(3);
        expect(pauses).toEqual([2_000, 10_000]);
    });

    test("R6 of D005: an unreachable Odoo is retried every minute for 30 minutes, then given up", async () => {
        const { send, pauses, attemptsAt, start, RETRY_WINDOW } = await notifierWith([]);
        await send();
        expect(pauses.slice(0, 3)).toEqual([2_000, 10_000, 30_000]);
        expect(pauses.slice(3).every((pause) => pause === MINUTE)).toBe(true);
        const lastAttempt = attemptsAt.at(-1)! - start;
        expect(lastAttempt).toBeGreaterThanOrEqual(RETRY_WINDOW);
        expect(lastAttempt - MINUTE).toBeLessThan(RETRY_WINDOW);
    });

    test("pending calls are dropped when the SFU shuts down", async () => {
        const { send, attemptsAt } = await notifierWith([]);
        const { StateNotifier } = await import("#src/recording/models/state_notifier.ts");
        jest.spyOn(StateNotifier.prototype, "wait").mockImplementationOnce(async () =>
            StateNotifier.closeAll()
        );
        await send();
        expect(attemptsAt).toHaveLength(1);
    });

    test.each([409, 401, 403, 404, 400])("R6 of D005: %d is final, not retried", async (status) => {
        const { send, pauses, attemptsAt } = await notifierWith([status]);
        await send();
        expect(attemptsAt).toHaveLength(1);
        expect(pauses).toEqual([]);
    });
});

function fileState(type: STREAM_TYPE, filename: string, timestamp: number) {
    return {
        tag: TIME_TAG.FILE_STATE_CHANGE,
        timestamp,
        info: { type, filename, sessionId: 1, active: true, available: true }
    };
}

describe("R17 of D005: delivery retries", () => {
    const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    const originalFetch = global.fetch;
    const recordingDir = "/mock/recordings/retry_session";
    const metadataPath = path.join(recordingDir, "metadata.bin");
    const deliveryPath = path.join(recordingDir, "delivery.json");
    const routingAddress = "http://odoo.test/discuss/recording/5";
    const destination = "http://odoo.test/discuss/recording/upload/token";
    let restoreEnv: (() => void) | undefined;
    let scheduler: typeof import("#src/recording/services/scheduler") | undefined;
    let mockFs: typeof import("#tests/utils/mockFileSystem").mockFs;
    let now = 0;
    /** URLs requested from Odoo, kept across process restarts */
    let requests: string[] = [];

    afterEach(async () => {
        await scheduler?.close();
        scheduler = undefined;
        global.fetch = originalFetch;
        restoreEnv?.();
        jest.restoreAllMocks();
    });

    /**
     * Starts the scheduler; on `restart`, first stops it and reloads the modules as a new
     * SFU process would, keeping the mocked disk.
     */
    async function startProcess({ restart = false } = {}) {
        if (restart) {
            const disk = diskFiles();
            await scheduler?.close();
            ({ mockFs } = await setupUnitTestsEnv());
            for (const [file, content] of disk) {
                mockFs.write(file, content);
            }
        }
        global.fetch = mockFetch;
        scheduler = await import("#src/recording/services/scheduler");
        await scheduler.start();
    }

    function diskFiles() {
        return new Map(
            [...(mockFs as unknown as { files: Map<string, string> }).files].filter(([file]) =>
                file.startsWith(recordingDir)
            )
        );
    }

    async function retrySetup() {
        restoreEnv = withMockEnv({ RECORDING_DELIVERY_RETRY: "1", RECORDING_ARCHIVE: undefined });
        jest.spyOn(os, "loadavg").mockReturnValue([0, 0, 0]);
        now = 100 * 24 * 60 * MINUTE;
        jest.spyOn(Date, "now").mockImplementation(() => now);
        ({ mockFs } = await setupUnitTestsEnv());
        mockFs.write(path.join(recordingDir, "audio", "audio_1.ogg"), "audio");
        mockFs.write(
            metadataPath,
            JSON.stringify({
                routingAddress,
                channelKey: "key",
                startedAt: now - 60_000,
                stoppedAt: now - 1000,
                timeStamps: [fileState(STREAM_TYPE.AUDIO, "audio_1.ogg", now - 59_000)],
                audio: true,
                video: false,
                transcription: false
            })
        );
        mockFetch.mockReset();
        requests = [];
    }

    function calls(route: string) {
        return requests.filter((url) => url.includes(route));
    }

    /** Odoo answers each request with the next status of its route, 200 when none is left. */
    function odooAnswers(statuses: { routing?: number[]; upload?: number[]; complete?: number[] }) {
        mockFetch.mockImplementation(async (input) => {
            const url = input.toString();
            requests.push(url);
            const route = url.startsWith(destination)
                ? "upload"
                : (/\/(routing|complete)\?/.exec(url)![1] as "routing" | "complete");
            const status = statuses[route]?.shift() ?? 200;
            if (status !== 200) {
                return new Response(null, { status });
            }
            return route === "routing"
                ? Response.json({ destination, method: "POST", requires_completion: true })
                : Response.json({ ok: true });
        });
    }

    async function readDeliveryState() {
        return JSON.parse(await mockFs.readFile(deliveryPath));
    }

    test("R17 of D005: two 500 answers, then delivery on the third attempt with one complete", async () => {
        await retrySetup();
        // the 1st attempt fails at routing, the 2nd at the upload
        odooAnswers({ routing: [500], upload: [500] });
        await startProcess();
        expect(mockFs.exists(metadataPath)).toBe(true);
        expect(await readDeliveryState()).toMatchObject({
            attempts: 1,
            nextAttemptAt: now + MINUTE
        });

        await scheduler!.__testing__.oneProcessingBatch();
        expect(requests).toHaveLength(1); // the pause is not over

        now += MINUTE;
        await scheduler!.__testing__.oneProcessingBatch();
        expect(await readDeliveryState()).toMatchObject({
            attempts: 2,
            nextAttemptAt: now + 5 * MINUTE
        });
        expect(mockFs.exists(recordingDir)).toBe(true);

        now += 5 * MINUTE;
        await scheduler!.__testing__.oneProcessingBatch();
        expect(mockFs.exists(recordingDir)).toBe(false);
        // every attempt starts with routing, for a new upload token
        expect(calls("/routing")).toHaveLength(3);
        expect(calls(destination)).toHaveLength(2);
        expect(calls("/complete")).toHaveLength(1);
    });

    test("R17 of D005: a restarted process goes on with the retries", async () => {
        await retrySetup();
        odooAnswers({ routing: [503, 503] });
        await startProcess();
        expect(calls("/routing")).toHaveLength(1);

        // restart before the pause is over: no attempt, the pause is kept
        now += 30_000;
        await startProcess({ restart: true });
        expect(calls("/routing")).toHaveLength(1);
        now += 30_000;
        await scheduler!.__testing__.oneProcessingBatch();
        expect(calls("/routing")).toHaveLength(2);
        expect(await readDeliveryState()).toMatchObject({ attempts: 2 });

        // restart after the pause
        now += 5 * MINUTE;
        await startProcess({ restart: true });
        expect(mockFs.exists(recordingDir)).toBe(false);
        expect(calls("/complete")).toHaveLength(1);
    });

    test("R17 of D005: a process stopped during an attempt delivers again after restart", async () => {
        await retrySetup();
        odooAnswers({});
        // the state a killed process leaves: metadata consumed, no delivery recorded
        mockFs.rename(metadataPath, `${metadataPath}.processing`);
        await startProcess({ restart: true });
        expect(mockFs.exists(recordingDir)).toBe(false);
        expect(calls("/complete")).toHaveLength(1);
    });

    test("R17 of D005: after 24 h of failures the recording folder is deleted", async () => {
        await retrySetup();
        odooAnswers({ routing: Array(100).fill(502) });
        const stoppedAt = now - 1000;
        const attempts = [now];
        await startProcess();
        for (;;) {
            const { nextAttemptAt } = await readDeliveryState();
            if (nextAttemptAt > stoppedAt + 24 * 60 * MINUTE) {
                break;
            }
            now = nextAttemptAt;
            attempts.push(now);
            await scheduler!.__testing__.oneProcessingBatch();
        }
        const pauses = attempts.slice(1).map((at, i) => (at - attempts[i]) / MINUTE);
        expect(pauses.slice(0, 5)).toEqual([1, 5, 15, 30, 60]);
        expect(pauses.slice(5).every((pause) => pause === 60)).toBe(true);
        expect(calls("/routing")).toHaveLength(attempts.length);
        expect(mockFs.exists(recordingDir)).toBe(true);

        now = stoppedAt + 24 * 60 * MINUTE + 1;
        await scheduler!.__testing__.oneProcessingBatch();
        expect(mockFs.exists(recordingDir)).toBe(false);
        expect(calls("/routing")).toHaveLength(attempts.length);
    });

    test.each([401, 403, 404])(
        "R17 of D005: a %d answer discards the recording without retries",
        async (status) => {
            await retrySetup();
            odooAnswers({ routing: [status] });
            await startProcess();
            expect(mockFs.exists(recordingDir)).toBe(false);
            now += 2 * 60 * MINUTE;
            await scheduler!.__testing__.oneProcessingBatch();
            expect(requests).toHaveLength(1);
        }
    );
});

/**
 * Upstream tests of tests/recording.test.ts, copied unchanged and run again with
 * RECORDING_DELIVERY_RETRY=1: a delivery is still never replayed after a cleanup failure,
 * and a routing answer without destination still discards the recording.
 */
describe("upstream scheduler tests with RECORDING_DELIVERY_RETRY=1", () => {
    let mediaService: typeof import("#src/recording/services/scheduler");
    let mockFs: typeof import("#tests/utils/mockFileSystem").mockFs;
    let mockFsModule: typeof import("#tests/utils/mockFileSystem").mockFsModule;
    let mockFsInstance: typeof import("#tests/utils/mockFileSystem").mockFs;
    let mockFsModuleInstance: typeof import("#tests/utils/mockFileSystem").mockFsModule;
    let loadAverage: jest.SpiedFunction<typeof os.loadavg>;
    let restoreEnv: () => void;

    const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    const originalFetch = global.fetch;

    beforeEach(async () => {
        restoreEnv = withMockEnv({ RECORDING_DELIVERY_RETRY: "1", RECORDING_ARCHIVE: undefined });
        loadAverage = jest.spyOn(os, "loadavg").mockReturnValue([0, 0, 0]);
        const env = await setupUnitTestsEnv();
        mockFs = mockFsInstance = env.mockFs;
        mockFsModule = mockFsModuleInstance = env.mockFsModule;

        global.fetch = mockFetch;

        mockFetch.mockResolvedValue({
            ok: true,
            text: async () => "",
            statusText: "OK"
        } as Response);

        mediaService = await import("#src/recording/services/scheduler");
        if (!(await import("#src/config.ts")).RECORDING_DELIVERY_RETRY) {
            throw new Error("RECORDING_DELIVERY_RETRY is not set");
        }
    });

    afterEach(async () => {
        if (mediaService) {
            await mediaService.close();
        }
        loadAverage.mockRestore();
        global.fetch = originalFetch;
        restoreEnv();
    });

    test("does not upload again when recording cleanup fails", async () => {
        const { MediaCompiler } = await import("#src/recording/models/media_compiler.ts");
        const recordingDir = "/mock/recordings/cleanup_failure";
        const metadataPath = path.join(recordingDir, "metadata.bin");
        const audioPath = path.join(recordingDir, "audio.ogg");
        mockFs.write(
            metadataPath,
            JSON.stringify({
                routingAddress: "http://routing.local",
                channelKey: "key",
                startedAt: 1000,
                stoppedAt: Date.now() - 1000,
                timeStamps: [],
                audio: true,
                video: false,
                transcription: false
            })
        );
        mockFs.write(audioPath, "audio");
        const compileAudio = jest
            .spyOn(MediaCompiler.prototype, "getAudio")
            .mockResolvedValue(audioPath);
        mockFetch
            .mockResolvedValueOnce(Response.json({ destination: "http://upload.local" }))
            .mockResolvedValueOnce(new Response());
        const remove = mockFsModule.rm.getMockImplementation()!;
        mockFsModule.rm.mockRejectedValue(new Error("cleanup failed"));
        try {
            await mediaService.start();
            expect(mockFs.exists(recordingDir)).toBe(true);
            expect(mockFs.exists(metadataPath)).toBe(false);
            expect(mockFs.exists(`${metadataPath}.processing`)).toBe(true);
            expect(mockFetch).toHaveBeenCalledTimes(2);
            mockFsModule.rm.mockImplementation(remove);
            await mediaService.__testing__.oneProcessingBatch();
            expect(mockFs.exists(recordingDir)).toBe(false);
            expect(compileAudio).toHaveBeenCalledTimes(1);
            expect(mockFetch).toHaveBeenCalledTimes(2);
        } finally {
            mockFsModule.rm.mockImplementation(remove);
            compileAudio.mockRestore();
        }
    });

    test("discards recording when routing returns no destination", async () => {
        const recordingName = "session_no_dest";
        const routingAddress = "http://www.oodo.test/routing";
        const recordingDir = `/mock/recordings/${recordingName}`;
        const metadata = {
            channelName: "Test Channel",
            routingAddress,
            channelKey: "key123",
            stoppedAt: Date.now() - 1000,
            startedAt: 1000,
            timeStamps: [
                fileState(STREAM_TYPE.AUDIO, "audio_1.ogg", 1100),
                fileState(STREAM_TYPE.CAMERA, "cam_1.mp4", 1100)
            ],
            audio: true,
            video: true,
            transcription: false
        };

        mockFsInstance.mkdir(recordingDir);
        mockFsInstance.mkdir(path.join(recordingDir, "audio"));
        mockFsInstance.mkdir(path.join(recordingDir, "camera"));
        mockFsInstance.write(path.join(recordingDir, "metadata.bin"), JSON.stringify(metadata));
        mockFsInstance.write(path.join(recordingDir, "audio", "audio_1.ogg"), "dummy audio");
        mockFsInstance.write(path.join(recordingDir, "camera", "cam_1.mp4"), "dummy video");

        mockFetch.mockImplementation(async (url: string | URL | Request) => {
            const urlString = url.toString();
            if (urlString.includes("/audio")) {
                return { ok: true, text: async () => "" } as Response;
            }
            if (urlString.includes("/routing")) {
                return {
                    ok: true,
                    text: async () => JSON.stringify({ destination: "" }),
                    statusText: "OK"
                } as Response;
            }
            return {
                ok: false,
                statusText: "Not Found",
                text: async () => ""
            } as Response;
        });

        await mediaService.start();

        const queryParams = `?start_ms=${metadata.startedAt}&end_ms=${metadata.stoppedAt}&mimetype=video%2Fmp4`;
        expect(mockFetch).toHaveBeenCalledWith(
            `${routingAddress}/routing${queryParams}`,
            expect.anything()
        );
        expect(mockFsModuleInstance.rm).toHaveBeenCalledWith(recordingDir, {
            recursive: true,
            force: true
        });
        expect(mockFsInstance.exists(recordingDir)).toBe(false);
        await mediaService.__testing__.oneProcessingBatch();
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});
