import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ root: '', source: {} as any, target: {} as any, create: vi.fn(), remove: vi.fn(), rcon: vi.fn(), state: 'stopped', recreate: vi.fn() }));
vi.mock('../db.js', () => ({ prisma: { server: {
  findUniqueOrThrow: async () => m.source,
  update: async ({ data }: any) => (m.target = { ...m.target, ...data }),
} } }));
vi.mock('../config.js', () => ({ serverDir: (id: string) => path.join(m.root, id) }));
vi.mock('./serverManager.js', () => ({ createServer: m.create, deleteServer: m.remove }));
vi.mock('./docker.js', () => ({ getState: async () => ({ state: m.state }), recreateContainer: m.recreate }));
vi.mock('./rcon.js', () => ({ rconCommand: m.rcon }));
import { cloneServer } from './serverClone.js';
const task = () => ({ id: 'task', update: vi.fn(async () => {}), log: vi.fn(async () => {}), done: vi.fn(async () => {}), fail: vi.fn(async () => {}) });
beforeEach(async () => {
  vi.resetAllMocks(); m.state = 'stopped'; m.root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-kopie-'));
  m.source = { id: 'a', name: 'Quelle', ownerId: 'besitzer', type: 'FABRIC', mcVersion: '1.20.1', memoryMb: 2048,
    extraEnv: { TYPE: 'FABRIC', RCON_PASSWORD: 'quell-passwort', WORLD: 'quell-welt' }, modpackProjectId: 'paket',
    quotaDiskMb: 0, quotaBackups: 3, quotaMemoryMb: 4096 };
  for (const sub of ['mods', 'meinewelt', 'meinewelt_nether']) await fs.mkdir(path.join(m.root, 'a', sub), { recursive: true });
  await fs.writeFile(path.join(m.root, 'a/server.properties'), 'level-name=meinewelt\nrcon.password=quell-passwort\nserver-ip=192.168.1.1\n');
  await fs.writeFile(path.join(m.root, 'a/mods/test.jar'), 'mod-inhalt');
  await fs.writeFile(path.join(m.root, 'a/meinewelt/level.dat'), 'welt-inhalt');
  m.create.mockImplementation(async input => {
    await fs.mkdir(path.join(m.root, 'kopie')); m.target = { ...m.source, ...input, extraEnv: input.extraEnv,
      id: 'kopie', port: 25600, rconPort: 25575, rconPassword: 'kopie-passwort' }; return m.target;
  });
  m.remove.mockImplementation(async server => fs.rm(path.join(m.root, server.id), { recursive: true, force: true }));
  m.rcon.mockResolvedValue('OK');
});
afterEach(async () => fs.rm(m.root, { recursive: true, force: true }));
it('kopiert ohne Welt, behält die Modpack-Bindung und trennt Dateien und Zugangsdaten', async () => {
  const copy = await cloneServer(m.source, { name: 'Testkopie', includeWorld: false }, task());
  const environment = copy.extraEnv as Record<string, string>;
  expect(copy.modpackProjectId).toBe('paket'); expect(environment.WORLD).toBeUndefined();
  expect(environment.RCON_PASSWORD).toBeUndefined(); expect(m.rcon).not.toHaveBeenCalled();
  await expect(fs.stat(path.join(m.root, 'kopie/meinewelt'))).rejects.toMatchObject({ code: 'ENOENT' });
  const properties = await fs.readFile(path.join(m.root, 'kopie/server.properties'), 'utf8');
  expect(properties).toContain('rcon.password=kopie-passwort'); expect(properties).not.toContain('192.168.1.1');
  await fs.writeFile(path.join(m.root, 'kopie/mods/test.jar'), 'geändert');
  expect(await fs.readFile(path.join(m.root, 'a/mods/test.jar'), 'utf8')).toBe('mod-inhalt');
});
it('speichert eine laufende Welt konsistent und schaltet das Speichern anschließend wieder ein', async () => {
  m.state = 'running'; await cloneServer(m.source, { name: 'Mit Welt', includeWorld: true }, task());
  expect(m.rcon.mock.calls.map(call => call[1])).toEqual(['save-off', 'save-all flush', 'save-on']);
  expect(await fs.readFile(path.join(m.root, 'kopie/meinewelt/level.dat'), 'utf8')).toBe('welt-inhalt');
});
it('legt bei einem Speicherfehler keine Kopie an und versucht trotzdem save-on', async () => {
  m.state = 'running'; m.rcon.mockRejectedValueOnce(new Error('Speicherfehler'));
  await expect(cloneServer(m.source, { name: 'Test', includeWorld: true }, task())).rejects.toThrow('Speicherfehler');
  expect(m.create).not.toHaveBeenCalled(); expect(m.rcon).toHaveBeenLastCalledWith(m.source, 'save-on');
});
it('verwirft eine Kopie mit Links vollständig und erhält die Quelle', async () => {
  await fs.mkdir(path.join(m.root, 'privat'));
  await fs.symlink(path.join(m.root, 'privat'), path.join(m.root, 'a/verknuepfung'), 'junction');
  await expect(cloneServer(m.source, { name: 'Test', includeWorld: false }, task())).rejects.toThrow(/Links|Link/);
  expect(m.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'kopie' }), true);
  expect(await fs.readFile(path.join(m.root, 'a/mods/test.jar'), 'utf8')).toBe('mod-inhalt');
});
