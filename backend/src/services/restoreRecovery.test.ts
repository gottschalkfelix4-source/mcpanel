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
