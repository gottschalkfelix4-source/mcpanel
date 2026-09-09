import net from 'node:net';
import type { Server } from '@prisma/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeRconConnections, listPlayers, rconCommand, RconClient } from './rcon.js';

const server = { containerName: 'mc-test', rconPassword: 'secret', type: 'MODPACK', extraEnv: {} } as Server;
const playerReply = 'There are 1 of a max of 20 players online: Felix';
let listener: net.Server;
let port: number;
let connections: number;
let commands: string[];
let sockets: Set<net.Socket>;
let respond: (socket: net.Socket, id: number, command: string) => void;

function reply(socket: net.Socket, id: number, type: number, body: string) {
  const payload = Buffer.from(body);
  const packet = Buffer.alloc(payload.length + 14);
  packet.writeInt32LE(payload.length + 10, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  payload.copy(packet, 12);
  socket.write(packet);
}

beforeEach(async () => {
  connections = 0;
  commands = [];
  sockets = new Set();
  respond = (socket, id, command) => reply(socket, id, 0, command === 'list' ? playerReply : `OK ${command}`);
  listener = net.createServer(socket => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readInt32LE(0) + 4) {
        const length = buffer.readInt32LE(0) + 4;
        const packet = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        const id = packet.readInt32LE(4);
        const body = packet.subarray(12, length - 2).toString();
        if (packet.readInt32LE(8) === 3) {
          reply(socket, body === 'secret' ? id : -1, 2, '');
        } else {
          commands.push(body);
          respond(socket, id, body);
        }
      }
    });
  });
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  port = (listener.address() as net.AddressInfo).port;
  const connect = net.createConnection;
  vi.spyOn(net, 'createConnection').mockImplementation(() => connect({ host: '127.0.0.1', port }));
});

afterEach(async () => {
  closeRconConnections();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => listener.close(() => resolve()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('reuses one authenticated connection for sequential and concurrent commands', async () => {
  expect(await rconCommand(server, 'say hello')).toBe('OK say hello');
  expect(await Promise.all(['one', 'two', 'three'].map(cmd => rconCommand(server, cmd))))
    .toEqual(['OK one', 'OK two', 'OK three']);
  expect(connections).toBe(1);
  expect(commands).toEqual(['say hello', 'one', 'two', 'three']);
});

it('shares concurrent player requests and refreshes the short cache on the same connection', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const results = await Promise.all(Array.from({ length: 8 }, () => listPlayers(server)));
  expect(commands).toEqual(['list']);
  results[0].players.push('Changed');
  expect((await listPlayers(server)).players).toEqual(['Felix']);
  expect(commands).toEqual(['list']);
  now.mockReturnValue(4001);
  await listPlayers(server);
  expect(commands).toEqual(['list', 'list']);
  expect(connections).toBe(1);
});

it('invalidates cached players after a console command', async () => {
  await listPlayers(server);
  await rconCommand(server, 'kick Felix');
  await listPlayers(server);
  expect(commands).toEqual(['list', 'kick Felix', 'list']);
  expect(connections).toBe(1);
});

it('reconnects after the server closes the connection and discards cached players', async () => {
  await listPlayers(server);
  for (const socket of sockets) socket.destroy();
  await vi.waitFor(() => expect(sockets.size).toBe(0));
  await listPlayers(server);
  expect(connections).toBe(2);
  expect(commands).toEqual(['list', 'list']);
});

it('does not replay a command when its response is lost, and recovers on the next request', async () => {
  respond = socket => socket.destroy();
  await expect(rconCommand(server, 'give Felix diamond')).rejects.toThrow('geschlossen');
  expect(commands).toEqual(['give Felix diamond']);
  respond = (socket, id) => reply(socket, id, 0, playerReply);
  expect((await listPlayers(server)).players).toEqual(['Felix']);
  expect(connections).toBe(2);
});

it('replaces a connection when its credentials change and recovers after authentication failure', async () => {
  await listPlayers(server);
  await expect(listPlayers({ ...server, rconPassword: 'wrong' })).rejects.toThrow('Passwort falsch');
  await listPlayers(server);
  expect(connections).toBe(3);
  expect(commands).toEqual(['list', 'list']);
});

it('keeps servers isolated', async () => {
  await Promise.all([listPlayers(server), listPlayers({ ...server, containerName: 'mc-other' })]);
  expect(connections).toBe(2);
  expect(commands).toEqual(['list', 'list']);
});

it('closes idle connections and reconnects on demand', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await listPlayers(server);
  await vi.advanceTimersByTimeAsync(60_000);
  vi.useRealTimers();
  await listPlayers(server);
  expect(connections).toBe(2);
});

it('does not cache an invalid player response', async () => {
  respond = (socket, id) => reply(socket, id, 0, 'Unknown command');
  await expect(listPlayers(server)).rejects.toThrow('Spielerliste');
  respond = (socket, id) => reply(socket, id, 0, playerReply);
  expect((await listPlayers(server)).players).toEqual(['Felix']);
  expect(commands).toEqual(['list', 'list']);
  expect(connections).toBe(1);
});

it('discards the socket after a command timeout', async () => {
  const client = new RconClient('127.0.0.1', port, 'secret', 50);
  await client.connect();
  respond = () => {};
  await expect(client.command('save-all')).rejects.toThrow('Timeout');
  await expect(client.command('list')).rejects.toThrow('nicht verbunden');
  expect(commands).toEqual(['save-all']);
});

it('rejects a connection closed before authentication rather than hanging', async () => {
  listener.removeAllListeners('connection');
  listener.on('connection', socket => socket.destroy());
  await expect(rconCommand(server, 'list')).rejects.toThrow();
});

it('rejects pending connection attempts when the pool is shut down', async () => {
  const request = rconCommand(server, 'list');
  const assertion = expect(request).rejects.toThrow('geschlossen');
  closeRconConnections();
  await assertion;
});

it('can recover from a synchronous socket creation error', async () => {
  vi.mocked(net.createConnection).mockImplementationOnce(() => { throw new Error('connect failed'); });
  await expect(listPlayers(server)).rejects.toThrow('connect failed');
  expect((await listPlayers(server)).players).toEqual(['Felix']);
});

it('does not reuse a player query queued before a player-changing command', async () => {
  const before = listPlayers(server);
  const kick = rconCommand(server, 'kick Felix');
  const after = listPlayers(server);
  await Promise.all([before, kick, after]);
  expect(commands).toEqual(['list', 'kick Felix', 'list']);
  expect(connections).toBe(1);
});
