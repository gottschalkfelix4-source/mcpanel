import { beforeEach, expect, it, vi } from 'vitest';
import type { Server } from '@prisma/client';

const m = vi.hoisted(() => ({ state: vi.fn(), logs: vi.fn(), players: vi.fn() }));
vi.mock('./docker.js', () => ({ getState: m.state, tailLogs: m.logs }));
vi.mock('./rcon.js', () => ({ listPlayers: m.players }));
vi.mock('./content.js', () => ({ contentDir: () => null }));
const { waitForServerReady } = await import('./serverStartup.js');
const { hasFatalServerLog } = await import('./serverLog.js');
const server = { id: 'starttest', type: 'MODPACK' } as Server;

beforeEach(() => {
  vi.resetAllMocks();
  m.players.mockRejectedValue(new Error('Noch nicht erreichbar'));
  m.logs.mockResolvedValue('');
});

it('wartet auf einen erfolgreichen Minecraft-Healthcheck', async () => {
  m.state.mockResolvedValueOnce({ state: 'starting', health: 'starting' }).mockResolvedValue({ state: 'running', health: 'healthy' });
  const onWaiting = vi.fn();
  await waitForServerReady(server, { pollMs: 1, onWaiting });
  expect(m.state).toHaveBeenCalledTimes(2);
  expect(onWaiting).toHaveBeenCalledOnce();
});

it('akzeptiert eine echte RCON-Antwort bei fehlendem Healthcheck', async () => {
  m.state.mockResolvedValue({ state: 'running', health: null });
  m.players.mockResolvedValue({ online: 0, max: 20, players: [] });
  await waitForServerReady(server);
});

it('meldet einen beendeten oder abgestürzten Container als fehlgeschlagenen Start', async () => {
  m.state.mockResolvedValue({ state: 'error', health: null });
  await expect(waitForServerReady(server)).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('Start fehlgeschlagen') });
  expect(m.players).not.toHaveBeenCalled();
});

it('begrenzt die Startwartezeit und meldet ohne Minecraft-Antwort keinen Erfolg', async () => {
  m.state.mockResolvedValue({ state: 'starting', health: 'starting' });
  await expect(waitForServerReady(server, { timeoutMs: 0 })).rejects.toThrow('Startwartezeit');
});

it('unterscheidet fatale Startmeldungen von harmlosen Mod-Fehlern und dem Runner-Abschluss', () => {
  expect(hasFatalServerLog('Failed to start the minecraft server')).toBe(true);
  expect(hasFatalServerLog('Minecraft has crashed!')).toBe(true);
  expect(hasFatalServerLog('ERROR: No data fixer registered\nModpack Update Checker Error fetching online info\nmc-server-runner Done')).toBe(false);
});
