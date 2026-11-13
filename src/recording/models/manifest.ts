import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SessionId } from "#src/core/models/session.ts";

export const MANIFEST_FILENAME = "manifest.json";

export type FramesManifest = {
    /** archive name inside the recording folder, absent when no frame was kept */
    file?: string;
    /** frames in the archive */
    count: number;
    /** frames extracted before thinning */
    extracted: number;
    /** maximum frames per recording */
    limit: number;
    /** whether frames were evenly dropped to stay within `limit` */
    thinned: boolean;
    /** why frames could not be produced */
    error?: string;
};

export type TrackManifest = {
    /** raw file, relative to the recording folder */
    file: string;
    session_id: SessionId;
    /** why the track is missing from the mix */
    error?: string;
};

export type TranscriptionTrackManifest = {
    /** raw file, relative to the recording folder */
    file: string;
    session_id: SessionId;
    user_id?: number;
    label?: string;
    /** 5-minute chunks of the track */
    chunks: number;
    /** chunks recognized, their phrases are in the transcripts */
    recognized: number;
    /** chunks without sound, not sent */
    silent: number;
    /** why the track, or some of its chunks, is missing from the transcripts (R16 of D005) */
    error?: string;
    /** short phrases without a Cyrillic letter, left out of the transcripts (R12 of D005) */
    dropped?: { start_ms: number; text: string }[];
};

/**
 * Describes the deliverables of a recording, written as `manifest.json` in its folder.
 * Each processing step owns one top-level key.
 */
export type Manifest = {
    /** per-track transcription (R10-R12, R16 of D005) */
    transcription?: { tracks: TranscriptionTrackManifest[]; error?: string };
    frames?: FramesManifest;
    /** audio tracks of the participants (R16 of D005) */
    tracks?: TrackManifest[];
    /** the mixed audio, `error` when it could not be compiled */
    mix?: { file?: string; error?: string };
    /** the compiled video, `error` when it could not be compiled */
    video?: { file?: string; error?: string };
};

export async function readManifest(directory: string): Promise<Manifest> {
    try {
        return JSON.parse(await readFile(path.join(directory, MANIFEST_FILENAME), "utf-8"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return {};
        }
        throw error;
    }
}

/**
 * Merges `patch` into the top-level keys of the manifest and writes it atomically.
 */
export async function updateManifest(directory: string, patch: Manifest): Promise<Manifest> {
    const manifest = { ...(await readManifest(directory)), ...patch };
    const manifestPath = path.join(directory, MANIFEST_FILENAME);
    await writeFile(`${manifestPath}.partial`, JSON.stringify(manifest, null, 2));
    await rename(`${manifestPath}.partial`, manifestPath);
    return manifest;
}
