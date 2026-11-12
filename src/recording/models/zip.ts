import { createReadStream, createWriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";

export type ZipEntry = {
    /** path inside the archive */
    name: string;
    /** file on disk */
    path: string;
};

const ZIP32_LIMIT = 0xffffffff;
const UTF8_NAMES = 0x0800;
const VERSION = 20;

function dosDateTime(date: Date) {
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
        date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
}

async function* zipChunks(entries: ZipEntry[]): AsyncGenerator<Buffer> {
    const { time, date } = dosDateTime(new Date());
    const centralDirectory: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name, "utf8");
        let crc = 0;
        let size = 0;
        for await (const chunk of createReadStream(entry.path)) {
            crc = crc32(chunk, crc);
            size += chunk.length;
        }
        if (size > ZIP32_LIMIT || offset > ZIP32_LIMIT) {
            throw new Error(`ZIP archive exceeds 4 GiB at ${entry.name}`);
        }
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(VERSION, 4);
        local.writeUInt16LE(UTF8_NAMES, 6);
        local.writeUInt16LE(0, 8); // stored
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(size, 18);
        local.writeUInt32LE(size, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(VERSION, 4);
        central.writeUInt16LE(VERSION, 6);
        local.copy(central, 8, 6, 28); // flags to name length
        central.writeUInt32LE(offset, 42);
        centralDirectory.push(central, name);
        yield local;
        yield name;
        let written = 0;
        for await (const chunk of createReadStream(entry.path)) {
            written += chunk.length;
            yield chunk;
        }
        if (written !== size) {
            throw new Error(`${entry.path} changed while being archived`);
        }
        offset += local.length + name.length + size;
    }
    const directory = Buffer.concat(centralDirectory);
    if (offset > ZIP32_LIMIT || directory.length > ZIP32_LIMIT) {
        throw new Error("ZIP archive exceeds 4 GiB");
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    yield directory;
    yield end;
}

/**
 * Writes an uncompressed ZIP archive (media files do not compress further),
 * streaming each file so large entries are not held in memory.
 * The archive appears at `outputPath` only once complete.
 *
 * @throws {Error} If there are more than 65535 entries or the archive exceeds 4 GiB (no ZIP64).
 */
export async function writeZip(outputPath: string, entries: ZipEntry[]): Promise<void> {
    if (entries.length > 0xffff) {
        throw new Error(`ZIP archive cannot hold ${entries.length} entries`);
    }
    const partialPath = `${outputPath}.partial`;
    try {
        await pipeline(zipChunks(entries), createWriteStream(partialPath));
        await rename(partialPath, outputPath);
    } catch (error) {
        await unlink(partialPath).catch(() => undefined);
        throw error;
    }
}
