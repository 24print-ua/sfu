import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

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

/**
 * Describes the deliverables of a recording, written as `manifest.json` in its folder.
 * Each processing step owns one top-level key.
 */
export type Manifest = {
    frames?: FramesManifest;
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
