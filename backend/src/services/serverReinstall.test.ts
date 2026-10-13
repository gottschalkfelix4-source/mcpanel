import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ root: '', row: {} as any, state: 'running', backup: vi.fn(), recreate: vi.fn(), start: vi.fn(), stop: vi.fn(), ready: vi.fn(), image: vi.fn(), pack: vi.fn() }));
vi.mock('../config.js', () => ({ serverDir: (id: string) => path.join(m.root, id), serverBackupDir: (id: string) => path.join(m.root, 'backups', id) }));
vi.mock('../db.js', () => ({ prisma: { server: {
  findUniqueOrThrow: async () => ({ ...m.row }),
  update: async ({ data }: any) => (m.row = { ...m.row, ...data }),
} } }));
vi.mock('./docker.js', () => ({ getState: async () => ({ state: m.state }), stop: m.stop, start: m.start, recreateContainer: m.recreate, ensureImage: m.image, imageForServer: () => 'java21' }));
vi.mock('./backups.js', () => ({ createBackup: m.backup }));
vi.mock('./modpack.js', () => ({ installModpack: m.pack }));
vi.mock('./diskUsage.js', () => ({ invalidateDiskUsage: vi.fn() }));
vi.mock('./serverStartup.js', () => ({ waitForServerReady: m.ready }));
import { reinstallServer } from './serverReinstall.js';
import { reinstallSchema } from './reinstallationData.js';
import { withServerOperation } from './operations.js';
const task = () => ({ id: 'task', update: vi.fn(async () => {}), log: vi.fn(async () => {}), done: vi.fn(async () => {}), fail: vi.fn(async () => {}) });
const request = () => reinstallSchema.parse({ name: 'Neu', description: 'Neue Installation', type: 'VANILLA', mcVersion: '1.21.1', memoryMb: 2048 });
const actor = { id: 'besitzer', isAdmin: false };
beforeEach(async () => {
  vi.resetAllMocks(); m.state = 'running'; m.root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-neuinstallation-'));
  m.backup.mockResolvedValue({ name: 'Sicherung', id: 'backup' });
  m.row = { id: 'a', name: 'Alt', description: '', type: 'MODPACK', mcVersion: '1.20.1', memoryMb: 4096, ownerId: 'besitzer', port: 25599,
    rconPort: 25575, rconPassword: 'bestehendes-passwort', quotaMemoryMb: 4096, quotaDiskMb: 0, modpackProjectId: 'alt',
    extraEnv: { TYPE: 'FABRIC', FABRIC_LOADER_VERSION: 'alt', MODS: 'alte-mods', MC_IMAGE: 'admin-image', JVM_OPTS: 'admin-werte', SERVER_PORT: '25565' } };
  for (const sub of ['meinewelt', 'meinewelt_nether', 'config', 'mods', 'plugins', 'libraries']) await fs.mkdir(path.join(m.root, 'a', sub), { recursive: true });
  await fs.writeFile(path.join(m.root, 'a/meinewelt/level.dat'), 'Welt vorher');
  await fs.writeFile(path.join(m.root, 'a/meinewelt_nether/level.dat'), 'Nether vorher');
  await fs.writeFile(path.join(m.root, 'a/server.properties'), 'level-name=meinewelt\nlevel-seed=123\nwhite-list=true\nserver-port=9999\n');
  await fs.writeFile(path.join(m.root, 'a/ops.json'), '["Spieler"]');
  await fs.writeFile(path.join(m.root, 'a/mods/alt.jar'), 'alte Mod');
  await fs.writeFile(path.join(m.root, 'a/server.jar'), 'alter Server');
});
afterEach(async () => fs.rm(m.root, { recursive: true, force: true }));

it('ersetzt alte Software, erhält Welt, Nether, Spielerrechte, Ports und Admin-Vorgaben', async () => {
  await reinstallServer('a', request(), task(), actor);
  expect(m.backup.mock.invocationCallOrder[0]).toBeLessThan(m.recreate.mock.invocationCallOrder[0]);
  expect(await fs.readFile(path.join(m.root, 'a/meinewelt/level.dat'), 'utf8')).toBe('Welt vorher');
  expect(await fs.readFile(path.join(m.root, 'a/meinewelt_nether/level.dat'), 'utf8')).toBe('Nether vorher');
  expect(await fs.readFile(path.join(m.root, 'a/ops.json'), 'utf8')).toBe('["Spieler"]');
  for (const file of ['mods', 'plugins', 'config', 'libraries', 'server.jar']) await expect(fs.stat(path.join(m.root, 'a', file))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(m.row).toMatchObject({ name: 'Neu', type: 'VANILLA', modpackProjectId: null, ownerId: 'besitzer', port: 25599, rconPassword: 'bestehendes-passwort' });
  expect(m.row.extraEnv).toEqual({ MC_IMAGE: 'admin-image', JVM_OPTS: 'admin-werte', SERVER_PORT: '25565' });
  expect(m.start).not.toHaveBeenCalled();
});

it('beginnt nur bei ausdrücklicher Auswahl ohne Welt und legt trotzdem vorher eine Sicherung an', async () => {
  await reinstallServer('a', { ...request(), keepWorld: false }, task(), actor);
  await expect(fs.stat(path.join(m.root, 'a/meinewelt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(path.join(m.root, 'a/server.properties'), 'utf8')).not.toContain('level-seed');
  expect(m.backup).toHaveBeenCalledTimes(1);
});

it.each(['running', 'stopped'])('holt Dateien und Metadaten bei einem Containerfehler zurück (vorher %s)', async state => {
  m.state = state; m.recreate.mockRejectedValueOnce(new Error('Containerfehler'));
  await expect(reinstallServer('a', request(), task(), actor)).rejects.toThrow('Containerfehler');
  expect(await fs.readFile(path.join(m.root, 'a/mods/alt.jar'), 'utf8')).toBe('alte Mod');
  expect(m.row).toMatchObject({ name: 'Alt', memoryMb: 4096, type: 'MODPACK', modpackProjectId: 'alt' });
  expect(m.start).toHaveBeenCalledTimes(state === 'running' ? 1 : 0);
});

it('stellt auch bei fehlgeschlagener Startprüfung den vorherigen Stand wieder her', async () => {
  m.ready.mockRejectedValueOnce(new Error('Minecraft antwortet nicht'));
  await expect(reinstallServer('a', { ...request(), startAfter: true }, task(), actor)).rejects.toThrow('Minecraft antwortet nicht');
  expect(m.row.type).toBe('MODPACK');
  expect(await fs.readFile(path.join(m.root, 'a/mods/alt.jar'), 'utf8')).toBe('alte Mod');
});

it('verändert bei fehlgeschlagener Sicherung keine Dateien und startet den vorher laufenden Server wieder', async () => {
  m.backup.mockRejectedValueOnce(new Error('Sicherung fehlgeschlagen'));
  await expect(reinstallServer('a', request(), task(), actor)).rejects.toThrow('Sicherung fehlgeschlagen');
  expect(await fs.readFile(path.join(m.root, 'a/mods/alt.jar'), 'utf8')).toBe('alte Mod');
  expect(m.row.name).toBe('Alt'); expect(m.start).toHaveBeenCalledTimes(1);
});

it('lehnt unzulässigen RAM vor Sicherung und Stopp ab', async () => {
  await expect(reinstallServer('a', { ...request(), memoryMb: 8192 }, task(), actor)).rejects.toMatchObject({ statusCode: 400 });
  expect(m.stop).not.toHaveBeenCalled(); expect(m.backup).not.toHaveBeenCalled();
});

it('nutzt für Modpacks die sichere Installation mit Pflichtbackup und frischem Datenordner', async () => {
  const body = { ...request(), type: 'MODPACK' as const, modpack: { provider: 'modrinth' as const, projectId: 'neu', versionId: 'version' } };
  await reinstallServer('a', body, task(), actor);
  expect(m.pack).toHaveBeenCalledWith('a', expect.objectContaining({ backupFirst: true, reinstall: expect.objectContaining({ keepWorld: true }), createdById: 'besitzer' }), expect.anything());
});

it('verhindert konkurrierende Dateioperationen während einer Neuinstallation', async () => {
  let release!: () => void;
  const active = withServerOperation('a', 'Sicherung', () => new Promise<void>(resolve => { release = resolve; }));
  await expect(reinstallServer('a', request(), task(), actor)).rejects.toMatchObject({ statusCode: 409 });
  release(); await active; expect(m.stop).not.toHaveBeenCalled();
});

it('weist verlinkte Weltdaten ab und erhält den alten Stand', async () => {
  await fs.mkdir(path.join(m.root, 'privat'));
  await fs.symlink(path.join(m.root, 'privat'), path.join(m.root, 'a/meinewelt/verknuepfung'), 'junction');
  await expect(reinstallServer('a', request(), task(), actor)).rejects.toThrow('Links');
  expect(await fs.readFile(path.join(m.root, 'a/mods/alt.jar'), 'utf8')).toBe('alte Mod');
});
