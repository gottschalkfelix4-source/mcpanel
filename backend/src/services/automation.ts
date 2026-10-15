import { withServerOperation } from './operations.js';
import type { Automation, Server } from '@prisma/client';
import { prisma } from '../db.js';
import { audit, getServerAccess } from '../auth/context.js';
import { assertAutomationAccess } from '../auth/automationAccess.js';
import { forbidden } from '../lib/errors.js';
import * as dockerSvc from './docker.js';
import { rconCommand } from './rcon.js';
import { createBackup } from './backups.js';
import { checkForUpdate, installModpack } from './modpack.js';
import { runTask } from './tasks.js';
import { matchesCron, parseCron } from './cron.js';
import { emitToServer } from '../ws/io.js';
import { notify } from './notify.js';

export const TRIGGERS = ['SCHEDULE', 'ON_CRASH'] as const;
export const ACTIONS = [
  'COMMAND',
  'BACKUP',
  'RESTART',
  'START',
  'STOP',
  'MODPACK_UPDATE',
] as const;

export type TriggerType = (typeof TRIGGERS)[number];
export type ActionType = (typeof ACTIONS)[number];

export type RunStatus = 'OK' | 'FEHLER' | 'UEBERSPRUNGEN';

interface AutomationConfig {
  command?: string;
  backupName?: string;
  note?: string;
  keepBackups?: number;
  /** Sekunden Vorwarnung im Chat vor Neustart oder Stopp. */
  warnSeconds?: number;
}

/** Der Ersteller darf die Regel nicht mehr ausführen (gelöscht, gesperrt, Rechte entzogen). */
class AuthorizationLost extends Error {}

/** Wann vor Ablauf der Frist noch einmal gewarnt wird (Sekunden). */
const WARN_MARKS = [300, 120, 60, 30, 10, 5];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** „2 Minuten“, „1 Minute“, „30 Sekunden“. */
export function warnText(action: 'RESTART' | 'STOP', left: number): string {
  const verb = action === 'RESTART' ? 'Neustart' : 'Herunterfahren';
  const span = left >= 60 && left % 60 === 0
    ? `${left / 60} ${left === 60 ? 'Minute' : 'Minuten'}`
    : `${left} ${left === 1 ? 'Sekunde' : 'Sekunden'}`;
  return `say Server-${verb} in ${span}`;
}

/**
 * Kündigt Neustart/Stopp im Spiel an und wartet die Frist ab. Läuft bewusst
 * außerhalb der Serversperre – sonst stünden Konsole und Backups minutenlang.
 * Eine nicht zustellbare Warnung hält die Aktion nicht auf.
 */
async function warnPlayers(server: Server, action: 'RESTART' | 'STOP', seconds: number): Promise<void> {
  const say = (left: number) => rconCommand(server, warnText(action, left)).catch(() => '');
  await say(seconds);
  let left = seconds;
  for (const mark of WARN_MARKS) {
    if (mark >= left) continue;
    await sleep((left - mark) * 1000);
    left = mark;
    await say(left);
  }
  await sleep(left * 1000);
}

// ---------------------------------------------------------------------------
// Ausführung
// ---------------------------------------------------------------------------

/**
 * Führt eine Automatisierung aus und schreibt das Ergebnis zurück.
 * Wirft nie – Fehler landen als Status an der Regel.
 */
export async function runAutomation(
  automation: Automation,
  origin: 'zeitplan' | 'ereignis' | 'manuell',
  actorId?: string,
): Promise<{ status: RunStatus; message: string }> {
  const server = await prisma.server.findUnique({ where: { id: automation.serverId } });
  if (!server) return finish(automation, 'FEHLER', 'Server existiert nicht mehr');

  const config = (automation.config ?? {}) as AutomationConfig;

  try {
    const authorize = async () => {
      const userId = origin === 'manuell' ? actorId : automation.createdById;
      const user = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
      if (!user?.active) {
        if (origin === 'manuell') throw forbidden('Automatisierung hat keinen aktiven berechtigten Benutzer');
        throw new AuthorizationLost('Das Konto, das die Regel zuletzt gespeichert hat, ist gelöscht oder gesperrt');
      }
      try {
        assertAutomationAccess(await getServerAccess(user, server.id), automation.action, config);
      } catch (err) {
        if (origin === 'manuell') throw err;
        throw new AuthorizationLost(`${user.username} hat nicht mehr die Rechte für diese Regel`);
      }
      return user.id;
    };
    await authorize();
    const { state } = await dockerSvc.getState(server);
    let running = state === 'running';

    if (automation.onlyWhenRunning && !running) {
      return finish(automation, 'UEBERSPRUNGEN', 'Server läuft nicht – Aktion ausgelassen');
    }

    const warn = Math.min(Math.max(Math.floor(config.warnSeconds ?? 0), 0), 600);
    if (running && warn > 0 && (automation.action === 'RESTART' || automation.action === 'STOP')) {
      await warnPlayers(server, automation.action, warn);
      running = (await dockerSvc.getState(server)).state === 'running';
    }

    const message = await withServerOperation(server.id, 'Automatisierung', async () => {
      await authorize();
      return execute(automation, server, config, running);
    });
    await audit(origin === 'manuell' ? actorId! : automation.createdById, server.id, `automation.${automation.action.toLowerCase()}`,
      `${automation.name} (${origin})`);

    // Bei BACKUP meldet createBackup den Erfolg bereits selbst – sonst käme
    // für einen Vorgang zweimal dieselbe Nachricht an.
    if (automation.action !== 'BACKUP') {
      void notify('automation.ok', {
        serverId: server.id,
        serverName: server.name,
        title: `Automatisierung „${automation.name}"`,
        message,
        fields: [
          { name: 'Aktion', value: automation.action },
          { name: 'Auslöser', value: origin },
        ],
      });
    }

    return finish(automation, 'OK', message);
  } catch (err) {
    if (err instanceof AuthorizationLost) {
      // Nicht jede Minute erneut scheitern: Regel abschalten, bis jemand mit
      // Rechten sie wieder einschaltet (und damit zum neuen Ausführenden wird).
      const message = `Deaktiviert: ${err.message}. Zum Reaktivieren erneut einschalten.`;
      await prisma.automation.update({ where: { id: automation.id }, data: { enabled: false } }).catch(() => {});
      void notify('automation.failed', {
        serverId: server.id,
        serverName: server.name,
        title: `Automatisierung „${automation.name}" deaktiviert`,
        message,
        fields: [{ name: 'Aktion', value: automation.action }],
      });
      return finish(automation, 'FEHLER', message);
    }
    const message = err instanceof Error ? err.message : String(err);

    void notify(automation.action === 'BACKUP' ? 'backup.failed' : 'automation.failed', {
      serverId: server.id,
      serverName: server.name,
      title: `Automatisierung „${automation.name}" fehlgeschlagen`,
      message,
      fields: [
        { name: 'Aktion', value: automation.action },
        { name: 'Auslöser', value: origin },
      ],
    });

    return finish(automation, 'FEHLER', message);
  }
}

async function execute(
  automation: Automation,
  server: Server,
  config: AutomationConfig,
  running: boolean,
): Promise<string> {
  const action = automation.action as ActionType;
  switch (action) {
    case 'COMMAND': {
      const command = (config.command ?? '').trim().replace(/^\//, '');
      if (!command) throw new Error('Kein Befehl hinterlegt');
      if (!running) throw new Error('Server läuft nicht – Befehl nicht zustellbar');
      const response = await rconCommand(server, command);
      return response.trim() ? response.trim().slice(0, 200) : `Befehl gesendet: ${command}`;
    }

    case 'BACKUP': {
      const stamp = new Date().toLocaleString('de-DE');
      const backup = await createBackup(server, {
        name: config.backupName?.trim() || `Automatisch ${stamp}`,
        note: config.note ?? 'Von einer Automatisierung erstellt',
        createdById: null,
        origin: 'AUTOMATIC',
        automationId: automation.id,
      });
      const removed = await pruneBackups(server.id, automation.id, config.keepBackups);
      const size = `${(Number(backup.sizeBytes) / 1024 / 1024).toFixed(1)} MB`;
      return removed > 0
        ? `Backup erstellt (${size}), ${removed} alte gelöscht`
        : `Backup erstellt (${size})`;
    }

    case 'RESTART':
      await dockerSvc.restart(server);
      return 'Server neu gestartet';

    case 'START':
      if (running) return 'Server lief bereits';
      await dockerSvc.start(server);
      return 'Server gestartet';

    case 'STOP':
      if (!running) return 'Server war bereits gestoppt';
      await dockerSvc.stop(server);
      return 'Server gestoppt';

    case 'MODPACK_UPDATE': {
      if (!server.modpackProjectId || !server.modpackProvider) {
        throw new Error('Auf diesem Server ist kein Modpack installiert');
      }
      const info = await checkForUpdate(server);
      if (!info?.latest) throw new Error('Keine Versionen gefunden');
      if (!info.updateAvailable) return 'Bereits auf der neuesten Version';

      await runTask(server.id, 'modpack.update', async (task) => {
        await installModpack(
          server.id,
          {
            provider: server.modpackProvider as 'modrinth' | 'curseforge',
            projectId: server.modpackProjectId!,
            versionId: info.latest.id,
            backupFirst: true,
            keepConfig: false,
          },
          task,
        );
      }, true);
      return `Update auf ${info.latest.name} abgeschlossen`;
    }

    default:
      throw new Error(`Unbekannte Aktion: ${action}`);
  }
}

/**
 * Alte Backups *dieser* Regel aufräumen, wenn eine Obergrenze gesetzt ist.
 * Handgemachte, angeheftete und Sicherheits-Backups fasst sie nie an; ältere
 * automatische Sicherungen ohne Regelzuordnung zählen noch mit.
 */
export async function pruneBackups(serverId: string, automationId: string, keep: number | undefined): Promise<number> {
  if (!keep || keep < 1) return 0;

  const backups = await prisma.backup.findMany({
    where: {
      serverId,
      pinned: false,
      OR: [{ automationId }, { automationId: null, origin: 'AUTOMATIC' }],
    },
    orderBy: { createdAt: 'desc' },
  });
  const surplus = backups.slice(keep);
  if (surplus.length === 0) return 0;

  const { deleteBackup } = await import('./backups.js');
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) return 0;

  let removed = 0;
  for (const backup of surplus) {
    try {
      await deleteBackup(server, backup.id);
      removed++;
    } catch {
      /* eine fehlgeschlagene Löschung darf den Lauf nicht kippen */
    }
  }
  return removed;
}

async function finish(
  automation: Automation,
  status: RunStatus,
  message: string,
): Promise<{ status: RunStatus; message: string }> {
  await prisma.automation
    .update({
      where: { id: automation.id },
      data: {
        lastRunAt: new Date(),
        lastStatus: status,
        lastMessage: message.slice(0, 500),
        runCount: { increment: status === 'UEBERSPRUNGEN' ? 0 : 1 },
      },
    })
    .catch(() => {});

  emitToServer(automation.serverId, 'automation', {
    id: automation.id,
    status,
    message,
    lastRunAt: new Date().toISOString(),
  });

  return { status, message };
}

// ---------------------------------------------------------------------------
// Zeitgeber
// ---------------------------------------------------------------------------

/** Zuletzt gesehener Zustand je Server – für die Absturzerkennung. */
const lastSeen = new Map<string, { running: boolean; finishedAt: string | null }>();
/** Zeitpunkte erkannter Abstürze je Server – für die Absturzschleifen-Bremse. */
const crashLog = new Map<string, number[]>();
/** Verhindert Doppelläufe innerhalb derselben Minute. */
const lastMinuteRun = new Map<string, string>();
/** Regeln, die gerade laufen – ein langes Backup wird nicht erneut angestoßen. */
const inFlight = new Set<string>();
/** Je Server eine Kette: Regeln desselben Servers laufen nacheinander. */
const serverChains = new Map<string, Promise<void>>();

const CRASH_WINDOW_MS = 10 * 60_000;
const CRASH_LIMIT = 3;

let timer: NodeJS.Timeout | null = null;
let ticking = false;

const minuteKey = (date: Date) =>
  `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;

/**
 * Erkennt einen Absturz seit der letzten Prüfung. Neben dem Wechsel
 * „lief → Fehler“ zählt auch ein neues Laufende mit Fehler – so fällt auch ein
 * Server auf, der zwischen zwei Prüfungen gestartet und gleich wieder
 * abgestürzt ist.
 */
export function detectCrash(
  previous: { running: boolean; finishedAt: string | null } | undefined,
  current: { state: string; finishedAt?: string | null },
  plannedStop: boolean,
): boolean {
  if (!previous || current.state !== 'error' || plannedStop) return false;
  const newRunEnded = Boolean(current.finishedAt) && current.finishedAt !== previous.finishedAt;
  return previous.running || newRunEnded;
}

/** Vermerkt den Absturz und sagt, ob der Server in einer Absturzschleife hängt. */
export function recordCrash(serverId: string, now = Date.now()): boolean {
  const recent = (crashLog.get(serverId) ?? []).filter((at) => now - at < CRASH_WINDOW_MS);
  recent.push(now);
  crashLog.set(serverId, recent);
  return recent.length > CRASH_LIMIT;
}

function enqueue(automation: Automation, origin: 'zeitplan' | 'ereignis', log: (msg: string) => void): void {
  if (inFlight.has(automation.id)) {
    log(`Automatisierung "${automation.name}": läuft noch – dieser Termin entfällt`);
    return;
  }
  inFlight.add(automation.id);
  const previous = serverChains.get(automation.serverId) ?? Promise.resolve();
  const next = previous.then(async () => {
    try {
      const result = await runAutomation(automation, origin);
      log(`Automatisierung "${automation.name}": ${result.status} – ${result.message}`);
    } catch (err) {
      log(`Automatisierung "${automation.name}" fehlgeschlagen: ${err instanceof Error ? err.message : err}`);
    } finally {
      inFlight.delete(automation.id);
    }
  });
  serverChains.set(automation.serverId, next);
  void next.finally(() => {
    if (serverChains.get(automation.serverId) === next) serverChains.delete(automation.serverId);
  });
}

async function tick(log: (msg: string) => void): Promise<void> {
  // Ein langsamer Docker-Daemon darf keine überlappenden Prüfungen auslösen.
  if (ticking) return;
  ticking = true;
  try {
    const now = new Date();
    const key = minuteKey(now);

    const automations = await prisma.automation.findMany({ where: { enabled: true } });
    if (automations.length === 0) return;

    // Absturzerkennung: Zustand je betroffenem Server einmal abfragen, parallel.
    const crashServers = [...new Set(
      automations.filter((a) => a.trigger === 'ON_CRASH').map((a) => a.serverId),
    )];
    const crashed = new Set<string>();
    const looping = new Set<string>();

    await Promise.all(crashServers.map(async (serverId) => {
      try {
        const server = await prisma.server.findUnique({ where: { id: serverId } });
        if (!server) return;
        const current = await dockerSvc.getState(server);
        const isRunning = current.state === 'running' || current.state === 'starting';
        if (detectCrash(lastSeen.get(serverId), current, dockerSvc.wasPlannedStop(serverId))) {
          crashed.add(serverId);
          if (recordCrash(serverId)) {
            looping.add(serverId);
            log(`Server ${server.name} stürzt wiederholt ab – automatischer Neustart pausiert`);
            void notify('automation.failed', {
              serverId,
              serverName: server.name,
              title: `${server.name} stürzt wiederholt ab`,
              message: `Mehr als ${CRASH_LIMIT} Abstürze in ${CRASH_WINDOW_MS / 60_000} Minuten – Start/Neustart durch Automatisierungen wird ausgesetzt. Bitte Protokoll prüfen und den Server von Hand starten.`,
              fields: [],
            });
          }
        }
        lastSeen.set(serverId, { running: isRunning, finishedAt: current.finishedAt ?? null });
      } catch (err) {
        log(`Absturzprüfung für ${serverId} fehlgeschlagen: ${err instanceof Error ? err.message : err}`);
      }
    }));

    for (const automation of automations) {
      let due = false;

      if (automation.trigger === 'SCHEDULE' && automation.cron) {
        try {
          due = matchesCron(parseCron(automation.cron), now);
        } catch {
          due = false;
        }
        if (due && lastMinuteRun.get(automation.id) === key) due = false;
      } else if (automation.trigger === 'ON_CRASH') {
        due = crashed.has(automation.serverId);
        if (due && looping.has(automation.serverId) && (automation.action === 'RESTART' || automation.action === 'START')) {
          void finish(automation, 'UEBERSPRUNGEN', 'Absturzschleife erkannt – automatischer Start ausgesetzt');
          due = false;
        }
      }

      if (!due) continue;

      lastMinuteRun.set(automation.id, key);
      enqueue(automation, automation.trigger === 'SCHEDULE' ? 'zeitplan' : 'ereignis', log);
    }
  } finally {
    ticking = false;
  }
}

/**
 * Startet den Zeitgeber. Er prüft alle 20 Sekunden; ein Cron-Ausdruck kann
 * dadurch innerhalb seiner Minute nicht zweimal auslösen (siehe lastMinuteRun).
 */
export function startScheduler(log: (msg: string) => void): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick(log).catch((err) => log(`Automatisierung fehlgeschlagen: ${err}`));
  }, 20_000);
  log('Automatisierungen aktiv (Prüfung alle 20 Sekunden)');
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
