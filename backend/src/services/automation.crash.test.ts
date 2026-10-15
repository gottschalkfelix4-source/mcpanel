import { describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ prisma: {} }));
vi.mock('../auth/context.js', () => ({ audit: vi.fn(), getServerAccess: vi.fn() }));
vi.mock('./docker.js', () => ({ getState: vi.fn() }));
vi.mock('./rcon.js', () => ({ rconCommand: vi.fn() }));
vi.mock('./backups.js', () => ({ createBackup: vi.fn() }));
vi.mock('./modpack.js', () => ({ checkForUpdate: vi.fn(), installModpack: vi.fn() }));
vi.mock('./tasks.js', () => ({ runTask: vi.fn() }));
vi.mock('../ws/io.js', () => ({ emitToServer: vi.fn() }));
vi.mock('./notify.js', () => ({ notify: vi.fn() }));

import { detectCrash, recordCrash, warnText } from './automation.js';

describe('warnText', () => {
  it.each([
    ['RESTART', 300, 'say Server-Neustart in 5 Minuten'],
    ['RESTART', 60, 'say Server-Neustart in 1 Minute'],
    ['STOP', 90, 'say Server-Herunterfahren in 90 Sekunden'],
    ['STOP', 1, 'say Server-Herunterfahren in 1 Sekunde'],
  ] as const)('%s mit %i s → „%s“', (action, left, text) => {
    expect(warnText(action, left)).toBe(text);
  });
});

describe('detectCrash', () => {
  const running = { running: true, finishedAt: '2026-10-15T10:00:00Z' };

  it('meldet den Wechsel von „läuft“ auf „Fehler“', () => {
    expect(detectCrash(running, { state: 'error', finishedAt: '2026-10-15T11:00:00Z' }, false)).toBe(true);
  });

  it('ignoriert geplante Stopps und sauber beendete Server', () => {
    expect(detectCrash(running, { state: 'error', finishedAt: '2026-10-15T11:00:00Z' }, true)).toBe(false);
    expect(detectCrash(running, { state: 'stopped', finishedAt: '2026-10-15T11:00:00Z' }, false)).toBe(false);
  });

  it('erkennt einen Absturz zwischen zwei Prüfungen am neuen Laufende', () => {
    const stopped = { running: false, finishedAt: '2026-10-15T10:00:00Z' };
    expect(detectCrash(stopped, { state: 'error', finishedAt: '2026-10-15T10:05:00Z' }, false)).toBe(true);
    // Derselbe alte Fehlerzustand zählt nicht noch einmal.
    expect(detectCrash(stopped, { state: 'error', finishedAt: '2026-10-15T10:00:00Z' }, false)).toBe(false);
  });

  it('meldet beim ersten Blick auf einen Server nichts', () => {
    expect(detectCrash(undefined, { state: 'error', finishedAt: '2026-10-15T10:00:00Z' }, false)).toBe(false);
  });
});

describe('recordCrash', () => {
  it('meldet eine Absturzschleife erst nach mehreren Abstürzen im Zeitfenster', () => {
    const start = Date.UTC(2026, 9, 15, 12);
    const results = Array.from({ length: 6 }, (_, i) => recordCrash('schleife', start + i * 1000));
    expect(results[0]).toBe(false);
    expect(results.at(-1)).toBe(true);
  });

  it('vergisst alte Abstürze außerhalb des Zeitfensters', () => {
    const start = Date.UTC(2026, 9, 15, 12);
    for (let i = 0; i < 6; i++) recordCrash('alt', start + i * 1000);
    expect(recordCrash('alt', start + 24 * 60 * 60 * 1000)).toBe(false);
  });

  it('zählt Server getrennt', () => {
    const start = Date.UTC(2026, 9, 15, 12);
    for (let i = 0; i < 6; i++) recordCrash('a', start + i);
    expect(recordCrash('b', start + 10)).toBe(false);
  });
});
