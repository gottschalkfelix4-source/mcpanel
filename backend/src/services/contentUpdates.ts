import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Server } from '@prisma/client';
import { badRequest } from '../lib/errors.js';
import { downloadToFile } from '../lib/download.js';
import { computeCurseforgeFingerprint } from '../lib/curseforgeFingerprint.js';
import { mapLimit } from '../lib/jarEntry.js';
import { safePath } from '../lib/safePath.js';
import * as curseforge from '../providers/curseforge.js';
import * as modrinth from '../providers/modrinth.js';
import type { ProjectVersion } from '../providers/types.js';
import { contentDir, contentKindFor, serverLoader } from './content.js';
import { remainingDiskBytes } from './quota.js';

/**
 * Update-Prüfung für einzelne Mods und Plugins.
 *
 * Installierte Jars haben keine Herkunftsangabe – sie können über den Katalog,
 * ein Modpack oder den Dateimanager gekommen sein. Erkannt werden sie über
 * ihre Prüfsummen bei beiden Anbietern: Modrinth über die SHA-1-Prüfsumme
 * (`version_files`), CurseForge über den eigenen Datei-Fingerprint
 * (MurmurHash2, siehe `lib/curseforgeFingerprint.ts`). Für jedes getroffene
 * Projekt wird die neueste Version gesucht, die zu Minecraft- und
 * Loader-Version des Servers passt; eine jüngere passende Version meldet ein
 * Update. Fehlt der CurseForge-API-Key, prüft das Panel nur Modrinth.
 */

// ---------------------------------------------------------------------------
// Caches – Hashes hängen an Größe + Änderungszeit, Projektabfragen an der Zeit.
// ---------------------------------------------------------------------------

/** SHA-1 je Datei, gültig solange Größe und Änderungszeit unverändert sind. */
const hashCache = new Map<string, { size: number; mtimeMs: number; sha1: string }>();

/** CurseForge-Fingerprint je Datei, gültig solange Größe und Änderungszeit unverändert sind. */
const fingerprintCache = new Map<string, { size: number; mtimeMs: number; fingerprint: number }>();

const LATEST_TTL_MS = 10 * 60 * 1000;
const PROJECT_META_TTL_MS = 60 * 60 * 1000;

/** Neueste passende Version je Projekt+Loader+Minecraft – `null` = keine/Fehler. */
const latestCache = new Map<string, { at: number; version: ProjectVersion | null }>();
/** Projektköpfe (Name, Slug) für die Anzeige. */
const metaCache = new Map<string, { at: number; meta: modrinth.ProjectMeta | null }>();

function cacheTrim<T>(cache: Map<string, T>, limit: number) {
  // Hashes sind billig neu zu berechnen – bei Überlauf lieber alles verwerfen,
  // als Buch über die ältesten Einträge zu führen.
  if (cache.size > limit) cache.clear();
}

async function sha1Of(file: string): Promise<string> {
  const hash = crypto.createHash('sha1');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function hashOf(serverId: string, name: string, file: string): Promise<string | null> {
  const stat = await fsp.lstat(file).catch(() => null);
  if (!stat || !stat.isFile()) return null;
  const key = `${serverId}/${name}`;
  const cached = hashCache.get(key);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.sha1;
  const sha1 = await sha1Of(file);
  cacheTrim(hashCache, 2000);
  hashCache.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, sha1 });
  return sha1;
}

/** Jars über 256 MB sind als Mods unplausibel – Fingerprint-Berechnung überspringen. */
const MAX_FINGERPRINT_BYTES = 256 * 1024 * 1024;

async function fingerprintOf(serverId: string, name: string, file: string): Promise<number | null> {
  const stat = await fsp.lstat(file).catch(() => null);
  if (!stat || !stat.isFile() || stat.size > MAX_FINGERPRINT_BYTES) return null;
  const key = `${serverId}/${name}`;
  const cached = fingerprintCache.get(key);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.fingerprint;
  const data = await fsp.readFile(file);
  const fingerprint = computeCurseforgeFingerprint(new Uint8Array(data));
  cacheTrim(fingerprintCache, 2000);
  fingerprintCache.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, fingerprint });
  return fingerprint;
}


/** Neueste zu Loader + Minecraft passende Modrinth-Version mit primärer Datei. */
async function latestVersionFor(projectId: string, loader: string | null, mcVersion: string): Promise<ProjectVersion | null> {
  const key = `${projectId}|${loader ?? '-'}|${mcVersion}`;
  const cached = latestCache.get(key);
  if (cached && Date.now() - cached.at < LATEST_TTL_MS) return cached.version;
  let version: ProjectVersion | null = null;
  try {
    const versions = await modrinth.getVersions(projectId, {
      loaders: loader ? [loader] : undefined,
      gameVersions: [mcVersion],
    });
    // Die API liefert absteigend nach Veröffentlichungsdatum – darauf verlassen
    // wir uns nicht, sortiert wird hier noch einmal.
    version = [...versions]
      .sort((a, b) => b.datePublished.localeCompare(a.datePublished))
      .find((v) => v.downloadUrl && v.filename) ?? null;
  } catch {
    version = null; // Einzelne Projekte (gelöscht, gesperrt) dürfen die Prüfung nicht stoppen.
  }
  cacheTrim(latestCache, 4000);
  latestCache.set(key, { at: Date.now(), version });
  return version;
}

/** Neueste zu Loader + Minecraft passende CurseForge-Version. */
async function curseforgeLatest(projectId: string, loader: string | null, mcVersion: string): Promise<ProjectVersion | null> {
  const key = `cf:${projectId}|${loader ?? '-'}|${mcVersion}`;
  const cached = latestCache.get(key);
  if (cached && Date.now() - cached.at < LATEST_TTL_MS) return cached.version;
  let version: ProjectVersion | null = null;
  try {
    version = await curseforge.latestCompatibleVersion(projectId, mcVersion, loader);
  } catch {
    version = null;
  }
  cacheTrim(latestCache, 4000);
  latestCache.set(key, { at: Date.now(), version });
  return version;
}

interface CurseforgeMeta {
  id: string;
  name: string;
  slug: string;
}

async function curseforgeMeta(projectId: string): Promise<CurseforgeMeta | null> {
  const cached = metaCache.get(`cf:${projectId}`);
  if (cached && Date.now() - cached.at < PROJECT_META_TTL_MS) return cached.meta as CurseforgeMeta | null;
  let meta: CurseforgeMeta | null = null;
  try {
    const project = await curseforge.getProject(projectId);
    meta = { id: project.id, name: project.name, slug: project.slug };
  } catch {
    meta = null;
  }
  cacheTrim(metaCache, 4000);
  metaCache.set(`cf:${projectId}`, { at: Date.now(), meta: meta as unknown as modrinth.ProjectMeta | null });
  return meta;
}

async function metaFor(projectId: string): Promise<modrinth.ProjectMeta | null> {
  const cached = metaCache.get(projectId);
  if (cached && Date.now() - cached.at < PROJECT_META_TTL_MS) return cached.meta;
  let meta: modrinth.ProjectMeta | null = null;
  try {
    meta = (await modrinth.getProjectsByIds([projectId])).get(projectId) ?? null;
  } catch {
    meta = null;
  }
  cacheTrim(metaCache, 4000);
  metaCache.set(projectId, { at: Date.now(), meta });
  return meta;
}

// ---------------------------------------------------------------------------
// Prüfung
// ---------------------------------------------------------------------------

export interface ContentUpdateInfo {
  filename: string;
  provider: 'modrinth' | 'curseforge';
  projectId: string;
  projectSlug: string;
  projectName: string;
  projectUrl: string | null;
  installedVersion: string;
  latestVersionId: string;
  latestVersion: string;
  latestVersionName: string;
  latestVersionType: 'release' | 'beta' | 'alpha';
  latestFilename: string;
  downloadUrl: string | null;
  releasedAt: string;
}

export interface ContentUpdateCheck {
  checkedAt: string;
  updates: ContentUpdateInfo[];
  /**
   * Gesetzt, wenn ein Anbieter nicht erreichbar war – die Treffer des anderen
   * Anbieters werden trotzdem geliefert. `error` bleibt null, wenn alle
   * konfigurierten Quellen geklappt haben.
   */
  error: string | null;
}

/**
 * Aktivierte Mods/Plugins gegen Modrinth und CurseForge prüfen. Deaktivierte
 * Dateien bleiben außen vor – wer sie wieder einschaltet, prüft dann erneut.
 * Unbekannte Jars (Handarbeit, keiner der Anbieter kennt sie) werden still
 * übersprungen. Ohne CurseForge-API-Key prüft das Panel nur Modrinth.
 */
export async function checkContentUpdates(server: Server): Promise<ContentUpdateCheck> {
  const checkedAt = new Date().toISOString();
  const dir = contentDir(server);
  if (!dir) return { checkedAt, updates: [], error: null };

  const names = (await fsp.readdir(safePath(dir, '')).catch(() => [] as string[]))
    // Nur aktive Jars; `.jar.disabled` ist ausdrücklich kein Kandidat.
    .filter((name) => /\.jar$/i.test(name) && !name.toLowerCase().endsWith('.disabled'));

  // SHA-1 je Datei (mit Cache über Größe/Änderungszeit) und Batch-Erkennung.
  const hashes = new Map<string, string>();
  for (const name of names) {
    const sha1 = await hashOf(server.id, name, safePath(dir, name));
    if (sha1) hashes.set(name, sha1);
  }
  if (hashes.size === 0) return { checkedAt, updates: [], error: null };

  const fehler: string[] = [];
  const updates: ContentUpdateInfo[] = [];

  // Loader nur bei Mods filtern; Plugins sind bei Modrinth je nach Projekt als
  // paper/spigot/bukkit markiert, ein Filter würde Treffer übersehen. Bei
  // CurseForge gilt dasselbe: Plugins tragen meist keinen Loader.
  const loader = contentKindFor(server.type) === 'mod' ? serverLoader(server).toLowerCase() : null;

  const modrinthInstalliert = await (async () => {
    let gefunden: Map<string, ProjectVersion[]>;
    try {
      gefunden = await modrinth.getVersionsForHashes([...hashes.values()]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fehler.push(
        message.startsWith('Modrinth:')
          ? message
          : 'Modrinth ist gerade nicht erreichbar – später erneut versuchen',
      );
      return new Map<string, ProjectVersion>();
    }

    // Installierte Version je Datei – bei mehreren Treffern die jüngste.
    const installiert = new Map<string, ProjectVersion>();
    for (const [name, sha1] of hashes) {
      const versions = gefunden.get(sha1);
      if (!versions?.length) continue;
      installiert.set(name, versions.reduce((a, b) => (a.datePublished > b.datePublished ? a : b)));
    }
    if (installiert.size === 0) return installiert;

    const projectIds = [...new Set([...installiert.values()].map((v) => v.projectId))];
    const metas = await mapLimit(projectIds, 4, metaFor);
    const jeProjekt = new Map(projectIds.map((id, i) => [id, metas[i]]));
    const latest = await mapLimit(projectIds, 4, (id) => latestVersionFor(id, loader, server.mcVersion));

    for (const [name, aktuell] of installiert) {
      const neueste = latest[projectIds.indexOf(aktuell.projectId)];
      if (!neueste || neueste.id === aktuell.id) continue;
      if (!(neueste.datePublished > aktuell.datePublished)) continue;
      const meta = jeProjekt.get(aktuell.projectId);
      updates.push({
        filename: name,
        provider: 'modrinth',
        projectId: aktuell.projectId,
        projectSlug: meta?.slug ?? aktuell.projectId,
        projectName: meta?.title ?? aktuell.projectId,
        projectUrl: meta ? `https://modrinth.com/${meta.projectType}/${meta.slug}` : null,
        installedVersion: aktuell.versionNumber,
        latestVersionId: neueste.id,
        latestVersion: neueste.versionNumber,
        latestVersionName: neueste.name,
        latestVersionType: neueste.versionType ?? 'release',
        latestFilename: neueste.filename,
        downloadUrl: neueste.downloadUrl,
        releasedAt: neueste.datePublished,
      });
    }
    return installiert;
  })();


  const curseforgeErgebnis = await (async () => {
    if (!(await curseforge.isConfigured())) return;

    // Nur Dateien, die Modrinth nicht kennt – dort war die Erkennung schon
    // erfolgreich, ein zweiter Anbieter-Check ist überflüssig.
    const ohneModrinth = [...hashes.keys()].filter((name) => !modrinthInstalliert.has(name));
    if (ohneModrinth.length === 0) return;

    const fingerprints = new Map<string, number>();
    for (const name of ohneModrinth) {
      const fp = await fingerprintOf(server.id, name, safePath(dir, name));
      if (fp != null) fingerprints.set(name, fp);
    }
    if (fingerprints.size === 0) return;

    let matches: Map<number, curseforge.CurseforgeMatch>;
    try {
      matches = await curseforge.fingerprintMatches([...fingerprints.values()]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fehler.push(
        message.startsWith('CurseForge:')
          ? message
          : 'CurseForge ist gerade nicht erreichbar – später erneut versuchen',
      );
      return;
    }

    // Installierte Version je Datei.
    const installiertCf = new Map<string, ProjectVersion>();
    for (const [name, fp] of fingerprints) {
      const match = matches.get(fp);
      if (!match) continue;
      installiertCf.set(name, curseforge.toVersionPublic(match.file));
    }
    if (installiertCf.size === 0) return;

    // Metadaten und neueste passende Version – je Projekt gebündelt.
    const projektIds = [...new Set([...installiertCf.values()].map((v) => v.projectId))];
    const metas = await mapLimit(projektIds, 4, curseforgeMeta);
    const jeProjekt = new Map(projektIds.map((id, i) => [id, metas[i]]));
    const latest = await mapLimit(projektIds, 4, (id) =>
      curseforgeLatest(id, loader, server.mcVersion),
    );

    for (const [name, aktuell] of installiertCf) {
      const neueste = latest[projektIds.indexOf(aktuell.projectId)];
      if (!neueste || neueste.id === aktuell.id) continue;
      if (!(neueste.datePublished > aktuell.datePublished)) continue;
      const meta = jeProjekt.get(aktuell.projectId);
      updates.push({
        filename: name,
        provider: 'curseforge',
        projectId: aktuell.projectId,
        projectSlug: meta?.slug ?? aktuell.projectId,
        projectName: meta?.name ?? aktuell.projectId,
        projectUrl: meta
          ? `https://www.curseforge.com/minecraft/mc-mods/${meta.slug}`
          : null,
        installedVersion: aktuell.versionNumber,
        latestVersionId: neueste.id,
        latestVersion: neueste.versionNumber,
        latestVersionName: neueste.name,
        latestVersionType: neueste.versionType ?? 'release',
        latestFilename: neueste.filename,
        downloadUrl: neueste.downloadUrl,
        releasedAt: neueste.datePublished,
      });
    }
  })();
  void curseforgeErgebnis;

  // Treffer beider Anbieter vereinen; ein Anbieter-Fehler wird gemeldet, sobald
  // die andere Quelle nichts beigetragen hat oder ebenfalls scheiterte.
  updates.sort((a, b) => a.filename.localeCompare(b.filename, 'de', { numeric: true }));
  return { checkedAt, updates, error: fehler.length > 0 ? fehler.join(' ') : null };
}


// ---------------------------------------------------------------------------
// Anwenden
// ---------------------------------------------------------------------------

/**
 * Eine Datei auf die angegebene Version bringen: neue Datei herunterladen und
 * erst nach Erfolg die alte (und eine ggf. vorhandene `.disabled`-Kopie)
 * entfernen. Ein Fehlschlag des Downloads lässt den alten Stand unangetastet –
 * so wie beim Installieren einzelner Mods.
 */
export async function applyContentUpdate(
  server: Server,
  oldFilename: string,
  projectId: string,
  versionId: string,
  provider: 'modrinth' | 'curseforge' = 'modrinth',
): Promise<{ newFilename: string }> {
  const dir = contentDir(server);
  if (!dir) throw badRequest('Dieser Servertyp lädt weder Mods noch Plugins.');

  const version =
    provider === 'curseforge'
      ? await curseforge.getVersion(projectId, versionId)
      : await modrinth.getVersion(versionId);
  if (version.projectId !== projectId) throw badRequest('Die Versions-ID gehört nicht zum gewählten Projekt.');

  let url: string | null = version.downloadUrl;
  let headers: Record<string, string>;
  if (provider === 'curseforge') {
    url = await curseforge.resolveDownloadUrl(projectId, versionId, version.filename);
    headers = await curseforge.downloadHeaders();
  } else {
    headers = modrinth.modrinthHeaders();
  }
  if (!url) throw badRequest('Für diese Datei ist kein automatischer Download erlaubt');

  await fsp.mkdir(dir, { recursive: true });

  const alte = safePath(dir, path.basename(oldFilename));
  const alteSize = (await fsp.stat(alte).catch(() => null))?.size ?? 0;

  // Erst die neue Datei vollständig laden (ersetzt eine gleichnamige atomar),
  // dann die alte entfernen – nie umgekehrt.
  const target = safePath(dir, path.basename(version.filename));
  await downloadToFile(url, target, {
    maxBytes: (await remainingDiskBytes(server)) + alteSize,
    headers,
  });

  if (alte !== target) {
    await fsp.rm(alte, { force: true });
    const disabled = safePath(dir, `${path.basename(oldFilename)}.disabled`);
    if (disabled !== target) await fsp.rm(disabled, { force: true });
  }
  return { newFilename: path.basename(version.filename) };
}

