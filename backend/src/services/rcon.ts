import net from 'node:net';
import type { Server } from '@prisma/client';
import { nodeIdOf, nodeLocation } from '../lib/serverLocation.js';
import { rconPreamble } from '../node/protocol.js';
import { rawNodeDocker } from './nodeClients.js';

/** Label, mit dem das Panel seine Minecraft-Container markiert (wie `LABEL_SERVER` in docker.ts). */
const SERVER_LABEL = 'mcpanel.server';

/**
 * Wohin die RCON-Verbindung geht: lokal über das Docker-Netz an den
 * Containernamen (dort ein Alias im Netz). Auf einer Node an die
 * RCON-Weiterleitung des Agenten; die erste Zeile nennt Token und Container,
 * danach spricht man normales RCON. So muss kein Minecraft-Container seinen
 * RCON-Port veröffentlichen.
 */
export function rconTarget(server: Pick<Server, 'id' | 'containerName'>): { host: string; port: number; node?: { id: string; token: string } } {
  const nodeId = nodeIdOf(server.id);
  const node = nodeId ? nodeLocation(nodeId) : null;
  if (nodeId && !node) throw new Error(`Node ${nodeId} ist dem Panel nicht bekannt`);
  return node
    ? { host: node.tunnelIp, port: node.ports.rcon, node: { id: node.id, token: node.agentToken } }
    : { host: server.containerName, port: 25575 };
}

/**
 * Container eines Servers auf einer Node, als Docker-ID. Der Agent schlägt den
 * Container über die Docker-API nach – dort zählt der echte Containername,
 * und der folgt dem Anzeigenamen („Mein-Server“). `containerName` ist nur ein
 * Alias im Minecraft-Netz und würde dort nicht gefunden.
 */
async function nodeContainerId(nodeId: string, serverId: string): Promise<string> {
  const running = await rawNodeDocker(nodeId).listContainers({ filters: { label: [`${SERVER_LABEL}=${serverId}`] } });
  if (running.length === 0) throw new Error('Der Container läuft auf der Node nicht');
  return running[0].Id;
}

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
  private rejectConnect?: (error: Error) => void;
  private pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();

  constructor(
    private host: string,
    private port: number,
    private password: string,
    private timeoutMs = 8000,
    private onClose?: () => void,
    /** Erste Zeile für die RCON-Weiterleitung eines Node-Agenten (auch erst beim Verbinden ermittelt) */
    private preamble?: string | (() => Promise<string>),
  ) {}

  async connect(): Promise<void> {
    const preamble = typeof this.preamble === 'function' ? await this.preamble() : this.preamble;
    return new Promise((resolve, reject) => {
      this.rejectConnect = reject;
      const socket = net.createConnection({ host: this.host, port: this.port });
      this.socket = socket;

      const onError = (err: Error) => {
        this.cleanup(err);
        reject(err);
      };

      socket.setTimeout(this.timeoutMs, () => onError(new Error('RCON Timeout')));
      socket.once('error', onError);
      socket.on('data', (d) => this.onData(d));
      socket.on('close', () => onError(new Error('RCON Verbindung geschlossen')));

      socket.once('connect', () => {
        socket.setTimeout(0);
        socket.removeListener('error', onError);
        socket.on('error', (e) => this.cleanup(e));
        if (preamble) socket.write(preamble);
        this.send(TYPE_AUTH, this.password)
          .then(() => { this.rejectConnect = undefined; resolve(); })
          .catch(reject);
      });
    });
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readInt32LE(0);
      if (size < 10 || size > 4 * 1024 * 1024) {
        this.cleanup(new Error('RCON: Ungültige Paketgröße'));
        return;
      }
      if (this.buffer.length < size + 4) break;
      const packet = this.buffer.subarray(4, size + 4);
      this.buffer = this.buffer.subarray(size + 4);

      const id = packet.readInt32LE(0);
      const type = packet.readInt32LE(4);
      const body = packet.subarray(8, packet.length - 2).toString('utf8');

      if (id === -1) {
        this.cleanup(new Error('RCON: Passwort falsch'));
        return;
      }
      const waiter = this.pending.get(id);
      if (waiter && (type === TYPE_RESPONSE || type === TYPE_AUTH_RESPONSE)) {
        this.pending.delete(id);
        waiter.resolve(body);
      }
    }
  }

  private send(type: number, body: string, timeoutMs = this.timeoutMs): Promise<string> {
    if (!this.socket) return Promise.reject(notDelivered(new Error('RCON nicht verbunden')));
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
        // Nach einem Timeout ist unklar, ob der Befehl bereits ausgeführt wurde.
        // Verbindung verwerfen und den Befehl niemals automatisch wiederholen.
        this.cleanup(new Error('RCON Timeout'));
      }, timeoutMs);
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

  command(cmd: string, timeoutMs?: number): Promise<string> {
    return this.send(TYPE_COMMAND, cmd, timeoutMs);
  }

  private cleanup(err: Error) {
    this.rejectConnect?.(err);
    this.rejectConnect = undefined;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
      this.buffer = Buffer.alloc(0);
      this.onClose?.();
    }
  }

  close() {
    this.cleanup(new Error('geschlossen'));
  }
}

const IDLE_TIMEOUT_MS = 60_000;
const PLAYER_CACHE_MS = 3000;

interface Connection {
  client: RconClient;
  password: string;
  /** Ziel „host:port“ – ändert es sich (Umzug auf eine Node), wird neu verbunden. */
  target: string;
  ready: Promise<void>;
  tail: Promise<unknown>;
  pending: number;
  closed: boolean;
  playerRevision: number;
  idleTimer?: NodeJS.Timeout;
  players?: { command: string; value: PlayerList; expiresAt: number };
  playerRequest?: { command: string; promise: Promise<PlayerList> };
}

const connections = new Map<string, Connection>();

/**
 * Markiert Fehler, bei denen der Befehl den Server sicher nicht erreicht hat
 * (Verbindungsaufbau oder Anmeldung gescheitert). Nur dann darf ein Aufrufer
 * auf einen anderen Weg (stdin) ausweichen – nach einem Timeout ist der Befehl
 * womöglich schon ausgeführt.
 */
const NOT_DELIVERED = Symbol('rcon.notDelivered');
function notDelivered(error: unknown): Error {
  const err = error instanceof Error ? error : new Error(String(error));
  (err as Error & { [NOT_DELIVERED]?: boolean })[NOT_DELIVERED] = true;
  return err;
}
export function rconNotDelivered(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { [NOT_DELIVERED]?: boolean })[NOT_DELIVERED]);
}

function getConnection(server: Server): Connection {
  const key = server.containerName;
  const { host, port, node } = rconTarget(server);
  // Bei jedem Verbindungsaufbau neu nachschlagen: ein neu angelegter Container hat eine neue ID.
  const preamble = node
    ? async () => rconPreamble(node.token, await nodeContainerId(node.id, server.id))
    : undefined;
  const target = `${host}:${port}`;
  const existing = connections.get(key);
  if (existing?.password === server.rconPassword && existing.target === target) return existing;
  if (existing) {
    clearTimeout(existing.idleTimer);
    existing.client.close();
  }

  const discard = () => {
    entry.closed = true;
    clearTimeout(entry.idleTimer);
    if (connections.get(key) === entry) connections.delete(key);
  };
  const client = new RconClient(host, port, server.rconPassword, 8000, discard, preamble);
  const entry: Connection = {
    client, password: server.rconPassword, target,
    ready: client.connect().catch(error => {
      discard();
      client.close();
      throw error;
    }),
    tail: Promise.resolve(), pending: 0, closed: false, playerRevision: 0,
  };
  connections.set(key, entry);
  return entry;
}

function sendCommand(entry: Connection, command: string, timeoutMs?: number): Promise<string> {
  clearTimeout(entry.idleTimer);
  entry.pending++;
  // Eine gemeinsame Verbindung, auch bei gleichzeitigen API-/Live-Abfragen.
  const result = entry.tail.then(async () => {
    try {
      await entry.ready;
    } catch (error) {
      throw notDelivered(error);
    }
    if (entry.closed) throw notDelivered(new Error('RCON nicht verbunden'));
    return timeoutMs === undefined ? entry.client.command(command) : entry.client.command(command, timeoutMs);
  });
  entry.tail = result.catch(() => {});
  return result.catch(error => {
    entry.client.close();
    throw error;
  }).finally(() => {
    if (--entry.pending === 0 && !entry.closed) {
      entry.idleTimer = setTimeout(() => entry.client.close(), IDLE_TIMEOUT_MS);
      entry.idleTimer.unref();
    }
  });
}

/**
 * `save-all flush` antwortet erst, wenn jeder Chunk auf der Platte liegt –
 * bei großen Welten oder während einer Vorgenerierung dauert das deutlich
 * länger als die üblichen 8 s.
 */
export const SAVE_FLUSH_TIMEOUT_MS = 180_000;

/** Befehle teilen eine Verbindung pro Server; keine Wiederholung bei Fehlern. */
export function rconCommand(server: Server, command: string, options: { timeoutMs?: number } = {}): Promise<string> {
  const entry = getConnection(server);
  entry.players = undefined;
  entry.playerRequest = undefined;
  entry.playerRevision++;
  return sendCommand(entry, command, options.timeoutMs);
}

/** Verbindung eines Servers schließen – etwa nach einem Umzug auf eine andere Node. */
export function closeRconConnection(server: Pick<Server, 'containerName'>): void {
  const entry = connections.get(server.containerName);
  if (!entry) return;
  clearTimeout(entry.idleTimer);
  entry.client.close();
  connections.delete(server.containerName);
}

export function closeRconConnections(): void {
  for (const entry of connections.values()) {
    clearTimeout(entry.idleTimer);
    entry.client.close();
  }
  connections.clear();
}

export interface PlayerList {
  online: number;
  max: number;
  players: string[];
}

/** `list`-Ausgabe des Servers parsen. */
export async function listPlayers(server: Server): Promise<PlayerList> {
  // Bukkit plugins may override /list with a formatted/custom command.
  const extra = (server.extraEnv ?? {}) as Record<string, string>;
  const loader = (extra.TYPE || server.type).toUpperCase();
  const command = ['PAPER', 'PURPUR', 'SPIGOT'].includes(loader) ? 'minecraft:list' : 'list';
  const entry = getConnection(server);
  if (entry.players?.command === command && entry.players.expiresAt > Date.now()) {
    return { ...entry.players.value, players: [...entry.players.value.players] };
  }
  let request = entry.playerRequest;
  if (!request || request.command !== command) {
    const revision = entry.playerRevision;
    const promise = sendCommand(entry, command).then(raw => {
      const value = parsePlayerList(raw);
      if (entry.playerRevision === revision) {
        entry.players = { command, value, expiresAt: Date.now() + PLAYER_CACHE_MS };
      }
      return value;
    });
    request = { command, promise };
    entry.playerRequest = request;
  }
  try {
    const value = await request.promise;
    return { ...value, players: [...value.players] };
  } finally {
    if (entry.playerRequest === request) entry.playerRequest = undefined;
  }
}

export function parsePlayerList(raw: string): PlayerList {
  const clean = raw.replace(/§./g, '').trim();
  const m = clean.match(/(\d+)\s*(?:of a max(?:imum)? of|von maximal|\/)\s*(\d+)/i);
  if (!m) throw new Error('Spielerliste konnte nicht gelesen werden: unerwartete Serverantwort');
  const online = Number(m[1]);
  const max = Number(m[2]);
  const idx = clean.indexOf(':', m.index! + m[0].length);
  const namePart = idx >= 0 ? clean.slice(idx + 1) : '';
  const players = namePart
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Bedrock-Spieler über Geyser/Floodgate tragen ein Präfix („.“ oder „*“).
  if (players.length !== online || players.some(name => !/^[.*]?[A-Za-z0-9_]{1,32}$/.test(name))) {
    throw new Error('Spielerliste konnte nicht vollständig gelesen werden');
  }
  return { online, max, players };
}
