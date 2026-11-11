import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ root: '', update: vi.fn() }));
vi.mock('../config.js', () => ({ serverDir: (id: string) => path.join(m.root, id) }));
vi.mock('../db.js', () => ({ prisma: { server: { update: m.update } } }));

const { recoverInterruptedRestore, restorePaths, STALE_RESTORE_MS } = await import('./restoreRecovery.js');

beforeEach(async () => { m.root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-restore-')); m.update.mockReset(); });
afterEach(async () => { await fs.rm(m.root, { recursive: true, force: true }); });

async function prepare(at: number) {
  const { dir, old, journal } = restorePaths('srv');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'welt.txt'), 'neu');
  await fs.mkdir(old, { recursive: true });
  await fs.writeFile(path.join(old, 'welt.txt'), 'alt');
  await fs.writeFile(journal, JSON.stringify({ data: { name: 'Alt' }, committed: false, at }));
  return { dir, old, journal };
}

it('rollt einen frisch unterbrochenen Vorgang zurück', async () => {
  const { dir, old } = await prepare(Date.now() - 60_000);
  await recoverInterruptedRestore('srv');
  expect(await fs.readFile(path.join(dir, 'welt.txt'), 'utf8')).toBe('alt');
  await expect(fs.lstat(old)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(m.update).toHaveBeenCalledWith({ where: { id: 'srv' }, data: { name: 'Alt' } });
});

it('lässt nach langer Zeit den aktuellen Stand stehen und legt den alten nur beiseite', async () => {
  const { dir, old, journal } = await prepare(Date.now() - STALE_RESTORE_MS - 60_000);
  await recoverInterruptedRestore('srv');
  expect(await fs.readFile(path.join(dir, 'welt.txt'), 'utf8')).toBe('neu');
  expect(m.update).not.toHaveBeenCalled();
  await expect(fs.lstat(old)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.lstat(journal)).rejects.toMatchObject({ code: 'ENOENT' });
  const kept = (await fs.readdir(m.root)).find((name) => name.startsWith('srv.restore-verwaist-'));
  expect(await fs.readFile(path.join(m.root, kept!, 'welt.txt'), 'utf8')).toBe('alt');
});

const { commitRestore, finishRestore } = await import('./restoreRecovery.js');

async function vorbereitet() {
  const { dir, old, stage, journal } = restorePaths('srv');
  await fs.mkdir(path.join(dir, 'world'), { recursive: true });
  await fs.writeFile(path.join(dir, 'world/level.dat'), 'welt');
  await fs.writeFile(path.join(dir, 'alt.txt'), 'alt');
  await fs.mkdir(stage, { recursive: true });
  await fs.writeFile(path.join(stage, 'neu.txt'), 'neu');
  return { dir, old, stage, journal };
}

it('hängt übernommene Ordner beim Austausch um und merkt sie sich im Journal', async () => {
  const { dir, old, journal } = await vorbereitet();
  await commitRestore('srv', ['world']);
  expect(await fs.readFile(path.join(dir, 'world/level.dat'), 'utf8')).toBe('welt');
  expect(await fs.readFile(path.join(dir, 'neu.txt'), 'utf8')).toBe('neu');
  await expect(fs.lstat(path.join(old, 'world'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.parse(await fs.readFile(journal, 'utf8')).moved).toEqual(['world']);
  await finishRestore('srv');
  expect(await fs.readFile(path.join(dir, 'world/level.dat'), 'utf8')).toBe('welt');
});

it('legt sie beim Zurückrollen zurück, bevor der neue Stand gelöscht wird', async () => {
  const { dir, old } = await vorbereitet();
  await commitRestore('srv', ['world']);
  await recoverInterruptedRestore('srv');
  expect(await fs.readFile(path.join(dir, 'world/level.dat'), 'utf8')).toBe('welt');
  expect(await fs.readFile(path.join(dir, 'alt.txt'), 'utf8')).toBe('alt');
  await expect(fs.lstat(path.join(dir, 'neu.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.lstat(old)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rollt auch einen mitten im Umhängen abgebrochenen Austausch sauber zurück', async () => {
  const { dir, old, stage, journal } = await vorbereitet();
  await fs.mkdir(path.join(dir, 'karte'), { recursive: true });
  await fs.writeFile(path.join(dir, 'karte/k.bin'), 'k');
  // Stand wie nach einem Absturz: Ordner getauscht, erst einer von zwei umgehängt.
  await fs.writeFile(journal, JSON.stringify({ committed: false, at: Date.now(), moved: ['world', 'karte'] }));
  await fs.rename(dir, old);
  await fs.rename(stage, dir);
  await fs.rename(path.join(old, 'world'), path.join(dir, 'world'));
  await recoverInterruptedRestore('srv');
  expect(await fs.readFile(path.join(dir, 'world/level.dat'), 'utf8')).toBe('welt');
  expect(await fs.readFile(path.join(dir, 'karte/k.bin'), 'utf8')).toBe('k');
});

it('löscht nichts, wenn ein Ordner in beiden Ständen liegt', async () => {
  const { dir, old } = await vorbereitet();
  await commitRestore('srv', ['world']);
  await fs.mkdir(path.join(old, 'world'), { recursive: true });
  await expect(recoverInterruptedRestore('srv')).rejects.toThrow('von Hand prüfen');
  expect(await fs.readFile(path.join(dir, 'world/level.dat'), 'utf8')).toBe('welt');
});

it('tauscht nicht, wenn der neue Stand den Ordner schon enthält oder der Name ein Pfad ist', async () => {
  const { dir, stage } = await vorbereitet();
  await expect(commitRestore('srv', ['../fremd'])).rejects.toThrow('Ungültiger Ordnername');
  await fs.mkdir(path.join(stage, 'world'));
  await expect(commitRestore('srv', ['world'])).rejects.toThrow('existiert im neuen Stand bereits');
  expect(await fs.readFile(path.join(dir, 'alt.txt'), 'utf8')).toBe('alt');
  expect(await fs.readFile(path.join(dir, 'world/level.dat'), 'utf8')).toBe('welt');
});
