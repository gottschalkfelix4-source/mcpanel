import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  lookup: vi.fn(),
  channels: [] as any[],
  members: [] as any[],
  channelUpdate: vi.fn(),
  memberUpdate: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({ default: { lookup: m.lookup } }));
vi.mock('./settings.js', () => ({
  getSetting: async (key: string) => m.settings.get(key) ?? null,
  setSetting: async (key: string, value: string) => { m.settings.set(key, value); },
}));
vi.mock('../db.js', () => ({ prisma: {
  notificationChannel: { findMany: async () => m.channels, update: m.channelUpdate },
  serverMember: { findMany: async () => m.members, update: m.memberUpdate },
  backup: { updateMany: async () => ({ count: 0 }) },
} }));

import { runDataMigrations, targetsPrivateNetwork } from './migrations.js';

beforeEach(() => {
  vi.clearAllMocks();
  m.settings.clear();
  m.channels = [];
  m.members = [];
  m.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

describe('targetsPrivateNetwork', () => {
  it.each(['http://192.168.188.129:8123/x', 'http://localhost/', 'http://nas.lan/', 'http://ha.home.arpa/', 'http://[::1]/'])(
    'erkennt %s als lokales Ziel', async (target) => {
      m.lookup.mockImplementation(async (host: string) => [{ address: host === 'localhost' ? '127.0.0.1' : host }]);
      expect(await targetsPrivateNetwork(target)).toBe(true);
    },
  );

  it('löst Namen auf und erkennt öffentliche Ziele', async () => {
    expect(await targetsPrivateNetwork('https://discord.com/api/webhooks/1')).toBe(false);
    m.lookup.mockResolvedValue([{ address: '10.0.0.4', family: 4 }]);
    expect(await targetsPrivateNetwork('https://intern.example.org/hook')).toBe(true);
  });

  it('eine kaputte Adresse gilt nicht als lokal', async () => {
    expect(await targetsPrivateNetwork('kein url')).toBe(false);
  });
});

describe('runDataMigrations', () => {
  it('erlaubt bestehenden LAN-Webhooks und globalen Kanälen weiter das lokale Netz – genau einmal', async () => {
    m.lookup.mockImplementation(async (host: string) => [{ address: host }]);
    m.channels = [
      { id: 'lan', serverId: 'a', target: 'http://192.168.1.5/hook' },
      { id: 'discord', serverId: 'a', target: 'https://1.1.1.1/hook' },
      { id: 'global', serverId: null, target: 'https://1.1.1.1/hook' },
    ];
    const log = vi.fn();
    await runDataMigrations(log);
    expect(m.channelUpdate.mock.calls.map(([arg]) => arg.where.id)).toEqual(['lan', 'global']);

    m.channelUpdate.mockClear();
    await runDataMigrations(log);
    expect(m.channelUpdate).not.toHaveBeenCalled();
  });

  it('gibt Mitgliedern mit Einspielrecht das neue Download-Recht', async () => {
    m.members = [
      { id: 'mit', permissions: ['backup.restore'] },
      { id: 'schon', permissions: ['backup.restore', 'backup.download'] },
    ];
    await runDataMigrations(vi.fn());
    expect(m.memberUpdate).toHaveBeenCalledTimes(1);
    expect(m.memberUpdate.mock.calls[0][0]).toEqual({
      where: { id: 'mit' }, data: { permissions: ['backup.restore', 'backup.download'] },
    });
  });
});
