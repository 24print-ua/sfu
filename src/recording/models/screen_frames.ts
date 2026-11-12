import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

import * as config from "#src/config.ts";
import {
    INPUT_RECOVERY_OPTIONS,
    spawnFfmpeg,
    validateMediaFile
} from "#src/recording/models/media_compiler.ts";
import { updateManifest, type FramesManifest } from "#src/recording/models/manifest.ts";
import { writeZip } from "#src/recording/models/zip.ts";
import { TIME_TAG, type TimeStampData } from "#src/recording/models/recorder.ts";
import { STREAM_TYPE } from "#src/shared/enums.ts";
import { Logger } from "#src/utils/utils.ts";

const logger = new Logger("SCREEN_FRAMES");
const TEMP_DIRECTORY = "frames_tmp";

/**
 * Keeps `limit` items spread evenly over `items`, including the first one.
 */
export function thinEvenly<T>(items: T[], limit: number): T[] {
    if (items.length <= limit) {
        return items;
    }
    return Array.from({ length: limit }, (_, i) => items[Math.floor((i * items.length) / limit)]);
}

/**
 * Saves the screen sharing of a recording as JPEG frames in `frames.zip`:
 * one frame per second, consecutive duplicates dropped, named by their offset from
 * the start of the recording in milliseconds, evenly thinned to the frame limit.
 * The result is recorded under `frames` in `manifest.json`.
 *
 * @returns The manifest entry, or undefined when the recording has no screen sharing.
 */
export async function compileScreenFrames({
    workingDir,
    startedAt,
    stoppedAt,
    timeStamps,
    signal
}: {
    workingDir: string;
    startedAt: number;
    stoppedAt: number;
    timeStamps: TimeStampData[];
    signal: AbortSignal;
}): Promise<FramesManifest | undefined> {
    const screenFiles = new Map<string, number>();
    for (const { tag, info, timestamp } of timeStamps) {
        if (
            tag === TIME_TAG.FILE_STATE_CHANGE &&
            info?.type === STREAM_TYPE.SCREEN &&
            info.active &&
            timestamp < stoppedAt &&
            !screenFiles.has(info.filename)
        ) {
            screenFiles.set(info.filename, timestamp);
        }
    }
    if (screenFiles.size === 0) {
        return;
    }
    const { filter, quality, limit, archive } = config.recording.frames;
    const tempDir = path.join(workingDir, TEMP_DIRECTORY);
    await rm(tempDir, { recursive: true, force: true });
    try {
        const frames: { offset: number; path: string }[] = [];
        let index = 0;
        for (const [filename, fileStartTime] of screenFiles) {
            const input = path.join(workingDir, STREAM_TYPE.SCREEN, filename);
            if (!(await validateMediaFile(input, "v:0", signal))) {
                logger.warn(`Skipping corrupted screen file: ${input}`);
                continue;
            }
            const outputDir = path.join(tempDir, String(index++));
            await mkdir(outputDir, { recursive: true });
            await spawnFfmpeg(
                [
                    ...INPUT_RECOVERY_OPTIONS,
                    "-i",
                    input,
                    "-map",
                    "0:v:0",
                    "-vf",
                    filter,
                    "-fps_mode",
                    "vfr",
                    "-q:v",
                    quality,
                    // name each frame by its timestamp in milliseconds
                    "-enc_time_base",
                    "1:1000",
                    "-frame_pts",
                    "1",
                    path.join(outputDir, "%d.jpg")
                ],
                path.join(workingDir, `frames_${filename}.log`),
                signal
            );
            for (const name of await readdir(outputDir)) {
                const offset = fileStartTime - startedAt + Number.parseInt(name, 10);
                if (offset <= stoppedAt - startedAt) {
                    frames.push({ offset, path: path.join(outputDir, name) });
                }
            }
        }
        frames.sort((a, b) => a.offset - b.offset);
        const kept = thinEvenly(frames, limit);
        const names = new Set<number>();
        const entries = kept.map((frame) => {
            let offset = frame.offset;
            while (names.has(offset)) {
                offset++; // two screen files at the same millisecond
            }
            names.add(offset);
            return { name: `${offset}.jpg`, path: frame.path };
        });
        if (entries.length > 0) {
            await writeZip(path.join(workingDir, archive), entries);
        }
        const summary: FramesManifest = {
            ...(entries.length > 0 ? { file: archive } : {}),
            count: entries.length,
            extracted: frames.length,
            limit,
            thinned: kept.length < frames.length
        };
        await updateManifest(workingDir, { frames: summary });
        return summary;
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}
