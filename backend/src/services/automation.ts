import { withServerOperation } from './operations.js';
import type { Automation, Server } from '@prisma/client';
import { prisma } from '../db.js';
import { audit } from '../auth/context.js';
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
): Promise<{ status: RunStatus; message: string }> {
  const server = await prisma.server.findUnique({ where: { id: automation.serverId } });
  if (!server) return finish(automation, 'FEHLER', 'Server existiert nicht mehr');

  const config = (automation.config ?? {}) as AutomationConfig;

  try {
    const { state } = await dockerSvc.getState(server);
    const running = state === 'running';

    if (automation.onlyWhenRunning && !running) {
      return finish(automation, 'UEBERSPRUNGEN', 'Server läuft nicht – Aktion ausgelassen');
    }

    const message = await withServerOperation(server.id, 'Automatisierung', () => execute(automation.action as ActionType, server, config, running));
    await audit(automation.createdById, server.id, `automation.${automation.action.toLowerCase()}`,
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
  action: ActionType,
  server: Server,
  config: AutomationConfig,
  running: boolean,
): Promise<string> {
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
      });
      const removed = await pruneBackups(server.id, config.keepBackups);
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

/** Alte automatische Backups aufräumen, wenn eine Obergrenze gesetzt ist. */
async function pruneBackups(serverId: string, keep: number | undefined): Promise<number> {
  if (!keep || keep < 1) return 0;

  const backups = await prisma.backup.findMany({
    where: { serverId },
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

/** Letzte gesehene Laufzeit je Server – für die Absturzerkennung. */
const wasRunning = new Map<string, boolean>();
/** Verhindert Doppelläufe innerhalb derselben Minute. */
const lastMinuteRun = new Map<string, string>();

let timer: NodeJS.Timeout | null = null;

const minuteKey = (date: Date) =>
  `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;

async function tick(log: (msg: string) => void): Promise<void> {
  const now = new Date();
  const key = minuteKey(now);

  const automations = await prisma.automation.findMany({ where: { enabled: true } });
  if (automations.length === 0) return;

  // Absturzerkennung: Zustand je betroffenem Server einmal abfragen.
  const crashServers = new Set(
    automations.filter((a) => a.trigger === 'ON_CRASH').map((a) => a.serverId),
  );
  const crashed = new Set<string>();

  for (const serverId of crashServers) {
    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server) continue;
    const { state } = await dockerSvc.getState(server);
    const isRunning = state === 'running' || state === 'starting';
    if (wasRunning.get(serverId) && state === 'error' && !dockerSvc.wasPlannedStop(serverId)) crashed.add(serverId);
    wasRunning.set(serverId, isRunning);
  }

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
    }

    if (!due) continue;

    lastMinuteRun.set(automation.id, key);
    const result = await runAutomation(
      automation,
      automation.trigger === 'SCHEDULE' ? 'zeitplan' : 'ereignis',
    );
    log(`Automatisierung "${automation.name}": ${result.status} – ${result.message}`);
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
