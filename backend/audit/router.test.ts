/** Uses the official mc-router binary, real TCP sockets and synthetic Minecraft backends.
 * MC_ROUTER_BIN=/absolute/path/mc-router npx vitest run audit/router.test.ts
 */
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const binary = process.env.MC_ROUTER_BIN;
const listen = (server: net.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
function varint(value: number): Buffer { const out: number[] = []; do { let b = value & 127; value >>>= 7; if (value) b |= 128; out.push(b); } while (value); return Buffer.from(out); }
function handshake(host: string, state: number): Buffer {
  const name = Buffer.from(host);
  const body = Buffer.concat([varint(0), varint(765), varint(name.length), name, Buffer.from([0x63, 0xdd]), varint(state)]);
  return Buffer.concat([varint(body.length), body]);
}

describe.skipIf(!binary)('official mc-router / TCP routing', () => {
  let root: string, router: ChildProcess, port: number, first: number, second: number;
  let logs = '';
  const backends: net.Server[] = [];
  const clients = new Set<net.Socket>();
  async function writeRoutes(mapping: Record<string, string>) {
    await fs.writeFile(path.join(root, 'routes.tmp'), JSON.stringify({ mappings: mapping }));
    await fs.rename(path.join(root, 'routes.tmp'), path.join(root, 'routes.json'));
    if (router && router.exitCode === null) router.kill('SIGHUP');
  }
  async function connect(host: string, state = 1): Promise<string> {
    return new Promise(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      clients.add(socket);
      let data = '';
      const done = () => { clients.delete(socket); socket.destroy(); resolve(data); };
      socket.setTimeout(1500, done);
      socket.once('connect', () => {
        socket.write(handshake(host, state));
        if (state === 2) {
          const name = Buffer.from('AuditPlayer');
          const login = Buffer.concat([varint(0), varint(name.length), name, Buffer.alloc(16)]);
          socket.write(Buffer.concat([varint(login.length), login]));
        }
      });
      socket.on('data', chunk => { data += chunk.toString(); done(); });
      socket.once('error', done); socket.once('end', done);
    });
  }
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-router-'));
    for (const name of ['first', 'second']) {
      const server = net.createServer(socket => { clients.add(socket); socket.once('data', () => socket.end(name)); socket.once('close', () => clients.delete(socket)); });
      backends.push(server);
    }
    first = await listen(backends[0]); second = await listen(backends[1]);
    const reservation = net.createServer(); port = await listen(reservation); await new Promise<void>(resolve => reservation.close(() => resolve()));
    await writeRoutes({ 'one.example.test': `127.0.0.1:${first}`, 'alias.example.test': `127.0.0.1:${first}`, 'two.example.test': `127.0.0.1:${second}` });
    router = spawn(binary!, ['-port', String(port), '-routes-config', path.join(root, 'routes.json'), '-connection-rate-limit', '100']);
    router.stderr?.on('data', data => { logs += data; }); router.stdout?.on('data', data => { logs += data; });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await connect('one.example.test') === 'first') return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Router failed to start: ${logs}`);
  });
  afterAll(async () => {
    for (const socket of clients) socket.destroy();
    if (router && router.exitCode === null) {
      const exited = new Promise(resolve => router.once('exit', resolve)); router.kill('SIGTERM'); await exited;
    }
    await Promise.all(backends.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  it('routes two subdomains and an alias on the same port', async () => {
    expect(await Promise.all([connect('one.example.test'), connect('two.example.test'), connect('alias.example.test')])).toEqual(['first', 'second', 'first']);
  });
  it('routes login handshakes, including Forge hostname suffixes', async () => {
    expect(await connect('two.example.test', 2)).toBe('second');
    expect(await connect('one.example.test\0FML2\0', 2)).toBe('first');
  });
  it('refuses unknown names without a default backend', async () => {
    expect(await connect('unknown.example.test')).not.toMatch(/first|second/);
  });
  it('reloads atomic file replacements and removes deleted aliases', async () => {
    await writeRoutes({ 'one.example.test': `127.0.0.1:${second}` });
    let result = '';
    for (let attempt = 0; attempt < 40; attempt++) {
      result = await connect('one.example.test');
      if (result === 'second') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(result, logs.slice(-2000)).toBe('second');
    expect(await connect('alias.example.test')).not.toMatch(/first|second/);
  });
});
