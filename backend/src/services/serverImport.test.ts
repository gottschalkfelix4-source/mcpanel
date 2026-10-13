import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ root: '', state: 'stopped', start: vi.fn(), ready: vi.fn(), backup: vi.fn(), recreate: vi.fn(), update: vi.fn(), stop: vi.fn() }));
vi.mock('../config.js', () => ({ serverDir: (id: string) => path.join(m.root, 'servers', id), serverBackupDir: () => path.join(m.root, 'backups') }));
vi.mock('../db.js', () => ({ prisma: { server: { update: m.update, findUniqueOrThrow: async () => ({ id: 'neu', rconPassword: 'neues-panel-passwort' }) } } }));
vi.mock('./docker.js', () => ({ getState: async () => ({ state: m.state }), start: m.start, stop: m.stop, ensureImage: vi.fn(), imageForServer: () => 'java21', recreateContainer: m.recreate }));
vi.mock('./serverStartup.js', () => ({ waitForServerReady: m.ready }));
vi.mock('./diskUsage.js', () => ({ invalidateDiskUsage: vi.fn() }));
vi.mock('./backups.js', () => ({ createBackup: m.backup }));
vi.mock('./files.js', () => ({ dirSize: async () => 0 }));
import { inspectServerZip, extractServerZip, importServerZip, importSchema } from './serverImport.js';
const task = () => ({ id: 'task', update: vi.fn(async () => {}), log: vi.fn(async () => {}), done: vi.fn(async () => {}), fail: vi.fn(async () => {}) });
const request = () => importSchema.parse({ name: 'Mein Server', type: 'PAPER', mcVersion: '1.20.1' });
const directory = () => path.join(m.root, 'servers/neu');
async function fixture(prefix = '', extra: Record<string, string> = {}) {
  const zip = new AdmZip();
  for (const [name, data] of Object.entries({ 'server.properties': 'level-name=meine-welt\nonline-mode=true\nrcon.password=alt\nserver-port=25599\n',
    'meine-welt/level.dat': 'Originalwelt', 'meine-welt/playerdata/spieler.dat': 'Spielerdaten', 'mods/beispiel.jar': 'Mod', 'plugins/beispiel.jar': 'Plugin',
    'ops.json': '[{"name":"Spieler"}]', 'config/einstellung.toml': 'Wert=1', ...extra })) zip.addFile(prefix + name, Buffer.from(data));
  const file = path.join(m.root, 'server.zip'); await fs.writeFile(file, zip.toBuffer()); return file;
}
beforeEach(async () => {
  vi.clearAllMocks(); m.state = 'stopped'; m.backup.mockResolvedValue({ name: 'Sicherheitsbackup' }); m.recreate.mockResolvedValue(undefined); m.update.mockImplementation(async ({ data }: any) => ({ id: 'neu', ...data })); m.ready.mockResolvedValue(undefined);
  m.root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-import-'));
  await fs.mkdir(directory(), { recursive: true }); await fs.writeFile(path.join(directory(), 'eula.txt'), 'eula=true\n');
});
afterEach(async () => fs.rm(m.root, { recursive: true, force: true }));

it.each(['', 'Server/', 'Sicherung/Server/'])('übernimmt Welt, Spieler, Mods und Plugins aus dem ZIP mit Wurzel %s', async prefix => {
  const file = await fixture(prefix, { 'startserver.sh': 'unbekanntes-startkommando', 'user_jvm_args.txt': '-Xmx16G' });
  const plan = await inspectServerZip(file);
  await importServerZip('neu', file, plan, request(), task());
  expect(await fs.readFile(path.join(directory(), 'meine-welt/level.dat'), 'utf8')).toBe('Originalwelt');
  expect(await fs.readFile(path.join(directory(), 'meine-welt/playerdata/spieler.dat'), 'utf8')).toBe('Spielerdaten');
  expect(await fs.readFile(path.join(directory(), 'mods/beispiel.jar'), 'utf8')).toBe('Mod');
  expect(await fs.readFile(path.join(directory(), 'plugins/beispiel.jar'), 'utf8')).toBe('Plugin');
  const properties = await fs.readFile(path.join(directory(), 'server.properties'), 'utf8');
  expect(properties).toContain('level-name=meine-welt'); expect(properties).toContain('rcon.password=neues-panel-passwort');
  expect(properties.endsWith('query.port=25565\n')).toBe(true);
  const stored = (await fs.readdir(directory())).find(n => n.startsWith('import-startdateien-'))!;
  expect(await fs.readFile(path.join(directory(), stored, 'user_jvm_args.txt'), 'utf8')).toBe('-Xmx16G');
  expect(m.start).not.toHaveBeenCalled();
});

it('überschreibt niemals einen vorhandenen Serverbestand', async () => {
  await fs.writeFile(path.join(directory(), 'server.properties'), 'bestehend');
  const file = await fixture();
  await expect(importServerZip('neu', file, await inspectServerZip(file), request(), task())).rejects.toMatchObject({ statusCode: 409 });
  expect(await fs.readFile(path.join(directory(), 'server.properties'), 'utf8')).toBe('bestehend');
});

it('verweigert einen Import in einen inzwischen gestarteten Server', async () => {
  m.state = 'running'; const file = await fixture();
  await expect(importServerZip('neu', file, await inspectServerZip(file), request(), task())).rejects.toMatchObject({ statusCode: 409 });
});

it('behält die importierte Welt auch bei einem fehlgeschlagenen Start', async () => {
  m.ready.mockRejectedValueOnce(new Error('Start fehlgeschlagen')); const file = await fixture();
  await expect(importServerZip('neu', file, await inspectServerZip(file), { ...request(), startAfter: true }, task())).rejects.toThrow('Start fehlgeschlagen');
  expect(await fs.readFile(path.join(directory(), 'meine-welt/level.dat'), 'utf8')).toBe('Originalwelt');
});

it('erkennt ungültige ZIPs und überschrittene Entpackgrenzen', async () => {
  const file = await fixture();
  await expect(inspectServerZip(file, 4)).rejects.toThrow('Speicher');
  await fs.writeFile(file, 'Kein ZIP'); await expect(inspectServerZip(file)).rejects.toThrow('ZIP');
});

it('weist manipulierte Pfadausbrüche ab, bevor Dateien geschrieben werden', async () => {
  const file = await fixture('', { 'xx/ausbruch': 'Gefahr' });
  const bytes = await fs.readFile(file); const needle = Buffer.from('xx/ausbruch');
  for (let at = bytes.indexOf(needle); at >= 0; at = bytes.indexOf(needle, at + 1)) Buffer.from('../ausbruch').copy(bytes, at);
  await fs.writeFile(file, bytes); await expect(inspectServerZip(file)).rejects.toThrow();
  expect(await fs.readdir(directory())).toEqual(['eula.txt']);
});

it('weist Symlinks im ZIP ab', async () => {
  const file = await fixture(); const zip = new AdmZip(file);
  zip.addFile('link', Buffer.from('/etc/passwd')); zip.getEntry('link')!.attr = (0o120777 << 16) >>> 0;
  await fs.writeFile(file, zip.toBuffer()); await expect(inspectServerZip(file)).rejects.toThrow('Links');
});

it('weist mehrdeutige Serverwurzeln und doppelte Pfade ab', async () => {
  const file = await fixture('eins/', { 'Server.properties': 'anders' });
  await expect(inspectServerZip(file)).rejects.toThrow('doppelte');
  const zip = new AdmZip(); zip.addFile('eins/server.properties', Buffer.from('a')); zip.addFile('zwei/server.properties', Buffer.from('b'));
  await fs.writeFile(file, zip.toBuffer()); await expect(inspectServerZip(file)).rejects.toThrow('eindeutigen');
});

it('erkennt falsche CRC-Prüfsummen und rollt die halbfertige Installation zurück', async () => {
  const file = await fixture(); const bytes = await fs.readFile(file); const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE(0, central + 16); await fs.writeFile(file, bytes);
  await expect(importServerZip('neu', file, await inspectServerZip(file), request(), task())).rejects.toThrow('Prüfsumme');
  expect(await fs.readdir(directory())).toEqual(['eula.txt']);
});

it('verhindert Schreiben durch bereits vorhandene Symlinks im Ziel', async () => {
  const file = await fixture(); const target = path.join(m.root, 'ziel'); await fs.mkdir(target);
  await fs.symlink(directory(), path.join(target, 'meine-welt'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(extractServerZip(file, await inspectServerZip(file), target, async () => {})).rejects.toThrow('Links');
  expect(await fs.readdir(directory())).toEqual(['eula.txt']);
});

it('verlangt konkrete Minecraft- und Loader-Versionen ohne administrative Zusatzfelder', () => {
  expect(() => importSchema.parse({ name: 'Server', type: 'FORGE', mcVersion: '1.20.1' })).toThrow();
  expect(() => importSchema.parse({ name: 'Server', type: 'PAPER', mcVersion: 'LATEST' })).toThrow();
  expect(() => importSchema.parse({ name: 'Server', type: 'PAPER', mcVersion: '1.20.1', ownerId: 'fremd' })).toThrow();
});

it('sichert den bisherigen Server vor Import und verändert keine Besitzer oder Rechte', async () => {
  await fs.writeFile(path.join(directory(), 'alte-welt.dat'), 'Bisherige Welt');
  m.backup.mockImplementationOnce(async () => {
    expect(await fs.readFile(path.join(directory(), 'alte-welt.dat'), 'utf8')).toBe('Bisherige Welt');
    return { name: 'Sicherheitsbackup' };
  });
  const file = await fixture();
  await importServerZip('neu', file, await inspectServerZip(file), request(), task(), { id: 'mitglied', isAdmin: false });
  expect(m.backup).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ createdById: 'mitglied' }));
  expect(await fs.readFile(path.join(directory(), 'meine-welt/level.dat'), 'utf8')).toBe('Originalwelt');
  const data = m.update.mock.calls[0][0].data;
  expect(data).not.toHaveProperty('ownerId'); expect(data).not.toHaveProperty('members'); expect(data).not.toHaveProperty('quotaMemoryMb');
});
it('erhält bei Backupfehler sämtliche bisherigen Dateien', async () => {
  await fs.writeFile(path.join(directory(), 'alte-welt.dat'), 'Bisherige Welt');
  m.backup.mockRejectedValueOnce(new Error('Sicherung fehlgeschlagen'));
  const file = await fixture();
  await expect(importServerZip('neu', file, await inspectServerZip(file), request(), task(), { id: 'mitglied', isAdmin: false })).rejects.toThrow('Sicherung fehlgeschlagen');
  expect(await fs.readFile(path.join(directory(), 'alte-welt.dat'), 'utf8')).toBe('Bisherige Welt');
  expect(m.update).not.toHaveBeenCalled();
});
it('stellt bei Containerfehler den bisherigen Serverbestand wieder her', async () => {
  await fs.writeFile(path.join(directory(), 'alte-welt.dat'), 'Bisherige Welt');
  m.recreate.mockRejectedValueOnce(new Error('Containerfehler'));
  const file = await fixture();
  await expect(importServerZip('neu', file, await inspectServerZip(file), request(), task(), { id: 'mitglied', isAdmin: false })).rejects.toThrow('Containerfehler');
  expect(await fs.readFile(path.join(directory(), 'alte-welt.dat'), 'utf8')).toBe('Bisherige Welt');
  expect(m.recreate).toHaveBeenCalledTimes(2);
});
