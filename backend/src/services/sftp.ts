import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Server, utils, type Connection, type SFTPWrapper, type Attributes, type FileEntry } from 'ssh2';
import type { User } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { audit } from '../auth/context.js';
import { HttpError, badRequest } from '../lib/errors.js';
import { SftpFiles, sftpLocation } from './sftpFiles.js';

const STATUS = utils.sftp.STATUS_CODE;
const dummyHash = bcrypt.hashSync('mcpanel-sftp-kein-konto', 10);
let listener: Server | undefined;
let fingerprint = '';
const connections = new Set<Connection>();
const attempts = new Map<string, { count: number; until: number }>();

function attributes(entry: { isDir: boolean; size: number; modified: number }): Attributes {
  return { mode: entry.isDir ? 0o40755 : 0o100644, uid: 0, gid: 0,
    size: entry.size, atime: entry.modified, mtime: entry.modified };
}
function entry(name: string, value: { isDir: boolean; size: number; modified: number }): FileEntry {
  return { filename: name, longname: `${value.isDir ? 'drwxr-xr-x' : '-rw-r--r--'} 1 panel panel ${value.size} Jan 01 00:00 ${name}`, attrs: attributes(value) };
}

export async function verifySftpLogin(login: string, password: string): Promise<User | null> {
  if (!login || login.length > 254 || !password || password.length > 1024) return null;
  const user = await prisma.user.findFirst({ where: { OR: [{ email: login.toLowerCase() }, { username: login }] } });
  const valid = await bcrypt.compare(password, user?.active ? user.passwordHash : dummyHash);
  return user?.active && valid ? user : null;
}

/** Ein öffentlicher Fingerabdruck; private Schlüssel und Passwörter verlassen den Dienst nie. */
export function getSftpInfo() {
  const address = listener?.address();
  const port = config.sftp.publicPort || (address && typeof address !== 'string' ? address.port : config.sftp.port);
  return { enabled: Boolean(listener?.listening), host: config.sftp.host, port, fingerprint };
}

function attachSftp(stream: SFTPWrapper, user: User, touch: () => void) {
  const files = new SftpFiles(user);
  const directories = new Map<string, { path: string; entries: FileEntry[]; offset: number }>();
  let closed = false;
  let pending = 0;
  const respond = (id: number, fn: () => Promise<void>) => {
    touch();
    if (closed) return;
    if (++pending > 128) { --pending; stream.status(id, STATUS.FAILURE, 'Zu viele gleichzeitige Anfragen'); return; }
    void fn().catch((err) => {
      if (closed) return;
      const code = err instanceof HttpError && [401, 403].includes(err.statusCode) ? STATUS.PERMISSION_DENIED
        : (err as NodeJS.ErrnoException).code === 'ENOENT' || (err instanceof HttpError && err.statusCode === 404) ? STATUS.NO_SUCH_FILE : STATUS.FAILURE;
      stream.status(id, code, err instanceof HttpError ? err.message : 'Dateioperation fehlgeschlagen');
    }).finally(() => { --pending; });
  };
  const handleId = (handle: Buffer) => handle.toString('hex');
  const success = (id: number) => { if (!closed) stream.status(id, STATUS.OK); };
  stream.on('REALPATH', (id, value) => respond(id, async () => {
    await files.stat(value);
    const location = sftpLocation(value);
    const canonical = location ? `/${location.serverId}${location.relative === '/' ? '' : location.relative}` : '/';
    stream.name(id, [entry(canonical, await files.stat(value))]);
  }));
  for (const event of ['STAT', 'LSTAT'] as const) stream.on(event, (id: number, value: string) => respond(id, async () => stream.attrs(id, attributes(await files.stat(value)))));
  stream.on('OPENDIR', (id, value) => respond(id, async () => {
    if (directories.size >= 32) throw badRequest('Zu viele offene Ordner');
    const entries = (await files.list(value)).map((item) => entry(item.name, item));
    const handle = crypto.randomBytes(16);
    directories.set(handleId(handle), { path: value, entries, offset: 0 });
    stream.handle(id, handle);
  }));
  stream.on('READDIR', (id, handle) => respond(id, async () => {
    const directory = directories.get(handleId(handle));
    if (!directory) throw badRequest('Ungültige Ordnerverbindung');
    // Auch bereits geöffnete Verzeichnisse verlieren beim Rechteentzug ihren Zugriff.
    await files.stat(directory.path);
    if (!sftpLocation(directory.path)) directory.entries = (await files.list('/')).map((item) => entry(item.name, item));
    const batch = directory.entries.slice(directory.offset, directory.offset + 100);
    directory.offset += batch.length;
    if (batch.length) stream.name(id, batch);
    else stream.status(id, STATUS.EOF);
  }));
  stream.on('OPEN', (id, value, flags) => respond(id, async () => {
    const handle = await files.open(value, flags);
    stream.handle(id, Buffer.from(handle, 'hex'));
  }));
  stream.on('READ', (id, handle, offset, length) => respond(id, async () => {
    const data = await files.read(handleId(handle), offset, length);
    if (data.length) stream.data(id, data); else stream.status(id, STATUS.EOF);
  }));
  stream.on('WRITE', (id, handle, offset, data) => respond(id, async () => { await files.write(handleId(handle), offset, data); success(id); }));
  stream.on('FSTAT', (id, handle) => respond(id, async () => stream.attrs(id, attributes(await files.handleStat(handleId(handle))))));
  stream.on('CLOSE', (id, handle) => respond(id, async () => {
    if (directories.has(handleId(handle))) { await files.user(); directories.delete(handleId(handle)); }
    else await files.close(handleId(handle));
    success(id);
  }));
  stream.on('SETSTAT', (id, value, attrs) => respond(id, async () => { await files.metadata(value, attrs); success(id); }));
  stream.on('FSETSTAT', (id, handle, attrs) => respond(id, async () => { await files.metadata('', attrs, handleId(handle)); success(id); }));
  stream.on('MKDIR', (id, value) => respond(id, async () => { await files.mutate(value, 'mkdir'); success(id); }));
  stream.on('REMOVE', (id, value) => respond(id, async () => { await files.mutate(value, 'remove'); success(id); }));
  stream.on('RMDIR', (id, value) => respond(id, async () => { await files.mutate(value, 'rmdir'); success(id); }));
  stream.on('RENAME', (id, from, to) => respond(id, async () => { await files.mutate(from, 'rename', to); success(id); }));
  for (const event of ['SYMLINK', 'READLINK', 'EXTENDED'] as const) stream.on(event, (id: number) => {
    touch(); stream.status(id, STATUS.OP_UNSUPPORTED, 'Diese SFTP-Funktion wird nicht unterstützt');
  });
  const cleanup = () => { if (closed) return; closed = true; directories.clear(); void files.dispose(); };
  stream.on('close', cleanup);
  stream.on('end', cleanup);
  stream.on('error', cleanup);
  return cleanup;
}

export async function startSftp(log: (message: string) => void = console.info): Promise<void> {
  if (!config.sftp.enabled || listener) return;
  if (!Number.isInteger(config.sftp.port) || config.sftp.port < 0 || config.sftp.port > 65535 ||
      !Number.isInteger(config.sftp.publicPort) || config.sftp.publicPort < 0 || config.sftp.publicPort > 65535) {
    throw badRequest('Ungültiger SFTP-Port');
  }
  await fs.mkdir(config.dataRoot, { recursive: true });
  const keyPath = path.join(config.dataRoot, '.sftp-host-key');
  let key: string;
  try { key = await fs.readFile(keyPath, 'utf8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const generated = utils.generateKeyPairSync('ed25519').private;
    try { await fs.writeFile(keyPath, generated, { mode: 0o600, flag: 'wx' }); }
    catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError; }
    key = await fs.readFile(keyPath, 'utf8');
  }
  const parsed = utils.parseKey(key);
  if (parsed instanceof Error) throw badRequest('Der gespeicherte SFTP-Hostschlüssel ist ungültig');
  fingerprint = 'SHA256:' + crypto.createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '');
  listener = new Server({ hostKeys: [key], ident: 'MCPanel-SFTP' }, (client, info) => {
    if (connections.size >= 64) { client.end(); return; }
    connections.add(client);
    let authenticated: User | null = null;
    let authenticating = false;
    let channelOpen = false;
    let cleanup: (() => void) | undefined;
    let timer = setTimeout(() => client.end(), 30_000);
    timer.unref();
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => client.end(), 5 * 60_000); timer.unref(); };
    client.on('authentication', (context) => {
      if (context.method !== 'password' || authenticating) { context.reject(['password']); return; }
      const now = Date.now();
      for (const [ip, value] of attempts) if (value.until <= now) attempts.delete(ip);
      const limit = attempts.get(info.ip) ?? { count: 0, until: now + 60_000 };
      if (limit.count >= 8 || attempts.size >= 4096) { context.reject(['password']); return; }
      limit.count++; attempts.set(info.ip, limit);
      authenticating = true;
      void verifySftpLogin(context.username, context.password).then(async (user) => {
        if (!user) {
          await audit(null, null, 'auth.sftp.failed', `${context.username.slice(0, 120)} von ${info.ip}`);
          context.reject(['password']);
        } else {
          authenticated = user;
          await audit(user.id, null, 'auth.sftp', `von ${info.ip}`);
          context.accept(); touch();
        }
      }).catch(() => context.reject(['password'])).finally(() => { authenticating = false; });
    });
    client.on('ready', () => {
      client.on('session', (accept, reject) => {
        if (!authenticated || channelOpen) { reject(); return; }
        channelOpen = true;
        const session = accept();
        session.on('sftp', (acceptSftp) => { cleanup = attachSftp(acceptSftp(), authenticated!, touch); });
        session.on('close', () => { cleanup?.(); channelOpen = false; });
        // Keine Shell, Befehle, Portweiterleitungen oder Host-Dateien freigeben.
        session.on('shell', (_accept, rejectShell) => rejectShell());
        session.on('exec', (_accept, rejectExec) => rejectExec());
      });
    });
    const finish = () => { clearTimeout(timer); cleanup?.(); connections.delete(client); };
    client.on('close', finish);
    client.on('error', () => { finish(); client.end(); });
  });
  const current = listener;
  try {
    await new Promise<void>((resolve, reject) => {
      current.once('error', reject);
      current.listen(config.sftp.port, '0.0.0.0', () => { current.removeListener('error', reject); resolve(); });
    });
  } catch (err) { listener = undefined; throw err; }
  current.on('error', () => log('SFTP-Dienst: Verbindungsfehler'));
  log(`SFTP-Dateizugriff läuft auf Port ${config.sftp.port}`);
}

export async function stopSftp(): Promise<void> {
  const current = listener;
  listener = undefined;
  for (const client of connections) client.end();
  if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
}
