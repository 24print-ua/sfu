import fs from "node:fs/promises";
import { createReadStream } from "node:fs";

import * as config from "#src/config.ts";
import { sign } from "#src/core/services/auth.ts";
import type { SealedMetaData } from "#src/recording/models/recorder.ts";
import { Logger } from "#src/utils/utils.ts";

type RoutingResponse = {
    destination: string;
    method?: string;
    headers?: Record<string, string>;
    response_status?: number;
    requires_completion?: boolean;
};

const logger = new Logger("MEDIA_UPLOADER");
const MAX_ROUTING_RESPONSE_BYTES = 64 * 1024;
/** `aud` of the JWT of the 24print recording contract (24print-ua/24print-hub#227) */
export const RECORDING_AUDIENCE = "24print-call-recording";
const RECORDING_TOKEN_LIFETIME = 600; // seconds, exp - iat

/**
 * A response with an unexpected HTTP status.
 */
export class HttpError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

/**
 * Whether a request may succeed when repeated: a network failure or timeout, a 5xx or a 429.
 * Other statuses (401, 403, 404, 409...) and malformed responses are final.
 */
export function isRetryable(error: unknown): boolean {
    if (error instanceof HttpError) {
        return error.status >= 500 || error.status === 429;
    }
    return (
        error instanceof TypeError ||
        (error instanceof DOMException &&
            (error.name === "TimeoutError" || error.name === "AbortError"))
    );
}

/**
 * Signs a request of the 24print recording contract to Odoo: `aud`, `recording_id`
 * and a lifetime of 10 minutes, so a call-join token signed with the same key is refused.
 *
 * @param key - base64 channel key
 */
export function signRecordingToken(
    key: string | undefined,
    recordingId: string,
    claims: Record<string, unknown> = {}
): string {
    const iat = Math.floor(Date.now() / 1000);
    return sign(
        {
            ...claims,
            aud: RECORDING_AUDIENCE,
            recording_id: recordingId,
            iat,
            exp: iat + RECORDING_TOKEN_LIFETIME
        },
        key
    );
}

export class MediaUploader {
    private readonly _routingTimeoutMs: number;
    private readonly _uploadTimeoutMs: number;

    constructor({
        routingTimeoutMs,
        uploadTimeoutMs
    }: {
        routingTimeoutMs: number;
        uploadTimeoutMs: number;
    }) {
        this._routingTimeoutMs = routingTimeoutMs;
        this._uploadTimeoutMs = uploadTimeoutMs;
    }

    async transcribe({ filePath, metadata }: { filePath: string; metadata: SealedMetaData }) {
        const fileStats = await fs.stat(filePath);
        const params = new URLSearchParams({
            start_ms: String(metadata.startedAt),
            end_ms: String(metadata.stoppedAt),
            has_media_output: String(metadata.audio || metadata.video)
        });
        const response = await this._fetchWithTimeout(
            `${metadata.routingAddress}/transcribe?${params}`,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${this._makeJwt(metadata)}`,
                    "Content-Type": config.recording.audio.mimeType,
                    "Content-Length": fileStats.size.toString()
                },
                // FIXME remove linter error suppression
                // @ts-expect-error: Node fetch supports ReadStream
                // The reason is that the current tsconfig uses both ES2024 and DOM
                // because part of the SFU codebase runs on the client (client.ts)
                // this causes the linter to treat this fetch as a client fetch
                // it could probably fixed with some tsconfig compositing trickery
                // that takes client.ts, tests and shared files into account
                body: createReadStream(filePath),
                duplex: "half"
            },
            this._uploadTimeoutMs
        );
        await this._discardResponse(
            response,
            `Failed to upload audio to ${metadata.routingAddress}`
        );
    }

    /**
     * Uploads media and acknowledges completion when the routing contract requires it.
     *
     * @throws {Error} If routing, upload or completion fails or the routing response is too large.
     * @throws {SyntaxError} If the routing response is not valid JSON.
     * @throws {NodeJS.ErrnoException} If the media file cannot be read.
     * @throws {TypeError} If a network request fails.
     * @throws {DOMException} If a network request times out.
     */
    async uploadMedia({
        filePath,
        metadata,
        mimetype,
        recordingId
    }: {
        filePath: string;
        metadata: SealedMetaData;
        mimetype: string;
        /** sent as `recording_id` and signed in the JWT (24print contract) when set */
        recordingId?: string;
    }) {
        logger.info(`Uploading ${filePath} to ${metadata.routingAddress}`);
        const params = new URLSearchParams({
            ...(recordingId === undefined ? {} : { recording_id: recordingId }),
            start_ms: String(metadata.startedAt),
            end_ms: String(metadata.stoppedAt),
            mimetype
        });
        const response = await this._fetchWithTimeout(
            `${metadata.routingAddress}/routing?${params}`,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${this._makeJwt(metadata, recordingId)}`
                }
            },
            this._routingTimeoutMs
        );
        const jsonResponse = JSON.parse(
            await this._readRoutingResponse(
                response,
                `Failed to obtain routing from ${metadata.routingAddress}`
            )
        ) as RoutingResponse;
        if (!jsonResponse.destination) {
            throw new Error(`No upload destination returned by ${metadata.routingAddress}/routing`);
        }
        const fileStats = await fs.stat(filePath);
        const uploadResponse = await this._fetchWithTimeout(
            jsonResponse.destination,
            {
                method: jsonResponse.method ?? "POST",
                headers: {
                    "Content-Type": mimetype,
                    ...jsonResponse.headers,
                    "Content-Length": fileStats.size.toString()
                },
                // @ts-expect-error: same as above
                body: createReadStream(filePath),
                duplex: "half"
            },
            this._uploadTimeoutMs
        );
        await this._discardResponse(
            uploadResponse,
            `Failed to upload files to ${metadata.routingAddress}`,
            jsonResponse.response_status
        );
        if (jsonResponse.requires_completion === true) {
            params.delete("mimetype");
            const completionResponse = await this._fetchWithTimeout(
                `${metadata.routingAddress}/complete?${params}`,
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${this._makeJwt(metadata, recordingId)}`
                    }
                },
                this._routingTimeoutMs
            );
            await this._discardResponse(
                completionResponse,
                `Failed to complete recording at ${metadata.routingAddress}`
            );
        }
    }

    private _makeJwt(metadata: SealedMetaData, recordingId?: string) {
        const user = metadata.userId === undefined ? {} : { user_id: metadata.userId };
        if (recordingId !== undefined) {
            return signRecordingToken(metadata.channelKey, recordingId, user);
        }
        const nowSeconds = Date.now() / 1000;
        return sign(
            {
                exp: nowSeconds + 120,
                iat: nowSeconds,
                ...(metadata.userId === undefined ? {} : { user_id: metadata.userId })
            },
            metadata.channelKey
        );
    }

    private async _checkResponse(
        response: Response,
        errorMessage: string,
        expectedStatus?: number
    ) {
        if (!response.ok || (expectedStatus !== undefined && response.status !== expectedStatus)) {
            await response.body?.cancel().catch(() => undefined);
            throw new HttpError(
                `${errorMessage}: ${response.status} ${response.statusText}`,
                response.status
            );
        }
    }

    private async _discardResponse(
        response: Response,
        errorMessage: string,
        expectedStatus?: number
    ) {
        await this._checkResponse(response, errorMessage, expectedStatus);
        await response.body?.cancel().catch(() => undefined);
    }

    private async _readRoutingResponse(response: Response, errorMessage: string) {
        await this._checkResponse(response, errorMessage);
        const reader = response.body?.getReader();
        if (!reader) {
            return response.text();
        }
        const decoder = new TextDecoder();
        let body = "";
        let receivedBytes = 0;
        try {
            for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
                const { value } = chunk;
                receivedBytes += value.byteLength;
                if (receivedBytes > MAX_ROUTING_RESPONSE_BYTES) {
                    await reader.cancel().catch(() => undefined);
                    throw new Error(`Routing response exceeds ${MAX_ROUTING_RESPONSE_BYTES} bytes`);
                }
                body += decoder.decode(value, { stream: true });
            }
            return body + decoder.decode();
        } finally {
            reader.releaseLock();
        }
    }

    private _fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
        return fetch(url, {
            ...init,
            signal: AbortSignal.timeout(timeoutMs)
        });
    }
}
