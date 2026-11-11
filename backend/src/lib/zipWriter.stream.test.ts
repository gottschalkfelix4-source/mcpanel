import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { openPromise } from 'yauzl';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { collectSources, writeZipStream } from './zipWriter.js';

let root: string;
beforeEach(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcpanel-zipstrom-')); });
afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

async function fixture() {
  const dir = path.join(root, 'quelle');
  await fsp.mkdir(path.join(dir, 'world/region'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'server.properties'), 'level-name=world\n'.repeat(50));
  // Größer als die Im-Speicher-Grenze: läuft als Stream mit Data Descriptor.
  await fsp.writeFile(path.join(dir, 'world/region/r.0.0.mca'), crypto.randomBytes(9 * 1024 * 1024));
  await fsp.writeFile(path.join(dir, 'latest.log'), 'Zeile mit Umlauten äöü\n'.repeat(700_000));
  return dir;
}

async function hash(file: string) {
  return crypto.createHash('sha256').update(await fsp.readFile(file)).digest('hex');
}

it('schreibt fortlaufend ein Archiv, das yauzl und unzip vollständig lesen', async () => {
  const dir = await fixture();
  const sources = await collectSources(dir, await fsp.readdir(dir));
  const target = path.join(root, 'strom.zip');
  const out = fs.createWriteStream(target);
  const result = await writeZipStream(out, sources);
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  expect(result.size).toBe((await fsp.stat(target)).size);

  // Unabhängiger Entpacker: prüft Prüfsummen und Längen.
  let hasUnzip = true;
  try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); } catch { hasUnzip = false; }
  if (hasUnzip) {
    execFileSync('unzip', ['-tq', target], { stdio: 'pipe' });
    const extracted = path.join(root, 'entpackt');
    execFileSync('unzip', ['-q', target, '-d', extracted]);
    for (const name of ['server.properties', 'world/region/r.0.0.mca', 'latest.log']) {
      expect(await hash(path.join(extracted, name))).toBe(await hash(path.join(dir, name)));
    }
  }

  // Der Leser des Panels (Wiederherstellung, Prüfung).
  const zip = await openPromise(target, { lazyEntries: true, validateEntrySizes: true });
  const seen: Record<string, number> = {};
  for await (const entry of zip.eachEntry()) {
    if (entry.fileName.endsWith('/')) continue;
    let bytes = 0;
    for await (const chunk of await zip.openReadStreamPromise(entry)) bytes += (chunk as Buffer).length;
    seen[entry.fileName] = bytes;
  }
  await zip.close();
  expect(seen['world/region/r.0.0.mca']).toBe(9 * 1024 * 1024);
  expect(seen['latest.log']).toBe((await fsp.stat(path.join(dir, 'latest.log'))).size);
});

it('bricht ab, wenn das Ziel ausfällt, statt weiterzuschreiben', async () => {
  const dir = await fixture();
  const sources = await collectSources(dir, await fsp.readdir(dir));
  let written = 0;
  const failing = new Writable({
    write(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      cb(written > 2 * 1024 * 1024 ? new Error('Verbindung getrennt') : null);
    },
  });
  failing.on('error', () => {});
  await expect(writeZipStream(failing, sources)).rejects.toThrow('Verbindung getrennt');
});

it('achtet auf Rückstau eines langsamen Ziels', async () => {
  const dir = await fixture();
  const sources = await collectSources(dir, await fsp.readdir(dir));
  const slow = new PassThrough({ highWaterMark: 64 * 1024 });
  let peak = 0;
  let total = 0;
  const drain = (async () => {
    for await (const chunk of slow) {
      total += (chunk as Buffer).length;
      peak = Math.max(peak, slow.writableLength);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  })();
  const result = await writeZipStream(slow, sources);
  slow.end();
  await drain;
  expect(total).toBe(result.size);
  // Nie mehr als ein paar Blöcke im Puffer, obwohl das Archiv viele MB hat.
  expect(peak).toBeLessThan(8 * 1024 * 1024);
});
