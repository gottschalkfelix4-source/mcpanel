import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { promisify } from 'node:util';
import { constants as zlibConstants, crc32, deflateRaw, deflateRawSync } from 'node:zlib';
import { badRequest } from './errors.js';

/**
 * Schneller ZIP-Schreiber für Backups und Welt-Downloads.
 *
 * Der Zeitfresser beim alten tar.gz war gzip über die Regionsdateien: Minecraft
 * komprimiert sie schon selbst, ein zweites Mal packen spart kaum Platz, kostet
 * aber fast die ganze Laufzeit (ein Kern, ~40 MB/s). Hier werden bereits
 * komprimierte Dateien deshalb unverändert abgelegt ("stored"), nur der Rest
 * wird gepackt – kleine Dateien mehrere gleichzeitig im libuv-Threadpool.
 *
 * Große Dateien mit unbekannter Endung (Datenbanken von Distant Horizons,
 * CoreProtect, LuckPerms …) werden vorher angetestet: ist der Inhalt praktisch
 * nicht packbar, wird er ebenfalls nur abgelegt. Sonst lief eine einzige
 * solche Datei mit rund 35 MB/s durch die Kompression und bestimmte die ganze
 * Laufzeit. Was sich packen lässt, wird blockweise auf mehreren Kernen gepackt.
 *
 * Geschrieben wird mit festen Dateipositionen: der lokale Kopf einer großen
 * Datei wird nach dem Durchlauf mit Prüfsumme und Größen überschrieben, so
 * braucht es keine Data-Descriptors. ZIP64 greift nur, wo 4 GiB überschritten
 * werden; jedes Betriebssystem öffnet das Ergebnis ohne Zusatzprogramm.
 */

export interface ZipSource {
  /** Pfad im Archiv, immer mit "/" getrennt, ohne führenden Schrägstrich. */
  name: string;
  /** Absoluter Pfad auf der Platte. */
  path: string;
  size: number;
  mtime: Date;
  mode: number;
  directory: boolean;
}

export interface ZipOptions {
  /** Fortschritt in Bytes der Quelldateien – höchstens alle 250 ms. */
  onProgress?: (doneBytes: number, totalBytes: number) => void;
  /** Obergrenze für die Archivgröße (Speicherkontingent). */
  maxBytes?: number;
}

export interface ZipResult {
  entries: number;
  /** Summe der unkomprimierten Dateigrößen. */
  bytes: number;
  /** Größe des Archivs. */
  size: number;
}

/** Endungen, deren Inhalt schon komprimiert ist – noch einmal packen kostet nur Zeit. */
const SCHON_GEPACKT = new Set([
  // Minecraft: Regionen, Entities, POI; NBT-Dateien sind gzip
  '.mca', '.mcc', '.dat', '.dat_old', '.nbt', '.schem', '.schematic', '.litematic', '.prbm',
  // Archive und Mods
  '.jar', '.zip', '.gz', '.tgz', '.xz', '.zst', '.bz2', '.7z', '.rar', '.mcpack', '.mcworld',
  // Medien
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ogg', '.mp3', '.mp4',
]);

/** Bis zu dieser Größe wird eine Datei am Stück gelesen und parallel gepackt. */
const IM_SPEICHER_MAX = 8 * 1024 ** 2;
/** So viel darf gleichzeitig vorbereitet im Speicher liegen. */
const FENSTER_BYTES = 64 * 1024 ** 2;
const PARALLEL = Math.min(8, Math.max(2, os.availableParallelism?.() ?? os.cpus().length));
/** Ab hier bekommt der lokale Kopf vorsorglich ein ZIP64-Feld – die Datei könnte noch wachsen. */
/** So viele Dateisystem-Abfragen laufen beim Sammeln gleichzeitig. */
const SAMMELN_PARALLEL = 16;
const ZIP64_SCHWELLE = 0xf000_0000;
const MAX32 = 0xffff_ffff;
const ZIP64_EINTRAEGE = 0xffff;

/** Bis zu dieser Größe wird synchron gepackt. */
const SYNCHRON_MAX = 16 * 1024;
/** Blockgröße beim Durchreichen und beim parallelen Packen großer Dateien. */
const BLOCK = 1024 * 1024;
/** Proben je großer Datei (Anfang, Mitte, Ende) und ihre Größe. */
const PROBE_BYTES = 128 * 1024;
/** Spart das Packen weniger als das, wird die Datei nur abgelegt. */
const PROBE_MIN_ERSPARNIS = 0.08;
/** Leerer Schlussblock eines Deflate-Stroms (BFINAL, feste Huffman-Codes, Blockende). */
const DEFLATE_ENDE = Buffer.from([0x03, 0x00]);

const deflateRawAsync = promisify(deflateRaw) as (data: Buffer, options?: { level?: number; finishFlush?: number }) => Promise<Buffer>;

/**
 * Lohnt sich das Packen dieser großen Datei? Drei kurze Proben mit der
 * schnellsten Stufe genügen: Datenbanken mit bereits komprimiertem Inhalt
 * verraten sich überall gleich.
 */
async function lohntPacken(input: fs.FileHandle, size: number): Promise<boolean> {
  if (size <= 0) return false;
  const len = Math.min(PROBE_BYTES, size);
  const stellen = size <= len * 3 ? [0] : [0, Math.floor((size - len) / 2), size - len];
  let roh = 0;
  let gepackt = 0;
  for (const position of stellen) {
    const probe = Buffer.allocUnsafe(len);
    const { bytesRead } = await input.read(probe, 0, len, position);
    if (bytesRead === 0) continue;
    roh += bytesRead;
    gepackt += (await deflateRawAsync(probe.subarray(0, bytesRead), { level: 1 })).length;
  }
  return roh > 0 && gepackt <= roh * (1 - PROBE_MIN_ERSPARNIS);
}

export function shouldStore(name: string): boolean {
  return SCHON_GEPACKT.has(path.extname(name).toLowerCase());
}

/**
 * Sammelt Dateien und Ordner unterhalb von `root` für die angegebenen
 * Einträge der obersten Ebene. Symlinks und Spezialdateien werden
 * übersprungen – die Wiederherstellung würde sie ohnehin ablehnen.
 */
export async function collectSources(
  root: string,
  tops: string[],
  include: (relative: string) => boolean = () => true,
): Promise<ZipSource[]> {
  // Mehrere Abfragen gleichzeitig: bei Hunderttausenden Kartenkacheln oder
  // einer per Netz eingehängten Node kostet das Nacheinander sonst Minuten.
  // Die Reihenfolge im Ergebnis bleibt dieselbe (sortiert, Ordner vor Inhalt).
  let frei = SAMMELN_PARALLEL;
  const wartend: (() => void)[] = [];
  const begrenzt = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (frei > 0) frei -= 1;
    else await new Promise<void>((resolve) => wartend.push(resolve));
    try {
      return await fn();
    } finally {
      const naechster = wartend.shift();
      if (naechster) naechster();
      else frei += 1;
    }
  };

  const walk = async (relative: string): Promise<ZipSource[]> => {
    if (!include(relative)) return [];
    const absolute = path.join(root, relative);
    const stat = await begrenzt(() => fs.lstat(absolute).catch(() => null));
    if (!stat) return [];
    const name = relative.split(path.sep).join('/');
    if (stat.isDirectory()) {
      const result: ZipSource[] = [{ name: `${name}/`, path: absolute, size: 0, mtime: stat.mtime, mode: stat.mode & 0o777, directory: true }];
      const children = await begrenzt(() => fs.readdir(absolute).catch(() => [] as string[]));
      const teile = await Promise.all(children.sort().map((child) => walk(path.join(relative, child))));
      for (const teil of teile) for (const eintrag of teil) result.push(eintrag);
      return result;
    }
    if (stat.isFile()) {
      return [{ name, path: absolute, size: stat.size, mtime: stat.mtime, mode: stat.mode & 0o777, directory: false }];
    }
    return [];
  };

  const result: ZipSource[] = [];
  for (const teil of await Promise.all([...tops].sort().map(walk))) for (const eintrag of teil) result.push(eintrag);
  return result;
}

function dosZeit(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

interface Eintrag {
  name: Buffer;
  method: 0 | 8;
  crc: number;
  size: number;
  compressed: number;
  offset: number;
  zeit: { time: number; date: number };
  external: number;
  zip64Lokal: boolean;
  /**
   * Größe und Prüfsumme stehen hinter den Daten (Data Descriptor) statt im
   * lokalen Kopf – nötig, wenn das Ziel kein Zurückspringen erlaubt (Stream).
   */
  deskriptor?: boolean;
}

/** Data Descriptor im ZIP64-Format: Signatur, CRC, gepackte und echte Größe. */
function deskriptor(e: Eintrag): Buffer {
  const buf = Buffer.alloc(24);
  buf.writeUInt32LE(0x08074b50, 0);
  buf.writeUInt32LE(e.crc >>> 0, 4);
  buf.writeBigUInt64LE(BigInt(e.compressed), 8);
  buf.writeBigUInt64LE(BigInt(e.size), 16);
  return buf;
}

function lokalerKopf(e: Eintrag): Buffer {
  const extra = e.zip64Lokal ? 20 : 0;
  const buf = Buffer.alloc(30 + e.name.length + extra);
  buf.writeUInt32LE(0x04034b50, 0);
  buf.writeUInt16LE(e.zip64Lokal ? 45 : 20, 4);
  buf.writeUInt16LE(e.deskriptor ? 0x0808 : 0x0800, 6); // Dateinamen in UTF-8 (+ Data Descriptor)
  buf.writeUInt16LE(e.method, 8);
  buf.writeUInt16LE(e.zeit.time, 10);
  buf.writeUInt16LE(e.zeit.date, 12);
  buf.writeUInt32LE(e.deskriptor ? 0 : e.crc >>> 0, 14);
  buf.writeUInt32LE(e.zip64Lokal ? MAX32 : e.compressed, 18);
  buf.writeUInt32LE(e.zip64Lokal ? MAX32 : e.size, 22);
  buf.writeUInt16LE(e.name.length, 26);
  buf.writeUInt16LE(extra, 28);
  e.name.copy(buf, 30);
  if (e.zip64Lokal) {
    const at = 30 + e.name.length;
    buf.writeUInt16LE(0x0001, at);
    buf.writeUInt16LE(16, at + 2);
    buf.writeBigUInt64LE(e.deskriptor ? 0n : BigInt(e.size), at + 4);
    buf.writeBigUInt64LE(e.deskriptor ? 0n : BigInt(e.compressed), at + 12);
  }
  return buf;
}

function zentralerKopf(e: Eintrag): Buffer {
  const felder: number[] = [];
  if (e.size >= MAX32) felder.push(e.size);
  if (e.compressed >= MAX32) felder.push(e.compressed);
  if (e.offset >= MAX32) felder.push(e.offset);
  const extra = felder.length ? 4 + felder.length * 8 : 0;
  const buf = Buffer.alloc(46 + e.name.length + extra);
  buf.writeUInt32LE(0x02014b50, 0);
  buf.writeUInt16LE((3 << 8) | 45, 4); // Unix, ZIP 4.5
  buf.writeUInt16LE(felder.length || e.deskriptor ? 45 : 20, 6);
  buf.writeUInt16LE(e.deskriptor ? 0x0808 : 0x0800, 8);
  buf.writeUInt16LE(e.method, 10);
  buf.writeUInt16LE(e.zeit.time, 12);
  buf.writeUInt16LE(e.zeit.date, 14);
  buf.writeUInt32LE(e.crc >>> 0, 16);
  buf.writeUInt32LE(Math.min(e.compressed, MAX32), 20);
  buf.writeUInt32LE(Math.min(e.size, MAX32), 24);
  buf.writeUInt16LE(e.name.length, 28);
  buf.writeUInt16LE(extra, 30);
  buf.writeUInt32LE(e.external >>> 0, 38);
  buf.writeUInt32LE(Math.min(e.offset, MAX32), 42);
  e.name.copy(buf, 46);
  if (felder.length) {
    let at = 46 + e.name.length;
    buf.writeUInt16LE(0x0001, at);
    buf.writeUInt16LE(felder.length * 8, at + 2);
    at += 4;
    for (const wert of felder) {
      buf.writeBigUInt64LE(BigInt(wert), at);
      at += 8;
    }
  }
  return buf;
}

function ende(anzahl: number, cdOffset: number, cdSize: number): Buffer {
  const zip64 = anzahl >= ZIP64_EINTRAEGE || cdOffset >= MAX32 || cdSize >= MAX32;
  const teile: Buffer[] = [];
  if (zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE((3 << 8) | 45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(anzahl), 24);
    rec.writeBigUInt64LE(BigInt(anzahl), 32);
    rec.writeBigUInt64LE(BigInt(cdSize), 40);
    rec.writeBigUInt64LE(BigInt(cdOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8);
    locator.writeUInt32LE(1, 16);
    teile.push(rec, locator);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Math.min(anzahl, ZIP64_EINTRAEGE), 8);
  eocd.writeUInt16LE(Math.min(anzahl, ZIP64_EINTRAEGE), 10);
  eocd.writeUInt32LE(Math.min(cdSize, MAX32), 12);
  eocd.writeUInt32LE(Math.min(cdOffset, MAX32), 16);
  teile.push(eocd);
  return Buffer.concat(teile);
}

interface Ziel {
  pos: number;
  /** Kann nachträglich an eine frühere Stelle schreiben */
  readonly springt: boolean;
  write(buf: Buffer): Promise<void>;
  at(buf: Buffer, position: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Schreibt fortlaufend in einen Stream – etwa direkt in einen Upload. Achtet
 * auf Rückstau, damit bei langsamer Leitung nicht das ganze Archiv im
 * Arbeitsspeicher landet, und reicht einen Fehler des Ziels an den nächsten
 * Schreibversuch weiter.
 */
class StromAusgabe implements Ziel {
  pos = 0;
  readonly springt = false;
  private fehler: Error | null = null;
  constructor(private readonly strom: Writable, private readonly max: number) {
    strom.on('error', (err) => { this.fehler = err; });
  }

  async write(buf: Buffer) {
    if (this.fehler) throw this.fehler;
    if (this.pos + buf.length > this.max) throw badRequest('Speicherkontingent reicht für diese Datei nicht aus');
    this.pos += buf.length;
    if (this.strom.write(buf)) return;
    await new Promise<void>((resolve, reject) => {
      const weiter = () => { aufraeumen(); resolve(); };
      const kaputt = (err: Error) => { aufraeumen(); reject(err); };
      const zu = () => { aufraeumen(); reject(this.fehler ?? new Error('Das Ziel hat die Verbindung geschlossen')); };
      const aufraeumen = () => {
        this.strom.off('drain', weiter); this.strom.off('error', kaputt); this.strom.off('close', zu);
      };
      this.strom.once('drain', weiter); this.strom.once('error', kaputt); this.strom.once('close', zu);
    });
  }

  async at(): Promise<void> {
    throw new Error('Ein Stream erlaubt kein Zurückspringen');
  }

  async close() { /* Abschließen ist Sache des Aufrufers – er wartet auf den Upload. */ }
}

/** Schreibt an feste Positionen; der Kopf großer Dateien wird hinterher ergänzt. */
class Ausgabe implements Ziel {
  pos = 0;
  readonly springt = true;
  constructor(private readonly fh: fs.FileHandle, private readonly max: number) {}

  close() { return this.fh.close(); }

  async write(buf: Buffer) {
    if (this.pos + buf.length > this.max) throw badRequest('Speicherkontingent reicht für diese Datei nicht aus');
    await this.at(buf, this.pos);
    this.pos += buf.length;
  }

  async at(buf: Buffer, position: number) {
    let off = 0;
    while (off < buf.length) {
      const { bytesWritten } = await this.fh.write(buf, off, buf.length - off, position + off);
      off += bytesWritten;
    }
  }
}

interface Vorbereitet {
  method: 0 | 8;
  crc: number;
  size: number;
  data: Buffer;
}

const istWeg = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

/** Kleine Datei lesen und – wenn es sich lohnt – packen. `null`: inzwischen verschwunden. */
async function vorbereiten(source: ZipSource): Promise<Vorbereitet | null> {
  let raw: Buffer;
  try {
    raw = await fs.readFile(source.path);
  } catch (err) {
    if (istWeg(err)) return null;
    throw err;
  }
  const crc = crc32(raw);
  if (!shouldStore(source.name) && raw.length > 64) {
    // Winzige Dateien (Kartenkacheln, Konfiguration) packt der Hauptfaden
    // schneller, als der Wechsel in den Threadpool und zurück dauert.
    const packed = raw.length <= SYNCHRON_MAX ? deflateRawSync(raw) : await deflateRawAsync(raw);
    if (packed.length < raw.length) return { method: 8, crc, size: raw.length, data: packed };
  }
  return { method: 0, crc, size: raw.length, data: raw };
}

/**
 * Schreibt `sources` als ZIP nach `target`. Die Datei darf noch nicht
 * existieren; bei einem Fehler bleibt sie unvollständig liegen und muss vom
 * Aufrufer entfernt werden.
 */
export async function writeZip(target: string, sources: ZipSource[], options: ZipOptions = {}): Promise<ZipResult> {
  const fh = await fs.open(target, 'wx', 0o600);
  return schreibe(new Ausgabe(fh, options.maxBytes ?? Infinity), sources, options);
}

/**
 * Wie `writeZip`, aber fortlaufend in einen Stream – das Archiv entsteht
 * direkt am Ziel (Upload), ohne Zwischendatei. Große Dateien bekommen dafür
 * einen Data Descriptor; gängige Entpacker und `yauzl` lesen das.
 * Der Stream wird nicht beendet: das übernimmt der Aufrufer.
 */
export function writeZipStream(target: Writable, sources: ZipSource[], options: ZipOptions = {}): Promise<ZipResult> {
  return schreibe(new StromAusgabe(target, options.maxBytes ?? Infinity), sources, options);
}

async function schreibe(out: Ziel, sources: ZipSource[], options: ZipOptions): Promise<ZipResult> {
  const total = sources.reduce((sum, s) => sum + s.size, 0);
  let done = 0;
  let zuletzt = 0;
  const melde = (force = false) => {
    const jetzt = Date.now();
    if (!options.onProgress || (!force && jetzt - zuletzt < 250)) return;
    zuletzt = jetzt;
    options.onProgress(done, total);
  };

  const eintraege: Eintrag[] = [];

  // Vorausschauend vorbereiten, aber in Reihenfolge schreiben.
  const vorbereitet = new Map<number, Promise<Vorbereitet | null>>();
  let geplant = 0;
  let fensterBytes = 0;
  const planeVoraus = () => {
    while (geplant < sources.length && vorbereitet.size < PARALLEL && fensterBytes < FENSTER_BYTES) {
      const s = sources[geplant];
      if (!s.directory && s.size <= IM_SPEICHER_MAX) {
        const job = vorbereiten(s);
        job.catch(() => {}); // wird beim Abholen ausgewertet
        vorbereitet.set(geplant, job);
        fensterBytes += s.size;
      }
      geplant += 1;
    }
  };

  try {
    for (let i = 0; i < sources.length; i++) {
      planeVoraus();
      const s = sources[i];
      const basis = {
        name: Buffer.from(s.name, 'utf8'),
        offset: out.pos,
        zeit: dosZeit(s.mtime),
        external: s.directory ? (((0o040000 | (s.mode || 0o755)) << 16) | 0x10) : ((0o100000 | (s.mode || 0o644)) << 16),
      };

      if (s.directory) {
        const e: Eintrag = { ...basis, method: 0, crc: 0, size: 0, compressed: 0, zip64Lokal: false };
        await out.write(lokalerKopf(e));
        eintraege.push(e);
        continue;
      }

      const job = vorbereitet.get(i);
      if (job) {
        vorbereitet.delete(i);
        fensterBytes -= s.size;
        const fertig = await job;
        done += s.size;
        if (!fertig) continue;
        const e: Eintrag = {
          ...basis, method: fertig.method, crc: fertig.crc, size: fertig.size,
          compressed: fertig.data.length, zip64Lokal: false,
        };
        await out.write(Buffer.concat([lokalerKopf(e), fertig.data]));
        eintraege.push(e);
        melde();
        continue;
      }

      // Große Datei: durchstreamen, Kopf danach ergänzen.
      let input: fs.FileHandle;
      try {
        input = await fs.open(s.path, 'r');
      } catch (err) {
        if (istWeg(err)) { done += s.size; continue; }
        throw err;
      }
      let crc = 0;
      const vorher = done;
      let e: Eintrag;
      let kopfPos: number;
      let datenStart: number;
      try {
        const packen = !shouldStore(s.name) && await lohntPacken(input, s.size);
        e = {
          ...basis, method: packen ? 8 : 0, crc: 0, size: 0, compressed: 0,
          // Im Stream stehen Größen erst hinter den Daten – immer im ZIP64-Format,
          // dann ist die Länge des Descriptors eindeutig.
          zip64Lokal: !out.springt || s.size >= ZIP64_SCHWELLE,
          deskriptor: !out.springt,
        };
        kopfPos = out.pos;
        await out.write(lokalerKopf(e));
        datenStart = out.pos;

        // Blöcke werden gleichzeitig gepackt, aber in Reihenfolge geschrieben.
        // Jeder endet mit einem Sync-Flush (bytegenau, kein Schlussblock) –
        // aneinandergehängt und mit `DEFLATE_ENDE` abgeschlossen ergibt das
        // einen gültigen Deflate-Strom.
        const wartend: Promise<Buffer>[] = [];
        for (;;) {
          const block = Buffer.allocUnsafe(BLOCK);
          const { bytesRead } = await input.read(block, 0, BLOCK, null);
          if (bytesRead === 0) break;
          const roh = bytesRead === BLOCK ? block : block.subarray(0, bytesRead);
          crc = crc32(roh, crc);
          e.size += bytesRead;
          if (packen) {
            const job = deflateRawAsync(roh, { finishFlush: zlibConstants.Z_SYNC_FLUSH });
            job.catch(() => {}); // wird beim Abholen ausgewertet
            wartend.push(job);
            if (wartend.length >= PARALLEL) await out.write(await wartend.shift()!);
          } else {
            await out.write(roh);
          }
          done = vorher + Math.min(e.size, s.size);
          melde();
        }
        if (packen) {
          while (wartend.length > 0) await out.write(await wartend.shift()!);
          await out.write(DEFLATE_ENDE);
        }
      } finally {
        await input.close().catch(() => {});
      }
      done = vorher + s.size;
      e.crc = crc;
      e.compressed = out.pos - datenStart;
      if (!e.zip64Lokal && (e.size >= MAX32 || e.compressed >= MAX32)) {
        throw new Error(`${s.name} ist während des Packens über 4 GB gewachsen`);
      }
      if (out.springt) await out.at(lokalerKopf(e), kopfPos);
      else await out.write(deskriptor(e));
      eintraege.push(e);
    }

    const cdOffset = out.pos;
    await out.write(Buffer.concat(eintraege.map(zentralerKopf)));
    const cdSize = out.pos - cdOffset;
    await out.write(ende(eintraege.length, cdOffset, cdSize));
    melde(true);
    return {
      entries: eintraege.length,
      bytes: eintraege.reduce((sum, e) => sum + e.size, 0),
      size: out.pos,
    };
  } finally {
    await out.close();
  }
}
