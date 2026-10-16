import type { Server } from '@prisma/client';
import { prisma } from '../db.js';
import * as dockerSvc from './docker.js';
import { listPlayers } from './rcon.js';

/**
 * Spielerstatistik: fragt laufende Server jede Minute nach ihrer Spielerliste,
 * führt daraus Aufenthalte (PlayerSession) und legt alle fünf Minuten die
 * Spielerzahl ab (PlayerCountSample). Die Konsole fragt nur, solange jemand
 * zuschaut – für einen Verlauf braucht es diesen eigenen, sparsamen Takt.
 */
const POLL_MS = 60_000;
const SAMPLE_EVERY = 5;
export const RETENTION_DAYS = 90;

/** Offene Aufenthalte je Server: Spielername → Session-ID. */
const open = new Map<string, Map<string, string>>();
let tick = 0;
let timer: NodeJS.Timeout | null = null;

async function closeAll(serverId: string, at: Date) {
  const sessions = open.get(serverId);
  if (!sessions?.size) return;
  await prisma.playerSession.updateMany({ where: { id: { in: [...sessions.values()] } }, data: { leftAt: at } });
  sessions.clear();
}

/** Ein Abfragedurchlauf für einen Server; exportiert für Tests. */
export async function pollServer(server: Server, now = new Date(), sample = false): Promise<void> {
  const { state } = await dockerSvc.getState(server);
  if (state !== 'running') {
    await closeAll(server.id, now);
    return;
  }
  let players: string[];
  try {
    players = (await listPlayers(server)).players;
  } catch {
    // RCON noch nicht bereit oder Antwort unlesbar: lieber nichts ändern als
    // Aufenthalte fälschlich beenden. lastSeenAt bleibt auf dem letzten Stand.
    return;
  }
  let sessions = open.get(server.id);
  if (!sessions) open.set(server.id, (sessions = new Map()));

  const current = new Set(players);
  const gone = [...sessions.entries()].filter(([name]) => !current.has(name));
  if (gone.length) {
    await prisma.playerSession.updateMany({ where: { id: { in: gone.map(([, id]) => id) } }, data: { leftAt: now, lastSeenAt: now } });
    for (const [name] of gone) sessions.delete(name);
  }
  const stillOnline = [...sessions.values()];
  if (stillOnline.length) await prisma.playerSession.updateMany({ where: { id: { in: stillOnline } }, data: { lastSeenAt: now } });
  for (const name of players) {
    if (sessions.has(name)) continue;
    const row = await prisma.playerSession.create({ data: { serverId: server.id, name, joinedAt: now, lastSeenAt: now } });
    sessions.set(name, row.id);
  }
  if (sample) await prisma.playerCountSample.create({ data: { serverId: server.id, at: now, count: players.length } });
}

async function pollAll(log: (msg: string) => void) {
  tick += 1;
  const sample = tick % SAMPLE_EVERY === 1;
  const servers = await prisma.server.findMany();
  for (const id of open.keys()) if (!servers.some((s) => s.id === id)) open.delete(id);
  for (const server of servers) {
    await pollServer(server, new Date(), sample).catch((err) =>
      log(`Spielerstatistik für ${server.name}: ${err instanceof Error ? err.message : err}`),
    );
  }
  // Einmal am Tag alte Daten entfernen.
  if (tick % (24 * 60) === 1) await pruneStats().catch(() => {});
}

export async function pruneStats(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600_000);
  await prisma.playerCountSample.deleteMany({ where: { at: { lt: cutoff } } });
  await prisma.playerSession.deleteMany({ where: { leftAt: { lt: cutoff } } });
}

export async function startPlayerStats(log: (msg: string) => void): Promise<void> {
  if (timer) return;
  // Aufenthalte aus dem letzten Lauf enden dort, wo der Spieler zuletzt
  // gesehen wurde – nicht beim Neustart des Panels Stunden später.
  await prisma.$executeRaw`UPDATE "PlayerSession" SET "leftAt" = "lastSeenAt" WHERE "leftAt" IS NULL`;
  const run = () => void pollAll(log).catch((err) => log(`Spielerstatistik: ${err instanceof Error ? err.message : err}`));
  run();
  timer = setInterval(run, POLL_MS);
  timer.unref();
}

export interface PlayerStats {
  days: number;
  timeline: { at: string; count: number; max: number }[];
  players: { name: string; totalSeconds: number; sessions: number; lastSeen: string; online: boolean }[];
  peak: { count: number; at: string | null };
  uniquePlayers: number;
  totalSeconds: number;
}

/** Auswertung für die Oberfläche: Verlauf (verdichtet) und Spielzeit je Spieler. */
export async function getPlayerStats(serverId: string, days: number, now = new Date()): Promise<PlayerStats> {
  const since = new Date(now.getTime() - days * 24 * 3600_000);
  const [samples, sessions] = await Promise.all([
    prisma.playerCountSample.findMany({ where: { serverId, at: { gte: since } }, orderBy: { at: 'asc' }, select: { at: true, count: true } }),
    prisma.playerSession.findMany({
      where: { serverId, joinedAt: { lt: now }, OR: [{ leftAt: null }, { leftAt: { gt: since } }] },
      select: { name: true, joinedAt: true, leftAt: true, lastSeenAt: true },
    }),
  ]);

  // Auf höchstens ~300 Punkte verdichten: Mittelwert und Höchstwert je Abschnitt.
  const bucketMs = Math.max(5 * 60_000, Math.ceil((days * 24 * 3600_000) / 300));
  const buckets = new Map<number, { sum: number; n: number; max: number }>();
  let peak = { count: 0, at: null as string | null };
  for (const s of samples) {
    const key = Math.floor(s.at.getTime() / bucketMs) * bucketMs;
    const b = buckets.get(key) ?? { sum: 0, n: 0, max: 0 };
    b.sum += s.count; b.n += 1; b.max = Math.max(b.max, s.count);
    buckets.set(key, b);
    if (s.count > peak.count) peak = { count: s.count, at: s.at.toISOString() };
  }
  const timeline = [...buckets.entries()].map(([at, b]) => ({
    at: new Date(at).toISOString(), count: Math.round((b.sum / b.n) * 10) / 10, max: b.max,
  }));

  const perPlayer = new Map<string, { totalSeconds: number; sessions: number; lastSeen: number; online: boolean }>();
  for (const s of sessions) {
    const start = Math.max(s.joinedAt.getTime(), since.getTime());
    const end = Math.min((s.leftAt ?? s.lastSeenAt).getTime(), now.getTime());
    const entry = perPlayer.get(s.name) ?? { totalSeconds: 0, sessions: 0, lastSeen: 0, online: false };
    entry.totalSeconds += Math.max(0, Math.round((end - start) / 1000));
    entry.sessions += 1;
    entry.lastSeen = Math.max(entry.lastSeen, (s.leftAt ?? s.lastSeenAt).getTime());
    if (!s.leftAt) entry.online = true;
    perPlayer.set(s.name, entry);
  }
  const players = [...perPlayer.entries()]
    .map(([name, p]) => ({ name, totalSeconds: p.totalSeconds, sessions: p.sessions, lastSeen: new Date(p.lastSeen).toISOString(), online: p.online }))
    .sort((a, b) => b.totalSeconds - a.totalSeconds)
    .slice(0, 200);

  return {
    days,
    timeline,
    players,
    peak,
    uniquePlayers: perPlayer.size,
    totalSeconds: players.reduce((sum, p) => sum + p.totalSeconds, 0),
  };
}
