import type { Server } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Spielerstatistik: aus wiederholten Spielerlisten entstehen Aufenthalte, und
 * die Auswertung rechnet Spielzeit und Verlauf im gewählten Zeitraum.
 */
const m = vi.hoisted(() => ({
  state: 'running',
  players: [] as string[] | Error,
  rows: [] as any[],
  samples: [] as any[],
}));

vi.mock('../db.js', () => ({ prisma: {
  playerSession: {
    create: vi.fn(async ({ data }: any) => {
      const row = { id: `s${m.rows.length + 1}`, leftAt: null, ...data };
      m.rows.push(row);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      for (const row of m.rows) if (where.id.in.includes(row.id)) Object.assign(row, data);
      return { count: where.id.in.length };
    }),
    findMany: vi.fn(async () => m.rows),
  },
  playerCountSample: {
    create: vi.fn(async ({ data }: any) => { m.samples.push(data); return data; }),
    findMany: vi.fn(async () => m.samples),
  },
} }));
vi.mock('./docker.js', () => ({ getState: vi.fn(async () => ({ state: m.state })) }));
vi.mock('./rcon.js', () => ({
  listPlayers: vi.fn(async () => {
    if (m.players instanceof Error) throw m.players;
    return { online: m.players.length, max: 20, players: m.players };
  }),
}));

const { pollServer, getPlayerStats } = await import('./playerStats.js');

const server = { id: 'srv', name: 'Test' } as Server;
const t = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 12, minutes));

beforeEach(() => {
  m.state = 'running';
  m.players = [];
  m.rows = [];
  m.samples = [];
});

describe('Aufenthalte aus Spielerlisten', () => {
  it('beginnt, verlängert und beendet Aufenthalte', async () => {
    m.players = ['Alex'];
    await pollServer(server, t(0), true);
    m.players = ['Alex', 'Steve'];
    await pollServer(server, t(1));
    m.players = ['Steve'];
    await pollServer(server, t(2), true);

    const alex = m.rows.find((r) => r.name === 'Alex');
    const steve = m.rows.find((r) => r.name === 'Steve');
    expect(alex).toMatchObject({ joinedAt: t(0), leftAt: t(2) });
    expect(steve).toMatchObject({ joinedAt: t(1), lastSeenAt: t(2), leftAt: null });
    expect(m.rows).toHaveLength(2);
    expect(m.samples.map((s) => s.count)).toEqual([1, 1]);
  });

  it('beendet keine Aufenthalte, wenn RCON nicht antwortet', async () => {
    m.players = ['Alex'];
    await pollServer(server, t(10));
    m.players = new Error('RCON nicht bereit');
    await pollServer(server, t(11));
    expect(m.rows.find((r) => r.name === 'Alex')?.leftAt).toBeNull();
  });

  it('beendet alle Aufenthalte, sobald der Server nicht mehr läuft', async () => {
    m.players = ['Alex', 'Steve'];
    await pollServer(server, t(20));
    m.state = 'exited';
    await pollServer(server, t(25));
    expect(m.rows.every((r) => r.leftAt?.getTime() === t(25).getTime())).toBe(true);
  });
});

describe('Auswertung', () => {
  it('summiert Spielzeit je Spieler und schneidet am Zeitraum ab', async () => {
    const now = new Date(Date.UTC(2026, 9, 8, 12, 0));
    const day = 24 * 3600_000;
    m.rows = [
      // Begann vor dem Zeitraum (7 Tage): nur die Stunde danach zählt.
      { name: 'Alex', joinedAt: new Date(now.getTime() - 7 * day - 3600_000), lastSeenAt: new Date(now.getTime() - 7 * day + 3600_000), leftAt: new Date(now.getTime() - 7 * day + 3600_000) },
      { name: 'Alex', joinedAt: new Date(now.getTime() - 2 * 3600_000), lastSeenAt: new Date(now.getTime() - 3600_000), leftAt: new Date(now.getTime() - 3600_000) },
      // Noch online: zählt bis zur letzten Sichtung.
      { name: 'Steve', joinedAt: new Date(now.getTime() - 1800_000), lastSeenAt: new Date(now.getTime() - 60_000), leftAt: null },
    ];
    m.samples = [
      { at: new Date(now.getTime() - 3600_000), count: 1 },
      { at: new Date(now.getTime() - 3600_000 + 60_000), count: 3 },
      { at: new Date(now.getTime() - 60_000), count: 1 },
    ];
    const stats = await getPlayerStats('srv', 7, now);
    expect(stats.players).toEqual([
      expect.objectContaining({ name: 'Alex', totalSeconds: 2 * 3600, sessions: 2, online: false }),
      expect.objectContaining({ name: 'Steve', totalSeconds: 1740, sessions: 1, online: true }),
    ]);
    expect(stats.uniquePlayers).toBe(2);
    expect(stats.totalSeconds).toBe(2 * 3600 + 1740);
    expect(stats.peak.count).toBe(3);
    // Zwei Messungen im selben Abschnitt: Mittelwert 2, Höchstwert 3.
    expect(stats.timeline[0]).toMatchObject({ count: 2, max: 3 });
    expect(stats.timeline.length).toBeLessThanOrEqual(300);
  });
});
