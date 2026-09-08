import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ root: '', update: vi.fn() }));
vi.mock('../src/config.js', () => ({ serverDir: (id: string) => path.join(m.root, id) }));
vi.mock('../src/db.js', () => ({ prisma: { server: { update: m.update } } }));
const { recoverInterruptedRestore, commitRestore, restorePaths, finishRestore, saveRestoreMetadata } = await import('../src/services/restoreRecovery.js');
beforeEach(async () => { m.root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-recovery-')); });
afterEach(async () => { await fs.rm(m.root, { recursive: true, force: true }); vi.clearAllMocks(); });

it('BUG-10: interrupted atomic swap restores the complete original directory', async () => {
  const p = restorePaths('a');
  await fs.mkdir(p.dir); await fs.mkdir(p.stage);
  await fs.writeFile(path.join(p.dir, 'world.dat'), 'original');
  await fs.writeFile(path.join(p.stage, 'world.dat'), 'restored');
  await saveRestoreMetadata('a', { mcVersion: '1.20.1' });
  await commitRestore('a');
  await recoverInterruptedRestore('a');
  expect(await fs.readFile(path.join(p.dir, 'world.dat'), 'utf8')).toBe('original');
  expect(m.update).toHaveBeenCalledWith({ where: { id: 'a' }, data: { mcVersion: '1.20.1' } });
});

it('a completed swap survives recovery without reverting its world', async () => {
  const p = restorePaths('a');
  await fs.mkdir(p.dir); await fs.mkdir(p.stage);
  await fs.writeFile(path.join(p.stage, 'world.dat'), 'restored');
  await commitRestore('a'); await finishRestore('a'); await recoverInterruptedRestore('a');
  expect(await fs.readFile(path.join(p.dir, 'world.dat'), 'utf8')).toBe('restored');
});

it('BUG-10: legacy partial stash preserves originals not yet moved', async () => {
  const p = restorePaths('a');
  await fs.mkdir(path.join(p.dir, '.restore-old'), { recursive: true });
  await fs.writeFile(path.join(p.dir, '.restore-old', 'world.dat'), 'already moved');
  await fs.writeFile(path.join(p.dir, 'config.txt'), 'not moved yet');
  await recoverInterruptedRestore('a');
  const salvage = (await fs.readdir(m.root)).find(name => name.startsWith('a.recovery-'))!;
  expect(await fs.readFile(path.join(m.root, salvage, 'config.txt'), 'utf8')).toBe('not moved yet');
  expect(await fs.readFile(path.join(p.dir, 'config.txt'), 'utf8')).toBe('not moved yet');
  expect(await fs.readFile(path.join(p.dir, 'world.dat'), 'utf8')).toBe('already moved');
});
