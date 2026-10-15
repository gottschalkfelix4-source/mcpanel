import { describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ prisma: {} }));
vi.mock('../config.js', () => ({ config: { dataRoot: '/data' } }));
vi.mock('./diskUsage.js', () => ({ computeDiskUsage: vi.fn(), getDiskUsage: vi.fn() }));

import { chooseBackupsToPrune } from './quota.js';

const at = (day: number) => new Date(Date.UTC(2026, 9, day));
const backups = [
  { id: 'hand-alt', origin: 'MANUAL', pinned: false, createdAt: at(1) },
  { id: 'auto-alt', origin: 'AUTOMATIC', pinned: false, createdAt: at(2) },
  { id: 'sicher', origin: 'SAFETY', pinned: false, createdAt: at(3) },
  { id: 'auto-neu', origin: 'AUTOMATIC', pinned: false, createdAt: at(4) },
  { id: 'angeheftet', origin: 'AUTOMATIC', pinned: true, createdAt: at(0) },
];

describe('chooseBackupsToPrune', () => {
  it('räumt erst automatische, dann Sicherheitskopien, zuletzt manuelle ab – jeweils die ältesten', () => {
    expect(chooseBackupsToPrune(backups, 4).map((b) => b.id)).toEqual(['auto-alt']);
    expect(chooseBackupsToPrune(backups, 2).map((b) => b.id)).toEqual(['auto-alt', 'auto-neu', 'sicher']);
    expect(chooseBackupsToPrune(backups, 1).map((b) => b.id)).toEqual(['auto-alt', 'auto-neu', 'sicher', 'hand-alt']);
  });

  it('löscht nie angeheftete oder geschützte Sicherungen, auch wenn das Kontingent dann überschritten bleibt', () => {
    const chosen = chooseBackupsToPrune(backups, 1, new Set(['auto-neu'])).map((b) => b.id);
    expect(chosen).not.toContain('angeheftet');
    expect(chosen).not.toContain('auto-neu');
    expect(chosen).toEqual(['auto-alt', 'sicher', 'hand-alt']);
  });

  it('tut nichts ohne Grenze oder unterhalb der Grenze', () => {
    expect(chooseBackupsToPrune(backups, 0)).toEqual([]);
    expect(chooseBackupsToPrune(backups, 5)).toEqual([]);
    expect(chooseBackupsToPrune(backups, 10)).toEqual([]);
  });
});
