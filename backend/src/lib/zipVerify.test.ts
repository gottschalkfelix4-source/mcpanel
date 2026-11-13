import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openPromise, type Entry } from 'yauzl';
import { collectSources, writeZip } from './zipWriter.js';
import { verifyZipEntries } from './zipVerify.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-zipverify-')); });
afterEach(() => fs.rm(root, { recursive: true, force: true }));

async function schreibe(relative: string, data: Buffer | string) {
  await fs.mkdir(path.dirname(path.join(root, 'src', relative)), { recursive: true });
  await fs.writeFile(path.join(root, 'src', relative), data);
}

/** Archiv mit allen Wegen des Schreibers: klein/groß, abgelegt/gepackt, leer, Ordner. */
async function archiv(): Promise<string> {
  await schreibe('world/region/r.0.0.mca', crypto.randomBytes(300 * 1024));
  await schreibe('world/region/r.1.0.mca', crypto.randomBytes(9 * 1024 * 1024));
  await schreibe('config/klein.json', JSON.stringify({ a: 'x'.repeat(500) }));
  await schreibe('config/mittel.txt', 'zeile mit inhalt\n'.repeat(60_000));
  await schreibe('plugins/daten.db', 'eintrag;wert;noch ein wert\n'.repeat(400_000));
  await schreibe('leer.txt', '');
  await fs.mkdir(path.join(root, 'src', 'leerer-ordner'));
  const base = path.join(root, 'src');
  const target = path.join(root, 'out.zip');
  await writeZip(target, await collectSources(base, await fs.readdir(base)));
  return target;
}

async function pruefe(file: string): Promise<number> {
  const zip = await openPromise(file, { lazyEntries: true, autoClose: false });
  try {
    const entries: Entry[] = [];
    for await (const entry of zip.eachEntry()) entries.push(entry);
    let gelesen = 0;
    await verifyZipEntries(file, zip, entries, (bytes) => { gelesen += bytes; });
    return gelesen;
  } finally {
    zip.close();
  }
}

async function eintrag(file: string, name: string): Promise<Entry> {
  const zip = await openPromise(file, { lazyEntries: true, autoClose: false });
  try {
    for await (const entry of zip.eachEntry()) if (entry.fileName === name) return entry;
    throw new Error('fehlt');
  } finally {
    zip.close();
  }
}

async function kippeByte(file: string, position: number) {
  const fh = await fs.open(file, 'r+');
  try {
    const byte = Buffer.alloc(1);
    await fh.read(byte, 0, 1, position);
    byte[0] ^= 0xff;
    await fh.write(byte, 0, 1, position);
  } finally {
    await fh.close();
  }
}

it('liest ein heiles Archiv vollständig und meldet jede entpackte Datei', async () => {
  const file = await archiv();
  const base = path.join(root, 'src');
  const erwartet = (await collectSources(base, await fs.readdir(base))).reduce((sum, s) => sum + s.size, 0);
  expect(await pruefe(file)).toBe(erwartet);
});

it.each([
  ['große abgelegte Regionsdatei', 'world/region/r.1.0.mca', 5 * 1024 * 1024],
  ['kleine abgelegte Regionsdatei', 'world/region/r.0.0.mca', 1000],
  ['kleine gepackte Datei', 'config/klein.json', 12],
  ['mittlere gepackte Datei', 'config/mittel.txt', 40],
  ['große, blockweise gepackte Datei', 'plugins/daten.db', 200],
])('erkennt ein verändertes Byte: %s', async (_titel, name, versatz) => {
  const file = await archiv();
  const e = await eintrag(file, name);
  await kippeByte(file, e.relativeOffsetOfLocalHeader + 30 + e.fileNameLength + versatz);
  await expect(pruefe(file)).rejects.toThrow();
});

it('erkennt ein abgeschnittenes Archiv', async () => {
  const file = await archiv();
  const zip = await openPromise(file, { lazyEntries: true, autoClose: false });
  const entries: Entry[] = [];
  for await (const entry of zip.eachEntry()) entries.push(entry);
  // Verzeichnis ist gelesen – danach fehlt der Datei die hintere Hälfte.
  await fs.truncate(file, Math.floor((await fs.stat(file)).size / 2));
  try {
    await expect(verifyZipEntries(file, zip, entries)).rejects.toThrow();
  } finally {
    zip.close();
  }
});

it('lässt sich von einer gefälschten Größenangabe nicht zum Aufblähen bringen', async () => {
  const file = await archiv();
  const zip = await openPromise(file, { lazyEntries: true, autoClose: false });
  const entries: Entry[] = [];
  for await (const entry of zip.eachEntry()) entries.push(entry);
  const ziel = entries.find((entry) => entry.fileName === 'config/mittel.txt')!;
  ziel.uncompressedSize = 10; // tatsächlicher Inhalt ist rund 1 MiB
  try {
    await expect(verifyZipEntries(file, zip, entries)).rejects.toThrow();
  } finally {
    zip.close();
  }
});
