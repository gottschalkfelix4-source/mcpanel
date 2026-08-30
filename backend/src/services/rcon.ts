import net from 'node:net';
import type { Server } from '@prisma/client';

const TYPE_AUTH = 3;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_COMMAND = 2;
const TYPE_RESPONSE = 0;

/**
 * Minimaler RCON-Client (Source RCON Protocol).
 * Verbindet sich über das Docker-Netzwerk direkt mit dem Container.
 */
export class RconClient {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();

  constructor(
    private host: string,
    private port: number,
    private password: string,
    private timeoutMs = 8000,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      this.socket = socket;

      const onError = (err: Error) => {
        this.cleanup(err);
        reject(err);
      };

      socket.setTimeout(this.timeoutMs, () => onError(new Error('RCON Timeout')));
      socket.once('error', onError);
      socket.on('data', (d) => this.onData(d));
      socket.on('close', () => this.cleanup(new Error('RCON Verbindung geschlossen')));

      socket.once('connect', () => {
        socket.setTimeout(0);
        socket.removeListener('error', onError);
        socket.on('error', (e) => this.cleanup(e));
        this.send(TYPE_AUTH, this.password)
          .then(() => resolve())
          .catch(reject);
      });
    });
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readInt32LE(0);
      if (this.buffer.length < size + 4) break;
      const packet = this.buffer.subarray(4, size + 4);
      this.buffer = this.buffer.subarray(size + 4);

      const id = packet.readInt32LE(0);
      const type = packet.readInt32LE(4);
      const body = packet.subarray(8, packet.length - 2).toString('utf8');

      if (id === -1) {
        for (const p of this.pending.values()) p.reject(new Error('RCON: Passwort falsch'));
        this.pending.clear();
        continue;
      }
      const waiter = this.pending.get(id);
      if (waiter && (type === TYPE_RESPONSE || type === TYPE_AUTH_RESPONSE)) {
        this.pending.delete(id);
        waiter.resolve(body);
      }
    }
  }

  private send(type: number, body: string): Promise<string> {
    if (!this.socket) return Promise.reject(new Error('RCON nicht verbunden'));
    const id = this.nextId++;
    const payload = Buffer.from(body, 'utf8');
    const packet = Buffer.alloc(payload.length + 14);
    packet.writeInt32LE(payload.length + 10, 0);
    packet.writeInt32LE(id, 4);
    packet.writeInt32LE(type, 8);
    payload.copy(packet, 12);
    packet.writeInt16LE(0, payload.length + 12);

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('RCON Timeout'));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket!.write(packet);
    });
  }

  command(cmd: string): Promise<string> {
    return this.send(TYPE_COMMAND, cmd);
  }

  private cleanup(err: Error) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }

  close() {
    this.cleanup(new Error('geschlossen'));
  }
}

/** Einmalige RCON-Verbindung: Befehl senden, Antwort zurückgeben. */
export async function rconCommand(server: Server, command: string): Promise<string> {
  const client = new RconClient(server.containerName, 25575, server.rconPassword);
  try {
    await client.connect();
    return await client.command(command);
  } finally {
    client.close();
  }
}

export interface PlayerList {
  online: number;
  max: number;
  players: string[];
}

/** `list`-Ausgabe des Servers parsen. */
export async function listPlayers(server: Server): Promise<PlayerList> {
  const raw = await rconCommand(server, 'list');
  const clean = raw.replace(/§./g, '').trim();
  const m = clean.match(/(\d+)\s*(?:of a max(?:imum)? of|\/)\s*(\d+)/i);
  const online = m ? Number(m[1]) : 0;
  const max = m ? Number(m[2]) : 0;
  const idx = clean.indexOf(':');
  const namePart = idx >= 0 ? clean.slice(idx + 1) : '';
  const players = namePart
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { online, max, players };
}
