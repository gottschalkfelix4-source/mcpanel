import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ root: '', archive: Buffer.alloc(0) as Buffer, row: {} as any, download: vi.fn(), recreate: vi.fn(), start: vi.fn(), stop: vi.fn() }));
vi.mock('../config.js', () => ({
  serverDir: (id: string) => path.join(m.root, 'servers', id),
  serverBackupDir: (id: string) => path.join(m.root, 'backups', id), cacheDir: () => path.join(m.root, 'cache'),
}));
vi.mock('../db.js', () => ({ prisma: { server: {
  findUniqueOrThrow: async () => ({ ...m.row }),
  update: async ({ data }: any) => { m.row = { ...m.row, ...data }; return { ...m.row }; },
} } }));
vi.mock('./docker.js', () => ({ getState: async () => ({ state: 'running' }), stop: m.stop, start: m.start, recreateContainer: m.recreate }));
vi.mock('./diskUsage.js', () => ({ invalidateDiskUsage: vi.fn() }));
vi.mock('./backups.js', () => ({ createBackup: vi.fn() }));
vi.mock('../providers/modrinth.js', () => ({
  getVersion: async () => ({ id: 'new', name: 'new pack', filename: 'fixture.mrpack', downloadUrl: 'https://fixture.test/archive' }),
  getProject: async () => ({ name: 'Pack', iconUrl: null }), modrinthHeaders: () => ({}),
}));
vi.mock('../lib/download.js', () => ({ downloadToFile: m.download }));
const { installModpack } = await import('./modpack.js');
const { withServerOperation } = await import('./operations.js');
const dir = () => path.join(m.root, 'servers/a');
const task = () => ({ id: 'task', update: vi.fn(async () => {}), log: vi.fn(async () => {}), done: vi.fn(), fail: vi.fn() });
const request = { provider: 'modrinth' as const, projectId: 'pack', versionId: 'new', backupFirst: false, keepConfig: true };
function archive(downloads: { path: string; downloads: string[] }[] = [], overrides: Record<string, string | Buffer> = {}) {
  const zip = new AdmZip();
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({ formatVersion: 1, name: 'Pack', versionId: 'new', dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.16.0' }, files: downloads })));
  for (const [name, data] of Object.entries(overrides)) zip.addFile('overrides/' + name, Buffer.from(data));
  m.archive = zip.toBuffer();
}
beforeEach(async () => {
  vi.resetAllMocks();
  m.root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-modpack-test-'));
  m.row = { id: 'a', name: 'Test', type: 'PAPER', mcVersion: '1.20.1', extraEnv: {}, modpackProjectId: 'pack', modpackVersionId: 'old', quotaDiskMb: 0 };
  for (const sub of ['mods', 'customworld', 'config']) await fs.mkdir(path.join(dir(), sub), { recursive: true });
  await fs.writeFile(path.join(dir(), 'server.properties'), 'level-name=customworld\n');
  await fs.writeFile(path.join(dir(), 'customworld/level.dat'), 'world original');
  await fs.writeFile(path.join(dir(), 'config/user.conf'), 'config original');
  await fs.writeFile(path.join(dir(), 'mods/old.jar'), 'working old mod');
  m.download.mockImplementation(async (url: string, dest: string) => {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    if (url.endsWith('/archive')) await fs.writeFile(dest, m.archive);
    else if (url.endsWith('/bad')) throw new Error('fixture HTTP 503');
    else await fs.writeFile(dest, 'new mod');
    return 7;
  });
});
afterEach(async () => fs.rm(m.root, { recursive: true, force: true }));
it('BUG-16: missing mandatory download preserves original files and version binding', async () => {
  archive([{ path: 'mods/missing.jar', downloads: ['https://fixture.test/bad'] }]);
  await expect(installModpack('a', request, task())).rejects.toThrow('Pflichtdatei');
  expect(await fs.readFile(path.join(dir(), 'mods/old.jar'), 'utf8')).toBe('working old mod');
  expect(m.row.modpackVersionId).toBe('old');
  expect(m.start).toHaveBeenCalledWith(expect.objectContaining({ modpackVersionId: 'old' }));
});
it('BUG-35: downloads and overrides cannot overwrite the configured world or preserved config', async () => {
  archive([
    { path: 'customworld/level.dat', downloads: ['https://fixture.test/world'] },
    { path: 'config/user.conf', downloads: ['https://fixture.test/config'] },
    { path: 'mods/new.jar', downloads: ['https://fixture.test/mod'] },
  ], { 'customworld/level.dat': 'destroy world', 'config/user.conf': 'destroy config' });
  await installModpack('a', request, task());
  expect(await fs.readFile(path.join(dir(), 'customworld/level.dat'), 'utf8')).toBe('world original');
  expect(await fs.readFile(path.join(dir(), 'config/user.conf'), 'utf8')).toBe('config original');
  expect(await fs.readFile(path.join(dir(), 'mods/new.jar'), 'utf8')).toBe('new mod');
  await expect(fs.stat(path.join(dir(), 'mods/old.jar'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(m.row.modpackVersionId).toBe('new');
});
it('rolls files and metadata back if container recreation fails after the swap', async () => {
  archive([{ path: 'mods/new.jar', downloads: ['https://fixture.test/mod'] }]);
  m.recreate.mockRejectedValueOnce(new Error('Docker recreation failed'));
  await expect(installModpack('a', request, task())).rejects.toThrow('recreation failed');
  expect(await fs.readFile(path.join(dir(), 'mods/old.jar'), 'utf8')).toBe('working old mod');
  expect(m.row.type).toBe('PAPER');
  expect(m.row.modpackVersionId).toBe('old');
});
it('BUG-09: rejects installation while another request owns the server', async () => {
  let release!: () => void;
  const active = withServerOperation('a', 'Restore', () => new Promise<void>(resolve => { release = resolve; }));
  try { await expect(installModpack('a', request, task())).rejects.toMatchObject({ statusCode: 409 }); }
  finally { release(); await active; }
  expect(m.stop).not.toHaveBeenCalled();
});

it('downloads independent mods concurrently without a quota', async () => {
  archive(Array.from({ length: 8 }, (_, i) => ({ path: `mods/new-${i}.jar`, downloads: [`https://fixture.test/mod-${i}`] })));
  const download = m.download.getMockImplementation()!;
  let active = 0, peak = 0;
  m.download.mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('/archive')) return download(...args);
    active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 10)); return await download(...args); }
    finally { active--; }
  });
  await installModpack('a', request, task());
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(4);
  expect(await fs.readFile(path.join(dir(), 'mods/new-7.jar'), 'utf8')).toBe('new mod');
});

it('keeps quota accounting incremental instead of scanning the tree per mod', async () => {
  m.row.quotaDiskMb = 1;
  archive(Array.from({ length: 12 }, (_, i) => ({ path: `mods/new-${i}.jar`, downloads: [`https://fixture.test/mod-${i}`] })));
  const reads = vi.spyOn(fs, 'readdir');
  try {
    await installModpack('a', request, task());
    const stageScans = reads.mock.calls.filter(([file]) => String(file) === dir() + '.restore-stage');
    expect(stageScans.length).toBeLessThanOrEqual(3);
    const budgets = m.download.mock.calls.filter(([url]) => !String(url).endsWith('/archive')).map(args => args[2].maxBytes);
    expect(budgets).toHaveLength(12);
    for (let i = 1; i < budgets.length; i++) expect(budgets[i]).toBe(budgets[i - 1] - 7);
  } finally { reads.mockRestore(); }
});

/** Ein Mod-Jar, wie es im Archiv liegt: nur die fabric.mod.json zaehlt hier. */
function modJar(id: string, environment: string): Buffer {
  const jar = new AdmZip();
  jar.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ schemaVersion: 1, id, environment })));
  return jar.toBuffer();
}

it('schaltet eine bekannte Client-Mod ab, die im Modrinth-Paket unter overrides/ mitkommt', async () => {
  // Genau der Fall aus "Better MC [FABRIC]": die Datei steht nicht im Index,
  // traegt also keine env-Angabe, und gibt sich selbst als beidseitig aus.
  archive([], {
    'mods/missingmodschecker.jar': modJar('missingmodschecker', '*'),
    'mods/packanalytics-fabric-1.0.4.jar': modJar('packanalytics', '*'),
    'mods/serverseitig.jar': modJar('serverseitig', '*'),
  });
  await installModpack('a', request, task());

  await expect(fs.stat(path.join(dir(), 'mods/missingmodschecker.jar'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await fs.stat(path.join(dir(), 'mods/packanalytics-fabric-1.0.4.jar.disabled'))).isFile()).toBe(true);
  expect((await fs.stat(path.join(dir(), 'mods/missingmodschecker.jar.disabled'))).isFile()).toBe(true);
  expect((await fs.stat(path.join(dir(), 'mods/serverseitig.jar'))).isFile()).toBe(true);
});

it('nimmt Mods mit, die nur wegen einer Client-Mod existieren', async () => {
  const begleiter = new AdmZip();
  begleiter.addFile('fabric.mod.json', Buffer.from(JSON.stringify({
    schemaVersion: 1, id: 'mmc_helper', environment: '*', depends: { missingmodschecker: '*' },
  })));
  archive([], {
    'mods/missingmodschecker.jar': modJar('missingmodschecker', '*'),
    'mods/mmc-helper.jar': begleiter.toBuffer(),
  });
  await installModpack('a', request, task());

  expect((await fs.stat(path.join(dir(), 'mods/mmc-helper.jar.disabled'))).isFile()).toBe(true);
});

it('laedt Shaderpacks und Client-Welten aus der Dateiliste gar nicht erst herunter', async () => {
  archive([
    { path: 'mods/new.jar', downloads: ['https://fixture.test/mod'] },
    { path: 'shaderpacks/Riesig.zip', downloads: ['https://fixture.test/shader'] },
    { path: 'saves/Clientwelt/level.dat', downloads: ['https://fixture.test/save'] },
  ]);
  const t = task();
  await installModpack('a', request, t);

  const urls = m.download.mock.calls.map((args: unknown[]) => String(args[0]));
  expect(urls).toContain('https://fixture.test/mod');
  expect(urls).not.toContain('https://fixture.test/shader');
  expect(urls).not.toContain('https://fixture.test/save');
  await expect(fs.stat(path.join(dir(), 'shaderpacks'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(t.log.mock.calls.some((args: unknown[]) => /2 reine Client-Datei/.test(String(args[0])))).toBe(true);
});
