import os from "node:os";
import path from "node:path";

import type { RouterRtpCodecCapability } from "mediasoup/node/lib/types";
// eslint-disable-next-line node/no-unpublished-import
import type { ProducerOptions } from "mediasoup-client/lib/Producer";

const FALSY_INPUT = new Set(["disable", "false", "none", "no", "0"]);
const envFlag = (value?: string) => {
    const normalized = value?.trim().toLowerCase();
    return Boolean(normalized && !FALSY_INPUT.has(normalized));
};
const envFlagOr = (value: string | undefined, fallback: boolean) =>
    value?.trim() ? envFlag(value) : fallback;
type LogLevel = "none" | "error" | "warn" | "info" | "debug" | "verbose";
type WorkerLogLevel = "none" | "error" | "warn" | "debug";
const testingMode = Boolean(process.env.JEST_WORKER_ID);
export const tmpDir = path.join(os.tmpdir(), "odoo_sfu");

// ------------------------------------------------------------
// ------------------   ENV VARIABLES   -----------------------
// ------------------------------------------------------------

/**
 * This env variable is <<REQUIRED>>, the base64 encoded key used
 * for HMAC/SHA256 signing/verification of the JWTs used for authentication.
 * e.g: AUTH_KEY=u6bsUQEWrHdKIuYplirRnbBmLbrKV5PxKG7DtA71mng=
 */
export const AUTH_KEY: string = process.env.AUTH_KEY!;

/**
 * A key used for encrypting/decrypting data locally, if not set one will be randomly generated.
 * It MUST be a 32bytes base64 key, for example generated from `openssl rand 32 | base64`
 */
export const LOCAL_KEY: string | undefined = process.env.LOCAL_KEY;

/**
 * This env variable is <<REQUIRED>>, the server needs to communicate its public IP to the clients as this is the IP
 * address that will be used for RTC connections. It can the local IP when testing locally.
 * e.g: PUBLIC_IP=190.165.1.70
 */
export const PUBLIC_IP: string = process.env.PUBLIC_IP!;

/**
 * The RTC listening interface
 * e.g: RTC_INTERFACE=0.0.0.0
 */
export const RTC_INTERFACE: string = process.env.RTC_INTERFACE || "0.0.0.0";

/**
 * Whether the server is behind a proxy,
 * If true, the server will use the headers "x-forwarded-for", "x-forwarded-proto" and "x-forwarded-host".
 * e.g: PROXY=1
 */
export const PROXY: boolean = Boolean(process.env.PROXY);

/**
 * The HTTP/WS interface
 * e.g: IP=localhost
 */
export const HTTP_INTERFACE: string = process.env.HTTP_INTERFACE || "0.0.0.0";

/**
 * Port of HTTP and Websocket, defaults to standard port 8070.
 */
export const PORT: number = Number(process.env.PORT) || 8070;
/**
 * The number of workers to spawn (up to core limits) to manage RTC servers.
 * 0 < NUM_WORKERS <= os.availableParallelism()
 */
export const NUM_WORKERS: number = Math.min(
    Number(process.env.NUM_WORKERS) || Infinity,
    os.availableParallelism()
);

/**
 * A comma separated list of the audio codecs to use, if not provided the server will support all available codecs (listed below).
 * eg: AUDIO_CODECS=opus,PCMU,PCMA
 */
export const AUDIO_CODECS: string | undefined = process.env.AUDIO_CODECS;

/**
 * A comma separated list of the video codecs to use, if not provided the server will support all available codecs (listed below).
 * eg: VIDEO_CODECS=VP8,H264,H264_1_2cb
 */
export const VIDEO_CODECS: string | undefined = process.env.VIDEO_CODECS;

/**
 * Lower bound for the range of ports that the SFU server can use for UDP and TCP communication
 */
export const RTC_MIN_PORT: number =
    (process.env.RTC_MIN_PORT && Number(process.env.RTC_MIN_PORT)) || 40000;

/**
 * Upper bound for the range of ports that the SFU server can use for UDP and TCP communication
 */
export const RTC_MAX_PORT: number =
    (process.env.RTC_MAX_PORT && Number(process.env.RTC_MAX_PORT)) || 49999;
/**
 * The maximum size of the buffer in byes for incoming messages per session
 */
export const MAX_BUF_IN: number = (process.env.MAX_BUF_IN && Number(process.env.MAX_BUF_IN)) || 0;

/**
 * The maximum size of the buffer in byes for outgoing messages per session
 */
export const MAX_BUF_OUT: number =
    (process.env.MAX_BUF_OUT && Number(process.env.MAX_BUF_OUT)) || 0;

/**
 * The maximum incoming bitrate in bps per session,
 * This is what each user can upload.
 */
export const MAX_BITRATE_IN: number =
    (process.env.MAX_BITRATE_IN && Number(process.env.MAX_BITRATE_IN)) || 8_000_000;

/**
 * The maximum outgoing bitrate in bps per session,
 * this is what each user can download.
 */
export const MAX_BITRATE_OUT: number =
    (process.env.MAX_BITRATE_OUT && Number(process.env.MAX_BITRATE_OUT)) || 10_000_000;

/**
 * The maximum bitrate (in bps) for the highest encoding layer (simulcast) per video producer (= per video stream).
 * see: `maxBitrate` @ https://www.w3.org/TR/webrtc/#dictionary-rtcrtpencodingparameters-members
 */
export const MAX_VIDEO_BITRATE: number =
    (process.env.MAX_VIDEO_BITRATE && Number(process.env.MAX_VIDEO_BITRATE)) || 4_000_000;

/**
 * The maximum amount of concurrent users per channel
 */
export const CHANNEL_SIZE: number =
    (process.env.CHANNEL_SIZE && Number(process.env.CHANNEL_SIZE)) || 100;

/**
 * Log level of the mediasoup workers, defaults to "none".
 */
export const WORKER_LOG_LEVEL: WorkerLogLevel =
    (process.env.DEBUG && (process.env.WORKER_LOG_LEVEL as WorkerLogLevel)) || "none";

/**
 * If not set, defaults to "error".
 * If set but not part of the available options, defaults to "error".
 */
export const LOG_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "error";

/**
 * Prefixes yyyy-mm-dd hh:mm:ss,mmm to the logs.
 */
export const LOG_TIMESTAMP: boolean = !FALSY_INPUT.has(process.env.LOG_TIMESTAMP!);
/**
 * Colors the logs according to their level.
 */
export const LOG_COLOR: boolean = process.env.LOG_COLOR
    ? Boolean(process.env.LOG_COLOR)
    : process.stdout.isTTY;

// ---------------------------------------------------------------------
// ------------------   RECORDING ENV VARS   ---------------------------
// ---------------------------------------------------------------------

/**
 * Whether the recording feature is enabled, false by default.
 */
export const RECORDING: boolean = envFlag(process.env.RECORDING);

/**
 * Optional disk reservation per recording in decimal megabytes. When unset or empty,
 * reserve the configured maximum duration and input bitrates instead.
 * This admission budget is not a limit on bytes written.
 */
export const RECORDING_RESERVATION_MB: number | undefined = process.env.RECORDING_RESERVATION_MB
    ? Number(process.env.RECORDING_RESERVATION_MB)
    : undefined;

/**
 * Base path used by local SFU storage directories, defaults to `${tmpDir}`.
 */
export const DATA_PATH: string = process.env.DATA_PATH || tmpDir;
/**
 * Lower bound for the range of ports that the SFU server can use for dynamic ports, used for
 * routing streams to internal processes (recording).
 */
export const DYNAMIC_MIN_PORT: number =
    (process.env.DYNAMIC_MIN_PORT && Number(process.env.DYNAMIC_MIN_PORT)) || 50000;
/**
 * Upper bound for the range of ports that the SFU server can use for dynamic ports
 */
export const DYNAMIC_MAX_PORT: number =
    (process.env.DYNAMIC_MAX_PORT && Number(process.env.DYNAMIC_MAX_PORT)) || 59999;
/**
 * If set, generates `.log` files alongside all ffmpeg file outputs.
 * eg: `recording_1768377901321.mp4` will have an associated `recording_1768377901321.mp4.log`
 */
export const FFMPEG_LOGGING = envFlag(process.env.FFMPEG_LOGGING);

/**
 * Maximum duration of a recording in minutes, defaults to 60. The recording stops when reached.
 * e.g: RECORDING_MAX_DURATION_MIN=240
 */
export const RECORDING_MAX_DURATION_MIN: number = process.env.RECORDING_MAX_DURATION_MIN?.trim()
    ? Number(process.env.RECORDING_MAX_DURATION_MIN)
    : 60;

/**
 * Seconds a recording goes on when fewer than 2 participants are left, defaults to 0 (stops
 * at once). A participant who reconnects within them keeps the recording going
 * (24print-ua/24print-hub#233). e.g: RECORDING_ALONE_GRACE_S=15
 */
export const RECORDING_ALONE_GRACE_S: number = process.env.RECORDING_ALONE_GRACE_S?.trim()
    ? Number(process.env.RECORDING_ALONE_GRACE_S)
    : 0;

/**
 * Whether cameras are recorded, defaults to true. Screen sharing is recorded either way.
 */
export const RECORDING_CAMERAS: boolean = envFlagOr(process.env.RECORDING_CAMERAS, true);

/**
 * Whether the raw video streams are compiled into one video file, defaults to true.
 * When false, the raw screen files remain available for `RECORDING_SCREEN_FRAMES`.
 */
export const RECORDING_COMPILE_VIDEO: boolean = envFlagOr(
    process.env.RECORDING_COMPILE_VIDEO,
    true
);

/**
 * Container of the raw video files. Unset keeps the codec-based container (mp4 for H264).
 * `mkv` stays readable when the writing process is killed.
 * e.g: RECORDING_RAW_VIDEO_CONTAINER=mkv
 */
export const RECORDING_RAW_VIDEO_CONTAINER: "mkv" | undefined =
    (process.env.RECORDING_RAW_VIDEO_CONTAINER?.trim() as "mkv") || undefined;

/**
 * If set, screen sharing is saved as JPEG frames (`frames.zip`) during processing.
 */
export const RECORDING_SCREEN_FRAMES: boolean = envFlag(process.env.RECORDING_SCREEN_FRAMES);

/**
 * The `normalize` option of the ffmpeg `amix` filter used to mix the audio tracks.
 * Unset keeps the ffmpeg default (normalized: volume drops as participants are added).
 * e.g: RECORDING_AUDIO_NORMALIZE=0
 */
export const RECORDING_AUDIO_NORMALIZE: "0" | "1" | undefined =
    (process.env.RECORDING_AUDIO_NORMALIZE?.trim() as "0" | "1") || undefined;

/**
 * If set, every start and stop of a recording is posted to `${recordingAddress}/state`,
 * one call at a time per channel, retried with pauses for at least 30 minutes.
 */
export const RECORDING_STATE_CALLBACK: boolean = envFlag(process.env.RECORDING_STATE_CALLBACK);

/**
 * If set, a delivery that fails on the network, a 5xx or a 429 is retried with pauses
 * (1, 5, 15, 30, 60 minutes, then hourly) until it succeeds or the recording expires
 * (`fileTTL`). Other failures still discard the recording.
 */
export const RECORDING_DELIVERY_RETRY: boolean = envFlag(process.env.RECORDING_DELIVERY_RETRY);

/**
 * If set, a recording is delivered as one `recording.zip` (mix.ogg, transcripts, frames.zip,
 * manifest.json) with its `recording_id` in the requests and in their JWT.
 */
export const RECORDING_ARCHIVE: boolean = envFlag(process.env.RECORDING_ARCHIVE);

/**
 * `/asr` endpoint of a speech recognition service with the Whisper ASR webservice API,
 * e.g. `parakeet-asr` (Parakeet TDT 0.6B v3) behind the 24print asr-gateway. If set, each
 * audio track is transcribed in 5-minute chunks, one request at a time, into
 * `transcript.txt` and `transcript.json` of `recording.zip`. Requires
 * `RECORDING_TRANSCRIBE_API_KEY`; ignored without `RECORDING_ARCHIVE`.
 * e.g: RECORDING_TRANSCRIBE_URL=https://app.24print.ua:9444/asr
 */
export const RECORDING_TRANSCRIBE_URL: string | undefined =
    process.env.RECORDING_TRANSCRIBE_URL?.trim() || undefined;

/**
 * `X-API-Key` of the requests to `RECORDING_TRANSCRIBE_URL`.
 */
export const RECORDING_TRANSCRIBE_API_KEY: string | undefined =
    process.env.RECORDING_TRANSCRIBE_API_KEY?.trim() || undefined;

// ---------------------------------
// ---------- CHECKS ---------------
// ---------------------------------

if (!testingMode) {
    if (!AUTH_KEY) {
        throw new Error(
            "AUTH_KEY env variable is required, it is not possible to authenticate requests without it"
        );
    }
    if (!PUBLIC_IP) {
        throw new Error(
            "PUBLIC_IP env variable is required, clients cannot establish webRTC connections without it"
        );
    }
}
if (RECORDING && !(DYNAMIC_MAX_PORT < RTC_MIN_PORT || DYNAMIC_MIN_PORT > RTC_MAX_PORT)) {
    throw new Error("Dynamic ports overlap with RTC ports");
}
if (
    RECORDING_RESERVATION_MB !== undefined &&
    (RECORDING_RESERVATION_MB <= 0 ||
        !Number.isSafeInteger(Math.ceil(RECORDING_RESERVATION_MB * 1_000_000)))
) {
    throw new Error("RECORDING_RESERVATION_MB must be positive with a safe integer byte size");
}
if (!(RECORDING_MAX_DURATION_MIN > 0 && Number.isFinite(RECORDING_MAX_DURATION_MIN))) {
    throw new Error("RECORDING_MAX_DURATION_MIN must be a positive number of minutes");
}
if (!(RECORDING_ALONE_GRACE_S >= 0 && Number.isFinite(RECORDING_ALONE_GRACE_S))) {
    throw new Error("RECORDING_ALONE_GRACE_S must be a non-negative number of seconds");
}
if (RECORDING_RAW_VIDEO_CONTAINER !== undefined && RECORDING_RAW_VIDEO_CONTAINER !== "mkv") {
    throw new Error("RECORDING_RAW_VIDEO_CONTAINER must be mkv or unset");
}
if (RECORDING_AUDIO_NORMALIZE !== undefined && !["0", "1"].includes(RECORDING_AUDIO_NORMALIZE)) {
    throw new Error("RECORDING_AUDIO_NORMALIZE must be 0, 1 or unset");
}
if (Boolean(RECORDING_TRANSCRIBE_URL) !== Boolean(RECORDING_TRANSCRIBE_API_KEY)) {
    throw new Error("RECORDING_TRANSCRIBE_URL and RECORDING_TRANSCRIBE_API_KEY go together");
}

// ------------------------------------------------------------
// --------------------   SETTINGS   --------------------------
// ------------------------------------------------------------

// timeouts in milliseconds
export const timeouts = Object.freeze({
    // how long a session can take to respond (to a ping or to a connection attempt)
    session: 10_000,
    // how long the websocket service waits for the authentication of a new websocket
    authentication: 10_000,
    // how long to wait between each time we ping the client to keep the session alive
    ping: 60_000,
    // how long to wait before we try to recover a session (consuming or producing media) after an error
    recovery: 2_000,
    // how long before a channel is closed after the last session leaves
    channel: 60 /* min */ * 60_000,
    // how long to wait to gather messages before sending through the bus
    busBatch: testingMode ? 10 : 300
});

/**
 * Internal SFU directorie.
 */
export const dir = Object.freeze({
    root: DATA_PATH,
    recordings: path.join(DATA_PATH, "recordings"),
    resources: path.join(DATA_PATH, "resources"),
    debug: path.join(DATA_PATH, "debug")
});

export const recording = {
    routingInterface: "127.0.0.1",
    directory: dir.recordings,
    enabled: RECORDING,
    metadataFileName: "metadata.bin",
    minDuration: 5 /* sec */ * 1000, // TODO should probably be raised in prod
    maxDuration: RECORDING_MAX_DURATION_MIN * 60 * 1000,
    aloneGrace: RECORDING_ALONE_GRACE_S * 1000,
    fileTTL: 24 /* hours */ * 60 * 60 * 1000,
    processingCooldown: 5 /* sec */ * 1000,
    video: {
        frameRate: "30",
        codec: "libsvtav1",
        preset: "8",
        ext: "mp4",
        mimeType: "video/mp4"
    },
    audio: {
        codec: "libopus",
        bitRate: "32k",
        ext: "ogg",
        mimeType: "audio/ogg"
    },
    /** screen frames, see `RECORDING_SCREEN_FRAMES` */
    frames: {
        // one frame per second, consecutive duplicates dropped
        filter: "fps=1,mpdecimate,scale=w='min(1280,iw)':h=-2",
        quality: "5",
        limit: 3600,
        archive: "frames.zip"
    },
    /** single delivery archive, see `RECORDING_ARCHIVE` */
    archive: {
        name: "recording.zip",
        mimeType: "application/zip"
    },
    /** per-track transcription, see `RECORDING_TRANSCRIBE_URL` */
    transcription: {
        /** transcripts only travel in `recording.zip` */
        enabled: Boolean(RECORDING_TRANSCRIBE_URL) && RECORDING_ARCHIVE,
        url: RECORDING_TRANSCRIBE_URL,
        apiKey: RECORDING_TRANSCRIBE_API_KEY,
        /** a failed request loses at most 5 minutes of recognized speech */
        chunkDuration: 5 /* min */ * 60_000,
        /**
         * Parakeet recognizes a 5-minute chunk in 18-23 s on the server, 40 s at most
         * (24print-ua/24print-hub#267): three times that plus one request ahead (the
         * service takes one at a time), with room, under the gateway's 600 s read timeout
         */
        requestTimeout: 5 /* min */ * 60_000,
        /** pauses after the 1st to 4th failed request; then `retryInterval` */
        retryDelays: [1, 5, 15, 30].map((minutes) => minutes * 60_000),
        retryInterval: 60 /* min */ * 60_000,
        /** after the recording stops; the rest of `fileTTL` is left to the delivery */
        deadline: 18 /* hours */ * 60 * 60_000,
        /** `silencedetect`: a chunk under this level throughout is not sent */
        silenceNoise: "-45dB",
        silenceMinDuration: "2",
        /** chunk encoding sent to the service */
        chunkArgs: ["-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "32k"]
    },
    /*
     * Limits the amount of video streams recorded at once.
     * Screen sharing has precedence over cameras and keeps only
     * the most recent streams up to the configured limits.
     *
     * if screenLimit is increased,
     * the mediaCompiler must implement a compatible layout (see _compileSegment)
     */
    cameraLimit: 4,
    screenLimit: 1
} as const;

// how many errors can occur before the session is closed, recovery attempts will be made until this limit is reached
export const maxSessionErrors: number = 6;

/**
 * Base producer options type
 */
const baseProducerOptions: ProducerOptions = {
    stopTracks: false,
    disableTrackOnPause: false,
    zeroRtpOnPause: true
};

export const rtc = Object.freeze({
    // https://mediasoup.org/documentation/v3/mediasoup/api/#WorkerSettings
    workerSettings: {
        disableLiburing: true,
        logLevel: WORKER_LOG_LEVEL,
        rtcMinPort: RTC_MIN_PORT,
        rtcMaxPort: RTC_MAX_PORT
    },
    // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcServer-dictionaries
    rtcServerOptions: {
        listenInfos: [
            {
                protocol: "udp" as const,
                ip: RTC_INTERFACE,
                announcedAddress: PUBLIC_IP,
                portRange: {
                    min: RTC_MIN_PORT,
                    max: RTC_MAX_PORT
                }
            },
            {
                protocol: "tcp" as const,
                ip: RTC_INTERFACE,
                announcedAddress: PUBLIC_IP,
                portRange: {
                    min: RTC_MIN_PORT,
                    max: RTC_MAX_PORT
                }
            }
        ]
    },
    // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
    rtcTransportOptions: {
        maxSctpMessageSize: MAX_BUF_IN,
        sctpSendBufferSize: MAX_BUF_OUT
    },
    plainTransportOptions: {
        listenIp: { ip: "0.0.0.0", announcedIp: PUBLIC_IP },
        rtcpMux: true,
        comedia: false
    },
    producerOptionsByKind: {
        /** Audio producer options */
        audio: baseProducerOptions,
        /** Video producer options */
        video: {
            ...baseProducerOptions,
            // for browsers using libwebrtc, values are set to allow simulcast layers to be made in that range
            codecOptions: {
                videoGoogleMinBitrate: 1_000,
                videoGoogleStartBitrate: 1_000_000,
                videoGoogleMaxBitrate: MAX_VIDEO_BITRATE * 2
            },
            encodings: [
                {
                    scaleResolutionDownBy: 4,
                    maxBitrate: Math.floor(MAX_VIDEO_BITRATE / 4)
                },
                {
                    scaleResolutionDownBy: 2,
                    maxBitrate: Math.floor(MAX_VIDEO_BITRATE / 2)
                },
                { scaleResolutionDownBy: 1, maxBitrate: MAX_VIDEO_BITRATE }
            ]
        }
    }
});

// ------------------------------------------------------------
// ---------------------   CODECS   ---------------------------
// ------------------------------------------------------------

// These are the codecs that CAN be used.
// The codecs that WILL be used are based on the appropriate env variables

/**
 * in RFC 7874, WebRTC specification mandates support of the Opus, PCMA and PCMU audio codecs on all WebRTC compatible browsers,
 * and recommend the same for any WebRTC endpoint.
 * https://datatracker.ietf.org/doc/html/rfc7874#section-3
 */
export const audioCodecs: Record<string, RouterRtpCodecCapability> = Object.freeze({
    opus: {
        // https://datatracker.ietf.org/doc/html/rfc7587
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2
    },
    PCMU: {
        // https://datatracker.ietf.org/doc/html/rfc7655
        kind: "audio",
        mimeType: "audio/PCMU", // g711 mu-law
        clockRate: 8000,
        preferredPayloadType: 0,
        channels: 1
    },
    PCMA: {
        // https://datatracker.ietf.org/doc/html/rfc7655
        kind: "audio",
        mimeType: "audio/PCMA", // g711 a-law
        clockRate: 8000,
        preferredPayloadType: 8,
        channels: 1
    }
});

/**
 * in RFC 7742, WebRTC specification mandates support of the VP8 and H.264 video codecs on all WebRTC compatible browsers.
 * and recommend the same for any WebRTC endpoint.
 * https://datatracker.ietf.org/doc/html/rfc7742#section-5
 */
export const videoCodecs: Record<string, RouterRtpCodecCapability> = Object.freeze({
    VP8: {
        // https://datatracker.ietf.org/doc/html/rfc7741
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000
    },
    VP9: {
        // https://datatracker.ietf.org/doc/html/draft-ietf-payload-vp9-16
        kind: "video",
        mimeType: "video/VP9",
        clockRate: 90000,
        parameters: {
            "profile-id": 2 // mediasoup doc indicates that only id 0 and 2 are supported
        }
    },
    H264: {
        kind: "video",
        mimeType: "video/H264",
        clockRate: 90000,
        parameters: {
            "level-asymmetry-allowed": 1,
            "packetization-mode": 1,
            "profile-level-id": "640028" // level 4.0 & high, supports 1920x1080 @ 30fps
        }
    },
    H264_1_2cb: {
        kind: "video",
        mimeType: "video/H264",
        clockRate: 90000,
        parameters: {
            "level-asymmetry-allowed": 1,
            "packetization-mode": 1,
            "profile-level-id": "42e00c" // level 1.2 & constrained baseline, as "mandated" by RFC 7742 section 6.2
        }
    },
    H264_1_3ch: {
        // https://datatracker.ietf.org/doc/html/rfc6184
        kind: "video",
        mimeType: "video/H264",
        clockRate: 90000,
        parameters: {
            "level-asymmetry-allowed": 1,
            "packetization-mode": 1,
            "profile-level-id": "640c0d" // level 1.3 & constrained high, as "recommended" by RFC 7742 section 6.2
        }
    }
});
