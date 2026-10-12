import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ root: '', user: {} as any, servers: {} as Record<string, any>, rights: [] as string[], remaining: Infinity, audit: vi.fn() }));
vi.mock('../config.js', () => ({ config: { jwtSecret: 'test' }, serverDir: (id: string) => path.join(m.root, id) }));
vi.mock('../db.js', () => ({ prisma: {
  user: { findUnique: async () => m.user },
  server: { findUnique: async ({ where }: any) => m.servers[where.id], findMany: async () => Object.values(m.servers) },
  serverMember: { findUnique: async () => ({ permissions: m.rights }) },
  auditLog: { create: m.audit },
} }));
vi.mock('./quota.js', () => ({ remainingDiskBytes: async () => m.remaining }));
vi.mock('./diskUsage.js', () => ({ invalidateDiskUsage: vi.fn() }));
const { SftpFiles, sftpLocation } = await import('./sftpFiles.js');
const { withServerOperation } = await import('./operations.js');
let session: InstanceType<typeof SftpFiles>;
const target = () => path.join(m.root, 'a', 'welt.dat');

beforeEach(async () => {
  m.root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-sftp-'));
  m.user = { id: 'user', role: 'USER', active: true, sessionVersion: 0 };
  m.servers = { a: { id: 'a', ownerId: 'other' }, b: { id: 'b', ownerId: 'other' } };
  m.rights = ['files.read', 'files.write'];
  m.remaining = Infinity;
  m.audit.mockResolvedValue({});
  await fs.mkdir(path.join(m.root, 'a'));
  await fs.mkdir(path.join(m.root, 'b'));
  await fs.writeFile(target(), 'Bestehende Welt');
  session = new SftpFiles(m.user);
});
afterEach(async () => { await session.dispose(); await fs.rm(m.root, { recursive: true, force: true }); });

it('hält bestehende Dateien während des Uploads unverändert und ersetzt erst bei CLOSE', async () => {
  const handle = await session.open('/a/welt.dat', 2 | 8 | 16);
  await session.write(handle, 5, Buffer.from('Welt'));
  await session.write(handle, 0, Buffer.from('Neue '));
  expect(await fs.readFile(target(), 'utf8')).toBe('Bestehende Welt');
  await session.close(handle);
  expect(await fs.readFile(target(), 'utf8')).toBe('Neue Welt');
  expect(await fs.readdir(path.dirname(target()))).toEqual(['welt.dat']);
});
it('bewahrt den Altbestand bei Verbindungsabbruch und gibt die Serversperre frei', async () => {
  const handle = await session.open('/a/welt.dat', 26);
  await session.write(handle, 0, Buffer.from('Unvollständig'));
  await expect(withServerOperation('a', 'Sicherung', async () => {})).rejects.toThrow('SFTP-Upload');
  await session.dispose();
  expect(await fs.readFile(target(), 'utf8')).toBe('Bestehende Welt');
  await expect(withServerOperation('a', 'Sicherung', async () => {})).resolves.toBeUndefined();
});
it('beginnt während einer Sicherung keinen SFTP-Upload', async () => {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const done = new Promise<void>((resolve) => { release = resolve; });
  const backup = withServerOperation('a', 'Sicherung', async () => { entered(); await done; });
  await ready;
  try { await expect(session.open('/a/welt.dat', 26)).rejects.toThrow('Sicherung'); }
  finally { release(); await backup; }
  expect(await fs.readFile(target(), 'utf8')).toBe('Bestehende Welt');
});
it('verweigert Schreibzugriffe für Mitglieder mit Leserechten', async () => {
  m.rights = ['files.read'];
  const handle = await session.open('/a/welt.dat', 1);
  expect((await session.read(handle, 0, 100)).toString()).toBe('Bestehende Welt');
  await expect(session.open('/a/welt.dat', 26)).rejects.toThrow('Berechtigung');
  await session.close(handle);
});
it('beachtet Rechteentzug auch bei einer bereits geöffneten Datei', async () => {
  const handle = await session.open('/a/welt.dat', 1);
  m.rights = [];
  await expect(session.read(handle, 0, 100)).rejects.toThrow('Berechtigung');
});
it('verwirft einen Upload, wenn das Konto vor CLOSE deaktiviert wird', async () => {
  const handle = await session.open('/a/welt.dat', 26);
  await session.write(handle, 0, Buffer.from('Neue Welt'));
  m.user.active = false;
  await expect(session.close(handle)).rejects.toThrow('widerrufen');
  expect(await fs.readFile(target(), 'utf8')).toBe('Bestehende Welt');
});
it('widerruft offene Dateizugriffe nach einem Passwortwechsel', async () => {
  session = new SftpFiles({ id: m.user.id, sessionVersion: 0 });
  const handle = await session.open('/a/welt.dat', 1);
  m.user.sessionVersion++;
  await expect(session.read(handle, 0, 100)).rejects.toThrow('widerrufen');
});
it('verhindert Überschreitung des Kontingents ohne Verlust des Altbestands', async () => {
  m.remaining = 0;
  const handle = await session.open('/a/welt.dat', 26);
  await expect(session.write(handle, 0, Buffer.alloc(1024))).rejects.toThrow('Speicherkontingent');
  await expect(session.close(handle)).rejects.toThrow('abgebrochen');
  expect(await fs.readFile(target(), 'utf8')).toBe('Bestehende Welt');
});
it('unterstützt das Fortsetzen einer vorhandenen Datei', async () => {
  const handle = await session.open('/a/welt.dat', 2);
  await session.write(handle, 0, Buffer.from('Andere'));
  await session.close(handle);
  expect(await fs.readFile(target(), 'utf8')).toBe('Andereende Welt');
});
it('verweigert serverübergreifendes Verschieben und Änderung der Wurzel', async () => {
  await expect(session.mutate('/a/welt.dat', 'rename', '/b/welt.dat')).rejects.toThrow('zwischen Servern');
  await expect(session.mutate('/a', 'remove')).rejects.toThrow('Serververzeichnisse');
  await expect(session.mutate('/', 'mkdir')).rejects.toThrow('Serververzeichnisse');
});
it('verhindert Pfadflucht und Zugriff auf interne Upload-Dateien', async () => {
  for (const invalid of ['/a/../../postgres', '/a/../b/welt.dat', '/a\\welt.dat', '/a/.sftp-upload-x/content', '/a/\0']) {
    expect(() => sftpLocation(invalid)).toThrow('Ungültiger');
  }
  await expect(session.stat('/postgres/password')).rejects.toThrow('Server nicht gefunden');
});
it('verweigert Symlinks auf Dateien außerhalb des Serververzeichnisses', async () => {
  const outside = path.join(m.root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret'), 'Privat');
  // Junctions benötigen unter Windows keine zusätzlichen Symlink-Rechte.
  await fs.symlink(outside, path.join(m.root, 'a', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(session.open('/a/link/secret', 1)).rejects.toThrow('Symbolische Links');
  await expect(session.open('/a/link/secret', 26)).rejects.toThrow('Symbolische Links');
});
it('blendet unfertige Uploads und Server ohne Dateirechte aus', async () => {
  const handle = await session.open('/a/welt.dat', 26);
  expect((await session.list('/a')).map((item) => item.name)).toEqual(['welt.dat']);
  await session.close(handle, false);
  m.rights = [];
  expect(await session.list('/')).toEqual([]);
});
it('verhindert, dass ein nur zum Schreiben geöffnetes Handle Dateien liest', async () => {
  const handle = await session.open('/a/welt.dat', 26);
  await expect(session.read(handle, 0, 100)).rejects.toThrow('Lesen');
  await session.close(handle, false);
});
it.skipIf(process.platform === 'win32')('erhält beim Ersetzen die bisherigen UNIX-Dateirechte', async () => {
  await fs.chmod(target(), 0o640);
  const before = await fs.stat(target());
  const handle = await session.open('/a/welt.dat', 26);
  await session.write(handle, 0, Buffer.from('Neue Welt'));
  await session.close(handle);
  const after = await fs.stat(target());
  expect(after.mode & 0o777).toBe(0o640);
  expect([after.uid, after.gid]).toEqual([before.uid, before.gid]);
});
