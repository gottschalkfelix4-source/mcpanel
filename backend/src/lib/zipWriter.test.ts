import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openPromise, type Entry } from 'yauzl';
import { collectSources, shouldStore, writeZip, type ZipSource } from './zipWriter.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-zip-'));
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

/** Liest jedes Eintrag vollständig mit yauzl – dasselbe, was Prüfung und Einspielen tun. */
async function lies(file: string): Promise<Map<string, { entry: Entry; data: Buffer }>> {
  const zip = await openPromise(file, { lazyEntries: true, autoClose: false });
  const result = new Map<string, { entry: Entry; data: Buffer }>();
  try {
    for await (const entry of zip.eachEntry()) {
      const chunks: Buffer[] = [];
      if (!entry.fileName.endsWith('/')) {
        for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(chunk as Buffer);
      }
      result.set(entry.fileName, { entry, data: Buffer.concat(chunks) });
    }
  } finally {
    zip.close();
  }
  return result;
}

async function schreibe(relative: string, data: Buffer | string) {
  await fs.mkdir(path.dirname(path.join(root, 'src', relative)), { recursive: true });
  await fs.writeFile(path.join(root, 'src', relative), data);
}

describe('writeZip', () => {
  it('legt Regionsdateien ungepackt ab, packt Text und liest sich unverändert zurück', async () => {
    const region = crypto.randomBytes(300 * 1024);
    const gross = crypto.randomBytes(9 * 1024 * 1024); // über der Grenze fürs parallele Packen
    const text = 'key=value\n'.repeat(50_000);
    await schreibe('world/region/r.0.0.mca', region);
    await schreibe('world/region/r.1.0.mca', gross);
    await schreibe('config/viel.json', text.repeat(2)); // ~1 MB Text, im Speicher gepackt
    await schreibe('logs-gross.txt', text.repeat(20)); // ~10 MB Text, gestreamt gepackt
    await schreibe('leer.txt', '');
    await schreibe('Umlaute äöü/ß.txt', 'grüß dich');
    await fs.mkdir(path.join(root, 'src', 'leerer-ordner'));

    const sources = await collectSources(path.join(root, 'src'), await fs.readdir(path.join(root, 'src')));
    const target = path.join(root, 'out.zip');
    const result = await writeZip(target, sources);
    const zip = await lies(target);

    expect(result.entries).toBe(zip.size);
    expect(zip.get('world/region/r.0.0.mca')!.data.equals(region)).toBe(true);
    expect(zip.get('world/region/r.0.0.mca')!.entry.compressionMethod).toBe(0);
    expect(zip.get('world/region/r.1.0.mca')!.data.equals(gross)).toBe(true);
    expect(zip.get('config/viel.json')!.entry.compressionMethod).toBe(8);
    expect(zip.get('config/viel.json')!.data.toString()).toBe(text.repeat(2));
    expect(zip.get('logs-gross.txt')!.entry.compressionMethod).toBe(8);
    expect(zip.get('logs-gross.txt')!.data.toString()).toBe(text.repeat(20));
    expect(zip.get('leer.txt')!.data.length).toBe(0);
    expect(zip.get('Umlaute äöü/ß.txt')!.data.toString()).toBe('grüß dich');
    expect(zip.has('leerer-ordner/')).toBe(true);
    // Text schrumpft deutlich, die Zufallsdaten nicht.
    expect(result.size).toBeLessThan(region.length + gross.length + 2 * 1024 * 1024);
  });

  it('meldet Fortschritt bis zur vollen Größe', async () => {
    await schreibe('a.mca', crypto.randomBytes(12 * 1024 * 1024));
    await schreibe('b.txt', 'x'.repeat(1000));
    const calls: [number, number][] = [];
    await writeZip(path.join(root, 'out.zip'), await collectSources(path.join(root, 'src'), ['a.mca', 'b.txt']), {
      onProgress: (done, total) => calls.push([done, total]),
    });
    expect(calls.at(-1)).toEqual([12 * 1024 * 1024 + 1000, 12 * 1024 * 1024 + 1000]);
  });

  it('überspringt Dateien, die inzwischen verschwunden sind', async () => {
    await schreibe('bleibt.txt', 'da');
    await schreibe('session.lock', 'weg');
    const sources = await collectSources(path.join(root, 'src'), ['bleibt.txt', 'session.lock']);
    await fs.rm(path.join(root, 'src', 'session.lock'));
    await writeZip(path.join(root, 'out.zip'), sources);
    expect([...(await lies(path.join(root, 'out.zip'))).keys()]).toEqual(['bleibt.txt']);
  });

  it('bricht ab, wenn das Kontingent nicht reicht', async () => {
    await schreibe('gross.mca', crypto.randomBytes(2 * 1024 * 1024));
    const sources = await collectSources(path.join(root, 'src'), ['gross.mca']);
    await expect(writeZip(path.join(root, 'out.zip'), sources, { maxBytes: 1024 * 1024 })).rejects.toThrow(/Speicherkontingent/);
  });

  it('nimmt keine Symlinks auf', async () => {
    await schreibe('echt.txt', 'inhalt');
    try {
      await fs.symlink(path.join(root, 'src', 'echt.txt'), path.join(root, 'src', 'link.txt'));
    } catch {
      return; // Windows ohne Symlink-Recht
    }
    const sources = await collectSources(path.join(root, 'src'), ['echt.txt', 'link.txt']);
    expect(sources.map((s) => s.name)).toEqual(['echt.txt']);
  });

  it('schreibt ab 65 535 Einträgen ein ZIP64-Ende, das sich wieder lesen lässt', async () => {
    await schreibe('klein.txt', 'a');
    const stat = await fs.stat(path.join(root, 'src', 'klein.txt'));
    const one: ZipSource = { name: '', path: path.join(root, 'src', 'klein.txt'), size: stat.size, mtime: stat.mtime, mode: 0o644, directory: false };
    const sources = Array.from({ length: 70_000 }, (_, i) => ({ ...one, name: `d/${i}.txt` }));
    const target = path.join(root, 'out.zip');
    const result = await writeZip(target, sources);
    expect(result.entries).toBe(70_000);
    const zip = await openPromise(target, { lazyEntries: true, autoClose: false });
    expect(zip.entryCount).toBe(70_000);
    zip.close();
  }, 60_000);
});

describe('shouldStore', () => {
  it('erkennt bereits komprimierte Formate', () => {
    expect(shouldStore('world/region/r.0.0.mca')).toBe(true);
    expect(shouldStore('mods/sodium.JAR')).toBe(true);
    expect(shouldStore('world/level.dat')).toBe(true);
    expect(shouldStore('server.properties')).toBe(false);
    expect(shouldStore('config/x.json')).toBe(false);
  });
});

describe('große Dateien mit unbekannter Endung', () => {
  // Distant Horizons, CoreProtect & Co. legen Gigabyte-Datenbanken an. Sind
  // sie nicht packbar, darf die Kompression nicht die Laufzeit bestimmen.
  it('legt eine nicht packbare Datenbank ab, statt sie zu packen', async () => {
    const daten = crypto.randomBytes(10 * 1024 * 1024);
    await schreibe('world/data/DistantHorizons.sqlite', daten);
    const sources = await collectSources(path.join(root, 'src'), ['world']);
    const target = path.join(root, 'dh.zip');
    const result = await writeZip(target, sources);
    const eintrag = (await lies(target)).get('world/data/DistantHorizons.sqlite')!;
    expect(eintrag.entry.compressionMethod).toBe(0);
    expect(eintrag.data.equals(daten)).toBe(true);
    expect(result.size).toBeLessThan(daten.length + 4096);
  });

  it('packt eine packbare Datenbank blockweise und liest sie unverändert zurück', async () => {
    // Kein sich wiederholendes Muster: jede Zeile ist anders, Blockgrenzen
    // fallen mitten in Zeilen – ein Fehler beim Aneinanderhängen fiele auf.
    const zeilen: string[] = [];
    for (let i = 0; zeilen.length < 260_000; i++) zeilen.push(`${i};spieler_${i % 977};minecraft:stone;${(i * 7919) % 100_003};${i % 3 === 0 ? 'gesetzt' : 'abgebaut'}`);
    const daten = Buffer.from(zeilen.join('\n'));
    expect(daten.length).toBeGreaterThan(9 * 1024 * 1024);
    await schreibe('plugins/CoreProtect/database.db', daten);
    const sources = await collectSources(path.join(root, 'src'), ['plugins']);
    const target = path.join(root, 'cp.zip');
    const result = await writeZip(target, sources);
    const eintrag = (await lies(target)).get('plugins/CoreProtect/database.db')!;
    expect(eintrag.entry.compressionMethod).toBe(8);
    expect(eintrag.data.equals(daten)).toBe(true);
    expect(result.size).toBeLessThan(daten.length / 2);
  });
});

describe('collectSources', () => {
  it('liefert trotz gleichzeitiger Abfragen eine feste Reihenfolge: sortiert, Ordner vor Inhalt', async () => {
    for (const name of ['b/2.txt', 'b/1.txt', 'a/x/tief.txt', 'a/z.txt', 'c.txt']) await schreibe(name, name);
    for (let i = 0; i < 60; i++) await schreibe(`viele/${String(i).padStart(2, '0')}.txt`, 'x');
    const base = path.join(root, 'src');
    const namen = (await collectSources(base, await fs.readdir(base))).map((s) => s.name);
    expect(namen.slice(0, 9)).toEqual(['a/', 'a/x/', 'a/x/tief.txt', 'a/z.txt', 'b/', 'b/1.txt', 'b/2.txt', 'c.txt', 'viele/']);
    expect(namen.slice(9)).toEqual(Array.from({ length: 60 }, (_, i) => `viele/${String(i).padStart(2, '0')}.txt`));
  });
});

