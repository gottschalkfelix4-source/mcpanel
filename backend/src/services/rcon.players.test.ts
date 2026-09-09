import type { Server } from '@prisma/client';
import { afterEach, expect, it, vi } from 'vitest';
import { listPlayers, parsePlayerList, RconClient } from './rcon.js';
afterEach(() => vi.restoreAllMocks());
it.each([
  ['There are 2 of a max of 20 players online: Felix, Alex', { online: 2, max: 20, players: ['Felix', 'Alex'] }],
  ['There are 0 of a max of 20 players online:', { online: 0, max: 20, players: [] }],
  ['§aThere are §e1 of a maximum of 20 players online: §rFelix', { online: 1, max: 20, players: ['Felix'] }],
  ['Es sind 1 von maximal 20 Spielern online: Felix', { online: 1, max: 20, players: ['Felix'] }],
])('parses joins and departures from %s', (raw, expected) => expect(parsePlayerList(raw)).toEqual(expected));
it.each(['', 'Unknown command', 'There are 2 of a max of 20 players online: Felix', 'There are 1 of a max of 20 players online: [Admin] Felix'])('does not silently report an empty server for invalid output %s', raw => {
  expect(() => parsePlayerList(raw)).toThrow('Spielerliste');
});
it.each([['PAPER', 'minecraft:list'], ['MODPACK', 'list'], ['VANILLA', 'list']] as const)('queries %s with the supported list command', async (type, command) => {
  vi.spyOn(RconClient.prototype, 'connect').mockResolvedValue();
  const send = vi.spyOn(RconClient.prototype, 'command').mockResolvedValue('There are 1 of a max of 20 players online: Felix');
  const close = vi.spyOn(RconClient.prototype, 'close').mockImplementation(() => {});
  expect(await listPlayers({ type, containerName: 'mc-id', rconPassword: 'test', extraEnv: {} } as Server)).toMatchObject({ players: ['Felix'] });
  expect(send).toHaveBeenCalledWith(command);
  expect(close).toHaveBeenCalledOnce();
});
