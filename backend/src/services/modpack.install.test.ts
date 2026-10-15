import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ root: '', archive: Buffer.alloc(0) as Buffer, row: {} as any, download: vi.fn(), recreate: vi.fn(), start: vi.fn(), stop: vi.fn(), ready: vi.fn(), ftb: vi.fn(), cfFind: vi.fn(), cfVersion: {} as any }));
vi.mock('../config.js', () => ({
  serverDir: (id: string) => path.join(m.root, 'servers', id),
  serverBackupDir: (id: string) => path.join(m.root, 'backups', id), cacheDir: () => path.join(m.root, 'cache'),
}));
vi.mock('../db.js', () => ({ prisma: { server: {
  findUniqueOrThrow: async () => ({ ...m.row }),
  update: async ({ data }: any) => { m.row = { ...m.row, ...data }; return { ...m.row }; },
} } }));
vi.mock('./docker.js', () => ({ getState: async () => ({ state: 'running' }), stop: m.stop, start: m.start, recreateContainer: m.recreate }));
vi.mock('./diskUsage.js', () => ({ invalidateDiskUsage: vi.fn(), adjustDiskUsage: vi.fn() }));
vi.mock('./backups.js', () => ({ createBackup: vi.fn() }));
vi.mock('./serverStartup.js', () => ({ waitForServerReady: m.ready }));
vi.mock('../providers/curseforge.js', () => ({
  getVersion: async () => m.cfVersion,
  getProject: async () => ({ name: 'Pack', iconUrl: null }),
  findServerPack: m.cfFind,
}));
vi.mock('../providers/ftb.js', () => ({ findServerPack: m.ftb }));
vi.mock('../providers/modrinth.js', () => ({
  getVersion: async () => ({ id: 'new', name: 'new pack', filename: 'fixture.mrpack', downloadUrl: 'https://fixture.test/archive' }),
  getProject: async () => ({ name: 'Pack', iconUrl: null }), modrinthHeaders: () => ({}),
}));
vi.mock('../lib/download.js', () => ({ downloadToFile: m.download }));
const { installModpack, allowedMrpackUrl } = await import('./modpack.js');
const { withServerOperation } = await import('./operations.js');
const dir = () => path.join(m.root, 'servers/a');
const task = () => ({ id: 'task', update: vi.fn(async () => {}), log: vi.fn(async () => {}), done: vi.fn(), fail: vi.fn() });
const request = { provider: 'modrinth' as const, projectId: 'pack', versionId: 'new', backupFirst: false, keepConfig: true };
function archive(downloads: { path: string; downloads: string[] }[] = [], overrides: Record<string, string | Buffer> = {}) {
  const zip = new AdmZip();
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({ formatVersion: 1, name: 'Pack', versionId: 'new', dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.16.0' }, files: downloads.map((file) => ({ hashes: { sha1: createHash('sha1').update('new mod').digest('hex') }, ...file })) })));
  for (const [name, data] of Object.entries(overrides)) zip.addFile('overrides/' + name, Buffer.from(data));
  m.archive = zip.toBuffer();
}
beforeEach(async () => {
  vi.resetAllMocks();
  m.ready.mockResolvedValue(undefined);
  m.ftb.mockResolvedValue(null); m.cfFind.mockResolvedValue(null);
  m.cfVersion = { id: 'new', name: 'Serverpaket', filename: 'server.zip', downloadUrl: 'https://fixture.test/archive', isServerPack: true, gameVersions: ['1.20.1'], loaders: ['fabric'] };
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
  archive([{ path: 'mods/missing.jar', downloads: ['https://cdn.modrinth.com/fixture/bad'] }]);
  await expect(installModpack('a', request, task())).rejects.toThrow('Pflichtdatei');
  expect(await fs.readFile(path.join(dir(), 'mods/old.jar'), 'utf8')).toBe('working old mod');
  expect(m.row.modpackVersionId).toBe('old');
  expect(m.stop).not.toHaveBeenCalled();
  expect(m.start).not.toHaveBeenCalled();
});
it('BUG-35: downloads and overrides cannot overwrite the configured world or preserved config', async () => {
  archive([
    { path: 'customworld/level.dat', downloads: ['https://cdn.modrinth.com/fixture/world'] },
    { path: 'config/user.conf', downloads: ['https://cdn.modrinth.com/fixture/config'] },
    { path: 'mods/new.jar', downloads: ['https://cdn.modrinth.com/fixture/mod'] },
  ], { 'customworld/level.dat': 'destroy world', 'config/user.conf': 'destroy config' });
  await installModpack('a', request, task());
  expect(await fs.readFile(path.join(dir(), 'customworld/level.dat'), 'utf8')).toBe('world original');
  expect(await fs.readFile(path.join(dir(), 'config/user.conf'), 'utf8')).toBe('config original');
  expect(await fs.readFile(path.join(dir(), 'mods/new.jar'), 'utf8')).toBe('new mod');
  await expect(fs.stat(path.join(dir(), 'mods/old.jar'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(m.row.modpackVersionId).toBe('new');
});

it('installiert ein Modpack frisch ohne Altmods, Plugins oder alte Loader-Dateien und erhält die Welt', async () => {
  await fs.mkdir(path.join(dir(), 'plugins'));
  await fs.writeFile(path.join(dir(), 'plugins/alt.jar'), 'altes Plugin');
  await fs.writeFile(path.join(dir(), 'server.jar'), 'alter Loader');
  m.row.extraEnv = { TYPE: 'PAPER', PAPER_BUILD: 'alt', JVM_OPTS: 'Admin-Vorgabe' };
  archive([], { 'config/neu.conf': 'neue Konfiguration' });
  await installModpack('a', { ...request, backupFirst: true, keepConfig: false, startAfter: false,
    reinstall: { name: 'Neu installiert', description: 'Neue Beschreibung', memoryMb: 2048, keepWorld: true } }, task());
  expect(await fs.readFile(path.join(dir(), 'customworld/level.dat'), 'utf8')).toBe('world original');
  expect(await fs.readFile(path.join(dir(), 'config/neu.conf'), 'utf8')).toBe('neue Konfiguration');
  for (const name of ['plugins', 'server.jar', 'mods/old.jar', 'config/user.conf']) await expect(fs.stat(path.join(dir(), name))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(m.row).toMatchObject({ name: 'Neu installiert', memoryMb: 2048, type: 'MODPACK', extraEnv: { TYPE: 'FABRIC', JVM_OPTS: 'Admin-Vorgabe' } });
});

it('stellt bei einer fehlgeschlagenen Modpack-Neuinstallation auch Name, RAM und alte Dateien wieder her', async () => {
  archive(); m.row.memoryMb = 4096; m.recreate.mockRejectedValueOnce(new Error('Containerfehler'));
  await expect(installModpack('a', { ...request, backupFirst: true, startAfter: false,
    reinstall: { name: 'Neue Auswahl', description: 'Neu', memoryMb: 2048, keepWorld: true } }, task())).rejects.toThrow('Containerfehler');
  expect(m.row).toMatchObject({ name: 'Test', memoryMb: 4096, modpackVersionId: 'old' });
  expect(await fs.readFile(path.join(dir(), 'mods/old.jar'), 'utf8')).toBe('working old mod');
});

it('beginnt eine Modpack-Neuinstallation auf Wunsch mit einer neuen Welt', async () => {
  archive([], { 'world/level.dat': 'vorgefertigte fremde Welt' });
  await installModpack('a', { ...request, backupFirst: true, startAfter: false,
    reinstall: { name: 'Neue Welt', description: '', memoryMb: 2048, keepWorld: false } }, task());
  await expect(fs.stat(path.join(dir(), 'customworld'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.stat(path.join(dir(), 'world'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rolls files and metadata back if container recreation fails after the swap', async () => {
  archive([{ path: 'mods/new.jar', downloads: ['https://cdn.modrinth.com/fixture/mod'] }]);
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
  archive(Array.from({ length: 8 }, (_, i) => ({ path: `mods/new-${i}.jar`, downloads: [`https://cdn.modrinth.com/fixture/mod-${i}`] })));
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
  archive(Array.from({ length: 12 }, (_, i) => ({ path: `mods/new-${i}.jar`, downloads: [`https://cdn.modrinth.com/fixture/mod-${i}`] })));
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
    { path: 'mods/new.jar', downloads: ['https://cdn.modrinth.com/fixture/mod'] },
    { path: 'shaderpacks/Riesig.zip', downloads: ['https://cdn.modrinth.com/fixture/shader'] },
    { path: 'saves/Clientwelt/level.dat', downloads: ['https://cdn.modrinth.com/fixture/save'] },
  ]);
  const t = task();
  await installModpack('a', request, t);

  const urls = m.download.mock.calls.map((args: unknown[]) => String(args[0]));
  expect(urls).toContain('https://cdn.modrinth.com/fixture/mod');
  expect(urls).not.toContain('https://cdn.modrinth.com/fixture/shader');
  expect(urls).not.toContain('https://cdn.modrinth.com/fixture/save');
  await expect(fs.stat(path.join(dir(), 'shaderpacks'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(t.log.mock.calls.some((args: unknown[]) => /2 reine Client-Datei/.test(String(args[0])))).toBe(true);
});

it('bricht ein Client-Paket mit fehlenden Zusatzdownloads ab und erhält die bisherigen Daten', async () => {
  archive([], { 'config/missing_mods_checker.json': JSON.stringify([
    { displayName: 'Balm', pattern: 'balm-fabric.jar', destination: 'mods', url: 'https://fixture.test/balm' },
    { displayName: 'Shader', pattern: 'shader.zip', destination: 'resourcepacks' },
  ]) });
  const t = task();
  await expect(installModpack('a', request, t)).rejects.toThrow('Balm');
  expect(await fs.readFile(path.join(dir(), 'mods/old.jar'), 'utf8')).toBe('working old mod');
  expect(m.row.modpackVersionId).toBe('old');
  expect(t.log.mock.calls.some((args: unknown[]) => String(args[0]).includes('https://fixture.test/balm'))).toBe(true);
  expect(m.ready).not.toHaveBeenCalled();
});

it('erkennt vorhandene Zusatzmods anhand einfacher Dateimuster und ignoriert Client-Ressourcen', async () => {
  archive([], {
    'config/missing_mods_checker.json': JSON.stringify([
      { pattern: 'balm-.*\\.jar', destination: 'mods' },
      { pattern: 'shader.zip', destination: 'resourcepacks' },
    ]),
    'mods/Balm-1.20.1.jar': modJar('balm', '*'),
  });
  await expect(installModpack('a', request, task())).resolves.toBeUndefined();
});

it('deaktiviert die beiden weiteren nachgewiesenen Client-Mods vor dem Start', async () => {
  archive([], {
    'mods/tooltips.jar': modJar('miningspeedtooltips', '*'),
    'mods/freezefix.jar': modJar('ftbquestsfreezefix', '*'),
  });
  await installModpack('a', request, task());
  for (const file of ['tooltips.jar.disabled', 'freezefix.jar.disabled']) expect((await fs.stat(path.join(dir(), 'mods', file))).isFile()).toBe(true);
});

it('erkennt OceanBlock-Client-Mods bei NeoForge an der Mod-ID und erhält ihre Dateien sowie die Welt', async () => {
  const zip = new AdmZip();
  const originals = new Map<string, Buffer>();
  for (const [file, id] of [['beliebig-a.jar', 'collapsible_groups'], ['beliebig-b.jar', 'euphoria_patcher'], ['server.jar', 'servermod']]) {
    const jar = new AdmZip();
    jar.addFile('META-INF/neoforge.mods.toml', Buffer.from(`[[mods]]\nmodId="${id}"\nversion="1.0"\n`));
    const data = jar.toBuffer(); originals.set(file, data); zip.addFile('mods/' + file, data);
  }
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({ formatVersion: 1, game: 'minecraft', name: 'NeoForge-Test', versionId: 'new', files: [], dependencies: { minecraft: '1.21.1', neoforge: '21.1.248' } })));
  for (const [file, data] of originals) {
    zip.deleteFile('mods/' + file);
    zip.addFile('overrides/mods/' + file, data);
  }
  m.archive = zip.toBuffer();
  await installModpack('a', request, task());
  for (const file of ['beliebig-a.jar', 'beliebig-b.jar']) {
    expect(await fs.readFile(path.join(dir(), 'mods', file + '.disabled'))).toEqual(originals.get(file));
    await expect(fs.stat(path.join(dir(), 'mods', file))).rejects.toMatchObject({ code: 'ENOENT' });
  }
  expect(await fs.readFile(path.join(dir(), 'mods/server.jar'))).toEqual(originals.get('server.jar'));
  expect(await fs.readFile(path.join(dir(), 'customworld/level.dat'), 'utf8')).toBe('world original');
});

it('wartet vor dem erfolgreichen Abschluss auf Minecraft und rollt einen Fehlstart zurück', async () => {
  archive([], { 'mods/new.jar': modJar('neu', '*') });
  m.ready.mockRejectedValueOnce(new Error('Minecraft-Start fehlgeschlagen'));
  await expect(installModpack('a', request, task())).rejects.toThrow('Minecraft-Start');
  expect(await fs.readFile(path.join(dir(), 'mods/old.jar'), 'utf8')).toBe('working old mod');
  expect(m.row.modpackVersionId).toBe('old');
  expect(m.start).toHaveBeenLastCalledWith(expect.objectContaining({ modpackVersionId: 'old' }));
});

it('prüft den Start nur bei angefordertem Autostart', async () => {
  archive();
  await installModpack('a', { ...request, startAfter: false }, task());
  expect(m.ready).not.toHaveBeenCalled();
  expect(m.start).not.toHaveBeenCalled();
});

it('übernimmt die Fabric-Version des offiziellen Serverpakets und erhält Welt und Konfiguration', async () => {
  const zip = new AdmZip();
  zip.addFile('mods/server.jar', modJar('servermod', '*'));
  zip.addFile('variables.txt', Buffer.from('MINECRAFT_VERSION=1.20.1\nMODLOADER=Fabric\nMODLOADER_VERSION=0.18.4\n'));
  zip.addFile('config/user.conf', Buffer.from('Neue Vorgabe'));
  zip.addFile('customworld/level.dat', Buffer.from('Fremde Welt'));
  m.archive = zip.toBuffer();
  await installModpack('a', { ...request, provider: 'curseforge' }, task());
  expect(m.row.extraEnv).toMatchObject({ TYPE: 'FABRIC', FABRIC_LOADER_VERSION: '0.18.4' });
  expect(await fs.readFile(path.join(dir(), 'customworld/level.dat'), 'utf8')).toBe('world original');
  expect(await fs.readFile(path.join(dir(), 'config/user.conf'), 'utf8')).toBe('config original');
});


it('verweigert CurseForge-Client-Pakete ohne Serverpaket vor jedem Serverstopp', async () => {
  m.cfVersion.isServerPack = false;
  await expect(installModpack('a', { ...request, provider: 'curseforge' }, task())).rejects.toThrow('Client-Pakete werden nicht installiert');
  expect(m.download).not.toHaveBeenCalled();
  expect(m.stop).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(dir(), 'customworld/level.dat'), 'utf8')).toBe('world original');
  expect(m.row.modpackVersionId).toBe('old');
});

it('weicht bei einem CurseForge-Ausfall nicht auf Client-Pakete oder FTB aus', async () => {
  m.cfVersion.isServerPack = false; m.cfFind.mockRejectedValue(new Error('HTTP 503'));
  await expect(installModpack('a', { ...request, provider: 'curseforge' }, task())).rejects.toThrow('503');
  expect(m.ftb).not.toHaveBeenCalled(); expect(m.stop).not.toHaveBeenCalled(); expect(m.download).not.toHaveBeenCalled();
});

it('verweigert ein als Serverpaket verknüpftes Client-Archiv vor dem Serverstopp', async () => {
  const zip = new AdmZip(); zip.addFile('manifest.json', Buffer.from('{}')); m.archive = zip.toBuffer();
  await expect(installModpack('a', { ...request, provider: 'curseforge' }, task())).rejects.toThrow('Client-Manifest');
  expect(m.stop).not.toHaveBeenCalled();
});

it.each(['', 'serverpack/'])('installiert ein Pixelmon-ServerPackCreator-Paket mit Manifest unter "%s"', async root => {
  m.cfVersion = { ...m.cfVersion, isServerPack: false, gameVersions: ['1.21.1'], loaders: ['neoforge'] };
  m.cfFind.mockResolvedValue({ pack: { ...m.cfVersion, id: '7454494', filename: 'serverpack9314.zip', isServerPack: true } });
  const zip = new AdmZip();
  // Die Dateiliste des echten Pakets nennt noch 9.3.9, enthalten ist 9.3.14.
  // Entscheidend sind die fertigen Dateien, nicht diese veraltete Inventarliste.
  zip.addFile(root + 'manifest.json', Buffer.from(JSON.stringify({
    files: ['config', 'mods\\Pixelmon-1.21.1-9.3.9-server.jar'],
    minecraftVersion: '1.21.1', modloader: 'NeoForge', modloaderVersion: '21.1.200', serverPackCreatorVersion: '7.3.0',
  })));
  zip.addFile(root + 'variables.txt', Buffer.from('MINECRAFT_VERSION=1.21.1\nMODLOADER=NeoForge\nMODLOADER_VERSION=21.1.200\n'));
  zip.addFile(root + 'mods/Pixelmon-1.21.1-9.3.14-server.jar', modJar('pixelmon', '*'));
  zip.addFile(root + 'config/pixelmon/config.yml', Buffer.from('pixelmon: true'));
  m.archive = zip.toBuffer();
  await installModpack('a', { ...request, provider: 'curseforge', startAfter: false, keepConfig: false }, task());
  expect(await fs.readdir(path.join(dir(), 'mods'))).toEqual(['Pixelmon-1.21.1-9.3.14-server.jar']);
  expect(await fs.readFile(path.join(dir(), 'config/pixelmon/config.yml'), 'utf8')).toBe('pixelmon: true');
  expect(await fs.readFile(path.join(dir(), 'customworld/level.dat'), 'utf8')).toBe('world original');
  expect(m.row).toMatchObject({ mcVersion: '1.21.1', modpackVersionId: 'new', extraEnv: { TYPE: 'NEOFORGE', NEOFORGE_VERSION: '21.1.200' } });
});

it.each([
  { manifestType: 'minecraftModpack', files: [{ projectID: 1, fileID: 2 }] },
  { manifestType: 'minecraftModpack', files: [], serverPackCreatorVersion: '7.3.0' },
])('verweigert Client-Manifeste auch mit enthaltenen Mods: %j', async manifest => {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
  zip.addFile('mods/client.jar', modJar('clientmod', '*'));
  m.archive = zip.toBuffer();
  await expect(installModpack('a', { ...request, provider: 'curseforge' }, task())).rejects.toThrow('Client-Manifest');
  expect(m.stop).not.toHaveBeenCalled();
  expect(m.row.modpackVersionId).toBe('old');
});

it('verweigert ServerPackCreator-Manifeste ohne enthaltene Mod-Dateien vor dem Serverstopp', async () => {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({ serverPackCreatorVersion: '7.3.0', files: ['mods/fehlt.jar'] })));
  zip.addFile('mods/', Buffer.alloc(0));
  m.archive = zip.toBuffer();
  await expect(installModpack('a', { ...request, provider: 'curseforge' }, task())).rejects.toThrow('keine fertigen Mod-Dateien');
  expect(m.stop).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(dir(), 'mods/old.jar'), 'utf8')).toBe('working old mod');
});

function ftbPlan(sha1 = createHash('sha1').update('new mod').digest('hex')) {
  m.cfVersion.isServerPack = false;
  m.ftb.mockResolvedValue({ projectId: 128, versionId: 100482, name: 'FTB OceanBlock 2', version: '1.21.1',
    minecraftVersion: '1.21.1', loader: 'NEOFORGE', loaderVersion: '21.1.248', excludedClientFiles: 2,
    downloads: [{ path: 'mods/server.jar', urls: ['https://fixture.test/mod'], size: 7, sha1 }] });
}

it('installiert das offizielle FTB-Manifest ohne Client-Archiv und erhält Welt, Konfiguration und Spielerdaten', async () => {
  ftbPlan();
  await fs.writeFile(path.join(dir(), 'ops.json'), '[{"name":"Spieler"}]');
  await installModpack('a', { ...request, provider: 'curseforge', startAfter: true }, task());
  expect(m.download.mock.calls.map(args => args[0])).toEqual(['https://fixture.test/mod']);
  expect(await fs.readdir(path.join(dir(), 'mods'))).toEqual(['server.jar']);
  expect(await fs.readFile(path.join(dir(), 'customworld/level.dat'), 'utf8')).toBe('world original');
  expect(await fs.readFile(path.join(dir(), 'config/user.conf'), 'utf8')).toBe('config original');
  expect(await fs.readFile(path.join(dir(), 'ops.json'), 'utf8')).toBe('[{"name":"Spieler"}]');
  expect(m.row.extraEnv).toMatchObject({ TYPE: 'NEOFORGE', NEOFORGE_VERSION: '21.1.248' });
  expect(m.start).toHaveBeenCalled(); expect(m.ready).toHaveBeenCalled();
});

it('bricht bei beschädigten FTB-Dateien vor dem Serverstopp ab und erhält die alte Installation', async () => {
  ftbPlan('0'.repeat(40));
  await expect(installModpack('a', { ...request, provider: 'curseforge' }, task())).rejects.toThrow('Pflichtdatei');
  expect(m.stop).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(dir(), 'mods/old.jar'), 'utf8')).toBe('working old mod');
  expect(m.row.modpackVersionId).toBe('old');
});


it.each([
  ['startserver.sh', 'FORGE_VERSION=47.4.0'],
  ['startserver.bat', 'set FORGE_VERSION=47.4.0'],
  ['startserver.bat', 'set "FORGE_VERSION=47.4.0"'],
  ['start.sh', 'export FORGE_VERSION="47.4.0" # Vorgabe'],
])('übernimmt die feste Forge-Version aus %s: %s', async (name, assignment) => {
  const zip = new AdmZip();
  zip.addFile('paket/mods/server.jar', modJar('servermod', '*'));
  zip.addFile('paket/' + name, Buffer.from(assignment + '\nINSTALLER="forge-1.20.1-$FORGE_VERSION-installer.jar"\n'));
  m.archive = zip.toBuffer();
  await installModpack('a', { ...request, provider: 'curseforge' }, task());
  expect(m.row.extraEnv).toMatchObject({ TYPE: 'FORGE', FORGE_VERSION: '47.4.0' });
  expect(await fs.readFile(path.join(dir(), 'customworld/level.dat'), 'utf8')).toBe('world original');
  await expect(fs.stat(path.join(dir(), name))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('bricht bei widersprüchlichen Loader-Versionen vor dem Serverstopp ab', async () => {
  const zip = new AdmZip(); zip.addFile('mods/server.jar', modJar('servermod', '*'));
  zip.addFile('startserver.sh', Buffer.from('FORGE_VERSION=47.4.0\n'));
  zip.addFile('startserver.bat', Buffer.from('set FORGE_VERSION=47.4.1\n'));
  m.archive = zip.toBuffer();
  await expect(installModpack('a', { ...request, provider: 'curseforge' }, task())).rejects.toThrow('widersprüchliche');
  expect(m.stop).not.toHaveBeenCalled();
});

it.each([
  ['https://cdn.modrinth.com/data/AANobbMI/versions/1/sodium.jar', true],
  ['https://github.com/owner/repo/releases/download/v1/mod.jar', true],
  ['https://raw.githubusercontent.com/owner/repo/main/mod.jar', true],
  ['http://cdn.modrinth.com/data/x.jar', false],
  ['https://cdn.modrinth.com:8443/data/x.jar', false],
  ['https://user:pw@cdn.modrinth.com/data/x.jar', false],
  ['https://192.168.188.129/mod.jar', false],
  ['https://cdn.modrinth.com.evil.example/x.jar', false],
  ['file:///etc/passwd', false],
  ['kein url', false],
])('lässt .mrpack-Downloads nur von erlaubten Hosts zu: %s → %s', (url, allowed) => {
  expect(allowedMrpackUrl(url)).toBe(allowed);
});
