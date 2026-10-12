import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';
import { z } from 'zod';
import { config } from '../config.js';
import { badRequest, notFound } from '../lib/errors.js';
import { safePath } from '../lib/safePath.js';
import { getSetting, setSetting } from './settings.js';
import { withServerOperation } from './operations.js';
import { matchesCron, parseCron } from './cron.js';
import { runTask, type TaskHandle } from './tasks.js';

export const panelBackupScheduleSchema = z.object({
  enabled: z.boolean(), cron: z.string().trim().max(100).refine(value => {
    try { parseCron(value); return true; } catch { return false; }
  }, 'Bitte einen gültigen Zeitplan mit fünf Cron-Feldern angeben.'),
  keep: z.number().int().min(1).max(365),
});
const run = promisify(execFile);
const root = () => safePath(config.dataRoot, 'backups/panel');
const filenamePattern = /^panel-[a-zA-Z0-9.-]+\.tar\.gz$/;

export async function getPanelBackupSchedule() {
  const raw = await getSetting('panel.backup.schedule');
  const defaults = { enabled: false, cron: '0 3 * * *', keep: 7 };
  let schedule = defaults;
  if (raw) {
    try { schedule = panelBackupScheduleSchema.parse(JSON.parse(raw)); } catch { /* Ungültige Vorgabe deaktiviert lassen. */ }
  }
  return { ...schedule, timezone: process.env.TZ || 'Europe/Berlin',
    lastRun: await getSetting('panel.backup.lastRun'), lastStatus: await getSetting('panel.backup.lastStatus') };
}

export async function listPanelBackups() {
  const result: { filename: string; sizeBytes: number; createdAt: string }[] = [];
  for (const name of await fs.readdir(root()).catch(() => [])) {
    if (!filenamePattern.test(name)) continue;
    const stat = await fs.stat(safePath(root(), name));
    if (stat.isFile()) result.push({ filename: name, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() });
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function panelBackupFile(filename: string) {
  if (!filenamePattern.test(filename)) throw badRequest('Ungültiger Name der Panel-Sicherung.');
  const resolved = safePath(root(), filename);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isFile()) throw notFound('Panel-Sicherung nicht gefunden.');
  return { path: safePath(root(), filename), sizeBytes: stat.size };
}

export async function deletePanelBackup(filename: string) {
  return withServerOperation('panel-backup', 'Panel-Sicherung', async () => {
    await panelBackupFile(filename);
    await fs.rm(safePath(root(), filename));
  });
}

/** Datenbank als konsistenter Dump; Schlüssel und Laufzeitvorgaben getrennt beilegen. */
export async function createPanelBackup(task?: TaskHandle) {
  return withServerOperation('panel-backup', 'Panel-Sicherung', async () => {
    await fs.mkdir(root(), { recursive: true, mode: 0o700 });
    const stage = await fs.mkdtemp(path.join(root(), '.vorbereitung-'));
    const filename = `panel-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}.tar.gz`;
    const temporary = filename + '.part';
    try {
      await task?.update(10, 'Panel-Datenbank wird konsistent gesichert …');
      try {
        await run(process.execPath, [fileURLToPath(new URL('../cli.js', import.meta.url)), 'sicherung', safePath(stage, 'database.dump')],
          { timeout: 10 * 60_000, maxBuffer: 1024 * 1024 });
      } catch { throw badRequest('Die Panel-Datenbank konnte nicht gesichert werden. PostgreSQL-Client und Datenbankzugriff prüfen.'); }
      await task?.update(65, 'Panel-Schlüssel und Einstellungen werden beigefügt …');
      await fs.writeFile(safePath(stage, '.jwt-secret'), config.jwtSecret, { mode: 0o600 });
      const key = await fs.readFile(safePath(config.dataRoot, '.sftp-host-key')).catch(err => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      });
      if (key) await fs.writeFile(safePath(stage, '.sftp-host-key'), key, { mode: 0o600 });
      await fs.writeFile(safePath(stage, 'runtime.json'), JSON.stringify({
        PUBLIC_HOST: config.publicHost, DOCKER_NETWORK: config.dockerNetwork,
        HOST_DATA_ROOT: config.hostDataRoot, MC_PORT_MIN: config.portRange.min, MC_PORT_MAX: config.portRange.max,
        MC_IMAGE: config.mcImage, MC_IMAGE_REPO: config.mcImageRepo, CURSEFORGE_API_KEY: config.curseforgeApiKey,
        SFTP_ENABLED: config.sftp.enabled, SFTP_PORT: config.sftp.port, SFTP_PUBLIC_PORT: config.sftp.publicPort, SFTP_HOST: config.sftp.host,
      }, null, 2), { mode: 0o600 });
      await fs.writeFile(safePath(stage, 'manifest.json'), JSON.stringify({ format: 1, createdAt: new Date().toISOString(),
        build: config.build, containsWorlds: false, database: 'database.dump' }, null, 2));
      await fs.writeFile(safePath(stage, 'WIEDERHERSTELLUNG.txt'),
        'Panel-Sicherung: Konten, Rechte, Einstellungen, Serverzuordnungen und Schlüssel.\n' +
        'Minecraft-Dateien und Welten werden separat über die Server-Backups gesichert.\n\n' +
        '1. Archiv in einen geschützten Wartungsordner entpacken.\n' +
        '2. Vor dem Einspielen Zugang zum Panel sperren und Automationen pausieren.\n' +
        '3. Im Panel-Container ausführen: node dist/cli.js einspielen /PFAD/database.dump --ja\n' +
        '4. .jwt-secret und .sftp-host-key im Datenverzeichnis wiederherstellen.\n' +
        '5. Laufzeitvorgaben aus runtime.json mit der Container-Konfiguration abgleichen; beim Umzug die Pfade anpassen.\n' +
        '6. Panel-Container neu starten. Serverdaten müssen zu den gesicherten Server-IDs passen.\n');
      await fs.writeFile(safePath(root(), temporary), '', { mode: 0o600 });
      await tar.create({ gzip: true, file: safePath(root(), temporary), cwd: stage, portable: true, strict: true }, await fs.readdir(stage));
      await fs.rename(safePath(root(), temporary), safePath(root(), filename));
      const schedule = await getPanelBackupSchedule();
      for (const old of (await listPanelBackups()).slice(schedule.keep)) await fs.rm(safePath(root(), old.filename));
      await setSetting('panel.backup.lastRun', new Date().toISOString());
      await setSetting('panel.backup.lastStatus', 'OK');
      await task?.update(100, 'Panel-Sicherung erstellt');
      return filename;
    } catch (err) {
      await setSetting('panel.backup.lastStatus', 'FEHLER');
      throw err;
    } finally {
      await fs.rm(safePath(root(), temporary), { force: true });
      await fs.rm(stage, { recursive: true, force: true });
    }
  });
}

let timer: NodeJS.Timeout | null = null;
let checking = false;
export function startPanelBackupScheduler(log: (message: string) => void) {
  if (timer) return;
  timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void (async () => {
      const schedule = await getPanelBackupSchedule();
      const now = new Date();
      const minute = now.toISOString().slice(0, 16);
      if (!schedule.enabled || !matchesCron(parseCron(schedule.cron), now) || await getSetting('panel.backup.lastMinute') === minute) return;
      await setSetting('panel.backup.lastMinute', minute);
      await runTask(null, 'panel.backup', task => createPanelBackup(task).then(() => {}), true);
      log('Geplante Panel-Sicherung erstellt.');
    })().catch(err => log(`Panel-Sicherung fehlgeschlagen: ${err instanceof Error ? err.message : err}`)).finally(() => { checking = false; });
  }, 20_000);
}
export function stopPanelBackupScheduler() { if (timer) clearInterval(timer); timer = null; }
