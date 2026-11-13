import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mapLimit, readJarEntry } from './jarEntry.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-jar-')); });
afterEach(() => fs.rm(root, { recursive: true, force: true }));

function jar(name: string, entries: Record<string, string>): string {
  const zip = new AdmZip();
  for (const [entry, content] of Object.entries(entries)) zip.addFile(entry, Buffer.from(content));
  const file = path.join(root, name);
  zip.writeZip(file);
  return file;
}

it('liest den bevorzugten Eintrag, sonst den nächsten', async () => {
  const beide = jar('a.jar', { 'META-INF/mods.toml': 'alt', 'META-INF/neoforge.mods.toml': 'neu', 'x/y.class': 'z'.repeat(5000) });
  expect((await readJarEntry(beide, ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml']))?.toString()).toBe('neu');
  const nurAlt = jar('b.jar', { 'META-INF/mods.toml': 'alt' });
  expect((await readJarEntry(nurAlt, ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml']))?.toString()).toBe('alt');
});

it('liefert null für fehlende Einträge, zu große Einträge und kaputte Dateien', async () => {
  const datei = jar('c.jar', { 'fabric.mod.json': '{"id":"x"}', 'gross.json': 'x'.repeat(2000) });
  expect(await readJarEntry(datei, ['gibt-es-nicht'])).toBeNull();
  expect(await readJarEntry(datei, ['gross.json'], 1000)).toBeNull();
  await fs.writeFile(path.join(root, 'kaputt.jar'), 'kein zip');
  expect(await readJarEntry(path.join(root, 'kaputt.jar'), ['fabric.mod.json'])).toBeNull();
});

it('arbeitet begrenzt parallel und behält die Reihenfolge', async () => {
  let gleichzeitig = 0;
  let hoechstens = 0;
  const ergebnis = await mapLimit([5, 1, 4, 2, 3], 2, async (wert) => {
    gleichzeitig++;
    hoechstens = Math.max(hoechstens, gleichzeitig);
    await new Promise((resolve) => setTimeout(resolve, wert));
    gleichzeitig--;
    return wert * 10;
  });
  expect(ergebnis).toEqual([50, 10, 40, 20, 30]);
  expect(hoechstens).toBe(2);
});
