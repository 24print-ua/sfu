import fs from "node:fs/promises";
import path from "node:path";

import * as config from "#src/config.ts";
import { decrypt } from "#src/core/services/auth.ts";
import { COMPILATION_TIMEOUT, MediaCompiler } from "#src/recording/models/media_compiler.ts";
import {
    MANIFEST_FILENAME,
    readManifest,
    updateManifest,
    type Manifest,
    type TrackManifest
} from "#src/recording/models/manifest.ts";
import { compileScreenFrames } from "#src/recording/models/screen_frames.ts";
import { TIME_TAG, type SealedMetaData } from "#src/recording/models/recorder.ts";
import { MediaUploader, isRetryable } from "#src/recording/models/media_uploader.ts";
import { writeZip, type ZipEntry } from "#src/recording/models/zip.ts";
import { STREAM_TYPE } from "#src/shared/enums.ts";
import { Logger } from "#src/utils/utils.ts";

const logger = new Logger("RECORDING_PROCESSOR");
const MINUTE = 60_000;
/** pauses after the 1st to 5th failed delivery; then `DELIVERY_RETRY_INTERVAL` */
export const DELIVERY_RETRY_DELAYS = [1, 5, 15, 30, 60].map((minutes) => minutes * MINUTE);
const DELIVERY_RETRY_INTERVAL = 60 * MINUTE;
/** retries of a recording, kept in its folder across restarts, see `RECORDING_DELIVERY_RETRY` */
export const DELIVERY_STATE_FILENAME = "delivery.json";
/**
 * Transcripts written in the recording folder by the transcription step (24print-hub#232),
 * added to the archive when present.
 */
export const TRANSCRIPT_FILES = ["transcript.txt", "transcript.json"];

type DeliveryState = {
    /** failed attempts so far */
    attempts: number;
    /** epoch ms before which the recording is not processed again */
    nextAttemptAt: number;
    /** set once the delivery succeeded, so a cleanup failure cannot replay it */
    delivered?: boolean;
    error?: string;
};

async function exists(file: string) {
    try {
        await fs.access(file);
        return true;
    } catch {
        return false;
    }
}

export class RecordingProcessor {
    private readonly _uploader: MediaUploader;
    private readonly _finalizeRecordingFolder: (
        recordingDirectory: string,
        folderName: string
    ) => Promise<void>;

    constructor({
        uploader,
        finalizeRecordingFolder
    }: {
        uploader: MediaUploader;
        finalizeRecordingFolder: (recordingDirectory: string, folderName: string) => Promise<void>;
    }) {
        this._uploader = uploader;
        this._finalizeRecordingFolder = finalizeRecordingFolder;
    }

    /**
     * Process a queued recording and discard its files on failure.
     * With `RECORDING_DELIVERY_RETRY`, a retryable delivery failure keeps the recording
     * queued until its next attempt instead.
     *
     * @returns `true` if the directory was removed or archived, `false` if processing
     * is deferred by CPU load, by a pending retry, or directory cleanup failed.
     */
    async process(folderName: string, processMedia = true): Promise<boolean> {
        const recordingDirectory = path.join(config.dir.recordings, folderName);
        const metadataPath = path.join(recordingDirectory, config.recording.metadataFileName);
        const processingPath = `${metadataPath}.processing`;
        try {
            const metadata = await this._readQueuedMetadata(recordingDirectory, metadataPath);
            logger.debug(`Read metadata for recording ${folderName}: ${metadata.channelName}`);
            if (!processMedia) {
                return false;
            }
            const retry = config.RECORDING_DELIVERY_RETRY
                ? await this._readDeliveryState(recordingDirectory)
                : undefined;
            if (retry && retry.nextAttemptAt > Date.now()) {
                return false;
            }
            // Consume the queued metadata so cleanup failure or restart cannot replay delivery.
            await fs.rename(metadataPath, processingPath);
            let delivered: boolean;
            try {
                delivered = await this._deliver(recordingDirectory, folderName, metadata);
            } catch (error) {
                if (!retry || !isRetryable(error)) {
                    throw error;
                }
                const attempts = retry.attempts + 1;
                const nextAttemptAt =
                    Date.now() + (DELIVERY_RETRY_DELAYS[attempts - 1] ?? DELIVERY_RETRY_INTERVAL);
                await this._writeDeliveryState(recordingDirectory, {
                    attempts,
                    nextAttemptAt,
                    error: String(error)
                });
                await fs.rename(processingPath, metadataPath);
                logger.warn(
                    `Delivery ${attempts} of ${folderName} failed, retrying at ${new Date(
                        nextAttemptAt
                    ).toISOString()}: ${error}`
                );
                return false;
            }
            try {
                await this._finalizeRecordingFolder(recordingDirectory, folderName);
            } catch (error) {
                if (retry) {
                    // the folder stays: mark it so it is not taken for an interrupted attempt
                    await this._writeDeliveryState(recordingDirectory, {
                        ...retry,
                        delivered: true
                    }).catch(() => undefined);
                }
                throw error;
            }
            if (delivered) {
                logger.info(`recording ${folderName} was successfully finalized`);
            } else {
                logger.warn(
                    `recording ${folderName} finalized without delivering media or transcription`
                );
            }
            return true;
        } catch (error) {
            logger.error(`Discarding recording ${folderName}: ${error}`);
            try {
                await fs.rm(recordingDirectory, { recursive: true, force: true });
                return true;
            } catch (cleanupError) {
                logger.error(`Failed to discard recording ${folderName}: ${cleanupError}`);
                return false;
            }
        }
    }

    /**
     * Compiles and delivers the recording.
     *
     * @returns whether media or a transcription was delivered
     */
    private async _deliver(
        recordingDirectory: string,
        folderName: string,
        metadata: SealedMetaData
    ): Promise<boolean> {
        const compiler = new MediaCompiler({
            workingDir: recordingDirectory,
            startedAt: metadata.startedAt,
            stoppedAt: metadata.stoppedAt,
            timeStamps: metadata.timeStamps
        });
        if (config.RECORDING_ARCHIVE) {
            return this._deliverArchive(recordingDirectory, folderName, metadata, compiler);
        }
        const audioPath =
            metadata.audio || metadata.transcription ? await compiler.getAudio() : undefined;
        if (metadata.transcription && audioPath) {
            await this._uploader.transcribe({ filePath: audioPath, metadata });
        }
        if (metadata.video && config.RECORDING_SCREEN_FRAMES) {
            await this._compileScreenFrames(recordingDirectory, metadata);
        }
        const videoPath =
            metadata.video && config.RECORDING_COMPILE_VIDEO
                ? await compiler.getVideo()
                : undefined;
        const mediaPath = videoPath ?? (metadata.audio ? audioPath : undefined);
        if (mediaPath) {
            await this._uploader.uploadMedia({
                filePath: mediaPath,
                metadata,
                mimetype: videoPath
                    ? config.recording.video.mimeType
                    : config.recording.audio.mimeType
            });
        }
        return Boolean(mediaPath || (metadata.transcription && audioPath));
    }

    /**
     * Delivers what was recorded as one archive (R16 of D005): a track, the mix or the
     * video that cannot be compiled is reported in `manifest.json` and the rest still goes.
     *
     * @returns whether an archive was delivered
     */
    private async _deliverArchive(
        recordingDirectory: string,
        folderName: string,
        metadata: SealedMetaData,
        compiler: MediaCompiler
    ): Promise<boolean> {
        const entries: ZipEntry[] = [];
        if (metadata.audio) {
            entries.push(
                ...(await this._compileOrReport(recordingDirectory, "mix", () =>
                    compiler.getAudio()
                ))
            );
            await updateManifest(recordingDirectory, {
                tracks: this._audioTracks(recordingDirectory, metadata, compiler)
            });
        }
        if (metadata.video && config.RECORDING_SCREEN_FRAMES) {
            await this._compileScreenFrames(recordingDirectory, metadata);
        }
        if (metadata.video && config.RECORDING_COMPILE_VIDEO) {
            entries.push(
                ...(await this._compileOrReport(recordingDirectory, "video", () =>
                    compiler.getVideo()
                ))
            );
        }
        for (const name of TRANSCRIPT_FILES) {
            const file = path.join(recordingDirectory, name);
            if (await exists(file)) {
                entries.push({ name, path: file });
            }
        }
        const manifest = await readManifest(recordingDirectory);
        if (manifest.frames?.file) {
            entries.push({
                name: config.recording.frames.archive,
                path: path.join(recordingDirectory, manifest.frames.file)
            });
        }
        if (entries.length === 0) {
            return false;
        }
        entries.push({
            name: MANIFEST_FILENAME,
            path: path.join(recordingDirectory, MANIFEST_FILENAME)
        });
        const archivePath = path.join(recordingDirectory, config.recording.archive.name);
        await writeZip(archivePath, entries);
        await this._uploader.uploadMedia({
            filePath: archivePath,
            metadata,
            mimetype: config.recording.archive.mimeType,
            recordingId: folderName
        });
        return true;
    }

    /**
     * Compiles the mix (`mix.ogg`) or the video (`video.<ext>`) and notes it in the manifest.
     *
     * @returns its archive entry, none when there is nothing to compile or it failed
     */
    private async _compileOrReport(
        recordingDirectory: string,
        key: "mix" | "video",
        compile: () => Promise<string | undefined>
    ): Promise<ZipEntry[]> {
        let entries: ZipEntry[] = [];
        let note: Manifest["mix"];
        try {
            const file = await compile();
            if (file) {
                const name = key === "mix" ? "mix.ogg" : `video${path.extname(file)}`;
                entries = [{ name, path: file }];
                note = { file: name };
            }
        } catch (error) {
            logger.error(`Failed to compile the ${key} of ${recordingDirectory}: ${error}`);
            note = { error: String(error) };
        }
        await updateManifest(recordingDirectory, { [key]: note });
        return entries;
    }

    /**
     * The audio tracks of the participants, with the unreadable ones marked.
     */
    private _audioTracks(
        recordingDirectory: string,
        metadata: SealedMetaData,
        compiler: MediaCompiler
    ): TrackManifest[] {
        const tracks = new Map<string, TrackManifest>();
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
            const file = path.join(STREAM_TYPE.AUDIO, info.filename);
            const unreadable = compiler.unreadableFiles.has(path.join(recordingDirectory, file));
            tracks.set(info.filename, {
                file,
                session_id: info.sessionId,
                ...(unreadable ? { error: "unreadable" } : {})
            });
        }
        return [...tracks.values()];
    }

    /**
     * Reads `metadata.bin`. With `RECORDING_DELIVERY_RETRY`, a process stopped during a
     * delivery attempt left `metadata.bin.processing` instead: it is put back so the
     * recording is delivered again.
     */
    private async _readQueuedMetadata(
        recordingDirectory: string,
        metadataPath: string
    ): Promise<SealedMetaData> {
        try {
            return await this._readMetadata(metadataPath);
        } catch (error) {
            if (
                !config.RECORDING_DELIVERY_RETRY ||
                (error as NodeJS.ErrnoException).code !== "ENOENT" ||
                (await this._readDeliveryState(recordingDirectory)).delivered
            ) {
                throw error;
            }
            await fs.rename(`${metadataPath}.processing`, metadataPath);
            logger.warn(`Resuming the interrupted delivery of ${recordingDirectory}`);
            return this._readMetadata(metadataPath);
        }
    }

    private async _readDeliveryState(recordingDirectory: string): Promise<DeliveryState> {
        try {
            return JSON.parse(
                await fs.readFile(path.join(recordingDirectory, DELIVERY_STATE_FILENAME), "utf-8")
            ) as DeliveryState;
        } catch {
            return { attempts: 0, nextAttemptAt: 0 };
        }
    }

    private async _writeDeliveryState(recordingDirectory: string, state: DeliveryState) {
        await fs.writeFile(
            path.join(recordingDirectory, DELIVERY_STATE_FILENAME),
            JSON.stringify(state)
        );
    }

    /**
     * A frame failure is recorded in the manifest and does not discard the other media.
     */
    private async _compileScreenFrames(workingDir: string, metadata: SealedMetaData) {
        if ((await readManifest(workingDir)).frames) {
            return; // extracted by an earlier delivery attempt
        }
        try {
            await compileScreenFrames({
                workingDir,
                startedAt: metadata.startedAt,
                stoppedAt: metadata.stoppedAt,
                timeStamps: metadata.timeStamps,
                signal: AbortSignal.timeout(COMPILATION_TIMEOUT)
            });
        } catch (error) {
            logger.error(`Failed to save screen frames of ${workingDir}: ${error}`);
            const { limit } = config.recording.frames;
            await updateManifest(workingDir, {
                frames: {
                    count: 0,
                    extracted: 0,
                    limit,
                    thinned: false,
                    error: String(error)
                }
            });
        }
    }

    private async _readMetadata(metadataPath: string): Promise<SealedMetaData> {
        const content = await fs.readFile(metadataPath, "utf-8");
        const metadata = JSON.parse(decrypt(content)) as SealedMetaData;
        const expirationDate = metadata.stoppedAt + config.recording.fileTTL;
        if (expirationDate < Date.now()) {
            throw new Error("Expired recording");
        }
        return metadata;
    }
}
