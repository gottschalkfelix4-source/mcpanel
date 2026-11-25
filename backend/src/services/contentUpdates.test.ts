import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeCurseforgeFingerprint } from '../lib/curseforgeFingerprint.js';
import type { ProjectVersion } from '../providers/types.js';

/**
 * Update-Prüfung einzelner Mods/Plugins. Das Dateisystem ist echt (temporäres
 * Datenverzeichnis je Test), Modrinth und Downloads sind gemockt. Die Module
 * werden je Test frisch geladen, damit die Modul-Caches (SHA-1, Projektzitate)
 * keine Ergebnisse in den nächsten Test tragen.
 */
const mocks = vi.hoisted(() => ({
  root: '',
  getVersionsForHashes: vi.fn(),
  getProjectsByIds: vi.fn(),
  getVersions: vi.fn(),
  getVersion: vi.fn(),
  downloadToFile: vi.fn(),
  remainingDiskBytes: vi.fn(),
  // CurseForge-Zweig
  cfConfigured: true,
  cfFingerprintMatches: vi.fn(),
  cfLatestCompatible: vi.fn(),
  cfGetProject: vi.fn(),
  cfGetVersion: vi.fn(),
  cfResolveDownloadUrl: vi.fn(),
  cfDownloadHeaders: vi.fn(),
}));

const serverDirOf = (id: string) => path.join(mocks.root, 'servers', id);

vi.mock('../config.js', () => ({ serverDir: (id: string) => serverDirOf(id) }));
vi.mock('../providers/modrinth.js', () => ({
  getVersionsForHashes: mocks.getVersionsForHashes,
  getProjectsByIds: mocks.getProjectsByIds,
  getVersions: mocks.getVersions,
  getVersion: mocks.getVersion,
  modrinthHeaders: () => ({ 'User-Agent': 'test' }),
}));
vi.mock('../providers/curseforge.js', () => ({
  isConfigured: async () => mocks.cfConfigured,
  fingerprintMatches: mocks.cfFingerprintMatches,
  latestCompatibleVersion: mocks.cfLatestCompatible,
  getProject: mocks.cfGetProject,
  getVersion: mocks.cfGetVersion,
  resolveDownloadUrl: mocks.cfResolveDownloadUrl,
  downloadHeaders: mocks.cfDownloadHeaders,
  toVersionPublic: (file: any): ProjectVersion => ({
    provider: 'curseforge',
    id: String(file.id),
    projectId: String(file.modId),
    name: file.displayName,
    versionNumber: file.displayName,
    gameVersions: (file.gameVersions ?? []).filter((v: string) => /^\d/.test(v)),
    loaders: (file.gameVersions ?? [])
      .map((v: string) => v.toLowerCase())
      .filter((v: string) => ['forge', 'fabric', 'neoforge', 'quilt'].includes(v)),
    datePublished: file.fileDate,
    downloadUrl: file.downloadUrl ?? null,
    filename: file.fileName,
    fileSize: file.fileLength ?? 0,
    versionType: file.releaseType === 2 ? 'beta' : file.releaseType === 3 ? 'alpha' : 'release',
  }),
}));
vi.mock('../lib/download.js', () => ({ downloadToFile: mocks.downloadToFile }));
vi.mock('./quota.js', () => ({ remainingDiskBytes: mocks.remainingDiskBytes }));

let checkContentUpdates: typeof import('./contentUpdates.js').checkContentUpdates;
let applyContentUpdate: typeof import('./contentUpdates.js').applyContentUpdate;

const version = (over: Partial<ProjectVersion> & { id: string; projectId: string }): ProjectVersion => ({
  provider: 'modrinth',
  name: '',
  versionNumber: '1.0.0',
  gameVersions: ['1.21.1'],
  loaders: ['fabric'],
  datePublished: '2026-01-01T00:00:00.000Z',
  downloadUrl: 'https://cdn.modrinth.com/test.jar',
  filename: 'mod-1.0.0.jar',
  fileSize: 123,
  versionType: 'release',
  ...over,
});

const sha1 = (content: string) => crypto.createHash('sha1').update(content).digest('hex');

const server = (type = 'FABRIC') =>
  ({ id: 'srv-1', type, mcVersion: '1.21.1', extraEnv: {} }) as unknown as Server;

const modsDir = () => path.join(serverDirOf('srv-1'), 'mods');

const probe = { id: 'probe-1', slug: 'mein-projekt', title: 'Mein Projekt', projectType: 'mod', iconUrl: null };

beforeEach(async () => {
  mocks.root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-updates-'));
  await fs.mkdir(modsDir(), { recursive: true });
  vi.clearAllMocks();
  vi.resetModules();
  mocks.cfConfigured = false;
  mocks.cfResolveDownloadUrl.mockImplementation(async (_a: string, _b: string, fileName?: string) =>
    fileName ? `https://edge.forgecdn.net/${fileName}` : null,
  );
  mocks.cfDownloadHeaders.mockResolvedValue({ 'x-api-key': 'test-key' });
  ({ checkContentUpdates, applyContentUpdate } = await import('./contentUpdates.js'));
});

afterEach(async () => {
  await fs.rm(mocks.root, { recursive: true, force: true });
});

describe('checkContentUpdates', () => {
  it('meldet ein Update samt Projekt- und Versionsangaben', async () => {
    const inhalt = 'mod-a-inhalt';
    await fs.writeFile(path.join(modsDir(), 'mod-a.jar'), inhalt);
    const hash = sha1(inhalt);

    mocks.getVersionsForHashes.mockResolvedValue(
      new Map([[hash, [version({ id: 'v1', projectId: 'probe-1', versionNumber: '1.0.0' })]]]),
    );
    mocks.getProjectsByIds.mockResolvedValue(new Map([['probe-1', probe]]));
    mocks.getVersions.mockResolvedValue([
      version({
        id: 'v2',
        projectId: 'probe-1',
        name: 'Mein Projekt 1.2.0',
        versionNumber: '1.2.0',
        datePublished: '2026-06-01T00:00:00.000Z',
        versionType: 'beta',
        filename: 'mein-projekt-1.2.0.jar',
      }),
    ]);

    const result = await checkContentUpdates(server());

    expect(result.error).toBeNull();
    expect(result.updates).toHaveLength(1);
    const update = result.updates[0];
    expect(update).toMatchObject({
      filename: 'mod-a.jar',
      projectId: 'probe-1',
      projectSlug: 'mein-projekt',
      projectName: 'Mein Projekt',
      projectUrl: 'https://modrinth.com/mod/mein-projekt',
      installedVersion: '1.0.0',
      latestVersionId: 'v2',
      latestVersion: '1.2.0',
      latestVersionName: 'Mein Projekt 1.2.0',
      latestVersionType: 'beta',
      latestFilename: 'mein-projekt-1.2.0.jar',
      downloadUrl: 'https://cdn.modrinth.com/test.jar',
    });
    // Mods werden mit Loader- und Minecraft-Filter geprüft.
    expect(mocks.getVersions).toHaveBeenCalledWith('probe-1', {
      loaders: ['fabric'],
      gameVersions: ['1.21.1'],
    });
  });

  it('meldet kein Update, wenn die installierte Version die neueste ist', async () => {
    const inhalt = 'aktuell';
    await fs.writeFile(path.join(modsDir(), 'aktuell.jar'), inhalt);
    mocks.getVersionsForHashes.mockResolvedValue(
      new Map([[sha1(inhalt), [version({ id: 'v1', projectId: 'probe-1' })]]]),
    );
    mocks.getProjectsByIds.mockResolvedValue(new Map([['probe-1', probe]]));
    mocks.getVersions.mockResolvedValue([version({ id: 'v1', projectId: 'probe-1' })]);

    const result = await checkContentUpdates(server());

    expect(result.updates).toEqual([]);
  });

  it('ignoriert deaktivierte, unbekannte und Nicht-Jar-Dateien', async () => {
    const bekannt = 'bekannt';
    await fs.writeFile(path.join(modsDir(), 'bekannt.jar'), bekannt);
    // Deaktivierte Kopie einer bekannten Datei: darf nicht als Kandidat gelten.
    await fs.writeFile(path.join(modsDir(), 'bekannt.jar.disabled'), bekannt);
    await fs.writeFile(path.join(modsDir(), 'fremd.jar'), 'von anderswo');
    await fs.writeFile(path.join(modsDir(), 'notizen.txt'), 'kein jar');
    mocks.getVersionsForHashes.mockResolvedValue(
      new Map([[sha1(bekannt), [version({ id: 'v1', projectId: 'probe-1' })]]]),
    );
    mocks.getProjectsByIds.mockResolvedValue(new Map([['probe-1', probe]]));
    mocks.getVersions.mockResolvedValue([version({ id: 'v1', projectId: 'probe-1' })]);

    const result = await checkContentUpdates(server());

    expect(result.updates).toEqual([]);
    // Anfragt werden nur die aktiven Jars – die deaktivierte Kopie und die
    // Textdatei zählen nicht.
    const angefragt = mocks.getVersionsForHashes.mock.calls[0][0] as string[];
    expect([...angefragt].sort()).toEqual([sha1(bekannt), sha1('von anderswo')].sort());
  });

  it('prüft Plugins ohne Loader-Filter', async () => {
    // Paper lädt aus plugins/, nicht aus mods/ – dort muss die Datei liegen.
    const pluginsDir = path.join(serverDirOf('srv-1'), 'plugins');
    await fs.mkdir(pluginsDir, { recursive: true });
    const inhalt = 'plugin';
    await fs.writeFile(path.join(pluginsDir, 'plugin-a.jar'), inhalt);
    mocks.getVersionsForHashes.mockResolvedValue(
      new Map([[sha1(inhalt), [version({ id: 'v1', projectId: 'probe-1' })]]]),
    );
    mocks.getProjectsByIds.mockResolvedValue(new Map([['probe-1', probe]]));
    mocks.getVersions.mockResolvedValue([version({ id: 'v1', projectId: 'probe-1' })]);

    await checkContentUpdates(server('PAPER'));

    expect(mocks.getVersions).toHaveBeenCalledWith('probe-1', {
      loaders: undefined,
      gameVersions: ['1.21.1'],
    });
  });

  it('lässt einzelne Projektfehler andere Updates nicht kosten', async () => {
    const inhaltA = 'mod-a';
    const inhaltB = 'mod-b';
    await fs.writeFile(path.join(modsDir(), 'mod-a.jar'), inhaltA);
    await fs.writeFile(path.join(modsDir(), 'mod-b.jar'), inhaltB);
    mocks.getVersionsForHashes.mockResolvedValue(
      new Map([
        [sha1(inhaltA), [version({ id: 'v1', projectId: 'kaputt' })]],
        [sha1(inhaltB), [version({ id: 'v1', projectId: 'probe-1' })]],
      ]),
    );
    mocks.getProjectsByIds.mockResolvedValue(new Map([['probe-1', probe]]));
    mocks.getVersions
      .mockRejectedValueOnce(new Error('Modrinth: HTTP 404'))
      .mockResolvedValueOnce([version({ id: 'v2', projectId: 'probe-1', datePublished: '2026-06-01T00:00:00.000Z' })]);

    const result = await checkContentUpdates(server());

    expect(result.error).toBeNull();
    expect(result.updates.map((u) => u.filename)).toEqual(['mod-b.jar']);
  });

  it('meldet einen Fehler, wenn Modrinth nicht erreichbar ist', async () => {
    await fs.writeFile(path.join(modsDir(), 'mod-a.jar'), 'x');
    mocks.getVersionsForHashes.mockRejectedValue(new Error('Modrinth: HTTP 503'));

    const result = await checkContentUpdates(server());

    expect(result.updates).toEqual([]);
    expect(result.error).toContain('Modrinth');
  });
});

describe('applyContentUpdate', () => {
  it('ersetzt die alte Datei und räumt eine deaktivierte Kopie auf', async () => {
    await fs.writeFile(path.join(modsDir(), 'mod-a.jar'), 'alt');
    await fs.writeFile(path.join(modsDir(), 'mod-a.jar.disabled'), 'alt-deaktiviert');
    mocks.getVersion.mockResolvedValue(
      version({
        id: 'v2',
        projectId: 'probe-1',
        versionNumber: '1.2.0',
        filename: 'mod-a-1.2.0.jar',
        downloadUrl: 'https://cdn.modrinth.com/neu.jar',
      }),
    );
    mocks.remainingDiskBytes.mockResolvedValue(10_000);
    mocks.downloadToFile.mockImplementation(async (_url: string, target: string) => {
      await fs.writeFile(target, 'neu');
      return 3;
    });

    const result = await applyContentUpdate(server(), 'mod-a.jar', 'probe-1', 'v2');

    expect(result.newFilename).toBe('mod-a-1.2.0.jar');
    expect(await fs.readFile(path.join(modsDir(), 'mod-a-1.2.0.jar'), 'utf8')).toBe('neu');
    await expect(fs.stat(path.join(modsDir(), 'mod-a.jar'))).rejects.toThrow();
    await expect(fs.stat(path.join(modsDir(), 'mod-a.jar.disabled'))).rejects.toThrow();
    // Die alte Größe wird vom Kontingent abgezogen, die neue Datei durfte den
    // Rest verbrauchen.
    expect(mocks.downloadToFile).toHaveBeenCalledWith(
      'https://cdn.modrinth.com/neu.jar',
      path.join(modsDir(), 'mod-a-1.2.0.jar'),
      expect.objectContaining({ maxBytes: 10_000 + 'alt'.length }),
    );
  });

  it('lehnt eine Versions-ID aus einem anderen Projekt ab', async () => {
    await fs.writeFile(path.join(modsDir(), 'mod-a.jar'), 'alt');
    mocks.getVersion.mockResolvedValue(version({ id: 'v2', projectId: 'anderes-projekt' }));

    await expect(applyContentUpdate(server(), 'mod-a.jar', 'probe-1', 'v2')).rejects.toMatchObject({
      statusCode: 400,
    });
    // Nichts wurde angetastet.
    expect(await fs.readFile(path.join(modsDir(), 'mod-a.jar'), 'utf8')).toBe('alt');
  });
});


describe('checkContentUpdates mit CurseForge', () => {
  const fpVon = (inhalt: string) => computeCurseforgeFingerprint(new TextEncoder().encode(inhalt));

  const cfFile = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 101,
    modId: 900,
    displayName: 'CF Mod 1.0.0',
    fileName: 'cf-mod-1.0.0.jar',
    fileDate: '2026-01-01T00:00:00.000Z',
    downloadUrl: null,
    gameVersions: ['1.21.1', 'Forge'],
    releaseType: 1,
    fileFingerprint: 0,
    ...over,
  });

  const cfVersion = (over: Partial<ProjectVersion> = {}): ProjectVersion => ({
    provider: 'curseforge',
    id: '102',
    projectId: '900',
    name: 'CF Mod 2.0.0',
    versionNumber: 'CF Mod 2.0.0',
    gameVersions: ['1.21.1'],
    loaders: ['forge'],
    datePublished: '2026-06-01T00:00:00.000Z',
    downloadUrl: 'https://edge.forgecdn.net/cf-mod-2.0.0.jar',
    filename: 'cf-mod-2.0.0.jar',
    fileSize: 5,
    versionType: 'beta',
    ...over,
  });

  it('erkennt CurseForge-Dateien über den Fingerprint und meldet Updates', async () => {
    const inhalt = 'nur-von-curseforge';
    await fs.writeFile(path.join(modsDir(), 'cf-mod.jar'), inhalt);
    mocks.cfConfigured = true;
    const fp = fpVon(inhalt);
    mocks.cfFingerprintMatches.mockResolvedValue(
      new Map([[fp, { modId: 900, file: cfFile() }]]),
    );
    mocks.cfGetProject.mockResolvedValue({ id: '900', slug: 'cf-mod', name: 'CF Mod' } as any);
    mocks.cfLatestCompatible.mockResolvedValue(cfVersion());

    // Modrinth kennt die Datei nicht.
    mocks.getVersionsForHashes.mockResolvedValue(new Map());

    const result = await checkContentUpdates(server());

    expect(result.error).toBeNull();
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]).toMatchObject({
      filename: 'cf-mod.jar',
      provider: 'curseforge',
      projectId: '900',
      projectSlug: 'cf-mod',
      projectName: 'CF Mod',
      projectUrl: 'https://www.curseforge.com/minecraft/mc-mods/cf-mod',
      installedVersion: 'CF Mod 1.0.0',
      latestVersionId: '102',
      latestVersionType: 'beta',
      latestFilename: 'cf-mod-2.0.0.jar',
    });
  });

  it('prüft ohne API-Key nur Modrinth und meldet keinen Fehler', async () => {
    const inhalt = 'ohne-schluessel';
    await fs.writeFile(path.join(modsDir(), 'unbekannt.jar'), inhalt);
    mocks.cfConfigured = false;
    mocks.getVersionsForHashes.mockResolvedValue(new Map());

    const result = await checkContentUpdates(server());

    expect(result.updates).toEqual([]);
    expect(result.error).toBeNull();
    expect(mocks.cfFingerprintMatches).not.toHaveBeenCalled();
  });

  it('CurseForge-Ausfall meldet einen Fehler, Modrinth-Treffer bleiben erhalten', async () => {
    // Eine Datei, die Modrinth NICHT kennt – sie geht an CurseForge, das ausfällt.
    const nurCf = 'nur-curseforge-inhalt';
    await fs.writeFile(path.join(modsDir(), 'cf-einzeln.jar'), nurCf);
    // Eine Modrinth-Datei, deren Update trotzdem geliefert wird.
    const modrinthInhalt = 'mod-a';
    await fs.writeFile(path.join(modsDir(), 'mod-a.jar'), modrinthInhalt);
    mocks.cfConfigured = true;
    mocks.cfFingerprintMatches.mockRejectedValue(new Error('CurseForge: HTTP 503'));
    mocks.getVersionsForHashes.mockResolvedValue(
      new Map([[sha1(modrinthInhalt), [version({ id: 'v1', projectId: 'probe-1' })]]]),
    );
    mocks.getProjectsByIds.mockResolvedValue(new Map([['probe-1', probe]]));
    mocks.getVersions.mockResolvedValue([
      version({ id: 'v2', projectId: 'probe-1', datePublished: '2026-06-01T00:00:00.000Z' }),
    ]);

    const result = await checkContentUpdates(server());

    expect(result.updates.map((u) => u.filename)).toEqual(['mod-a.jar']);
    expect(result.updates[0].provider).toBe('modrinth');
    expect(result.error).toContain('CurseForge');
  });
});

describe('applyContentUpdate mit CurseForge', () => {
  it('lädt über die CDN-URL mit API-Key und ersetzt die alte Datei', async () => {
    await fs.writeFile(path.join(modsDir(), 'cf-mod.jar'), 'alt');
    mocks.cfGetVersion.mockResolvedValue({
      provider: 'curseforge',
      id: '102',
      projectId: '900',
      versionNumber: 'CF Mod 2.0.0',
      filename: 'cf-mod-2.0.0.jar',
      downloadUrl: null,
    } as any);
    mocks.remainingDiskBytes.mockResolvedValue(10_000);
    mocks.downloadToFile.mockImplementation(async (_url: string, target: string) => {
      await fs.writeFile(target, 'neu');
      return 3;
    });

    const result = await applyContentUpdate(server(), 'cf-mod.jar', '900', '102', 'curseforge');

    expect(result.newFilename).toBe('cf-mod-2.0.0.jar');
    expect(mocks.cfResolveDownloadUrl).toHaveBeenCalledWith('900', '102', 'cf-mod-2.0.0.jar');
    expect(mocks.downloadToFile).toHaveBeenCalledWith(
      'https://edge.forgecdn.net/cf-mod-2.0.0.jar',
      path.join(modsDir(), 'cf-mod-2.0.0.jar'),
      expect.objectContaining({ headers: { 'x-api-key': 'test-key' } }),
    );
    await expect(fs.stat(path.join(modsDir(), 'cf-mod.jar'))).rejects.toThrow();
    expect(await fs.readFile(path.join(modsDir(), 'cf-mod-2.0.0.jar'), 'utf8')).toBe('neu');
  });
});
