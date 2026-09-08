/** Regression tests converted from the original bug reproductions. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  root: '',
  update: vi.fn(), findMany: vi.fn(), stop: vi.fn(), recreate: vi.fn(), start: vi.fn(),
}));
vi.mock('../src/config.js', () => ({
  config: { portRange: { min: 25565, max: 25570 } },
  serverDir: (id: string) => path.join(m.root, 'servers', id),
  serverBackupDir: (id: string) => path.join(m.root, 'backups', id),
  serversDir: () => path.join(m.root, 'servers'),
  backupsDir: () => path.join(m.root, 'backups'),
  cacheDir: () => path.join(m.root, 'cache'),
}));
vi.mock('../src/db.js', () => ({ prisma: { server: { update: m.update, findMany: m.findMany } } }));
vi.mock('../src/services/docker.js', () => ({
  getState: async () => ({ state: 'running' }),
  stop: m.stop, recreateContainer: m.recreate, start: m.start,
}));
vi.mock('../src/services/diskUsage.js', () => ({ getDiskUsage: vi.fn(), invalidateDiskUsage: vi.fn() }));
vi.mock('../src/services/playerCount.js', () => ({ getPlayerCount: vi.fn() }));
vi.mock('../src/services/settings.js', () => ({ getPublicHost: async () => 'localhost', getSetting: async () => '' }));

const files = await import('../src/services/files.js');
const props = await import('../src/services/properties.js');
const { downloadToFile } = await import('../src/lib/download.js');
const { allocatePort, updateServerSettings } = await import('../src/services/serverManager.js');
const dir = () => path.join(m.root, 'servers', 'a');

beforeEach(async () => {
  m.root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-audit-'));
  await fs.mkdir(dir(), { recursive: true });
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(m.root, { recursive: true, force: true });
});

it('BUG-01: rejects a symlink for reads AND writes', async () => {
  const outside = path.join(m.root, 'outside.txt');
  await fs.writeFile(outside, 'private fixture');
  await fs.symlink(outside, path.join(dir(), 'link.txt'));
  await expect(files.readFile('a', 'link.txt')).rejects.toThrow('Links');
  await expect(files.writeFile('a', 'link.txt', 'overwritten')).rejects.toThrow('Links');
  expect(await fs.readFile(outside, 'utf8')).toBe('private fixture');
});

it('BUG-02: ZIP cannot write a sibling directory', async () => {
  const zip = new AdmZip();
  zip.addFile('fixture.txt', Buffer.from('escaped'));
  zip.getEntries()[0].entryName = '../a-other/escaped.txt';
  zip.writeZip(path.join(dir(), 'fixture.zip'));
  await expect(files.unzip('a', 'fixture.zip', '/')).rejects.toThrow('Pfad');
  await expect(fs.stat(path.join(m.root, 'servers/a-other/escaped.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('BUG-05: protected RCON password is omitted', async () => {
  await fs.writeFile(path.join(dir(), 'server.properties'), 'rcon.password=fixture-secret\nmotd=hello\n');
  const response = await props.readProperties('a');
  expect(response.extra['rcon.password']).toBeUndefined();
  expect(response.values['rcon.password']).toBeUndefined();
});

it('BUG-06: newline in a value is rejected', async () => {
  await expect(props.saveProperties('a', { motd: 'hello\nrcon.password=changed' })).rejects.toThrow('Ungültiger');
});

it('BUG-12: unchanged extraEnv leaves a running server alone', async () => {
  const server = { id: 'a', extraEnv: {}, memoryMb: 1024, mcVersion: '1.20.1', type: 'PAPER' };
  m.update.mockResolvedValue(server);
  const result = await updateServerSettings(server as never, { extraEnv: {} });
  expect(result.recreated).toBe(false);
  expect(m.stop).not.toHaveBeenCalled();
  expect(m.recreate).not.toHaveBeenCalled();
  expect(m.start).not.toHaveBeenCalled();
});

it('BUG-15: failed HTTP download preserves a pre-existing destination', async () => {
  const destination = path.join(dir(), 'existing.jar');
  await fs.writeFile(destination, 'working mod');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
  await expect(downloadToFile('https://fixture.invalid/mod', destination, { retries: 1 })).rejects.toThrow('503');
  expect(await fs.readFile(destination, 'utf8')).toBe('working mod');
});

it('BUG-19: an explicitly occupied port is rejected', async () => {
  m.findMany.mockResolvedValue([{ port: 25565 }]);
  await expect(allocatePort(25565)).rejects.toThrow('belegt');
});


it('BUG-15/32: interrupted and oversized streams preserve the previous download', async () => {
  const dest = path.join(dir(), 'existing.jar');
  await fs.writeFile(dest, 'old');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1,2])); controller.error(new Error('stream failed')); } }))));
  await expect(downloadToFile('https://fixture.invalid/file', dest, { retries: 1 })).rejects.toThrow('stream failed');
  expect(await fs.readFile(dest, 'utf8')).toBe('old');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('oversized new file')));
  await expect(downloadToFile('https://fixture.invalid/file', dest, { retries: 1, maxBytes: 4 })).rejects.toThrow('Speicherkontingent');
  expect(await fs.readFile(dest, 'utf8')).toBe('old');
});

it('BUG-32: oversized upload is rejected without replacing the original', async () => {
  await fs.writeFile(path.join(dir(), 'upload.txt'), 'old');
  await expect(files.saveUpload('a', '/', 'upload.txt', Readable.from(['too large']), 4)).rejects.toThrow('Speicherkontingent');
  expect(await fs.readFile(path.join(dir(), 'upload.txt'), 'utf8')).toBe('old');
  expect((await fs.readdir(dir())).filter(name => name.startsWith('.upload-'))).toEqual([]);
});
