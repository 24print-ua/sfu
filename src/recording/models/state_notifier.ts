import { setTimeout as sleep } from "node:timers/promises";

import {
    HttpError,
    isRetryable,
    signRecordingToken
} from "#src/recording/models/media_uploader.ts";
import { Logger } from "#src/utils/utils.ts";

/** Why a recording started or stopped, see `RECORDING_STATE_CALLBACK` */
export type StateReason = "user" | "alone" | "max_duration" | "error";

/**
 * Body of `POST ${recordingAddress}/state` (24print-ua/24print-hub#227, contract item 3).
 */
export type RecordingStateBody = {
    recording_id: string;
    active: boolean;
    /** whether the recording really started; false on a failed start */
    started: boolean;
    reason: StateReason;
    /** who pressed record or stop, null otherwise */
    user_id: number | null;
};

const logger = new Logger("RECORDING_STATE");
/** pauses before the 2nd, 3rd and 4th attempt; then `RETRY_INTERVAL` */
export const RETRY_DELAYS = [2_000, 10_000, 30_000];
const RETRY_INTERVAL = 60_000;
/** a deploy of the Odoo test host stops Odoo for up to 20 minutes */
export const RETRY_WINDOW = 30 * 60_000;
const REQUEST_TIMEOUT = 30_000;
/** aborted when the SFU shuts down: the pending calls would die with the process anyway */
let shutdown = new AbortController();

/**
 * Posts the recording starts and stops of one channel to Odoo, strictly in order:
 * a call is sent once the previous one got an answer or was given up.
 */
export class StateNotifier {
    private readonly _address: string;
    private readonly _key?: string;
    private _queue: Promise<void> = Promise.resolve();

    /**
     * @param address - `recordingAddress` of the channel
     * @param key - base64 channel key that signs the requests
     */
    constructor(address: string, key?: string) {
        this._address = address;
        this._key = key;
    }

    /**
     * Queues a state call; never rejects.
     */
    send(body: RecordingStateBody): Promise<void> {
        this._queue = this._queue.then(() => this._deliver(body));
        return this._queue;
    }

    /**
     * Drops the pending calls of every channel, on SFU shutdown.
     */
    static closeAll() {
        shutdown.abort();
        shutdown = new AbortController();
    }

    /** Waits between attempts without keeping the process alive. */
    async wait(ms: number, signal?: AbortSignal): Promise<void> {
        await sleep(ms, undefined, { signal, ref: false }).catch(() => undefined);
    }

    private async _deliver(body: RecordingStateBody) {
        const firstAttemptAt = Date.now();
        const call = `state active=${body.active} of ${body.recording_id}`;
        const { signal } = shutdown;
        for (let attempt = 0; ; attempt++) {
            if (signal.aborted) {
                logger.warn(`${call} dropped: the SFU is shutting down`);
                return;
            }
            try {
                const response = await fetch(`${this._address}/state`, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${signRecordingToken(this._key, body.recording_id)}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT)])
                });
                await response.body?.cancel().catch(() => undefined);
                if (response.ok) {
                    return;
                }
                const error = new HttpError(`${call}: ${response.status}`, response.status);
                if (!isRetryable(error)) {
                    // 409: a start that arrives after the stop of the same recording
                    logger.warn(`${error.message}, not retried`);
                    return;
                }
                logger.warn(`${error.message}, will retry`);
            } catch (error) {
                if (!isRetryable(error)) {
                    logger.error(`${call} failed: ${error}`);
                    return;
                }
                logger.warn(`${call} failed: ${error}, will retry`);
            }
            if (Date.now() - firstAttemptAt >= RETRY_WINDOW) {
                logger.error(`${call} given up after ${attempt + 1} attempts`);
                return;
            }
            await this.wait(RETRY_DELAYS[attempt] ?? RETRY_INTERVAL, signal);
        }
    }
}
