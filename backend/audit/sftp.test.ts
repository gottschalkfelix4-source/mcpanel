/** Echter SSH/SFTP-Verkehr mit Wegwerf-Dateien und gemockter Datenbank, ohne Produktivzugriff. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Client, type SFTPWrapper } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ root: '', user: {} as any, rights: ['files.read', 'files.write'] }));
vi.mock('../src/config.js', () => ({
  config: { get dataRoot() { return m.root; }, jwtSecret: 'test', sftp: { enabled: true, port: 0, publicPort: 0, host: '127.0.0.1' } },
  serverDir: (id: string) => path.join(m.root, 'servers', id),
}));
vi.mock('../src/db.js', () => ({ prisma: {
  user: { findUnique: async () => ({ ...m.user }), findFirst: async ({ where }: any) =>
    where.OR.some((value: any) => value.username === m.user.username || value.email === m.user.email) ? { ...m.user } : null },
  server: { findUnique: async ({ where }: any) => where.id === 'a' ? { id: 'a', ownerId: 'other', name: 'Test', quotaDiskMb: 0 } : null,
    findMany: async () => [{ id: 'a', ownerId: 'other', name: 'Test' }] },
  serverMember: { findUnique: async () => ({ permissions: [...m.rights] }) },
  auditLog: { create: async () => ({}) },
} }));
vi.mock('../src/services/quota.js', () => ({ remainingDiskBytes: async () => Infinity }));
vi.mock('../src/services/diskUsage.js', () => ({ invalidateDiskUsage: vi.fn() }));
const { startSftp, stopSftp, getSftpInfo } = await import('../src/services/sftp.js');
const { withServerOperation } = await import('../src/services/operations.js');

describe.skipIf(process.env.AUDIT_SFTP_TESTS !== '1')('SFTP mit echten Client-Verbindungen', () => {
  const clients = new Set<Client>();
  async function connect(password = 'Test-Passwort', username = 'test') {
    const client = new Client();
    clients.add(client);
    await new Promise<void>((resolve, reject) => {
      client.once('error', reject).once('ready', resolve).connect({ host: '127.0.0.1', port: getSftpInfo().port,
        username, password, readyTimeout: 5000,
        hostVerifier: (key) => 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '') === getSftpInfo().fingerprint });
    });
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => client.sftp((err, stream) => err ? reject(err) : resolve(stream)));
    return { client, sftp };
  }
  const open = (sftp: SFTPWrapper, value: string, flags: 'w' | 'r') => new Promise<Buffer>((resolve, reject) => sftp.open(value, flags, (err, handle) => err ? reject(err) : resolve(handle)));
  const write = (sftp: SFTPWrapper, handle: Buffer, data: Buffer, offset = 0) => new Promise<void>((resolve, reject) => sftp.write(handle, data, 0, data.length, offset, (err) => err ? reject(err) : resolve()));
  const close = (sftp: SFTPWrapper, handle: Buffer) => new Promise<void>((resolve, reject) => sftp.close(handle, (err) => err ? reject(err) : resolve()));

  beforeAll(async () => {
    m.root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-sftp-audit-'));
    await fs.mkdir(path.join(m.root, 'servers', 'a'), { recursive: true });
    m.user = { id: 'user', username: 'test', email: 'test@example.com', active: true, role: 'USER', sessionVersion: 0,
      passwordHash: await bcrypt.hash('Test-Passwort', 10) };
    await startSftp(() => {});
  });
  afterAll(async () => {
    for (const client of clients) client.end();
    await stopSftp();
    await fs.rm(m.root, { recursive: true, force: true });
  });
  it('meldet Benutzer mit dem Panel-Passwort an und lehnt falsche Kennwörter ab', async () => {
    await expect(connect('Falsch')).rejects.toThrow();
    const { client } = await connect('Test-Passwort', 'TEST@EXAMPLE.COM');
    client.end();
  });
  it('überträgt Dateien vollständig, listet sie auf und lädt sie wieder herunter', async () => {
    const { sftp, client } = await connect();
    const data = Buffer.alloc(512 * 1024, 42);
    const handle = await open(sftp, '/a/upload.jar', 'w');
    for (let offset = 0; offset < data.length; offset += 32768) await write(sftp, handle, data.subarray(offset, offset + 32768), offset);
    await close(sftp, handle);
    const listing = await new Promise<any>((resolve, reject) => sftp.readdir('/a', (err, entries) => err ? reject(err) : resolve(entries)));
    expect(listing.map((item: any) => item.filename)).toContain('upload.jar');
    const received = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      sftp.createReadStream('/a/upload.jar').on('data', (chunk: Buffer) => chunks.push(chunk)).on('error', reject).on('end', () => resolve(Buffer.concat(chunks)));
    });
    expect(received).toEqual(data);
    client.end();
  });
  it('verwirft abgebrochene Übertragungen und entsperrt den Server', async () => {
    const target = path.join(m.root, 'servers', 'a', 'welt.dat');
    await fs.writeFile(target, 'Alte Welt');
    const { client, sftp } = await connect();
    const handle = await open(sftp, '/a/welt.dat', 'w');
    await write(sftp, handle, Buffer.from('Abbruch'));
    client.end();
    await vi.waitFor(async () => {
      await withServerOperation('a', 'Prüfung', async () => {});
      expect(await fs.readFile(target, 'utf8')).toBe('Alte Welt');
      expect((await fs.readdir(path.dirname(target))).some((name) => name.startsWith('.sftp-upload-'))).toBe(false);
    }, { timeout: 5000 });
  });
  it('beachtet neue Leserechte auch innerhalb einer offenen Verbindung', async () => {
    const { client, sftp } = await connect();
    m.rights = ['files.read'];
    await expect(open(sftp, '/a/verboten.txt', 'w')).rejects.toThrow('Berechtigung');
    m.rights = ['files.read', 'files.write'];
    client.end();
  });
  it('verweigert Shell-Ausführung und Portweiterleitungen', async () => {
    const { client } = await connect();
    await expect(new Promise((resolve, reject) => client.exec('id', (err, stream) => err ? reject(err) : resolve(stream)))).rejects.toThrow();
    await expect(new Promise((resolve, reject) => client.forwardOut('127.0.0.1', 0, '127.0.0.1', 3000, (err, stream) => err ? reject(err) : resolve(stream)))).rejects.toThrow();
    client.end();
  });
  it('behält den Hostschlüssel bei einem Dienstneustart', async () => {
    const previous = getSftpInfo().fingerprint;
    await stopSftp();
    await startSftp(() => {});
    expect(getSftpInfo().fingerprint).toBe(previous);
  });
});
