import fs, { type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { User } from '@prisma/client';
import { prisma } from '../db.js';
import { audit, getServerAccess } from '../auth/context.js';
import { PERMISSIONS, type Permission } from '../auth/permissions.js';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js';
import * as files from './files.js';
import { withServerOperation } from './operations.js';
import { remainingDiskBytes } from './quota.js';
import { invalidateDiskUsage } from './diskUsage.js';

type Location = { serverId: string; relative: string };
type OpenFile = Location & {
  file: FileHandle; writable: boolean; readable: boolean; append: boolean;
  maxSize: number; temporaryDir?: string; release?: () => Promise<void>;
  failed: boolean; pending: Promise<unknown>;
};

/** Virtuelle Wurzel: ausschließlich Serververzeichnisse, niemals Panel- oder Datenbankdateien. */
export function sftpLocation(value: string): Location | null {
  if (value.includes('\0') || value.includes('\\') || value.length > 4096) throw badRequest('Ungültiger Pfad');
  const parts = value.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..' || part.startsWith('.sftp-upload-'))) throw badRequest('Ungültiger Pfad');
  if (!parts.length) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(parts[0])) throw badRequest('Ungültiger Serverpfad');
  return { serverId: parts[0], relative: '/' + parts.slice(1).join('/') };
}

/** Hält dieselbe Sperre wie Panel-Aktionen bis zum Abschluss oder Abbruch des Uploads. */
async function reserveUpload(id: string): Promise<() => Promise<void>> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let acquired!: () => void;
  let rejected!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { acquired = resolve; rejected = reject; });
  const operation = withServerOperation(id, 'SFTP-Upload', async () => {
    acquired();
    await released;
  }).catch(rejected);
  await ready;
  return async () => { release(); await operation; };
}

export class SftpFiles {
  private handles = new Map<string, OpenFile>();
  private disposed = false;
  private identity: Pick<User, 'id' | 'sessionVersion'>;
  constructor(identity: Pick<User, 'id' | 'sessionVersion'>) {
    this.identity = { id: identity.id, sessionVersion: identity.sessionVersion };
  }

  async user(): Promise<User> {
    const user = await prisma.user.findUnique({ where: { id: this.identity.id } });
    if (!user?.active || user.sessionVersion !== this.identity.sessionVersion) throw unauthorized('SFTP-Sitzung widerrufen');
    return user;
  }

  async access(location: Location, permission: Permission) {
    const access = await getServerAccess(await this.user(), location.serverId);
    if (!access.can(permission)) throw forbidden('Keine Berechtigung für diese Dateioperation');
    files.resolveSafe(location.serverId, location.relative);
    return access;
  }

  async list(value: string): Promise<{ name: string; isDir: boolean; size: number; modified: number }[]> {
    const location = sftpLocation(value);
    if (!location) {
      const user = await this.user();
      const rows = await prisma.server.findMany({ where: user.role === 'ADMIN' ? {} : {
        OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
      }, orderBy: { name: 'asc' } });
      const visible = [];
      for (const row of rows) {
        const access = await getServerAccess(user, row.id);
        if (access.can(PERMISSIONS.FILES_READ)) visible.push({ name: row.id, isDir: true, size: 0, modified: 0 });
      }
      return visible;
    }
    await this.access(location, PERMISSIONS.FILES_READ);
    return (await files.listDir(location.serverId, location.relative))
      .filter((entry) => !entry.name.startsWith('.sftp-upload-'))
      .map((entry) => ({ name: entry.name, isDir: entry.isDir, size: entry.size, modified: Math.floor(Date.parse(entry.modified) / 1000) }));
  }

  async stat(value: string) {
    const location = sftpLocation(value);
    if (!location) { await this.user(); return { isDir: true, size: 0, modified: 0 }; }
    await this.access(location, PERMISSIONS.FILES_READ);
    const stat = await fs.stat(files.resolveSafe(location.serverId, location.relative));
    if (!stat.isFile() && !stat.isDirectory()) throw forbidden('Dieser Dateityp ist nicht erlaubt');
    return { isDir: stat.isDirectory(), size: stat.size, modified: Math.floor(stat.mtimeMs / 1000) };
  }

  async open(value: string, flags: number): Promise<string> {
    if (this.disposed || this.handles.size >= 32) throw badRequest('Zu viele offene Dateien');
    const location = sftpLocation(value);
    if (!location || location.relative === '/') throw forbidden('Das Serververzeichnis kann nicht überschrieben werden');
    // SFTP-v3: READ=1, WRITE=2, APPEND=4, CREAT=8, TRUNC=16, EXCL=32.
    if (!Number.isInteger(flags) || flags < 1 || flags > 63 || !(flags & 3) || (!(flags & 2) && (flags & 60))) {
      throw badRequest('Ungültiger Dateizugriff');
    }
    const writable = Boolean(flags & 2);
    const permission = writable ? PERMISSIONS.FILES_WRITE : PERMISSIONS.FILES_READ;
    let release: (() => Promise<void>) | undefined;
    let temporaryDir: string | undefined;
    let file: FileHandle | undefined;
    try {
      await this.access(location, permission);
      if ((flags & 1) && writable) await this.access(location, PERMISSIONS.FILES_READ);
      if (writable) release = await reserveUpload(location.serverId);
      const { server } = await this.access(location, permission);
      const original = await fs.stat(files.resolveSafe(location.serverId, location.relative)).catch((err) => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
      if (original && !original.isFile()) throw forbidden('Dieser Dateityp ist nicht erlaubt');
      if (!original && !(flags & 8)) throw notFound('Datei nicht gefunden');
      if (original && (flags & 32)) throw badRequest('Datei existiert bereits');
      let maxSize = Infinity;
      if (writable) {
        maxSize = await remainingDiskBytes(server) + (original?.size ?? 0);
        const destination = files.resolveSafe(location.serverId, location.relative);
        temporaryDir = await fs.mkdtemp(path.join(path.dirname(destination), '.sftp-upload-'));
        const temporary = () => files.resolveSafe(location.serverId, files.toRelative(location.serverId, path.join(temporaryDir!, 'content')));
        // Fortsetzen und Teiländerungen benötigen Leserechte für den Altbestand.
        if (original && !(flags & 16)) {
          await this.access(location, PERMISSIONS.FILES_READ);
          await fs.copyFile(files.resolveSafe(location.serverId, location.relative), temporary());
        }
        file = await fs.open(temporary(), 'a+');
        // Kein O_APPEND: Clients übertragen Blöcke auch außerhalb der Reihenfolge.
        await file.close();
        file = await fs.open(temporary(), 'r+');
        const owner = original ?? await fs.stat(files.resolveSafe(location.serverId, path.posix.dirname(location.relative)));
        // Beim Ersetzen bleiben Schreibrechte des Minecraft-Containers erhalten; neue Dateien erben den Ordnerbesitzer.
        await file.chmod(original ? original.mode & 0o777 : 0o644);
        if (process.platform !== 'win32') await file.chown(owner.uid, owner.gid);
      } else {
        file = await fs.open(files.resolveSafe(location.serverId, location.relative), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      }
      if (this.disposed || this.handles.size >= 32) throw badRequest('Verbindung geschlossen oder zu viele offene Dateien');
      const handle = crypto.randomBytes(16).toString('hex');
      this.handles.set(handle, { ...location, file, writable, readable: Boolean(flags & 1), append: Boolean(flags & 4), maxSize,
        temporaryDir, release, failed: false, pending: Promise.resolve() });
      return handle;
    } catch (err) {
      await file?.close().catch(() => {});
      if (temporaryDir) {
        try { await fs.rm(files.resolveSafe(location.serverId, files.toRelative(location.serverId, temporaryDir)), { recursive: true, force: true }); } catch { /* Ein veränderter Pfad darf keine fremden Daten löschen. */ }
      }
      await release?.();
      throw err;
    }
  }

  private async use<T>(id: string, fn: (handle: OpenFile) => Promise<T>): Promise<T> {
    const handle = this.handles.get(id);
    if (!handle) throw badRequest('Ungültige Dateiverbindung');
    const next = handle.pending.catch(() => {}).then(() => fn(handle));
    handle.pending = next;
    return next;
  }

  async read(id: string, offset: number, length: number): Promise<Buffer> {
    return this.use(id, async (handle) => {
      if (!handle.readable) throw forbidden('Datei ist nicht zum Lesen geöffnet');
      await this.access(handle, PERMISSIONS.FILES_READ);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1) throw badRequest('Ungültiger Lesebereich');
      const buffer = Buffer.alloc(Math.min(length, 256 * 1024));
      const result = await handle.file.read(buffer, 0, buffer.length, offset);
      return buffer.subarray(0, result.bytesRead);
    });
  }

  async write(id: string, offset: number, data: Buffer): Promise<void> {
    return this.use(id, async (handle) => {
      try {
        if (!handle.writable || handle.failed) throw forbidden('Upload ist nicht schreibbar');
        await this.access(handle, PERMISSIONS.FILES_WRITE);
        if (handle.append) offset = (await handle.file.stat()).size;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + data.length)) throw badRequest('Ungültiger Schreibbereich');
        if (offset + data.length > handle.maxSize) throw badRequest('Speicherkontingent reicht für den Upload nicht aus');
        let written = 0;
        while (written < data.length) {
          const result = await handle.file.write(data, written, data.length - written, offset + written);
          if (!result.bytesWritten) throw badRequest('Datei konnte nicht vollständig geschrieben werden');
          written += result.bytesWritten;
        }
      } catch (err) { handle.failed = true; throw err; }
    });
  }

  async handleStat(id: string) {
    return this.use(id, async (handle) => {
      await this.access(handle, handle.writable ? PERMISSIONS.FILES_WRITE : PERMISSIONS.FILES_READ);
      const stat = await handle.file.stat();
      return { isDir: false, size: stat.size, modified: Math.floor(stat.mtimeMs / 1000) };
    });
  }

  async metadata(value: string, attrs: { size?: number; atime?: number; mtime?: number }, id?: string) {
    if (attrs.size !== undefined) throw badRequest('Die Dateigröße kann nur durch einen Upload geändert werden');
    const atime = attrs.atime;
    const mtime = attrs.mtime;
    if ((atime !== undefined && !Number.isFinite(atime)) || (mtime !== undefined && !Number.isFinite(mtime))) throw badRequest('Ungültiger Zeitstempel');
    if (id) return this.use(id, async (handle) => {
      if (!handle.writable || handle.failed) throw forbidden('Datei ist nicht schreibbar');
      await this.access(handle, PERMISSIONS.FILES_WRITE);
      if (atime !== undefined && mtime !== undefined) await handle.file.utimes(atime, mtime);
    });
    const location = sftpLocation(value);
    if (!location || location.relative === '/') throw forbidden('Serververzeichnisse können nicht verändert werden');
    await withServerOperation(location.serverId, 'SFTP-Dateiattribute', async () => {
      await this.access(location, PERMISSIONS.FILES_WRITE);
      if (atime !== undefined && mtime !== undefined) await fs.utimes(files.resolveSafe(location.serverId, location.relative), atime, mtime);
    });
  }

  async close(id: string, commit = true): Promise<void> {
    const handle = this.handles.get(id);
    if (!handle) throw badRequest('Ungültige Dateiverbindung');
    // Vor dem Warten entfernen: nach CLOSE darf kein weiterer Block angenommen werden.
    this.handles.delete(id);
    await handle.pending.catch(() => {});
    try {
      if (commit && handle.writable) {
        if (handle.failed) throw badRequest('Upload abgebrochen; vorhandene Datei bleibt erhalten');
        await this.access(handle, PERMISSIONS.FILES_WRITE);
        await handle.file.sync();
        await handle.file.close();
        const temporary = files.resolveSafe(handle.serverId, files.toRelative(handle.serverId, path.join(handle.temporaryDir!, 'content')));
        const destination = files.resolveSafe(handle.serverId, handle.relative);
        await fs.rename(temporary, destination);
        invalidateDiskUsage(handle.serverId);
        await audit(this.identity.id, handle.serverId, 'files.sftp.upload', handle.relative);
      }
    } finally {
      await handle.file.close().catch(() => {});
      if (handle.temporaryDir) {
        try { await fs.rm(files.resolveSafe(handle.serverId, files.toRelative(handle.serverId, handle.temporaryDir)), { recursive: true, force: true }); } catch { /* Ein veränderter Pfad darf keine fremden Daten löschen. */ }
      }
      await handle.release?.();
    }
  }

  async mutate(value: string, action: 'mkdir' | 'remove' | 'rmdir' | 'rename', target?: string) {
    const location = sftpLocation(value);
    if (!location || location.relative === '/') throw forbidden('Serververzeichnisse können nicht verändert werden');
    await withServerOperation(location.serverId, 'SFTP-Dateiänderung', async () => {
      await this.access(location, PERMISSIONS.FILES_WRITE);
      if (action === 'mkdir') await fs.mkdir(files.resolveSafe(location.serverId, location.relative));
      else if (action === 'rename') {
        const destination = sftpLocation(target!);
        if (!destination || destination.serverId !== location.serverId || destination.relative === '/') throw forbidden('Verschieben zwischen Servern ist nicht erlaubt');
        await this.access(destination, PERMISSIONS.FILES_WRITE);
        const source = files.resolveSafe(location.serverId, location.relative);
        await fs.rename(source, files.resolveSafe(destination.serverId, destination.relative));
      } else if (action === 'remove') await fs.unlink(files.resolveSafe(location.serverId, location.relative));
      else if (action === 'rmdir') await fs.rmdir(files.resolveSafe(location.serverId, location.relative));
      // Attribute vom Client geben keine zusätzlichen Host-Rechte. Zeitstempel werden separat gesetzt.
      invalidateDiskUsage(location.serverId);
      await audit(this.identity.id, location.serverId, `files.sftp.${action}`, location.relative);
    });
  }

  async dispose() {
    this.disposed = true;
    await Promise.allSettled([...this.handles.keys()].map((id) => this.close(id, false)));
  }
}
