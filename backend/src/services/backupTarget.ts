/**
 * Zweitablage für Backups – konfigurierbar in der Oberfläche, nicht über die
 * Umgebung. Zwei Arten:
 *
 *   SMB  – eine Samba-/Windows-Freigabe. Sie wird als CIFS-Mount in den
 *          Backend-Container gehängt; danach ist sie ein ganz normaler Ordner,
 *          und das Kopieren großer Archive erledigt der Kernel.
 *   S3   – beliebiger S3-kompatibler Speicher (AWS, MinIO, Backblaze B2,
 *          Wasabi). Der Upload läuft mehrteilig, sonst wäre bei 5 GB Schluss.
 *
 * Zugangsdaten liegen in der Setting-Tabelle und verlassen den Server nie:
 * die Oberfläche bekommt nur eine maskierte Fassung.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { prisma } from '../db.js';
import { withQueuedOperation } from './operations.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

import { getSetting, setSetting } from './settings.js';
import { badRequest } from '../lib/errors.js';

const run = promisify(execFile);

const SETTING_KEY = 'backup.target';
/** Einhängepunkt der Freigabe im Backend-Container. */
const SMB_MOUNT = '/mnt/backup-target';
/**
 * Zweiter Einhängepunkt nur zum Ausprobieren. Eine Prüfung mit fremden Daten
 * darf die laufende Einbindung nicht ersetzen – sonst schreibt das Panel seine
 * Sicherungen anschließend auf eine Freigabe, die nie gespeichert wurde.
 */
const SMB_PROBE = '/mnt/backup-probe';

export type TargetKind = 'NONE' | 'SMB' | 'S3';

export interface SmbConfig {
  /** Server oder IP, z. B. "nas.fritz.box" oder "192.168.1.20" */
  host: string;
  /** Freigabename, z. B. "backups" */
  share: string;
  /** Unterordner innerhalb der Freigabe (optional) */
  path: string;
  username: string;
  password: string;
  domain: string;
  /** SMB-Protokollfassung, Vorgabe 3.0 */
  version: string;
}

export interface S3Config {
  /** Leer = AWS. Für MinIO/B2/Wasabi die Endpunkt-URL eintragen. */
  endpoint: string;
  region: string;
  bucket: string;
  /** Präfix im Bucket, z. B. "mcpanel/" */
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO und viele andere brauchen Pfad-Adressierung statt Host-Präfix. */
  forcePathStyle: boolean;
}

export interface TargetConfig {
  kind: TargetKind;
  smb: SmbConfig;
  s3: S3Config;
}

const EMPTY: TargetConfig = {
  kind: 'NONE',
  smb: { host: '', share: '', path: '', username: '', password: '', domain: '', version: '3.0' },
  s3: {
    endpoint: '',
    region: 'us-east-1',
    bucket: '',
    prefix: '',
    accessKeyId: '',
    secretAccessKey: '',
    forcePathStyle: true,
  },
};

// ---------------------------------------------------------------------------
// Konfiguration lesen und schreiben
// ---------------------------------------------------------------------------

let cached: TargetConfig | null = null;

export async function getTarget(): Promise<TargetConfig> {
  if (cached) return cached;
  const raw = await getSetting(SETTING_KEY, '');
  if (!raw) {
    cached = EMPTY;
    return cached;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<TargetConfig>;
    cached = {
      kind: parsed.kind ?? 'NONE',
      smb: { ...EMPTY.smb, ...(parsed.smb ?? {}) },
      s3: { ...EMPTY.s3, ...(parsed.s3 ?? {}) },
    };
  } catch {
    cached = EMPTY;
  }
  return cached;
}

async function saveTargetUnlocked(next: TargetConfig): Promise<void> {
  const previous = await getTarget();
  if (previous.kind !== 'NONE') {
    const targetId = await registerTarget(previous);
    await prisma.backup.updateMany({ where: { mirrored: true, targetId: null }, data: { targetId } });
  }
  if (next.kind === 'SMB') await mountSmb(next.smb);
  else await unmountSmb();
  try {
    await setSetting(SETTING_KEY, JSON.stringify(next));
    cached = next;
  } catch (err) {
    if (previous.kind === 'SMB') await mountSmb(previous.smb);
    throw err;
  }
}

/** Für die Oberfläche: ohne Kennwörter, mit maskiertem Schlüssel. */
export function publicTarget(config: TargetConfig) {
  const mask = (value: string) =>
    value ? `${value.slice(0, 4)}…${value.length > 8 ? value.slice(-2) : ''}` : '';

  return {
    kind: config.kind,
    smb: {
      host: config.smb.host,
      share: config.smb.share,
      path: config.smb.path,
      username: config.smb.username,
      domain: config.smb.domain,
      version: config.smb.version,
      passwordSet: Boolean(config.smb.password),
    },
    s3: {
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      bucket: config.s3.bucket,
      prefix: config.s3.prefix,
      accessKeyId: config.s3.accessKeyId,
      forcePathStyle: config.s3.forcePathStyle,
      secretMasked: mask(config.s3.secretAccessKey),
      secretSet: Boolean(config.s3.secretAccessKey),
    },
  };
}

export function isEnabled(config: TargetConfig): boolean {
  return config.kind !== 'NONE';
}

// ---------------------------------------------------------------------------
// SMB: einhängen und aushängen
// ---------------------------------------------------------------------------

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ist an diesem Punkt etwas eingehaengt?
 *
 * Gelesen wird /proc/mounts, nicht die Ausgabe von `mount`: im Container gibt
 * es keine /etc/mtab, und busybox' `mount` gibt dann schlicht nichts aus. Die
 * Pruefung war damit immer negativ, und jede Einbindung stapelte sich auf die
 * vorige, bis der Punkt als belegt galt.
 */
async function isMounted(at: string = SMB_MOUNT): Promise<boolean> {
  try {
    const table = await fsp.readFile('/proc/mounts', 'utf8');
    // Zeilenaufbau: "Geraet Einhaengepunkt Typ Optionen 0 0" – der Punkt steht
    // also immer von Leerzeichen umschlossen darin.
    return table.includes(` ${at} `);
  } catch {
    return false;
  }
}

/**
 * Kennzeichen der gerade eingehaengten Freigabe. Ohne das wuerde beim
 * Speichern zweimal hintereinander eingehaengt (einmal fuer die Pruefung,
 * einmal beim Uebernehmen) und der zweite Versuch liefe in "Resource busy".
 */
let mountedSignature: string | null = null;

const signature = (smb: SmbConfig) =>
  [smb.host, smb.share, smb.username, smb.domain, smb.version, smb.password].join('|');

async function unmountSmb(at: string = SMB_MOUNT): Promise<void> {
  if (at === SMB_MOUNT) mountedSignature = null;
  // Mehrfach, falls sich frueher schon etwas gestapelt hat.
  for (let round = 0; round < 5 && (await isMounted(at)); round++) {
    // Erst sauber aushaengen; erst wenn das scheitert, verzoegert.
    await run('umount', [at]).catch(() => run('umount', ['-l', at]).catch(() => {}));
    for (let i = 0; i < 15 && (await isMounted(at)); i++) await delay(200);
  }
}

/** mount.cifs meldet nackte Fehlernummern - die uebersetzen wir. */
function describeMountError(raw: string): string {
  if (/mount error\(13\)|Permission denied/.test(raw)) {
    return 'Zugangsdaten abgelehnt - Benutzer, Kennwort oder Domaene pruefen';
  }
  if (/mount error\(2\)|No such file or directory/.test(raw)) {
    return 'Freigabe nicht gefunden - Name der Freigabe pruefen';
  }
  if (/mount error\(112\)|Host is down|No route to host|mount error\(101\)/.test(raw)) {
    return 'Server nicht erreichbar - Adresse und Netz pruefen';
  }
  if (/bad address|Unable to find suitable address|Name or service not known|could not resolve/i.test(raw)) {
    return 'Servername nicht auffindbar - Adresse pruefen';
  }
  if (/mount error\(95\)|mount error\(22\)|Protocol not supported/.test(raw)) {
    return 'Protokollfassung passt nicht - andere SMB-Version waehlen';
  }
  if (/mount error\(16\)|Resource busy/.test(raw)) {
    return 'Einhaengepunkt noch belegt - bitte gleich noch einmal versuchen';
  }
  if (/mount error\(115\)|timed out|Connection timed out/i.test(raw)) {
    return 'Zeitueberschreitung - Server antwortet nicht';
  }
  return `Freigabe konnte nicht eingehaengt werden: ${raw.slice(0, 200)}`;
}

/**
 * Haengt die Freigabe ein. Braucht CAP_SYS_ADMIN am Container - vertretbar,
 * weil das Panel ohnehin den Docker-Socket haelt und damit bereits
 * root-gleiche Rechte auf dem Host hat.
 */
async function mountSmb(smb: SmbConfig, at: string = SMB_MOUNT): Promise<void> {
  const sig = signature(smb);
  if (at === SMB_MOUNT && mountedSignature === sig && (await isMounted())) return;

  await unmountSmb(at);
  await fsp.mkdir(at, { recursive: true });

  for (const value of [smb.username, smb.password, smb.domain]) {
    if (/[\r\n\0]/.test(value)) throw badRequest('SMB-Zugangsdaten dürfen keine Zeilenumbrüche enthalten');
  }
  if (!/^(default|1\.0|2\.0|2\.1|3\.0|3\.02|3\.1\.1)$/.test(smb.version || '3.0')) throw badRequest('Ungültige SMB-Version');
  const credentialsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcpanel-cifs-'));
  const credentials = path.join(credentialsDir, 'credentials');
  await fsp.writeFile(credentials, `username=${smb.username || 'guest'}\npassword=${smb.password}\ndomain=${smb.domain}\n`, { mode: 0o600 });
  const options = [`credentials=${credentials}`, `vers=${smb.version || '3.0'}`, 'uid=0', 'gid=0', 'file_mode=0644', 'dir_mode=0755', ...(smb.username ? [] : ['guest'])].join(',');

  const source = `//${smb.host}/${smb.share}`;
  try {
    await run('mount', ['-t', 'cifs', source, at, '-o', options], { timeout: 30_000 });
    if (!(await isMounted(at))) throw new Error('Mount wurde nicht aktiv');
    if (at === SMB_MOUNT) mountedSignature = sig;
  } catch (err) {
    if (at === SMB_MOUNT) mountedSignature = null;
    // Die Zugangsdaten stehen im Optionsstring - sie duerfen nicht in der
    // Meldung landen, die spaeter in der Oberflaeche steht.
    const raw = (err instanceof Error ? err.message : String(err)).replace(
      /password=[^,']*/g,
      'password=***',
    );
    throw new Error(describeMountError(raw));
  } finally {
    await fsp.rm(credentialsDir, { recursive: true, force: true });
  }
}

/** Zielordner innerhalb der Freigabe. */
function smbDir(config: TargetConfig, serverId: string): string {
  const relative = config.smb.path.replace(/\\/g, '/');
  if (relative.split('/').includes('..')) throw badRequest('Ungültiger SMB-Unterordner');
  return path.posix.join(SMB_MOUNT, relative, serverId);
}

/** Setzt den aktuellen Stand um – beim Start und nach jedem Speichern. */
async function applyTargetUnlocked(): Promise<void> {
  const config = await getTarget();
  if (config.kind === 'SMB') {
    await mountSmb(config.smb);
  } else {
    await unmountSmb();
  }
}

// ---------------------------------------------------------------------------
// S3
// ---------------------------------------------------------------------------

function s3Client(s3: S3Config): S3Client {
  return new S3Client({
    region: s3.region || 'us-east-1',
    ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
    forcePathStyle: s3.forcePathStyle,
    credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
  });
}

function s3Key(config: TargetConfig, serverId: string, filename: string): string {
  const prefix = config.s3.prefix.replace(/^\/+|\/+$/g, '');
  return [prefix, serverId, filename].filter(Boolean).join('/');
}

// ---------------------------------------------------------------------------
// Betrieb
// ---------------------------------------------------------------------------

/** Legt eine fertige Sicherung in der Zweitablage ab. */
async function putBackupUnlocked(
  serverId: string,
  filename: string,
  localPath: string,
  onProgress?: (percent: number) => void,
  targetId?: string | null,
): Promise<void> {
  const config = await targetForBackup(targetId);

  if (config.kind === 'SMB') {
    await mountSmb(config.smb);
    const dir = smbDir(config, serverId);
    await fsp.mkdir(dir, { recursive: true });
    const temp = path.posix.join(dir, `.partial-${crypto.randomUUID()}`);
    try {
      await fsp.copyFile(localPath, temp);
      await fsp.rename(temp, path.posix.join(dir, filename));
    } finally { await fsp.rm(temp, { force: true }); }
    onProgress?.(100);
    return;
  }

  if (config.kind === 'S3') {
    const { size } = await fsp.stat(localPath);
    const upload = new Upload({
      client: s3Client(config.s3),
      params: {
        Bucket: config.s3.bucket,
        Key: s3Key(config, serverId, filename),
        Body: fs.createReadStream(localPath),
      },
      // 64 MB je Teil: bei 10.000 erlaubten Teilen reicht das für 640 GB.
      partSize: 64 * 1024 * 1024,
      queueSize: 3,
    });
    if (onProgress) {
      upload.on('httpUploadProgress', (p) => {
        if (p.loaded && size) onProgress(Math.round((p.loaded / size) * 100));
      });
    }
    try {
      await upload.done();
    } catch (err) {
      throw new Error(describeS3Error(err));
    }
  }
}

/**
 * Holt eine Sicherung zurück. Bei SMB ist das ein Pfad im Mount, bei S3 wird
 * die Datei in eine temporäre Kopie geladen; `cleanup` räumt sie wieder weg.
 */
async function fetchBackupUnlocked(
  serverId: string,
  filename: string,
  targetId?: string | null,
): Promise<{ path: string; cleanup: () => Promise<void> } | null> {
  const config = await targetForBackup(targetId);

  if (config.kind === 'SMB') {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcpanel-backup-'));
    const temp = path.join(tempDir, 'archive.tar.gz');
    try {
      await mountSmb(config.smb, SMB_PROBE);
      const relative = config.smb.path.replace(/\\/g, '/');
      if (relative.split('/').includes('..')) throw badRequest('Ungültiger SMB-Unterordner');
      await fsp.copyFile(path.posix.join(SMB_PROBE, relative, serverId, filename), temp);
      return { path: temp, cleanup: () => fsp.rm(tempDir, { recursive: true, force: true }) };
    } catch (err) {
      await fsp.rm(tempDir, { recursive: true, force: true });
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    } finally { await unmountSmb(SMB_PROBE); }
  }

  if (config.kind === 'S3') {
    const client = s3Client(config.s3);
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcpanel-backup-'));
    const tmp = path.join(dir, 'archive.tar.gz');
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: s3Key(config, serverId, filename) }), { abortSignal: AbortSignal.timeout(120_000) });
      if (!res.Body) throw new Error('S3 lieferte keinen Dateiinhalt');
      await pipeline(res.Body as NodeJS.ReadableStream, fs.createWriteStream(tmp), { signal: AbortSignal.timeout(120_000) });
      return { path: tmp, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
    } catch (err) {
      await fsp.rm(dir, { recursive: true, force: true });
      if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw err;
    } finally { client.destroy(); }
  }

  return null;
}

/** Entfernt eine Sicherung aus der Zweitablage. Fehler bleiben hier stehen. */
async function removeBackupUnlocked(serverId: string, filename: string, targetId?: string | null): Promise<void> {
  const config = await targetForBackup(targetId);

  if (config.kind === 'SMB') {
    await mountSmb(config.smb);
    await fsp.rm(path.posix.join(smbDir(config, serverId), filename), { force: true }).catch(() => {});
    return;
  }

  if (config.kind === 'S3') {
    await s3Client(config.s3)
      .send(
        new DeleteObjectCommand({
          Bucket: config.s3.bucket,
          Key: s3Key(config, serverId, filename),
        }),
      )
      .catch(() => {});
  }
}

export interface TargetStatus {
  kind: TargetKind;
  ok: boolean;
  message: string;
  freeBytes: number | null;
}

/** Prüft die Erreichbarkeit – für den Testknopf und die Statusanzeige. */
async function testTargetUnlocked(config?: TargetConfig): Promise<TargetStatus> {
  const target = config ?? (await getTarget());

  if (target.kind === 'NONE') {
    return { kind: 'NONE', ok: true, message: 'Keine Zweitablage eingerichtet', freeBytes: null };
  }

  if (target.kind === 'SMB') {
    // Fremde Daten werden an einem eigenen Punkt ausprobiert, gespeicherte am
    // laufenden - so bleibt eine funktionierende Einbindung unangetastet.
    const at = config ? SMB_PROBE : SMB_MOUNT;
    try {
      if (!target.smb.host || !target.smb.share) throw new Error('Server und Freigabe fehlen');
      if (config || !(await isMounted(at))) await mountSmb(target.smb, at);

      const dir = path.posix.join(at, target.smb.path || '');
      await fsp.mkdir(dir, { recursive: true });
      const marker = path.posix.join(dir, '.mcpanel-schreibtest');
      await fsp.writeFile(marker, 'ok');
      await fsp.rm(marker, { force: true });

      let freeBytes: number | null = null;
      try {
        const st = await fsp.statfs(at);
        freeBytes = Number(st.bsize) * Number(st.bavail);
      } catch {
        freeBytes = null;
      }

      return { kind: 'SMB', ok: true, message: 'Freigabe erreichbar und beschreibbar', freeBytes };
    } catch (err) {
      return {
        kind: 'SMB',
        ok: false,
        message: err instanceof Error ? err.message : 'Freigabe nicht erreichbar',
        freeBytes: null,
      };
    } finally {
      if (config) await unmountSmb(SMB_PROBE).catch(() => {});
    }
  }

  try {
    if (!target.s3.bucket) throw new Error('Bucket fehlt');
    await s3Client(target.s3).send(new HeadBucketCommand({ Bucket: target.s3.bucket }));
    return { kind: 'S3', ok: true, message: 'Bucket erreichbar', freeBytes: null };
  } catch (err) {
    return { kind: 'S3', ok: false, message: describeS3Error(err), freeBytes: null };
  }
}

/**
 * S3-Fehler in eine brauchbare Meldung uebersetzen. HeadBucket antwortet ohne
 * Rumpf, das SDK meldet dann nur "UnknownError" – damit kann niemand etwas
 * anfangen, obwohl der Status-Code die Ursache genau benennt.
 */
function describeS3Error(err: unknown): string {
  const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const status = e.$metadata?.httpStatusCode;

  if (status === 403) return 'Zugangsdaten abgelehnt (403) – Schluessel oder Rechte pruefen';
  if (status === 404) return 'Bucket nicht gefunden (404) – Name und Region pruefen';
  if (status === 301 || status === 400) return 'Falsche Region oder Endpunkt fuer diesen Bucket';

  const message = e.message ?? String(err);
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return 'Endpunkt nicht auffindbar – Adresse pruefen';
  if (/ECONNREFUSED/i.test(message)) return 'Verbindung abgelehnt – laeuft der Dienst?';
  if (/timeout|ETIMEDOUT/i.test(message)) return 'Zeitueberschreitung – Endpunkt nicht erreichbar';
  if (message === 'UnknownError') return `Abgelehnt${status ? ` (HTTP ${status})` : ''}`;
  return message.slice(0, 300);
}

/** Wirft, wenn die Angaben unvollständig sind. */
export function assertComplete(config: TargetConfig): void {
  if (config.kind === 'SMB') {
    if (!config.smb.host.trim()) throw badRequest('Der Name oder die IP des Servers fehlt');
    if (!config.smb.share.trim()) throw badRequest('Der Name der Freigabe fehlt');
  }
  if (config.kind === 'S3') {
    if (!config.s3.bucket.trim()) throw badRequest('Der Bucket fehlt');
    if (!config.s3.accessKeyId.trim()) throw badRequest('Die Zugriffsschlüssel-ID fehlt');
    if (!config.s3.secretAccessKey.trim()) throw badRequest('Der geheime Schlüssel fehlt');
  }
}

export async function registerTarget(target: TargetConfig): Promise<string> {
  const serialized = JSON.stringify(target);
  const id = crypto.createHash('sha256').update(serialized).digest('hex');
  await prisma.backupTargetVersion.upsert({ where: { id }, create: { id, config: JSON.parse(serialized) }, update: {} });
  return id;
}

async function targetForBackup(id?: string | null): Promise<TargetConfig> {
  if (!id) return getTarget();
  const row = await prisma.backupTargetVersion.findUniqueOrThrow({ where: { id } });
  return row.config as unknown as TargetConfig;
}

export const saveTarget = (...args: Parameters<typeof saveTargetUnlocked>) => withQueuedOperation("backup-target", "Backup-Zweitablage", () => saveTargetUnlocked(...args));

export const testTarget = (...args: Parameters<typeof testTargetUnlocked>) => withQueuedOperation("backup-target", "Backup-Zweitablage", () => testTargetUnlocked(...args));

export const putBackup = (...args: Parameters<typeof putBackupUnlocked>) => withQueuedOperation("backup-target", "Backup-Zweitablage", () => putBackupUnlocked(...args));

export const fetchBackup = (...args: Parameters<typeof fetchBackupUnlocked>) => withQueuedOperation("backup-target", "Backup-Zweitablage", () => fetchBackupUnlocked(...args));

export const removeBackup = (...args: Parameters<typeof removeBackupUnlocked>) => withQueuedOperation("backup-target", "Backup-Zweitablage", () => removeBackupUnlocked(...args));

export const applyTarget = (...args: Parameters<typeof applyTargetUnlocked>) => withQueuedOperation("backup-target", "Backup-Zweitablage", () => applyTargetUnlocked(...args));
