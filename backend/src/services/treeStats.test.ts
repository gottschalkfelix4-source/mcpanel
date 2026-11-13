import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { forgetTreeStats, treeStats } from './treeStats.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-tree-')); });
afterEach(() => fs.rm(root, { recursive: true, force: true }));

async function put(relative: string, bytes: number) {
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), Buffer.alloc(bytes));
}

it('zählt Größe und Dateien aller Unterordner', async () => {
  await put('welt/region/r.0.0.mca', 8192);
  await put('welt/level.dat', 100);
  for (let i = 0; i < 150; i++) await put(`welt/kacheln/${i % 7}/${i}.json`, 10);
  expect(await treeStats(path.join(root, 'welt'))).toEqual({ bytes: 8192 + 100 + 1500, files: 152, partial: false });
});

// Ein Link auf einen fremden Ordner darf dessen Größe nicht verraten.
it('zählt Verknüpfungen nicht mit und folgt ihnen nicht', async () => {
  await put('fremd/geheim.bin', 5000);
  await put('ordner/datei.txt', 7);
  await fs.symlink(path.join(root, 'fremd'), path.join(root, 'ordner', 'link'));
  await fs.symlink(path.join(root, 'fremd', 'geheim.bin'), path.join(root, 'ordner', 'datei-link'));
  expect(await treeStats(path.join(root, 'ordner'))).toEqual({ bytes: 7, files: 1, partial: false });
});

it('rechnet nach einer Änderung neu, auch für übergeordnete Ordner', async () => {
  await put('a/b/c.txt', 10);
  expect((await treeStats(path.join(root, 'a'))).bytes).toBe(10);
  await put('a/b/d.txt', 20);
  expect((await treeStats(path.join(root, 'a'))).bytes).toBe(10); // noch aus dem Zwischenspeicher
  forgetTreeStats(path.join(root, 'a', 'b'));
  expect((await treeStats(path.join(root, 'a'))).bytes).toBe(30);
});

it('liefert für einen fehlenden Ordner leere Zahlen statt eines Fehlers', async () => {
  expect(await treeStats(path.join(root, 'gibt-es-nicht'))).toEqual({ bytes: 0, files: 0, partial: false });
});
