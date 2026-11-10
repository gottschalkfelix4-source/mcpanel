import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  exec: vi.fn(), send: vi.fn(), versions: new Map<string, any>(), setting: '', mounted: false,
}));
vi.mock('node:child_process', () => ({ execFile: m.exec }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { send = m.send; destroy() {} },
  GetObjectCommand: class { constructor(public input: unknown) {} },
  DeleteObjectCommand: class { constructor(public input: unknown) {} },
  HeadBucketCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('./settings.js', () => ({ getSetting: async () => m.setting, setSetting: async (_key: string, value: string) => { m.setting = value; } }));
vi.mock('../db.js', () => ({ prisma: {
  backupTargetVersion: {
    upsert: async ({ create }: any) => { m.versions.set(create.id, create); return create; },
    findUniqueOrThrow: async ({ where }: any) => m.versions.get(where.id),
  }, backup: { updateMany: vi.fn() },
} }));
let target: typeof import('./backupTarget.js');
const rawRead = fs.readFile.bind(fs), rawMkdir = fs.mkdir.bind(fs);
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); m.setting = ''; m.mounted = false; m.versions.clear();
  vi.spyOn(fs, 'readFile').mockImplementation(((file: any, ...args: any[]) => file === '/proc/mounts'
    ? Promise.resolve(m.mounted ? '//fixture/share /mnt/backup-target cifs rw 0 0\n' : '') : (rawRead as any)(file, ...args)) as any);
  vi.spyOn(fs, 'mkdir').mockImplementation(((file: any, ...args: any[]) => String(file).startsWith('/mnt/backup-') ? Promise.resolve(undefined) : (rawMkdir as any)(file, ...args)) as any);
  target = await import('./backupTarget.js');
});
afterEach(() => vi.restoreAllMocks());
async function config(kind: 'SMB' | 'S3') {
  const value = structuredClone(await target.getTarget());
  value.kind = kind;
  value.smb = { host: 'fixture', share: 'share', path: '', username: 'test', password: "comma,'$(literal)", domain: '', version: '3.0' };
  value.s3 = { endpoint: 'http://fixture.invalid', region: 'test', bucket: 'old-bucket', prefix: 'old', accessKeyId: 'fixture', secretAccessKey: 'fixture', forcePathStyle: true };
  return value;
}
it('BUG-27: SMB credentials use a private file and never enter shell arguments', async () => {
  const cfg = await config('SMB');
  let credentialPath = '';
  m.exec.mockImplementation((command, args, _options, callback) => {
    void (async () => {
      expect(command).toBe('mount');
      expect(JSON.stringify(args)).not.toContain(cfg.smb.password);
      credentialPath = args[args.indexOf('-o') + 1].match(/credentials=([^,]+)/)[1];
      // Windows kennt keine POSIX-Rechtebits; dort ist die Pruefung nicht aussagekraeftig.
      if (process.platform !== 'win32') {
        expect((await fs.stat(credentialPath)).mode & 0o777).toBe(0o600);
      }
      expect(await fs.readFile(credentialPath, 'utf8')).toContain(`password=${cfg.smb.password}\n`);
      m.mounted = true;
    })().then(() => callback(null, '', ''), callback);
  });
  await target.saveTarget(cfg);
  expect(m.exec).toHaveBeenCalledOnce();
  await expect(fs.stat(credentialPath)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('BUG-28: failed SMB mount prevents copying a backup into the local mount directory', async () => {
  const cfg = await config('SMB');
  const id = await target.registerTarget(cfg);
  const copy = vi.spyOn(fs, 'copyFile');
  m.exec.mockImplementation((_cmd, _args, _opts, cb) => cb(new Error('Permission denied')));
  await expect(target.putBackup('server', 'fixture.tar.gz', '/tmp/unused-fixture', undefined, id)).rejects.toThrow('abgelehnt');
  expect(copy).not.toHaveBeenCalled();
});
it('BUG-29: historical backup target remains usable after the active target changes', async () => {
  const old = await config('S3');
  await target.saveTarget(old);
  const id = await target.registerTarget(old);
  await target.saveTarget({ ...old, s3: { ...old.s3, bucket: 'new-bucket', prefix: 'new' } });
  m.send.mockResolvedValue({ Body: Readable.from(['original archive']) });
  const fetched = await target.fetchBackup('server', 'fixture.tar.gz', id);
  expect((m.send.mock.calls.at(-1)![0] as any).input).toMatchObject({ Bucket: 'old-bucket', Key: 'old/server/fixture.tar.gz' });
  expect(await fs.readFile(fetched!.path, 'utf8')).toBe('original archive');
  await fetched!.cleanup();
});
it('BUG-30: a failing S3 source stream rejects and removes partial temporary files', async () => {
  await target.saveTarget(await config('S3'));
  const temporary = vi.spyOn(fs, 'mkdtemp');
  m.send.mockResolvedValue({ Body: Readable.from((async function* () { yield Buffer.from('partial'); throw new Error('source interrupted'); })()) });
  await expect(target.fetchBackup('server', 'fixture.tar.gz')).rejects.toThrow('source interrupted');
  const dir = await temporary.mock.results.at(-1)!.value;
  await expect(fs.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('WebDAV: gespeichertes Kennwort gilt nur für denselben Server', async () => {
  const current = structuredClone(await target.getTarget());
  current.kind = 'WEBDAV';
  current.webdav = { url: 'https://cloud.example.de/remote.php/dav/files/anna/Backups', username: 'anna', password: 'geheim' };
  const input = (url: string, password?: string) => ({
    ...current, smb: { ...current.smb }, s3: { ...current.s3 }, webdav: { url, username: 'anna', password },
  });
  expect(target.keepStoredSecrets(input('https://cloud.example.de/anderer/Ordner'), current).webdav.password).toBe('geheim');
  expect(target.keepStoredSecrets(input('https://boese.example/dav'), current).webdav.password).toBe('');
  expect(target.keepStoredSecrets(input('http://cloud.example.de/remote.php/dav'), current).webdav.password).toBe('');
  expect(target.keepStoredSecrets(input('https://boese.example/dav', 'neu'), current).webdav.password).toBe('neu');
});
it('WebDAV: Kennwort erscheint nie in der Antwort an die Oberfläche', async () => {
  const cfg = structuredClone(await target.getTarget());
  cfg.webdav = { url: 'https://nas/dav', username: 'anna', password: 'streng-geheim' };
  const shown = target.publicTarget(cfg);
  expect(JSON.stringify(shown)).not.toContain('streng-geheim');
  expect(shown.webdav).toEqual({ url: 'https://nas/dav', username: 'anna', passwordSet: true });
});
it('WebDAV: ältere Ziel-Fassungen ohne WebDAV-Feld bleiben lesbar', async () => {
  m.setting = JSON.stringify({ kind: 'S3', s3: { bucket: 'b' } });
  const loaded = await target.getTarget();
  expect(loaded.webdav).toEqual({ url: '', username: '', password: '' });
  expect(() => target.assertComplete({ ...loaded, kind: 'WEBDAV' })).toThrow('WebDAV-Adresse fehlt');
  expect(() => target.assertComplete({ ...loaded, kind: 'WEBDAV', webdav: { url: 'ftp://x', username: '', password: '' } })).toThrow('http://');
});
