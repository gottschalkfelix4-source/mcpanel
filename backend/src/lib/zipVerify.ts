import fs from 'node:fs/promises';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { crc32, inflateRaw, inflateRawSync } from 'node:zlib';
import type { Entry, ZipFile } from 'yauzl';

/**
 * Liest jede Datei eines ZIPs einmal und hält sie gegen ihre CRC-Prüfsumme.
 *
 * Backups bestehen fast nur aus abgelegten (nicht gepackten) Regionsdateien.
 * Die werden hier direkt und in großen Blöcken aus der Datei gelesen, mehrere
 * Einträge gleichzeitig – über den Entpacker-Strom je Eintrag dauerte das
 * Prüfen länger als das Schreiben des Archivs. Geprüft wird dasselbe wie
 * vorher: Kopf, Länge und Prüfsumme jedes Eintrags.
 */

const PARALLEL = 4;
const BLOCK = 4 * 1024 * 1024;
/** Bis hierhin wird ein gepackter Eintrag am Stück entpackt, darüber als Strom. */
const AM_STUECK_MAX = 16 * 1024 * 1024;

/** Kleine Einträge: Kopf und Daten mit einem einzigen Lesezugriff holen. */
const KLEIN_MAX = 256 * 1024;
/** So kleine gepackte Einträge entpackt der Hauptfaden schneller, als ein Wechsel in den Threadpool dauert. */
const SYNCHRON_MAX = 32 * 1024;

const inflateRawAsync = promisify(inflateRaw) as (data: Buffer, options: { maxOutputLength: number }) => Promise<Buffer>;

async function readExact(fh: fs.FileHandle, buffer: Buffer, length: number, position: number, name: string): Promise<void> {
  let off = 0;
  while (off < length) {
    const { bytesRead } = await fh.read(buffer, off, length - off, position + off);
    if (bytesRead === 0) throw new Error(`Archiv ist abgeschnitten: ${name}`);
    off += bytesRead;
  }
}

/** Beginn der Nutzdaten: hinter dem lokalen Kopf samt Name und Zusatzfeld. */
async function dataStart(fh: fs.FileHandle, entry: Entry): Promise<number> {
  const head = Buffer.allocUnsafe(30);
  await readExact(fh, head, 30, entry.relativeOffsetOfLocalHeader, entry.fileName);
  if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`Ungültiger Dateikopf: ${entry.fileName}`);
  return entry.relativeOffsetOfLocalHeader + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
}

export async function verifyZipEntries(
  archive: string,
  zip: ZipFile,
  entries: Entry[],
  onRead?: (bytes: number) => void,
): Promise<void> {
  const fh = await fs.open(archive, 'r');
  let next = 0;
  let failed = false;

  /** Kartenkacheln & Co.: Hunderttausende winziger Dateien – jeder gesparte Zugriff zählt. */
  const verifySmall = async (entry: Entry, block: Buffer): Promise<boolean> => {
    // Das Zusatzfeld im lokalen Kopf kann anders lang sein als im Verzeichnis – großzügig mitlesen.
    const want = 30 + entry.fileNameLength + 64 + entry.compressedSize;
    const { bytesRead } = await fh.read(block, 0, want, entry.relativeOffsetOfLocalHeader);
    if (bytesRead < 30) throw new Error(`Archiv ist abgeschnitten: ${entry.fileName}`);
    if (block.readUInt32LE(0) !== 0x04034b50) throw new Error(`Ungültiger Dateikopf: ${entry.fileName}`);
    const start = 30 + block.readUInt16LE(26) + block.readUInt16LE(28);
    if (start + entry.compressedSize > bytesRead) return false; // ungewöhnlich langer Kopf: normaler Weg
    const data = block.subarray(start, start + entry.compressedSize);
    let raw = data;
    if (entry.compressionMethod === 8) {
      const limit = { maxOutputLength: Math.max(1, entry.uncompressedSize) };
      raw = data.length <= SYNCHRON_MAX && entry.uncompressedSize <= 4 * SYNCHRON_MAX ? inflateRawSync(data, limit) : await inflateRawAsync(data, limit);
    }
    if (raw.length !== entry.uncompressedSize) throw new Error(`Länge stimmt nicht: ${entry.fileName}`);
    if ((crc32(raw) >>> 0) !== (entry.crc32 >>> 0)) throw new Error(`Prüfsumme stimmt nicht: ${entry.fileName}`);
    onRead?.(raw.length);
    return true;
  };

  const verify = async (entry: Entry, block: Buffer): Promise<void> => {
    let crc = 0;
    const method = entry.compressionMethod;
    if ((method === 0 || method === 8) && entry.compressedSize <= KLEIN_MAX && entry.uncompressedSize <= AM_STUECK_MAX
      && await verifySmall(entry, block)) return;
    if (entry.compressionMethod === 0) {
      if (entry.compressedSize !== entry.uncompressedSize) throw new Error(`Größenangaben widersprechen sich: ${entry.fileName}`);
      let position = await dataStart(fh, entry);
      let left = entry.compressedSize;
      while (left > 0) {
        if (failed) return;
        const length = Math.min(left, BLOCK);
        await readExact(fh, block, length, position, entry.fileName);
        crc = crc32(block.subarray(0, length), crc);
        position += length;
        left -= length;
        onRead?.(length);
      }
    } else if (entry.compressionMethod === 8 && entry.compressedSize <= AM_STUECK_MAX && entry.uncompressedSize <= AM_STUECK_MAX) {
      const packed = Buffer.allocUnsafe(entry.compressedSize);
      await readExact(fh, packed, packed.length, await dataStart(fh, entry), entry.fileName);
      // Mehr als angekündigt darf nicht herauskommen (Schutz vor ZIP-Bomben).
      const raw = await inflateRawAsync(packed, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
      if (raw.length !== entry.uncompressedSize) throw new Error(`Länge stimmt nicht: ${entry.fileName}`);
      crc = crc32(raw);
      onRead?.(raw.length);
    } else {
      // Große gepackte Einträge und seltene Verfahren: über den Entpacker.
      const sink = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          crc = crc32(chunk, crc);
          onRead?.(chunk.length);
          callback();
        },
      });
      await pipeline(await zip.openReadStreamPromise(entry), sink);
    }
    if ((crc >>> 0) !== (entry.crc32 >>> 0)) throw new Error(`Prüfsumme stimmt nicht: ${entry.fileName}`);
  };

  const worker = async () => {
    const block = Buffer.allocUnsafe(BLOCK);
    while (!failed) {
      const entry = entries[next++];
      if (!entry) return;
      if (entry.fileName.endsWith('/')) continue;
      try {
        await verify(entry, block);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };

  try {
    const results = await Promise.allSettled(Array.from({ length: PARALLEL }, worker));
    const broken = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (broken) throw broken.reason;
  } finally {
    await fh.close();
  }
}
