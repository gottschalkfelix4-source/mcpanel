/**
 * Benachrichtigungen: schickt Ereignisse an Discord-Webhooks oder beliebige
 * HTTP-Ziele.
 *
 * Ein Kanal gehört entweder zu einem Server (serverId gesetzt) oder gilt
 * global (serverId = null). Jeder Kanal abonniert einzelne Ereignisse.
 *
 * Der Wächter am Ende der Datei pollt alle Server unabhängig davon, ob gerade
 * jemand im Panel zuschaut – sonst bliebe ein nächtlicher Absturz stumm.
 */
import type { NotificationChannel } from '@prisma/client';
import fs from 'node:fs/promises';
import { prisma } from '../db.js';
import { contentDir } from './content.js';
import { analyseCrash } from './crashAnalysis.js';
import * as dockerSvc from './docker.js';
import { getSetting, setSetting } from './settings.js';

// ---------------------------------------------------------------------------
// Ereignisse
// ---------------------------------------------------------------------------

export const EVENTS = [
  'server.started',
  'server.stopped',
  'server.crashed',
  'automation.ok',
  'automation.failed',
  'backup.done',
  'backup.failed',
  'modpack.update',
  'disk.low',
] as const;

export type NotifyEvent = (typeof EVENTS)[number];

export const EVENT_LABELS: Record<NotifyEvent, string> = {
  'server.started': 'Server gestartet',
  'server.stopped': 'Server gestoppt',
  'server.crashed': 'Server abgestürzt',
  'automation.ok': 'Automatisierung ausgeführt',
  'automation.failed': 'Automatisierung fehlgeschlagen',
  'backup.done': 'Backup erstellt',
  'backup.failed': 'Backup fehlgeschlagen',
  'modpack.update': 'Modpack-Update verfügbar',
  'disk.low': 'Speicherplatz knapp',
};

/** Was beim Anlegen eines Kanals vorausgewählt ist: nur die Störungen. */
export const DEFAULT_EVENTS: NotifyEvent[] = [
  'server.crashed',
  'automation.failed',
  'backup.failed',
  'disk.low',
];

export type Severity = 'info' | 'erfolg' | 'warnung' | 'fehler';

const COLORS: Record<Severity, number> = {
  info: 0x6b7280,
  erfolg: 0x5aa02c,
  warnung: 0xd08a2a,
  fehler: 0xd1453b,
};

const SEVERITY_OF: Record<NotifyEvent, Severity> = {
  'server.started': 'erfolg',
  'server.stopped': 'info',
  'server.crashed': 'fehler',
  'automation.ok': 'erfolg',
  'automation.failed': 'fehler',
  'backup.done': 'erfolg',
  'backup.failed': 'fehler',
  'modpack.update': 'info',
  'disk.low': 'warnung',
};

export interface NotifyContext {
  serverId?: string | null;
  serverName?: string | null;
  title: string;
  message: string;
  fields?: { name: string; value: string }[];
}

// ---------------------------------------------------------------------------
// Ratenbegrenzung
// ---------------------------------------------------------------------------

const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 3;

interface RateEntry {
  windowStart: number;
  sent: number;
  suppressed: number;
}

const rates = new Map<string, RateEntry>();

/**
 * Lässt höchstens RATE_MAX Meldungen je Kanal/Ereignis/Server im Zeitfenster
 * durch. Eine Absturzschleife erzeugt sonst hundert Discord-Nachrichten.
 * Unterdrückte Meldungen werden gezählt und beim nächsten Durchlass als
 * Nachsatz mitgeschickt.
 */
function rateCheck(key: string): { allowed: boolean; suppressed: number } {
  const now = Date.now();
  const entry = rates.get(key);

  if (!entry) {
    rates.set(key, { windowStart: now, sent: 1, suppressed: 0 });
    return { allowed: true, suppressed: 0 };
  }

  if (now - entry.windowStart > RATE_WINDOW_MS) {
    const suppressed = entry.suppressed;
    rates.set(key, { windowStart: now, sent: 1, suppressed: 0 });
    return { allowed: true, suppressed };
  }

  if (entry.sent < RATE_MAX) {
    entry.sent++;
    const suppressed = entry.suppressed;
    entry.suppressed = 0;
    return { allowed: true, suppressed };
  }

  entry.suppressed++;
  return { allowed: false, suppressed: 0 };
}

// ---------------------------------------------------------------------------
// Zustellung
// ---------------------------------------------------------------------------

function discordPayload(ctx: NotifyContext, severity: Severity, extra: string | null) {
  const fields = (ctx.fields ?? []).slice(0, 6).map((f) => ({
    name: f.name.slice(0, 240),
    value: (f.value || '–').slice(0, 1000),
    inline: true,
  }));

  return {
    username: 'MCPanel',
    embeds: [
      {
        title: ctx.title.slice(0, 240),
        description: [ctx.message, extra].filter(Boolean).join('\n\n').slice(0, 3800),
        color: COLORS[severity],
        fields,
        footer: { text: ctx.serverName ? `MCPanel · ${ctx.serverName}` : 'MCPanel' },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

function webhookPayload(event: NotifyEvent, ctx: NotifyContext, severity: Severity, extra: string | null) {
  return {
    event,
    label: EVENT_LABELS[event],
    severity,
    server: ctx.serverId ? { id: ctx.serverId, name: ctx.serverName ?? null } : null,
    title: ctx.title,
    message: ctx.message,
    note: extra,
    fields: ctx.fields ?? [],
    timestamp: new Date().toISOString(),
  };
}

/** Einmalige HTTP-Zustellung mit Zeitlimit. */
async function post(url: string, body: unknown): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`.trim());
    }
  } finally {
    clearTimeout(timeout);
  }
}

function payloadFor(
  channel: NotificationChannel,
  event: NotifyEvent,
  ctx: NotifyContext,
  severity: Severity,
  extra: string | null,
) {
  return channel.type === 'DISCORD'
    ? discordPayload(ctx, severity, extra)
    : webhookPayload(event, ctx, severity, extra);
}

async function deliver(
  channel: NotificationChannel,
  event: NotifyEvent,
  ctx: NotifyContext,
): Promise<void> {
  const severity = SEVERITY_OF[event];
  const key = `${channel.id}:${event}:${ctx.serverId ?? 'global'}`;
  const { allowed, suppressed } = rateCheck(key);
  if (!allowed) return;

  const extra =
    suppressed > 0
      ? `Hinweis: ${suppressed} weitere Meldungen dieser Art wurden in den letzten 10 Minuten unterdrückt.`
      : null;

  try {
    await post(channel.target, payloadFor(channel, event, ctx, severity, extra));
    await prisma.notificationChannel
      .update({
        where: { id: channel.id },
        data: {
          lastSentAt: new Date(),
          lastStatus: 'OK',
          lastMessage: EVENT_LABELS[event],
          sentCount: { increment: 1 },
        },
      })
      .catch(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.notificationChannel
      .update({
        where: { id: channel.id },
        data: { lastSentAt: new Date(), lastStatus: 'FEHLER', lastMessage: message.slice(0, 300) },
      })
      .catch(() => {});
  }
}

/**
 * Meldet ein Ereignis an alle passenden Kanäle. Wirft nie – eine kaputte
 * Webhook-URL darf keinen Serverstart und kein Backup kippen.
 */
export async function notify(event: NotifyEvent, ctx: NotifyContext): Promise<void> {
  try {
    const channels = await prisma.notificationChannel.findMany({
      where: {
        enabled: true,
        OR: [{ serverId: null }, ...(ctx.serverId ? [{ serverId: ctx.serverId }] : [])],
      },
    });

    const matching = channels.filter((c) => {
      const events = Array.isArray(c.events) ? (c.events as string[]) : [];
      return events.includes(event);
    });

    await Promise.all(matching.map((c) => deliver(c, event, ctx)));
  } catch {
    /* Benachrichtigungen sind Beiwerk – Fehler enden hier */
  }
}

/** Testnachricht für den Knopf in der Oberfläche. Wirft bei Fehlern. */
export async function testChannel(channel: NotificationChannel): Promise<void> {
  const events = Array.isArray(channel.events) ? (channel.events as string[]) : [];
  const ctx: NotifyContext = {
    serverId: channel.serverId,
    serverName: null,
    title: 'Testnachricht aus dem MCPanel',
    message: `Der Kanal „${channel.name}" ist richtig eingerichtet.`,
    fields: [{ name: 'Abonnierte Ereignisse', value: String(events.length) }],
  };

  await post(channel.target, payloadFor(channel, 'server.started', ctx, 'info', null));

  await prisma.notificationChannel
    .update({
      where: { id: channel.id },
      data: { lastSentAt: new Date(), lastStatus: 'OK', lastMessage: 'Testnachricht' },
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Wächter: Zustandswechsel und Modpack-Updates
// ---------------------------------------------------------------------------

/** Zuletzt gesehener Zustand je Server. */
const lastState = new Map<string, string>();
/** Erst nach dem ersten Durchlauf wird gemeldet – sonst käme beim Panel-Start
 *  für jeden laufenden Server eine Nachricht. */
let seeded = false;
/** Geplante Stopps (Panel, Automatisierung, Neuaufbau) – das ist kein Absturz. */
const planned = new Map<string, number>();

const PLANNED_WINDOW_MS = 3 * 60 * 1000;

/** Wird von docker.ts gerufen, bevor ein Container absichtlich anhält. */
export function markPlannedStop(serverId: string): void {
  planned.set(serverId, Date.now());
}

function wasPlanned(serverId: string): boolean {
  const at = planned.get(serverId);
  return Boolean(at && Date.now() - at < PLANNED_WINDOW_MS);
}

const MODPACK_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
let lastModpackCheck = 0;

const DISK_CHECK_EVERY_MS = 15 * 60 * 1000;
const DISK_WARN_PERCENT = 90;
let lastDiskCheck = 0;
/** Wer schon gewarnt wurde – erst nach Entspannung wieder melden. */
const diskWarned = new Set<string>();

/**
 * Meldet Server, deren Speicherkontingent zur Neige geht. Ohne Kontingent
 * gibt es keine sinnvolle Grenze, deshalb bleiben solche Server hier aussen
 * vor – für sie greift checkVolumeSpace().
 */
async function checkDiskQuota(): Promise<void> {
  if (Date.now() - lastDiskCheck < DISK_CHECK_EVERY_MS) return;
  lastDiskCheck = Date.now();

  const servers = await prisma.server.findMany({ where: { quotaDiskMb: { gt: 0 } } });
  if (servers.length === 0) return;

  const { quotaState } = await import('./quota.js');

  for (const server of servers) {
    const quota = await quotaState(server);
    if (quota.diskPercent === null) continue;

    if (quota.diskPercent < DISK_WARN_PERCENT) {
      // Wieder Luft: beim naechsten Anstieg darf erneut gewarnt werden.
      diskWarned.delete(server.id);
      continue;
    }
    if (diskWarned.has(server.id)) continue;
    diskWarned.add(server.id);

    const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    await notify('disk.low', {
      serverId: server.id,
      serverName: server.name,
      title: `${server.name}: Speicher wird knapp`,
      message:
        `${quota.diskPercent} % des Kontingents sind belegt. Neue Sicherungen und Uploads ` +
        'werden abgelehnt, sobald die Grenze erreicht ist.',
      fields: [
        { name: 'Belegt', value: gb(quota.diskUsedBytes) },
        { name: 'Kontingent', value: gb(quota.diskLimitBytes) },
        { name: 'Sicherungen', value: String(quota.backupCount) },
      ],
    });
  }
}

const VOLUME_CHECK_EVERY_MS = 15 * 60 * 1000;
/** Wie beim Kontingent: erst nach Entspannung wieder melden. */
let volumeWarned = false;
let lastVolumeCheck = 0;

/**
 * Meldet, wenn der Datenträger des Datenverzeichnisses zur Neige geht. Das
 * betrifft alle Installationen, auch die im Auslieferungszustand ohne jedes
 * Kontingent – und trifft härter als eine erschöpfte Serverzuteilung, weil auf
 * demselben Datenträger die Datenbank des Panels liegt.
 */
async function checkVolumeSpace(): Promise<void> {
  if (Date.now() - lastVolumeCheck < VOLUME_CHECK_EVERY_MS) return;
  lastVolumeCheck = Date.now();

  const { volumeSpace } = await import('./quota.js');
  const space = await volumeSpace();
  if (!space) return;

  if (!space.low) {
    volumeWarned = false;
    return;
  }
  if (volumeWarned) return;
  volumeWarned = true;

  const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  await notify('disk.low', {
    serverId: null,
    serverName: null,
    title: 'Datenträger wird knapp',
    message:
      `Nur noch ${gb(space.freeBytes)} von ${gb(space.totalBytes)} sind frei, ` +
      `${gb(space.usedBytes)} sind belegt (${space.usedPercent} %). Dort liegen ` +
      'Serverdaten, Sicherungen und die Datenbank des Panels: ist der Datenträger ' +
      'voll, brechen Sicherungen mitten im Archiv ab und das Panel selbst fällt aus.',
    fields: [
      { name: 'Frei', value: gb(space.freeBytes) },
      { name: 'Belegt', value: gb(space.usedBytes) },
      { name: 'Gesamt', value: gb(space.totalBytes) },
    ],
  });
}

/**
 * Räumt Docker-Rahmenbytes und ANSI-Sequenzen aus einem Log-Ausschnitt.
 *
 * `tailLogs` schneidet mitten in den Stream, deshalb greift die Entrahmung in
 * docker.ts dort nicht immer – in einer Discord-Nachricht sieht das sonst aus
 * wie `>....[K[23:00:08 INFO]`.
 */
function cleanLog(text: string): string {
  // Steuerzeichen bewusst ueber charCodeAt statt ueber ein Regex-Literal:
  // rohe Steuerbytes im Quelltext ueberleben kein Werkzeug unbeschadet.
  const ansi = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[A-Za-z]', 'g');

  return text
    .split('\n')
    .map((line) => {
      let out = '';
      for (const ch of line.replace(ansi, '')) {
        const code = ch.charCodeAt(0);
        if (code >= 32 && code !== 127) out += ch;
      }
      // Rest eines Rahmenkopfes vor dem Zeitstempel abschneiden
      return out.replace(/^[^[]*(?=\[\d{2}:\d{2}:\d{2})/, '');
    })
    .filter((line) => line.trim().length > 0)
    .join('\n');
}

async function checkStates(): Promise<void> {
  const servers = await prisma.server.findMany();

  for (const server of servers) {
    const { state } = await dockerSvc.getState(server);
    // Ein Server, der nach dem ersten Durchlauf neu auftaucht, wurde gerade
    // angelegt – er startet aus dem Nichts, nicht aus "unbekannt".
    const previous = lastState.has(server.id)
      ? lastState.get(server.id)
      : seeded
        ? 'missing'
        : undefined;
    lastState.set(server.id, state);

    // Erster Durchlauf nach dem Panel-Start: nur merken, nicht melden.
    if (previous === undefined || previous === state) continue;

    const wasUp = previous === 'running' || previous === 'starting';
    const isUp = state === 'running' || state === 'starting';

    if (!wasUp && isUp) {
      // Läuft wieder: eine alte Stopp-Markierung darf einen späteren Absturz
      // nicht mehr als „war so gewollt" durchgehen lassen.
      planned.delete(server.id);
      await notify('server.started', {
        serverId: server.id,
        serverName: server.name,
        title: `${server.name} läuft`,
        message: 'Der Server ist gestartet und nimmt Verbindungen an.',
      });
      continue;
    }

    if (wasUp && state === 'error' && !wasPlanned(server.id)) {
      // Ausfuehrlicher lesen als frueher: der Stacktrace, der die schuldige
      // Mod nennt, steht oft weit mehr als 15 Zeilen ueber dem Ende.
      const log = await dockerSvc.tailLogs(server, 200).catch(() => '');
      const tail = cleanLog(log).trim().slice(-1200);

      const inhaltsOrdner = contentDir(server);
      const diagnose = inhaltsOrdner
        ? analyseCrash(log, await fs.readdir(inhaltsOrdner).catch(() => [] as string[]))
        : null;
      const schuld = diagnose?.suspect
        ? [
            `**${diagnose.headline}**`,
            `Verdächtig: \`${diagnose.suspect.filename ?? diagnose.suspect.reference}\``,
            diagnose.reason,
            'Im Panel lässt sie sich mit einem Schalter abschalten.',
            '',
          ].join('\n')
        : '';

      await notify('server.crashed', {
        serverId: server.id,
        serverName: server.name,
        title: `${server.name} ist abgestürzt`,
        message:
          schuld +
          (tail
            ? ['Letzte Zeilen aus dem Protokoll:', '```', tail, '```'].join('\n')
            : 'Der Container hat sich unerwartet beendet.'),
      });
    }

    if (wasUp && !isUp) {
      await notify('server.stopped', {
        serverId: server.id,
        serverName: server.name,
        title: `${server.name} wurde gestoppt`,
        message: wasPlanned(server.id)
          ? 'Der Server wurde über das Panel heruntergefahren.'
          : 'Der Server ist nicht mehr aktiv.',
      });
    }
  }

  seeded = true;
}

async function checkModpackUpdates(): Promise<void> {
  if (Date.now() - lastModpackCheck < MODPACK_CHECK_EVERY_MS) return;
  lastModpackCheck = Date.now();

  const servers = await prisma.server.findMany({ where: { NOT: { modpackProjectId: null } } });
  if (servers.length === 0) return;

  const { checkForUpdate } = await import('./modpack.js');

  for (const server of servers) {
    try {
      const info = await checkForUpdate(server);
      if (!info?.updateAvailable || !info.latest) continue;

      // Nicht bei jedem Panel-Start dieselbe Version erneut melden.
      const key = `notify.modpack.${server.id}`;
      if ((await getSetting(key, '')) === String(info.latest.id)) continue;
      await setSetting(key, String(info.latest.id));

      await notify('modpack.update', {
        serverId: server.id,
        serverName: server.name,
        title: `Update für ${server.modpackName ?? 'Modpack'}`,
        message: `Eine neuere Version steht bereit: ${info.latest.name}`,
        fields: [
          { name: 'Installiert', value: server.modpackVersionName ?? 'unbekannt' },
          { name: 'Verfügbar', value: String(info.latest.name) },
        ],
      });
    } catch {
      /* Anbieter nicht erreichbar – der nächste Durchlauf versucht es erneut */
    }
  }
}

let timer: NodeJS.Timeout | null = null;

export function startWatcher(log: (msg: string) => void): void {
  if (timer) return;
  dockerSvc.onPlannedStop(markPlannedStop);

  const run = async () => {
    await checkStates().catch((err) => log(`Zustandsprüfung fehlgeschlagen: ${err}`));
    await checkModpackUpdates().catch(() => {});
    await checkDiskQuota().catch(() => {});
    await checkVolumeSpace().catch(() => {});
  };

  void run();
  timer = setInterval(() => void run(), 20_000);
  log('Benachrichtigungen aktiv (Zustandsprüfung alle 20 Sekunden)');
}

export function stopWatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
