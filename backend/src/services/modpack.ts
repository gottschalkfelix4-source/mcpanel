import { dirSize } from './files.js';
import { archivePath as archiveEntryPath, safePath } from '../lib/safePath.js';
import { commitRestore, finishRestore, recoverInterruptedRestore, restorePaths, saveRestoreMetadata } from './restoreRecovery.js';
import { parseProperties } from './properties.js';
import { withServerOperation } from './operations.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { Server } from '@prisma/client';
import { cacheDir, serverDir, serverBackupDir } from '../config.js';
import { prisma } from '../db.js';
import { downloadToFile } from '../lib/download.js';
import * as modrinth from '../providers/modrinth.js';
import * as curseforge from '../providers/curseforge.js';
import type { ProjectVersion, ProviderId } from '../providers/types.js';
import type { TaskHandle } from './tasks.js';
import * as dockerSvc from './docker.js';
import { createBackup } from './backups.js';
import { invalidateDiskUsage } from './diskUsage.js';

export interface InstallRequest {
  provider: ProviderId;
  projectId: string;
  versionId: string;
  /** Vorher automatisch ein Backup anlegen (Standard bei Updates). */
  backupFirst?: boolean;
  /** Vorhandene config/ nicht überschreiben. */
  keepConfig?: boolean;
  /** Nach der Installation direkt starten. */
  startAfter?: boolean;
}

type Loader = 'FORGE' | 'NEOFORGE' | 'FABRIC' | 'QUILT' | 'VANILLA';

interface PackPlan {
  name: string;
  version: string;
  minecraftVersion: string;
  loader: Loader;
  loaderVersion: string | null;
  /** Dateien, die heruntergeladen werden müssen (Pfad relativ zu /data). */
  downloads: { path: string; urls: string[]; size: number }[];
  /** Ordner im Archiv, deren Inhalt nach /data kopiert wird. */
  overrideDirs: string[];
  /**
   * Das Archiv ist ein fertiges Serverpaket des Autors – es enthält bereits
   * nur servertaugliche Mods, deshalb entfällt die Client-Mod-Prüfung.
   */
  isServerPack: boolean;
  zip: AdmZip;
}

// ---------------------------------------------------------------------------
// Öffentliche API
// ---------------------------------------------------------------------------

export async function getVersion(
  provider: ProviderId,
  projectId: string,
  versionId: string,
): Promise<ProjectVersion> {
  return provider === 'modrinth'
    ? modrinth.getVersion(versionId)
    : curseforge.getVersion(projectId, versionId);
}

export async function listVersions(
  provider: ProviderId,
  projectId: string,
): Promise<ProjectVersion[]> {
  return provider === 'modrinth'
    ? modrinth.getVersions(projectId)
    : curseforge.getVersions(projectId);
}

/** Prüft, ob für das installierte Modpack eine neuere Version existiert. */
export async function checkForUpdate(server: Server) {
  if (!server.modpackProvider || !server.modpackProjectId) return null;
  const provider = server.modpackProvider as ProviderId;
  const versions = await listVersions(provider, server.modpackProjectId);
  if (versions.length === 0) return null;

  const sorted = [...versions].sort(
    (a, b) => new Date(b.datePublished).getTime() - new Date(a.datePublished).getTime(),
  );
  const latest = sorted[0];
  const currentIndex = sorted.findIndex((v) => v.id === server.modpackVersionId);
  const current = currentIndex >= 0 ? sorted[currentIndex] : null;

  return {
    latest,
    current,
    updateAvailable: latest.id !== server.modpackVersionId,
    behindBy: currentIndex > 0 ? currentIndex : currentIndex === 0 ? 0 : null,
  };
}

/**
 * Installiert (oder aktualisiert) ein Modpack auf einem Server.
 * Läuft als Hintergrund-Task und meldet Fortschritt über den TaskHandle.
 */
async function installModpackImpl(
  serverId: string,
  request: InstallRequest,
  task: TaskHandle,
): Promise<void> {
  const server = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
  const isUpdate = Boolean(server.modpackProjectId);

  await task.update(1, 'Serverstatus prüfen …');
  const { state } = await dockerSvc.getState(server);
  const wasRunning = state === 'running' || state === 'starting';
  if (wasRunning) {
    await task.log('Server wird für die Installation gestoppt …');
    await dockerSvc.stop(server);
  }

  if (request.backupFirst ?? isUpdate) {
    await task.update(4, 'Sicherheitsbackup wird erstellt …');
    await task.log('Backup vor der Installation …');
    await createBackup(server, {
      name: `Vor ${isUpdate ? 'Update' : 'Installation'} ${new Date().toISOString().slice(0, 16)}`,
      note: 'Automatisch vor Modpack-Installation',
      createdById: null,
    });
  }

  await task.update(8, 'Modpack-Version wird geladen …');
  const version = await getVersion(request.provider, request.projectId, request.versionId);
  const project =
    request.provider === 'modrinth'
      ? await modrinth.getProject(request.projectId)
      : await curseforge.getProject(request.projectId);

  await task.log(`Modpack: ${project.name} – ${version.name}`);

  // --- Serverpaket bevorzugen ---------------------------------------------
  // CurseForge-Modpacks sind Client-Pakete: das Manifest enthält auch reine
  // Client-Mods (Sodium & Co.), die einen Server beim Start abstürzen lassen.
  // Bieten die Autoren ein Serverpaket an, nehmen wir immer das.
  let archiveSource = version;

  if (request.provider === 'curseforge' && !version.isServerPack) {
    try {
      const found = await curseforge.findServerPack(request.projectId, version);
      if (found) {
        archiveSource = found.pack;
        const source =
          found.route === 'linked'
            ? 'Serverpaket des Autors'
            : 'Passendes Serverpaket über die Versionskennung gefunden';
        await task.log(
          `${source}: ${found.pack.filename} ` +
            `(${(found.pack.fileSize / 1024 / 1024).toFixed(0)} MB) – wird statt des Client-Pakets verwendet.`,
        );
      } else {
        // Wie mit Client-Mods umgegangen wird, hängt vom Loader ab – das steht
        // weiter unten im Protokoll, sobald das Archiv analysiert ist.
        await task.log(
          'HINWEIS: Dieses Modpack bietet kein Serverpaket an – es wird das Client-Paket installiert.',
        );
      }
    } catch (err) {
      await task.log(
        `WARNUNG: Serverpaket nicht abrufbar (${err instanceof Error ? err.message : err}) – ` +
          'nutze das Client-Paket und sortiere Client-Mods selbst aus.',
      );
    }
  }

  // --- 1. Archiv herunterladen --------------------------------------------
  const archivePath = path.join(
    cacheDir(),
    'modpacks',
    `${request.provider}-${request.projectId}-${archiveSource.id}-${sanitize(archiveSource.filename)}`,
  );

  let url = archiveSource.downloadUrl;
  if (!url && request.provider === 'curseforge') {
    url = await curseforge.resolveDownloadUrl(
      request.projectId,
      archiveSource.id,
      archiveSource.filename,
    );
  }
  if (!url) {
    throw new Error(
      'Für diese Datei erlaubt der Autor keinen automatischen Download. ' +
        'Lade das Serverpaket manuell herunter und lege es über den Dateimanager ab.',
    );
  }

  const cached = await fs.stat(archivePath).catch(() => null);
  if (cached && cached.size > 0) {
    await task.log('Archiv aus dem Cache verwendet.');
    await task.update(20, 'Archiv aus dem Cache');
  } else {
    await task.update(10, 'Modpack wird heruntergeladen …');
    await downloadToFile(url, archivePath, {
      headers: request.provider === 'modrinth' ? modrinth.modrinthHeaders() : undefined,
      onProgress: throttle((received, total) => {
        const pct = total ? (received / total) * 100 : 0;
        void task.update(10 + pct * 0.1, `Modpack wird geladen … ${formatBytes(received)}`);
      }),
    });
    await task.log(`Archiv geladen: ${archiveSource.filename}`);
  }

  // --- 2. Archiv analysieren ----------------------------------------------
  await task.update(21, 'Archiv wird analysiert …');
  const plan =
    request.provider === 'modrinth'
      ? await planFromMrpack(archivePath)
      : await planFromCurseforge(archivePath, task, {
          minecraftVersion: pickMinecraftVersion(version) ?? server.mcVersion,
          loader: pickLoader(version),
          name: project.name,
          version: version.name,
        });

  await task.log(
    `Minecraft ${plan.minecraftVersion} · ${plan.loader}` +
      `${plan.loaderVersion ? ' ' + plan.loaderVersion : ''} · ${plan.downloads.length} Dateien`,
  );

  // --- 3. Alte Mods entfernen ---------------------------------------------
  const original = serverDir(serverId);
  const { stage: dir } = restorePaths(serverId);
  await fs.mkdir(original, { recursive: true });
  await fs.cp(original, dir, { recursive: true });
  const rawProperties = await fs.readFile(safePath(original, 'server.properties'), 'utf8').catch(() => '');
  const worldName = parseProperties(rawProperties)['level-name'] || 'world';
  const protectedPath = (relative: string) => isProtectedPackPath(relative, worldName, request.keepConfig ?? false);
  // Validate all paths before removing/replacing anything, even in staging.
  for (const item of plan.downloads) archiveEntryPath(dir, item.path);
  for (const prefixDir of plan.overrideDirs) {
    const prefix = prefixDir === '.' ? '' : prefixDir.replace(/\/+$/, '') + '/';
    for (const entry of plan.zip.getEntries()) {
      const name = entry.entryName.replace(/\\/g, '/');
      if (!prefix || name.startsWith(prefix)) archiveEntryPath(dir, prefix ? name.slice(prefix.length) : name);
    }
  }
  if (isUpdate) {
    await task.update(24, 'Alte Mods werden entfernt …');
    for (const sub of ['mods', 'kubejs/startup_scripts', 'kubejs/server_scripts']) {
      await fs.rm(path.join(dir, sub), { recursive: true, force: true });
    }
    await task.log('mods/ geleert – Welt, Konfiguration und Spielerdaten bleiben erhalten.');
  }

  // --- 4. Archivinhalt entpacken ------------------------------------------
  await task.update(26, 'Modpack-Dateien werden entpackt …');
  const extracted = await extractOverrides(plan, dir, { keepConfig: request.keepConfig ?? false, worldName, maxGrowth: server.quotaDiskMb > 0 ? Math.max(0, server.quotaDiskMb * 1024 * 1024 - await dirSize(dir) - await dirSize(serverBackupDir(serverId))) : Infinity });
  if (plan.isServerPack) {
    await task.log(`${extracted} Dateien aus dem Serverpaket entpackt.`);
  }

  // --- 5. Mods herunterladen ----------------------------------------------
  const total = plan.downloads.length;
  let completed = 0;
  const concurrency = 1; // A shared disk budget must include each completed file before the next download.
  const queue = [...plan.downloads];
  const failures: string[] = [];

  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const target = archiveEntryPath(dir, item.path);
      if (protectedPath(path.relative(dir, target))) continue;

      let ok = false;
      for (const candidate of item.urls) {
        try {
          const previous = await fs.stat(target).catch(() => null);
          const budget = server.quotaDiskMb > 0 ? Math.max(0, server.quotaDiskMb * 1024 * 1024 - await dirSize(dir) - await dirSize(serverBackupDir(serverId))) + (previous?.size ?? 0) : Infinity;
          await downloadToFile(candidate, target, { retries: 2, maxBytes: budget });
          ok = true;
          break;
        } catch {
          /* nächste URL versuchen */
        }
      }
      if (!ok) {
        failures.push(item.path);
        await task.log(`FEHLER: ${item.path} konnte nicht geladen werden`);
      }
      completed++;
      if (completed % 3 === 0 || completed === total) {
        await task.update(
          30 + (completed / Math.max(1, total)) * 55,
          `Mods werden geladen … ${completed}/${total}`,
        );
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, worker));

  if (failures.length > 0) {
    throw new Error(`${failures.length} Pflichtdatei(en) konnten nicht geladen werden: ${failures.join(', ')}`);
  }

  // --- 6. Client-Mods aussortieren ----------------------------------------
  // Nur beim Client-Paket nötig – und nur bei Forge/NeoForge:
  //   * Modrinth markiert die Seite pro Datei (env.server), das ist schon erledigt.
  //   * Fabric und Quilt lesen `environment` aus der fabric.mod.json und
  //     überspringen Client-Mods selbst. Die Jars müssen dabei liegen bleiben,
  //     sonst schlägt die Abhängigkeitsauflösung anderer Mods fehl.
  //   * Forge/NeoForge kennen keine solche Angabe – hier filtern wir.
  if (!plan.isServerPack && request.provider === 'curseforge') {
    await task.update(88, 'Client-Mods werden geprüft …');

    const isFabricLike = plan.loader === 'FABRIC' || plan.loader === 'QUILT';
    const { disabled, keptAsDependency } = isFabricLike
      ? await disableFabricClientDependents(dir)
      : await disableClientOnlyMods(dir);

    if (isFabricLike) {
      await task.log(
        `${plan.loader} überspringt als "client" markierte Mods selbst – ` +
          'geprüft wird nur, was faktisch clientseitig ist, es aber nicht angibt.',
      );
    }

    if (disabled.length > 0) {
      await task.log(`${disabled.length} Client-Mod(s) deaktiviert:`);
      for (const entry of disabled.slice(0, 15)) {
        await task.log(`   ${entry.file} – ${entry.reason}`);
      }
      if (disabled.length > 15) await task.log(`   … +${disabled.length - 15} weitere`);
      await task.log('Im Tab "Mods" kannst du sie bei Bedarf wieder aktivieren.');
    } else {
      await task.log('Keine problematischen Client-Mods gefunden.');
    }

    for (const kept of keptAsDependency) {
      await task.log(`${kept.file} bleibt aktiv – ${kept.neededBy} braucht sie als Abhängigkeit.`);
    }
  }

  // --- 7. Server-Datensatz aktualisieren ----------------------------------
  await task.update(94, 'Servereinstellungen werden gespeichert …');
  const extraEnv: Record<string, string> = {
    ...((server.extraEnv ?? {}) as Record<string, string>),
    TYPE: plan.loader,
  };
  delete extraEnv.FORGE_VERSION;
  delete extraEnv.NEOFORGE_VERSION;
  delete extraEnv.FABRIC_LOADER_VERSION;
  delete extraEnv.QUILT_LOADER_VERSION;

  if (plan.loaderVersion) {
    if (plan.loader === 'FORGE') extraEnv.FORGE_VERSION = plan.loaderVersion;
    if (plan.loader === 'NEOFORGE') extraEnv.NEOFORGE_VERSION = plan.loaderVersion;
    if (plan.loader === 'FABRIC') extraEnv.FABRIC_LOADER_VERSION = plan.loaderVersion;
    if (plan.loader === 'QUILT') extraEnv.QUILT_LOADER_VERSION = plan.loaderVersion;
  }

  if (server.quotaDiskMb > 0 && await dirSize(dir) + await dirSize(serverBackupDir(serverId)) > server.quotaDiskMb * 1024 * 1024) throw new Error('Modpack überschreitet das Speicherkontingent');
  await saveRestoreMetadata(serverId, {
    type: server.type, mcVersion: server.mcVersion, extraEnv: server.extraEnv,
    modpackProvider: server.modpackProvider, modpackProjectId: server.modpackProjectId,
    modpackVersionId: server.modpackVersionId, modpackName: server.modpackName,
    modpackVersionName: server.modpackVersionName, modpackIconUrl: server.modpackIconUrl,
  });
  const updated = await prisma.server.update({
    where: { id: serverId },
    data: {
      type: 'MODPACK',
      mcVersion: plan.minecraftVersion,
      extraEnv,
      modpackProvider: request.provider,
      modpackProjectId: request.projectId,
      // Immer die vom Nutzer gewählte Version speichern – nicht die des
      // Serverpakets, sonst findet die Update-Prüfung sie nicht wieder.
      modpackVersionId: request.versionId,
      modpackName: project.name,
      modpackVersionName: version.name,
      modpackIconUrl: project.iconUrl,
    },
  });

  // --- 8. Container neu aufsetzen -----------------------------------------
  await task.update(97, 'Container wird neu aufgesetzt …');
  await commitRestore(serverId);
  await dockerSvc.recreateContainer(updated);
  invalidateDiskUsage(serverId);

  if (request.startAfter ?? wasRunning) {
    await task.update(99, 'Server wird gestartet …');
    await dockerSvc.start(updated);
  }

  await task.update(
    100,
    `${project.name} ${version.name} installiert`,
  );
  await finishRestore(serverId);
}

// ---------------------------------------------------------------------------
// Modrinth (.mrpack)
// ---------------------------------------------------------------------------

interface MrIndex {
  formatVersion: number;
  name: string;
  versionId: string;
  dependencies: Record<string, string>;
  files: {
    path: string;
    downloads: string[];
    fileSize?: number;
    env?: { client?: string; server?: string };
  }[];
}

async function planFromMrpack(archivePath: string): Promise<PackPlan> {
  const zip = new AdmZip(archivePath);
  const entry = zip.getEntry('modrinth.index.json');
  if (!entry) throw new Error('Ungültiges .mrpack – modrinth.index.json fehlt');
  const index = JSON.parse(entry.getData().toString('utf8')) as MrIndex;

  const deps = index.dependencies ?? {};
  let loader: Loader = 'VANILLA';
  let loaderVersion: string | null = null;
  if (deps['neoforge']) {
    loader = 'NEOFORGE';
    loaderVersion = deps['neoforge'];
  } else if (deps['forge']) {
    loader = 'FORGE';
    loaderVersion = deps['forge'];
  } else if (deps['fabric-loader']) {
    loader = 'FABRIC';
    loaderVersion = deps['fabric-loader'];
  } else if (deps['quilt-loader']) {
    loader = 'QUILT';
    loaderVersion = deps['quilt-loader'];
  }

  // Modrinth markiert Client-Only-Dateien explizit – die lassen wir weg.
  const downloads = index.files
    .filter((f) => f.env?.server !== 'unsupported')
    .map((f) => ({
      path: f.path.replace(/\\/g, '/'),
      urls: f.downloads,
      size: f.fileSize ?? 0,
    }));

  return {
    name: index.name,
    version: index.versionId,
    minecraftVersion: deps['minecraft'] ?? 'LATEST',
    loader,
    loaderVersion,
    downloads,
    overrideDirs: ['overrides', 'server-overrides'],
    isServerPack: false,
    zip,
  };
}

// ---------------------------------------------------------------------------
// CurseForge (manifest.json oder fertiges Serverpaket)
// ---------------------------------------------------------------------------

interface CfManifest {
  minecraft: { version: string; modLoaders: { id: string; primary?: boolean }[] };
  name: string;
  version: string;
  files: { projectID: number; fileID: number; required?: boolean }[];
  overrides?: string;
}

interface CfHint {
  minecraftVersion: string;
  loader: Loader;
  name: string;
  version: string;
}

async function planFromCurseforge(
  archivePath: string,
  task: TaskHandle,
  hint: CfHint,
): Promise<PackPlan> {
  const zip = new AdmZip(archivePath);
  const entry = zip.getEntry('manifest.json');

  // --- Serverpaket: keine manifest.json, dafür fertige mods/ --------------
  if (!entry) {
    const root = detectArchiveRoot(zip);
    const hasMods = zip
      .getEntries()
      .some((e) => e.entryName.replace(/\\/g, '/').startsWith(root + 'mods/'));
    if (!hasMods) {
      throw new Error('Unbekanntes CurseForge-Archiv – weder manifest.json noch mods/ gefunden');
    }

    const detected = detectLoaderFromArchive(zip, root);
    if (detected) {
      await task.log(`Loader aus dem Serverpaket erkannt: ${detected.loader} ${detected.version}`);
    }

    return {
      name: hint.name,
      version: hint.version,
      minecraftVersion: hint.minecraftVersion,
      loader: detected?.loader ?? hint.loader,
      loaderVersion: detected?.version ?? null,
      downloads: [],
      overrideDirs: [root === '' ? '.' : root],
      isServerPack: true,
      zip,
    };
  }

  // --- Client-Paket mit Manifest ------------------------------------------
  const manifest = JSON.parse(entry.getData().toString('utf8')) as CfManifest;
  const primary =
    manifest.minecraft.modLoaders.find((l) => l.primary) ?? manifest.minecraft.modLoaders[0];

  let loader: Loader = 'FORGE';
  let loaderVersion: string | null = null;
  if (primary?.id) {
    const [rawName, ...rest] = primary.id.split('-');
    const name = rawName.toLowerCase();
    loaderVersion = rest.join('-') || null;
    if (name === 'neoforge') loader = 'NEOFORGE';
    else if (name === 'fabric') loader = 'FABRIC';
    else if (name === 'quilt') loader = 'QUILT';
    else loader = 'FORGE';
  }

  await task.update(22, `Mod-Metadaten werden geladen (${manifest.files.length}) …`);
  const files = await curseforge.getFilesBulk(manifest.files.map((f) => f.fileID));
  const byId = new Map(files.map((f) => [f.id, f]));

  const downloads: PackPlan['downloads'] = [];
  for (const wanted of manifest.files) {
    const file = byId.get(wanted.fileID);
    if (!file) {
      throw new Error(`Pflichtdatei ${wanted.fileID} fehlt im Katalog`);
    }
    const urls: string[] = [];
    if (file.downloadUrl) urls.push(file.downloadUrl);
    const fallback = await curseforge.resolveDownloadUrl(
      wanted.projectID,
      wanted.fileID,
      file.fileName,
    );
    if (fallback && !urls.includes(fallback)) urls.push(fallback);
    if (urls.length === 0) {
      throw new Error(`Kein Download für Pflichtdatei ${file.fileName} verfügbar`);
    }
    downloads.push({ path: `mods/${file.fileName}`, urls, size: file.fileLength });
  }

  return {
    name: manifest.name,
    version: manifest.version,
    minecraftVersion: manifest.minecraft.version,
    loader,
    loaderVersion,
    downloads,
    overrideDirs: [manifest.overrides ?? 'overrides'],
    isServerPack: false,
    zip,
  };
}

/** Serverpakete packen ihren Inhalt oft in einen einzelnen Wurzelordner. */
function detectArchiveRoot(zip: AdmZip): string {
  const names = zip.getEntries().map((e) => e.entryName.replace(/\\/g, '/'));
  if (names.some((n) => n.startsWith('mods/'))) return '';

  const roots = new Set(names.map((n) => n.split('/')[0]).filter(Boolean));
  if (roots.size === 1) {
    const root = [...roots][0];
    if (names.some((n) => n.startsWith(`${root}/mods/`))) return `${root}/`;
  }
  return '';
}

/** Loader und -Version aus den Pfaden eines Serverpakets ableiten. */
function detectLoaderFromArchive(
  zip: AdmZip,
  root: string,
): { loader: Loader; version: string } | null {
  const names = zip.getEntries().map((e) => e.entryName.replace(/\\/g, '/').slice(root.length));

  const patterns: { loader: Loader; regexes: RegExp[] }[] = [
    {
      loader: 'NEOFORGE',
      regexes: [
        /^libraries\/net\/neoforged\/neoforge\/([^/]+)\//,
        /(?:^|\/)neoforge-([\d.]+)-installer\.jar$/,
      ],
    },
    {
      loader: 'FORGE',
      regexes: [
        /^libraries\/net\/minecraftforge\/forge\/[^/]*?-([\d.]+)\//,
        /(?:^|\/)forge-[\d.]+-([\d.]+)-installer\.jar$/,
      ],
    },
    {
      loader: 'FABRIC',
      regexes: [/^libraries\/net\/fabricmc\/fabric-loader\/([^/]+)\//],
    },
    {
      loader: 'QUILT',
      regexes: [/^libraries\/org\/quiltmc\/quilt-loader\/([^/]+)\//],
    },
  ];

  for (const { loader, regexes } of patterns) {
    for (const regex of regexes) {
      for (const name of names) {
        const match = name.match(regex);
        if (match?.[1]) return { loader, version: match[1] };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Client-Mods erkennen
// ---------------------------------------------------------------------------

/**
 * Rendering-Mods, die auf einem dedizierten Server garantiert abstürzen –
 * sie greifen beim Start auf LWJGL/OpenGL zu, das serverseitig fehlt.
 * Bewusst kurz gehalten: lieber eine Mod übersehen als eine nötige abschalten.
 */
const CLIENT_ONLY_PREFIXES = [
  'sodium',
  'reeses-sodium-options',
  'iris',
  'oculus',
  'rubidium',
  'embeddium',
  'optifine',
  'canvas-renderer',
  'nvidium',
  'immediatelyfast',
];

function normalizeModName(filename: string): string {
  return filename
    .replace(/\.jar(\.disabled)?$/i, '')
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
}

interface ForgeModInfo {
  /** Mod-IDs, die dieses Jar bereitstellt. */
  provides: string[];
  /** Mod-IDs, die dieses Jar benötigt. */
  requires: string[];
}

/** Grobe Auswertung von META-INF/(neoforge.)mods.toml – reicht für Mod-IDs. */
function readForgeModInfo(jarPath: string): ForgeModInfo | null {
  try {
    const zip = new AdmZip(jarPath);
    const entry =
      zip.getEntry('META-INF/neoforge.mods.toml') ?? zip.getEntry('META-INF/mods.toml');
    if (!entry) return null;

    const provides: string[] = [];
    const requires: string[] = [];
    let section: 'mods' | 'dependencies' | null = null;

    for (const raw of entry.getData().toString('utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('[[mods]]')) {
        section = 'mods';
        continue;
      }
      if (line.startsWith('[[dependencies.') || line.startsWith('[dependencies.')) {
        section = 'dependencies';
        continue;
      }
      if (line.startsWith('[')) {
        section = null;
        continue;
      }

      const match = line.match(/^modId\s*=\s*["']([^"']+)["']/i);
      if (!match) continue;
      if (section === 'mods') provides.push(match[1].toLowerCase());
      else if (section === 'dependencies') requires.push(match[1].toLowerCase());
    }

    return { provides, requires };
  } catch {
    return null;
  }
}

export interface ClientModFilterResult {
  disabled: { file: string; reason: string }[];
  /** Erkannt, aber behalten – eine andere Mod hängt davon ab. */
  keptAsDependency: { file: string; neededBy: string }[];
}

interface FabricModInfo {
  file: string;
  id: string;
  /** "client" | "server" | "*" */
  environment: string;
  /** Pflicht-Abhängigkeiten. */
  depends: string[];
}

/** Steuerzeichen, an denen JSON.parse sonst scheitert (kommt in Mod-Jars vor). */
const CONTROL_CHARS = new RegExp(
  '[' +
    String.fromCharCode(0) + '-' + String.fromCharCode(8) +
    String.fromCharCode(11) + String.fromCharCode(12) +
    String.fromCharCode(14) + '-' + String.fromCharCode(31) +
  ']',
  'g',
);

function readFabricModInfo(modsDir: string, file: string): FabricModInfo | null {
  try {
    const entry = new AdmZip(path.join(modsDir, file)).getEntry('fabric.mod.json');
    if (!entry) return null;
    const parsed = JSON.parse(
      entry.getData().toString('utf8').replace(CONTROL_CHARS, ''),
    ) as { id?: string; environment?: string; depends?: Record<string, unknown> };
    if (!parsed.id) return null;
    return {
      file,
      id: parsed.id,
      environment: parsed.environment ?? '*',
      depends: Object.keys(parsed.depends ?? {}),
    };
  } catch {
    return null;
  }
}

/**
 * Fabric/Quilt: Mods deaktivieren, die *faktisch* clientseitig sind, es aber
 * nicht deklarieren.
 *
 * Der Loader überspringt selbstständig alles mit `"environment": "client"` –
 * darum fassen wir diese Jars nicht an. Er erkennt aber nicht, dass eine als
 * beidseitig deklarierte Mod nur wegen einer Client-Mod existiert. Genau die
 * bricht dann beim Start ab (`Cannot load class … in environment type SERVER`).
 *
 * Zwei Regeln, beide transitiv angewandt:
 *   1. Pflicht-Abhängigkeit auf eine Client-Mod  → selbst clientseitig.
 *   2. Mod-ID beginnt mit `<client-mod-id>_` oder `-` → Begleit-Mod desselben
 *      Projekts (z. B. `colorwheel_patcher` zu `colorwheel`).
 */
async function disableFabricClientDependents(serverPath: string): Promise<ClientModFilterResult> {
  const modsDir = path.join(serverPath, 'mods');
  const files = (await fs.readdir(modsDir).catch(() => [] as string[])).filter((f) =>
    /\.jar$/i.test(f),
  );

  const mods = files
    .map((file) => readFabricModInfo(modsDir, file))
    .filter((m): m is FabricModInfo => m !== null);

  const clientIds = new Set(mods.filter((m) => m.environment === 'client').map((m) => m.id));
  const derived = new Map<string, string>(); // Mod-ID -> Begründung

  for (let changed = true; changed; ) {
    changed = false;
    for (const mod of mods) {
      if (clientIds.has(mod.id)) continue;

      const dependency = mod.depends.find((d) => clientIds.has(d));
      if (dependency) {
        clientIds.add(mod.id);
        derived.set(mod.id, `hängt zwingend von ${dependency} ab`);
        changed = true;
        continue;
      }

      // Kurze IDs ausklammern, sonst trifft der Präfixvergleich Fremdes.
      const companion = [...clientIds].find(
        (id) => id.length >= 4 && (mod.id.startsWith(`${id}_`) || mod.id.startsWith(`${id}-`)),
      );
      if (companion) {
        clientIds.add(mod.id);
        derived.set(mod.id, `Begleit-Mod von ${companion}`);
        changed = true;
      }
    }
  }

  const result: ClientModFilterResult = { disabled: [], keptAsDependency: [] };

  for (const mod of mods) {
    const reason = derived.get(mod.id);
    if (!reason) continue;
    await fs
      .rename(path.join(modsDir, mod.file), path.join(modsDir, `${mod.file}.disabled`))
      .then(() => result.disabled.push({ file: mod.file, reason }))
      .catch(() => {});
  }

  return result;
}

/**
 * Deaktiviert reine Client-Mods (nur Forge/NeoForge – siehe Aufrufstelle).
 *
 * Eine erkannte Client-Mod bleibt liegen, wenn eine andere Mod sie als
 * Abhängigkeit deklariert: sie zu entfernen würde die Auflösung sprengen und
 * den Server genauso am Start hindern.
 *
 * Nichts wird gelöscht – im Mods-Tab lässt sich jede Datei wieder aktivieren.
 */
async function disableClientOnlyMods(serverPath: string): Promise<ClientModFilterResult> {
  const modsDir = path.join(serverPath, 'mods');
  const files = (await fs.readdir(modsDir).catch(() => [] as string[])).filter((f) =>
    /\.jar$/i.test(f),
  );

  const candidates = files.filter((file) =>
    CLIENT_ONLY_PREFIXES.some((prefix) => normalizeModName(file).startsWith(prefix)),
  );
  if (candidates.length === 0) return { disabled: [], keptAsDependency: [] };

  // Welche Mod-IDs brauchen die Dateien, die bleiben sollen?
  const required = new Map<string, string>(); // modId -> Datei, die sie braucht
  for (const file of files) {
    if (candidates.includes(file)) continue;
    const info = readForgeModInfo(path.join(modsDir, file));
    for (const modId of info?.requires ?? []) {
      if (!required.has(modId)) required.set(modId, file);
    }
  }

  const result: ClientModFilterResult = { disabled: [], keptAsDependency: [] };

  for (const file of candidates) {
    const info = readForgeModInfo(path.join(modsDir, file));
    const neededFor = (info?.provides ?? []).find((modId) => required.has(modId));

    if (neededFor) {
      result.keptAsDependency.push({ file, neededBy: required.get(neededFor)! });
      continue;
    }

    await fs
      .rename(path.join(modsDir, file), path.join(modsDir, `${file}.disabled`))
      .then(() => result.disabled.push({ file, reason: 'bekannte Client-Renderer-Mod' }))
      .catch(() => {});
  }

  return result;
}

// ---------------------------------------------------------------------------
// Entpacken
// ---------------------------------------------------------------------------

/** Diese Dateien werden beim Entpacken nie überschrieben. */
const PROTECTED = [
  'server.properties',
  'ops.json',
  'whitelist.json',
  'banned-players.json',
  'banned-ips.json',
  'usercache.json',
  'eula.txt',
];

/**
 * Startskripte, Installer und mitgelieferte Loader-Bibliotheken aus
 * Serverpaketen überspringen – den Loader installiert das Image selbst.
 */
const SERVERPACK_SKIP = [
  /^libraries\//,
  /^\.?[^/]*\.(bat|sh|ps1|command)$/i,
  /installer(\.jar|\.log)$/i,
  /^(neo)?forge-[\d.-]+\.jar$/i,
  /^(minecraft_)?server[\d.]*\.jar$/i,
  /^user_jvm_args\.txt$/i,
  /^run\.(bat|sh)$/i,
];

async function extractOverrides(
  plan: PackPlan,
  targetDir: string,
  opts: { keepConfig: boolean; worldName: string; maxGrowth: number },
): Promise<number> {
  const root = path.resolve(targetDir);
  let written = 0;

  for (const overrideDir of plan.overrideDirs) {
    const prefix = overrideDir === '.' ? '' : overrideDir.replace(/\/+$/, '') + '/';

    for (const entry of plan.zip.getEntries()) {
      if (entry.isDirectory) continue;
      const name = entry.entryName.replace(/\\/g, '/');
      if (prefix && !name.startsWith(prefix)) continue;

      const relative = prefix ? name.slice(prefix.length) : name;
      if (!relative) continue;
      if (relative === 'manifest.json' || relative === 'modrinth.index.json') continue;
      if (relative === 'modlist.html') continue;
      const normalized = path.relative(root, archiveEntryPath(root, relative));
      if (isProtectedPackPath(normalized, opts.worldName, opts.keepConfig)) continue;
      // Rein clientseitige Ordner haben auf einem Server nichts verloren
      if (/^(shaderpacks|screenshots|saves)\//.test(relative)) continue;
      if (plan.isServerPack && SERVERPACK_SKIP.some((r) => r.test(relative))) continue;

      const out = archiveEntryPath(root, relative);
      const previous = await fs.stat(out).catch(() => null);
      opts.maxGrowth -= Math.max(0, entry.header.size - (previous?.size ?? 0));
      if (opts.maxGrowth < 0) throw new Error('Speicherkontingent reicht für das Modpack nicht aus');
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, entry.getData());
      written++;
    }
  }

  return written;
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

/** Aus den gameVersions einer CurseForge-Datei die Minecraft-Version ziehen. */
function pickMinecraftVersion(version: ProjectVersion): string | null {
  return version.gameVersions.find((v) => /^\d+\.\d+/.test(v)) ?? null;
}

/** Aus den gameVersions einer CurseForge-Datei den Loader ziehen. */
function pickLoader(version: ProjectVersion): Loader {
  const loaders = version.loaders.map((l) => l.toLowerCase());
  if (loaders.includes('neoforge')) return 'NEOFORGE';
  if (loaders.includes('fabric')) return 'FABRIC';
  if (loaders.includes('quilt')) return 'QUILT';
  if (loaders.includes('forge')) return 'FORGE';
  return 'FORGE';
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function throttle<A extends unknown[]>(fn: (...args: A) => void, ms = 400): (...args: A) => void {
  let last = 0;
  return (...args: A) => {
    const now = Date.now();
    if (now - last < ms) return;
    last = now;
    fn(...args);
  };
}

export const installModpack = (...args: Parameters<typeof installModpackUnlocked>) => withServerOperation(args[0], "installModpack", () => installModpackUnlocked(...args));

export function isProtectedPackPath(relative: string, worldName: string, keepConfig: boolean): boolean {
  const name = relative.replace(/\\/g, '/');
  const first = name.split('/')[0];
  return PROTECTED.includes(name) || ['world', 'world_nether', 'world_the_end', worldName, `${worldName}_nether`, `${worldName}_the_end`].includes(first)
    || name === worldName || name.startsWith(worldName + '/')
    || (keepConfig && (name === 'config' || name.startsWith('config/')));
}

async function installModpackUnlocked(serverId: string, request: InstallRequest, task: TaskHandle): Promise<void> {
  await recoverInterruptedRestore(serverId);
  const server = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
  const { state } = await dockerSvc.getState(server);
  try {
    await installModpackImpl(serverId, request, task);
  } catch (err) {
    await dockerSvc.stop(await prisma.server.findUniqueOrThrow({ where: { id: serverId } }));
    await recoverInterruptedRestore(serverId);
    const recovered = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
    await dockerSvc.recreateContainer(recovered);
    if (state === 'running' || state === 'starting') await dockerSvc.start(recovered);
    throw err;
  }
}
