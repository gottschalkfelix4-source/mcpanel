import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ rcon: vi.fn(), stdin: vi.fn(), notDelivered: vi.fn() }));
vi.mock('./rcon.js', () => ({ rconCommand: m.rcon, rconNotDelivered: m.notDelivered }));
vi.mock('./docker.js', () => ({ writeStdin: m.stdin }));

import { sendServerCommand } from './consoleCommand.js';

const server = { id: 'a', containerName: 'mc-a' } as any;

beforeEach(() => {
  vi.clearAllMocks();
  m.stdin.mockResolvedValue(undefined);
});

it('schickt Befehle über RCON und gibt die Antwort zurück', async () => {
  m.rcon.mockResolvedValue('There are 0 of a max of 20 players online');
  expect(await sendServerCommand(server, 'list')).toEqual({ via: 'rcon', response: 'There are 0 of a max of 20 players online' });
  expect(m.stdin).not.toHaveBeenCalled();
});

it('weicht nur auf stdin aus, wenn RCON den Befehl sicher nicht zugestellt hat', async () => {
  m.rcon.mockRejectedValue(new Error('ECONNREFUSED'));
  m.notDelivered.mockReturnValue(true);
  expect(await sendServerCommand(server, 'say hallo')).toEqual({ via: 'stdin', response: '' });
  expect(m.stdin).toHaveBeenCalledWith(server, 'say hallo');
});

it('wiederholt nach einem Timeout nicht – der Befehl könnte schon gelaufen sein', async () => {
  m.rcon.mockRejectedValue(new Error('Timeout'));
  m.notDelivered.mockReturnValue(false);
  await expect(sendServerCommand(server, 'stop')).rejects.toMatchObject({ statusCode: 400 });
  expect(m.stdin).not.toHaveBeenCalled();
});
