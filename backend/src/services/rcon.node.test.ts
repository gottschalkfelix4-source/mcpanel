import net from 'node:net';
import type { Server } from '@prisma/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  port: 0,
  listContainers: vi.fn(),
}));
vi.mock('../lib/serverLocation.js', () => ({
  nodeIdOf: () => 'node-1',
  nodeLocation: () => ({ id: 'node-1', tunnelIp: '127.0.0.1', agentToken: 't'.repeat(43), ports: { rcon: mocks.port } }),
}));
vi.mock('./nodeClients.js', () => ({ rawNodeDocker: () => ({ listContainers: mocks.listContainers }) }));

import { closeRconConnections, rconCommand } from './rcon.js';

const containerId = 'a'.repeat(64);
// Der Docker-Name folgt dem Anzeigenamen; „mc-node-test“ ist nur der Alias im Netz.
const server = { id: 'srv-1', containerName: 'mc-node-test', rconPassword: 'secret', type: 'FABRIC', extraEnv: {} } as unknown as Server;
let listener: net.Server;
let preambles: string[];

function reply(socket: net.Socket, id: number, body: string) {
  const payload = Buffer.from(body);
  const packet = Buffer.alloc(payload.length + 14);
  packet.writeInt32LE(payload.length + 10, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(0, 8);
  payload.copy(packet, 12);
  socket.write(packet);
}

beforeEach(async () => {
  preambles = [];
  mocks.listContainers.mockReset();
  // Agent-Attrappe: erste Zeile merken, danach jedes RCON-Paket mit seinem Befehl beantworten.
  listener = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let preambleSeen = false;
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!preambleSeen) {
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        preambles.push(buffer.subarray(0, end + 1).toString('utf8'));
        buffer = buffer.subarray(end + 1);
        preambleSeen = true;
      }
      while (buffer.length >= 4 && buffer.length >= buffer.readInt32LE(0) + 4) {
        const length = buffer.readInt32LE(0) + 4;
        const packet = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        reply(socket, packet.readInt32LE(4), `OK ${packet.subarray(12, packet.length - 2).toString('utf8')}`);
      }
    });
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  mocks.port = (listener.address() as net.AddressInfo).port;
});

afterEach(async () => {
  closeRconConnections();
  await new Promise<void>((resolve) => listener.close(() => resolve()));
});

it('nennt dem Agenten die Container-ID aus dem Panel-Label statt des Netz-Alias', async () => {
  mocks.listContainers.mockResolvedValue([{ Id: containerId }]);
  await expect(rconCommand(server, 'tick query')).resolves.toBe('OK tick query');
  expect(mocks.listContainers).toHaveBeenCalledWith({ filters: { label: ['mcpanel.server=srv-1'] } });
  expect(preambles).toEqual([`MCPANEL-RCON ${'t'.repeat(43)} ${containerId}\n`]);
});

it('meldet einen nicht laufenden Container, ohne den Agenten zu fragen', async () => {
  mocks.listContainers.mockResolvedValue([]);
  await expect(rconCommand(server, 'list')).rejects.toThrow('Der Container läuft auf der Node nicht');
  expect(preambles).toEqual([]);
});
