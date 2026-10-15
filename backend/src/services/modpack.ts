import { dirSize } from './files.js';
import { archivePath as archiveEntryPath, safePath } from '../lib/safePath.js';
import { commitRestore, finishRestore, recoverInterruptedRestore, restorePaths, saveRestoreMetadata } from './restoreRecovery.js';
import { parseProperties } from './properties.js';
import { withServerOperation } from './operations.js';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { z } from 'zod';
import type { Server } from '@prisma/client';
import { cacheDir, serverDir, serverBackupDir } from '../config.js';
import { prisma } from '../db.js';
import { downloadToFile } from '../lib/download.js';
import * as modrinth from '../providers/modrinth.js';
import * as curseforge from '../providers/curseforge.js';
import * as ftb from '../providers/ftb.js';
import type { ProjectVersion, ProviderId } from '../providers/types.js';
import type { TaskHandle } from './tasks.js';
import * as dockerSvc from './docker.js';
import { createBackup } from './backups.js';
import { invalidateDiskUsage } from './diskUsage.js';
import { badRequest } from '../lib/errors.js';
import { waitForServerReady } from './serverStartup.js';
import { describeModFile, compareModDescriptors } from './modpackDiff.js';
import { serverLoader } from './content.js';
import { prepareReinstallData, reinstallEnvironment, reinstallMetadata, type ReinstallOptions } from './reinstallationData.js';

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
  /** Nur die Neuinstallationsroute setzt diese Optionen nach ihrer Rechteprüfung. */
  reinstall?: ReinstallOptions;
  createdById?: string;
}

type Loader = 'FORGE' | 'NEOFORGE' | 'FABRIC' | 'QUILT' | 'VANILLA';

interface PackPlan {
  name: string;
  version: string;
  minecraftVersion: string;
  loader: Loader;
  loaderVersion: string | null;
  /** Dateien, die heruntergeladen werden müssen (Pfad relativ zu /data). */
  downloads: { path: string; urls: string[]; size: number; sha1?: string; sha512?: string }[];
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
  prepared: string,
  changes: { started: boolean },
): Promise<void> {
  const server = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
  const isUpdate = Boolean(server.modpackProjectId);

  await task.update(1, 'Paket wird bei laufendem Server vorbereitet …');
  const { plan, version, project } = await loadPackPlan(server, request, task);
  const rawBefore = await fs.readFile(safePath(serverDir(serverId), 'server.properties'), 'utf8').catch(() => '');
  const worldBefore = parseProperties(rawBefore)['level-name'] || 'world';
  await prefetchDownloads(plan, prepared, server, task, relative => isProtectedPackPath(relative, worldBefore, request.keepConfig ?? false));
  // Erst ab hier müssen Welt und Serverdateien für den Austausch ruhen.
  await task.update(22, 'Serverstatus vor dem Austausch prüfen …');
  const { state } = await dockerSvc.getState(server);
  const wasRunning = state === 'running' || state === 'starting';
  changes.started = true;
  if (wasRunning) {
    await task.log('Server wird für die Installation gestoppt …');
    await dockerSvc.stop(server);
  }

  if (request.backupFirst ?? isUpdate) {
    await task.update(22, 'Sicherheitsbackup wird erstellt …');
    await task.log('Backup vor der Installation …');
    await createBackup(server, {
      name: `Vor ${request.reinstall ? 'Neuinstallation' : isUpdate ? 'Update' : 'Installation'} ${new Date().toISOString().slice(0, 16)}`,
      note: 'Automatisch vor Modpack-Installation',
      origin: 'SAFETY',
      createdById: request.createdById ?? null,
    });
  }

  // --- 3. Alte Mods entfernen ---------------------------------------------
  const original = serverDir(serverId);
  const { stage: dir } = restorePaths(serverId);
  await fs.mkdir(original, { recursive: true });
  await task.update(23, 'Vorhandene Daten werden für die sichere Installation vorbereitet …');
  // Reflink where supported; otherwise copy. Hardlinks would compromise rollback.
  // Old mods/scripts are discarded on updates, so never copy them just to delete them.
  const replaced = new Set(['mods', 'kubejs/startup_scripts', 'kubejs/server_scripts']);
  if (request.reinstall) await prepareReinstallData(server, dir, request.reinstall.keepWorld);
  else await fs.cp(original, dir, {
    recursive: true, mode: fsConstants.COPYFILE_FICLONE,
    filter: source => !isUpdate || !replaced.has(path.relative(original, source).split(path.sep).join('/')),
  });
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
  // With a quota, count once and update the budget after each atomic replacement.
  // Without a quota, a small worker pool overlaps CDN latency without flooding HDDs.
  const limited = server.quotaDiskMb > 0;
  const concurrency = limited ? 1 : 4;
  let remaining = limited ? Math.max(0, server.quotaDiskMb * 1024 * 1024 - await dirSize(dir) - await dirSize(serverBackupDir(serverId))) : Infinity;
  const queue = [...plan.downloads];

  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const target = archiveEntryPath(dir, item.path);
      if (protectedPath(path.relative(dir, target))) continue;

      const source = archiveEntryPath(prepared, item.path);
      const size = (await fs.stat(source)).size;
      const oldSize = (await fs.stat(target).catch(() => null))?.size ?? 0;
      if (size > remaining + oldSize) throw badRequest('Speicherkontingent reicht für das Modpack nicht aus');
      await fs.mkdir(path.dirname(archiveEntryPath(dir, item.path)), { recursive: true });
      await fs.copyFile(archiveEntryPath(prepared, item.path), archiveEntryPath(dir, item.path));
      if (limited) remaining -= size - oldSize;
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

  if (!plan.isServerPack) await assertSupplementaryDownloadsComplete(plan, dir, task);

  // --- 6. Client-Mods aussortieren ----------------------------------------
  // Nur beim Client-Paket nötig, dort aber bei jeder Quelle:
  //   * Modrinth markiert zwar `env.server` pro Datei, doch die Angabe steht
  //     nur für die Dateien im Index. Was in `overrides/mods/` mitgeliefert
  //     wird, trägt gar keine Kennzeichnung – und Packs, die ihre komplette
  //     Liste pauschal als serverfähig ausweisen, gibt es reichlich.
  //   * Fabric und Quilt überspringen als `"environment": "client"` erklärte
  //     Mods selbst. Die Jars müssen dabei liegen bleiben, sonst schlägt die
  //     Abhängigkeitsauflösung anderer Mods fehl. Wir suchen nur die, die
  //     faktisch clientseitig sind, es aber nicht angeben.
  //   * Forge/NeoForge kennen keine solche Angabe – hier filtern wir.
  if (!plan.isServerPack) {
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
    ...(request.reinstall ? reinstallEnvironment(server) : (server.extraEnv ?? {}) as Record<string, string>),
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
  await saveRestoreMetadata(serverId, request.reinstall ? reinstallMetadata(server) : {
    type: server.type, mcVersion: server.mcVersion, extraEnv: server.extraEnv,
    modpackProvider: server.modpackProvider, modpackProjectId: server.modpackProjectId,
    modpackVersionId: server.modpackVersionId, modpackName: server.modpackName,
    modpackVersionName: server.modpackVersionName, modpackIconUrl: server.modpackIconUrl,
  });
  const updated = await prisma.server.update({
    where: { id: serverId },
    data: {
      type: 'MODPACK',
      ...(request.reinstall ? { name: request.reinstall.name, description: request.reinstall.description, memoryMb: request.reinstall.memoryMb } : {}),
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
    await waitForServerReady(updated, { onWaiting: message => task.update(99, message) });
    await task.log('Minecraft antwortet – der Server wurde erfolgreich gestartet.');
  }

  await task.update(
    100,
    `${project.name} ${version.name} installiert`,
  );
  await finishRestore(serverId);
}

async function loadPackPlan(server: Server, request: InstallRequest, task: TaskHandle) {
  await task.update(8, 'Modpack-Version wird geladen …');
  const version = await getVersion(request.provider, request.projectId, request.versionId);
  const project =
    request.provider === 'modrinth'
      ? await modrinth.getProject(request.projectId)
      : await curseforge.getProject(request.projectId);

  await task.log(`Modpack: ${project.name} – ${version.name}`);
  if (project.serverSupport === 'unsupported') {
    throw badRequest('Dieses Modpack ist vom Anbieter ausdrücklich als reines Client-Paket markiert und kann nicht als Server installiert werden.');
  }

  // Nur ein nachweislich zugeordnetes Serverpaket verwenden. Abruffehler sind
  // keine Erlaubnis, stattdessen ein Client-Paket zu installieren.
  let archiveSource = version;
  if (request.provider === 'curseforge' && !version.isServerPack) {
    const found = await curseforge.findServerPack(request.projectId, version);
    if (found) {
      archiveSource = found.pack;
      const minecraft = pickMinecraftVersion(version);
      if ((minecraft && !found.pack.gameVersions.includes(minecraft))
        || (version.loaders.length > 0 && found.pack.loaders.length > 0
          && !version.loaders.some(loader => found.pack.loaders.includes(loader)))) {
        throw badRequest('Minecraft-Version oder Loader des verknüpften CurseForge-Serverpakets passen nicht zur Auswahl.');
      }
      await task.log(`Serverpaket des Autors: ${found.pack.filename} (Datei ${found.pack.id}).`);
    } else {
      const official = await ftb.findServerPack(project, version);
      if (!official) throw badRequest('Für diese Version wurde kein eindeutig zugeordnetes Serverpaket bei CurseForge oder FTB gefunden. Client-Pakete werden nicht installiert.');
      const plan: PackPlan = { ...official, overrideDirs: [], isServerPack: true, zip: new AdmZip() };
      await task.log(`Offizielles FTB-Serverpaket: ${official.name} ${official.version} · Projekt ${official.projectId} · Version ${official.versionId}.`);
      await task.log(`${official.downloads.length} Serverdateien mit SHA-1-Prüfung; ${official.excludedClientFiles} von FTB als clientseitig markierte Dateien werden nicht heruntergeladen.`);
      await task.log(`Minecraft ${plan.minecraftVersion} · ${plan.loader} ${plan.loaderVersion ?? ''}`);
      return { plan, version, project };
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
        void task.update(10 + pct * 0.1, `Modpack wird geladen … ${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ''}`).catch(() => {});
      }, 2000),
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

  // Die Dateiliste eines Client-Pakets führt auch Shaderpacks und Welten des
  // Clients. Die zu laden kostet bei großen Paketen mehrere hundert Megabyte
  // Plattenplatz und Wartezeit für etwas, das der Server nie öffnet.
  const nurClient = plan.downloads.filter((item) => isClientOnlyPackPath(item.path));
  if (nurClient.length > 0) {
    plan.downloads = plan.downloads.filter((item) => !isClientOnlyPackPath(item.path));
    await task.log(
      `${nurClient.length} reine Client-Datei(en) übersprungen ` +
        `(${formatBytes(nurClient.reduce((sum, item) => sum + item.size, 0))}).`,
    );
  }

  await task.log(
    `Minecraft ${plan.minecraftVersion} · ${plan.loader}` +
      `${plan.loaderVersion ? ' ' + plan.loaderVersion : ''} · ${plan.downloads.length} Dateien`,
  );

  return { plan, version, project };
}

async function prefetchDownloads(plan: PackPlan, dir: string, server: Server, task: TaskHandle, protectedPath: (relative: string) => boolean) {
  for (const item of plan.downloads) archiveEntryPath(dir, item.path);
  for (const root of plan.overrideDirs) {
    const prefix = root === '.' ? '' : root.replace(/\/+$/, '') + '/';
    for (const entry of plan.zip.getEntries()) {
      const name = entry.entryName.replace(/\\/g, '/');
      if (name.startsWith(prefix)) archiveEntryPath(dir, name.slice(prefix.length));
    }
  }
  const queue = plan.downloads.filter(item => !protectedPath(item.path));
  const total = queue.length;
  let completed = 0;
  let remaining = server.quotaDiskMb > 0 ? server.quotaDiskMb * 1024 * 1024 : Infinity;
  const failures: string[] = [];
  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      let ok = false;
      for (const candidate of item.urls) {
        try {
          const size = await downloadToFile(candidate, archiveEntryPath(dir, item.path), { retries: 2, maxBytes: remaining });
          if (item.sha1 || item.sha512) {
            const bytes = await fs.readFile(archiveEntryPath(dir, item.path));
            const sizeWrong = item.size > 0 && bytes.length !== item.size;
            const sha1Wrong = item.sha1 && createHash('sha1').update(bytes).digest('hex') !== item.sha1;
            const sha512Wrong = item.sha512 && createHash('sha512').update(bytes).digest('hex') !== item.sha512;
            if (sizeWrong || sha1Wrong || sha512Wrong) {
              await fs.rm(archiveEntryPath(dir, item.path), { force: true });
              throw badRequest(`Prüfsumme oder Größe stimmt nicht: ${item.path}`);
            }
          }
          remaining -= size;
          ok = true;
          break;
        } catch { /* Nächste Downloadadresse versuchen. */ }
      }
      if (!ok) failures.push(item.path);
      completed++;
      if (completed % 3 === 0 || completed === total) await task.update(22,
        `Vorbereitung ohne Serverstopp: ${completed}/${total} Dateien`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(server.quotaDiskMb > 0 ? 1 : 4, Math.max(1, total)) }, worker));
  if (failures.length) throw badRequest(`${failures.length} Pflichtdatei(en) konnten nicht geladen werden: ${failures.join(', ')}`);
}

export async function previewModpack(server: Server, request: InstallRequest) {
  return withServerOperation(server.id, 'Modpack-Vorschau', async () => {
    await fs.mkdir(path.join(cacheDir(), 'modpacks'), { recursive: true });
    const prepared = await fs.mkdtemp(path.join(cacheDir(), 'modpacks', 'vorschau-'));
    const task: TaskHandle = { id: '', update: async () => {}, log: async () => {}, done: async () => {}, fail: async () => {} };
    try {
      const { plan, version } = await loadPackPlan(server, request, task);
      await prefetchDownloads(plan, prepared, server, task, () => false);
      const incoming = new Map<string, ReturnType<typeof describeModFile>>();
      for (const root of plan.overrideDirs) {
        const prefix = root === '.' ? '' : root.replace(/\/+$/, '') + '/';
        for (const entry of plan.zip.getEntries()) {
          const name = entry.entryName.replace(/\\/g, '/');
          if (!name.startsWith(prefix)) continue;
          const relative = name.slice(prefix.length);
          archiveEntryPath(prepared, relative);
          if (/^mods\/[^/]+\.jar$/i.test(relative)) incoming.set(path.basename(relative), describeModFile(path.basename(relative), entry.getData()));
        }
      }
      for (const item of plan.downloads) if (/^mods\/[^/]+\.jar$/i.test(item.path)) incoming.set(path.basename(item.path), describeModFile(path.basename(item.path), await fs.readFile(archiveEntryPath(prepared, item.path))));
      const current: ReturnType<typeof describeModFile>[] = [];
      const root = serverDir(server.id);
      for (const name of await fs.readdir(safePath(root, 'mods')).catch(() => [])) {
        if (/\.jar$/i.test(name)) current.push(describeModFile(name, await fs.readFile(safePath(root, 'mods/' + name))));
      }
      return { version: version.name, minecraft: { current: server.mcVersion, next: plan.minecraftVersion },
        loader: { current: serverLoader(server), next: plan.loader, version: plan.loaderVersion },
        serverPack: plan.isServerPack, ...compareModDescriptors(current, [...incoming.values()]) };
    } finally { await fs.rm(prepared, { recursive: true, force: true }); }
  });
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
    hashes?: { sha1?: string; sha512?: string };
    env?: { client?: string; server?: string };
  }[];
}

/**
 * Laut Modrinth-Spezifikation dürfen .mrpack-Dateien nur von diesen Hosts
 * laden. Alles andere (auch interne Adressen) wird verworfen.
 */
const MRPACK_HOSTS = new Set(['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com']);
export function allowedMrpackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && MRPACK_HOSTS.has(url.hostname.toLowerCase())
      && !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
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
    .map((f) => {
      const urls = (f.downloads ?? []).filter(allowedMrpackUrl);
      if (!urls.length) throw new Error(`Ungültiges .mrpack – ${f.path} hat keine erlaubte Downloadadresse`);
      const sha1 = f.hashes?.sha1?.toLowerCase();
      const sha512 = f.hashes?.sha512?.toLowerCase();
      if (!sha1 && !sha512) throw new Error(`Ungültiges .mrpack – ${f.path} hat keine Prüfsumme`);
      return { path: f.path.replace(/\\/g, '/'), urls, size: f.fileSize ?? 0, sha1, sha512 };
    });

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
  const root = detectArchiveRoot(zip);
  const entry = zip.getEntry(root + 'manifest.json');

  // ServerPackCreator verwendet denselben Dateinamen wie CurseForge, aber
  // listet bereits enthaltene Dateien statt noch herunterzuladender Mods auf.
  // Nur dieses bekannte Format zulassen; echte Client-Manifeste weiter ablehnen.
  if (entry) {
    let manifest: unknown;
    try { manifest = JSON.parse(entry.getData().toString('utf8')); }
    catch { throw badRequest('Die manifest.json im CurseForge-Serverpaket ist ungültig. Installation abgebrochen; vorhandene Daten bleiben erhalten.'); }
    const serverManifest = z.object({
      serverPackCreatorVersion: z.string().min(1),
      files: z.array(z.string()),
    }).safeParse(manifest);
    if (!serverManifest.success || (typeof manifest === 'object' && manifest !== null && 'manifestType' in manifest)) {
      throw badRequest('Die ausgewählte CurseForge-Datei enthält ein Client-Manifest statt eines fertigen Serverpakets. Installation abgebrochen; vorhandene Daten bleiben erhalten.');
    }
  }

  // --- Serverpaket: fertige Mod-Dateien müssen bereits enthalten sein. ----
  const hasMods = zip
    .getEntries()
    .some((e) => !e.isDirectory && e.entryName.replace(/\\/g, '/').startsWith(root + 'mods/') && /\.jar$/i.test(e.entryName));
  if (!hasMods) {
    throw badRequest('Das CurseForge-Serverpaket enthält keine fertigen Mod-Dateien unter mods/. Installation abgebrochen; vorhandene Daten bleiben erhalten.');
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

  // ServerPackCreator legt die verbindlichen Versionen in variables.txt ab.
  // Nur lesen, niemals die mitgelieferten Startskripte ausführen.
  const variablesEntry = zip.getEntry(root + 'variables.txt');
  if (variablesEntry) {
    const variables = parseProperties(variablesEntry.getData().toString('utf8'));
    const loader = variables.MODLOADER?.toUpperCase() as Loader;
    const version = variables.MODLOADER_VERSION?.replace(/^['"]|['"]$/g, '');
    if (['FABRIC', 'QUILT', 'FORGE', 'NEOFORGE'].includes(loader) && version && /^[\d][\w.+-]*$/.test(version)) {
      return { loader, version };
    }
  }

  // ATM-Serverpakete hinterlegen die Loader-Version direkt in Startskripten.
  // Ausschließlich feste Zuweisungen lesen; keinerlei Shell-Auswertung ausführen.
  const scriptVersions = new Map<string, { loader: Loader; version: string }>();
  const versionKeys: Record<string, Loader> = {
    FORGE_VERSION: 'FORGE', NEOFORGE_VERSION: 'NEOFORGE',
    FABRIC_LOADER_VERSION: 'FABRIC', QUILT_LOADER_VERSION: 'QUILT',
  };
  for (const entry of zip.getEntries()) {
    const relative = entry.entryName.replace(/\\/g, '/').slice(root.length);
    if (!/^(?:startserver|start|run)\.(?:sh|bat)$/i.test(relative)) continue;
    const text = entry.getData().toString('utf8');
    const assignments = /^\s*(?:(?:export|set)\s+)?["']?(FORGE_VERSION|NEOFORGE_VERSION|FABRIC_LOADER_VERSION|QUILT_LOADER_VERSION)["']?\s*=\s*["']?(\d+(?:\.\d+)+(?:[-+][a-z\d._-]+)?)["']?\s*(?:#.*)?$/gim;
    for (const match of text.matchAll(assignments)) {
      const loader = versionKeys[match[1].toUpperCase()];
      scriptVersions.set(`${loader}/${match[2]}`, { loader, version: match[2] });
    }
  }
  if (scriptVersions.size > 1) throw badRequest('Die Startskripte des Serverpakets nennen widersprüchliche Loader-Versionen. Installation abgebrochen.');
  if (scriptVersions.size === 1) return [...scriptVersions.values()][0];

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

/**
 * Mods, die sich in der fabric.mod.json als beidseitig ausgeben
 * (`"environment": "*"`), auf einem Server aber sofort den Start abbrechen.
 * Der Loader hat dagegen keine Handhabe – sie sind nur über den Namen zu
 * erkennen, deshalb bleibt die Liste kurz und nennt jedes Mal den Grund.
 */
const CLIENT_ONLY_MOD_IDS: Record<string, string> = {
  // Öffnet beim Start ein Swing-Fenster: java.awt.HeadlessException. Steckt
  // in den „Better MC"-Paketen und in allem, was deren Vorlage benutzt.
  missingmodschecker: 'öffnet beim Start ein Fenster, das es auf einem Server nicht gibt',
  // Telemetrie desselben Autors. Läuft zwar auch serverseitig, aber ihr
  // Keepalive-Thread hält die JVM nach einem gescheiterten Start am Leben:
  // der Container bleibt „unhealthy" statt zu enden, das Panel sieht keinen
  // Absturz, und das Protokoll füllt sich minütlich mit „Connection refused".
  packanalytics: 'Telemetrie, die den Prozess nach einem Fehlstart am Leben hält und den Absturz verdeckt',
  // Greift im gemeinsamen Einstiegspunkt auf ItemTooltipCallback des Clients zu.
  miningspeedtooltips: 'verwendet beim Serverstart eine ausschließlich clientseitige Tooltip-API',
  // Als beidseitig deklariert; die leere Sprachdatei bricht Minecraft 1.20.1 ab.
  ftbquestsfreezefix: 'Client-Menü-Erweiterung mit einer leeren Sprachdatei, die den Serverstart abbricht',
  collapsible_groups: 'Client-Oberfläche greift beim Laden auf Minecraft-Screen-Klassen zu',
  euphoria_patcher: 'Shader-Patcher lädt ClientLevel-Klassen auf dem dedizierten Server',
};

const supplementarySchema = z.array(z.object({
  displayName: z.string().max(250).optional(),
  pattern: z.string().min(1).max(500),
  url: z.string().url().optional(),
  destination: z.string().default('mods'),
})).max(1000);

/** Dateinamen und einfache .*-Muster prüfen, ohne fremde reguläre Ausdrücke auszuführen. */
function matchesSupplementaryFile(file: string, pattern: string): boolean {
  const name = file.toLowerCase();
  const parts = pattern.toLowerCase().replace(/\\\./g, '.').split('.*');
  if (parts.length === 1) return name === parts[0];
  if (!name.startsWith(parts[0])) return false;
  let offset = parts[0].length;
  for (const part of parts.slice(1, -1)) {
    const found = name.indexOf(part, offset);
    if (found < 0) return false;
    offset = found + part.length;
  }
  return name.slice(offset).endsWith(parts[parts.length - 1]);
}

/** Manche Client-Pakete laden weitere Mods erst über ein grafisches Fenster nach. */
async function assertSupplementaryDownloadsComplete(plan: PackPlan, dir: string, task: TaskHandle): Promise<void> {
  let entry: ReturnType<AdmZip['getEntry']> = null;
  for (const prefix of plan.overrideDirs) {
    const candidate = plan.zip.getEntry(`${prefix}/config/missing_mods_checker.json`);
    if (candidate) entry = candidate;
  }
  if (!entry) return;
  let raw: unknown;
  try { raw = JSON.parse(entry.getData().toString('utf8')); }
  catch { throw badRequest('Die Zusatzdownload-Liste des Modpacks ist ungültig. Bitte ein vollständiges Serverpaket verwenden.'); }
  const parsed = supplementarySchema.safeParse(raw);
  if (!parsed.success) throw badRequest('Die Zusatzdownload-Liste des Modpacks ist ungültig. Bitte ein vollständiges Serverpaket verwenden.');
  const files = await fs.readdir(safePath(dir, 'mods')).catch(() => [] as string[]);
  const missing = parsed.data.filter(item => item.destination === 'mods' && !files.some(file => /\.jar$/i.test(file) && matchesSupplementaryFile(file, item.pattern)));
  if (!missing.length) return;
  await task.log('Das Client-Paket erwartet zusätzliche Downloads, die nicht im Archiv oder Index enthalten sind:');
  for (const item of missing) await task.log(`   ${item.displayName ?? item.pattern}${item.url ? ` – ${item.url}` : ''}`);
  throw badRequest(`Das Modpack ist unvollständig: ${missing.length} Zusatzdownload(s) fehlen (${missing.slice(0, 6).map(item => item.displayName ?? item.pattern).join(', ')}). Bitte das vollständige Serverpaket des Autors verwenden; die vorhandenen Serverdaten bleiben erhalten.`);
}

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
 * Drei Regeln, alle transitiv angewandt:
 *   0. Namentlich bekannter Server-Killer (CLIENT_ONLY_MOD_IDS, dazu die
 *      Renderer aus CLIENT_ONLY_PREFIXES) → clientseitig, egal was drinsteht.
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

  for (const mod of mods) {
    if (clientIds.has(mod.id)) continue;
    const grund =
      CLIENT_ONLY_MOD_IDS[mod.id] ??
      (CLIENT_ONLY_PREFIXES.some((p) => normalizeModName(mod.file).startsWith(p))
        ? 'bekannte Client-Renderer-Mod'
        : null);
    if (grund) {
      clientIds.add(mod.id);
      derived.set(mod.id, grund);
    }
  }

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

  const infoByFile = new Map(files.map((file) => [file, readForgeModInfo(path.join(modsDir, file))]));
  const candidates = files.filter((file) =>
    CLIENT_ONLY_PREFIXES.some((prefix) => normalizeModName(file).startsWith(prefix)) ||
    infoByFile.get(file)?.provides.some((id) => Boolean(CLIENT_ONLY_MOD_IDS[id])),
  );
  if (candidates.length === 0) return { disabled: [], keptAsDependency: [] };

  // Welche Mod-IDs brauchen die Dateien, die bleiben sollen?
  const required = new Map<string, string>(); // modId -> Datei, die sie braucht
  for (const file of files) {
    if (candidates.includes(file)) continue;
    const info = infoByFile.get(file);
    for (const modId of info?.requires ?? []) {
      if (!required.has(modId)) required.set(modId, file);
    }
  }

  const result: ClientModFilterResult = { disabled: [], keptAsDependency: [] };

  for (const file of candidates) {
    const info = infoByFile.get(file);
    const neededFor = (info?.provides ?? []).find((modId) => required.has(modId));

    if (neededFor) {
      result.keptAsDependency.push({ file, neededBy: required.get(neededFor)! });
      continue;
    }

    await fs
      .rename(path.join(modsDir, file), path.join(modsDir, `${file}.disabled`))
      .then(() => result.disabled.push({ file, reason: (info?.provides.map((id) => CLIENT_ONLY_MOD_IDS[id]).find(Boolean)) ?? 'bekannte Client-Renderer-Mod' }))
      .catch(() => {});
  }

  return result;
}

// ---------------------------------------------------------------------------
// Entpacken
// ---------------------------------------------------------------------------

/**
 * Ordner, die es nur im Spiel gibt. Shaderpacks sind bei großen Paketen
 * dreistellige Megabytebeträge, die ein Server nie anfasst; `saves/` sind die
 * Einzelspielerwelten des Clients und `screenshots/` braucht keine Erklärung.
 *
 * `resourcepacks/` bleibt bewusst drin: ein Server darf seinen Spielern ein
 * Paket ausliefern, das Verzeichnis hat dort also einen Zweck.
 */
const CLIENT_ONLY_DIRS = /^(shaderpacks|screenshots|saves)\//;

export function isClientOnlyPackPath(relative: string): boolean {
  return CLIENT_ONLY_DIRS.test(relative.replace(/\\/g, '/'));
}

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

/** Einzelne Dateien in Modpack-Overrides sind nie so groß; alles darüber ist verdächtig. */
const MAX_OVERRIDE_BYTES = 2 * 1024 ** 3;

async function extractOverrides(
  plan: PackPlan,
  targetDir: string,
  opts: { keepConfig: boolean; worldName: string; maxGrowth: number },
): Promise<number> {
  const root = path.resolve(targetDir);
  let written = 0;
  // Auch ohne Kontingent: der Datenträger darf nicht volllaufen (1 GiB Reserve).
  const free = await fs.statfs(root).then((st) => Number(st.bsize) * Number(st.bavail) - 1024 ** 3).catch(() => Infinity);
  opts.maxGrowth = Math.min(opts.maxGrowth, Math.max(0, free));

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
      if (isClientOnlyPackPath(relative)) continue;
      if (plan.isServerPack && SERVERPACK_SKIP.some((r) => r.test(relative))) continue;

      // adm-zip begrenzt das Entpacken auf die angegebene Größe – außer sie
      // steht auf 0. Ein solcher Eintrag mit Inhalt wäre eine ZIP-Bombe.
      if (entry.header.size === 0 && entry.header.compressedSize > 2) throw new Error(`Ungültiger Eintrag im Modpack: ${relative}`);
      if (entry.header.size > MAX_OVERRIDE_BYTES) throw new Error(`Datei im Modpack ist zu groß: ${relative}`);
      const out = archiveEntryPath(root, relative);
      const previous = await fs.stat(out).catch(() => null);
      opts.maxGrowth -= Math.max(0, entry.header.size - (previous?.size ?? 0));
      if (opts.maxGrowth < 0) throw new Error('Speicherplatz reicht für das Modpack nicht aus');
      const data = entry.getData();
      if (data.length !== entry.header.size) throw new Error(`Größe im Modpack stimmt nicht: ${relative}`);
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(archiveEntryPath(root, relative), data);
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
  await fs.mkdir(path.join(cacheDir(), 'modpacks'), { recursive: true });
  const prepared = await fs.mkdtemp(path.join(cacheDir(), 'modpacks', 'vorbereitung-'));
  const changes = { started: false };
  try {
    await installModpackImpl(serverId, request, task, prepared, changes);
  } catch (err) {
    if (!changes.started) throw err;
    await dockerSvc.stop(await prisma.server.findUniqueOrThrow({ where: { id: serverId } }));
    await recoverInterruptedRestore(serverId);
    const recovered = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
    await dockerSvc.recreateContainer(recovered);
    if (state === 'running' || state === 'starting') await dockerSvc.start(recovered);
    throw err;
  } finally {
    await fs.rm(prepared, { recursive: true, force: true });
  }
}
