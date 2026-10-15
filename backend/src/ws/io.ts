import type { Server as IOServer, Socket } from 'socket.io';
import { authenticateToken, getServerAccess } from '../auth/context.js';
import { HttpError } from '../lib/errors.js';

let io: IOServer | null = null;

export function setIO(instance: IOServer) {
  io = instance;
}

export function getIO(): IOServer | null {
  return io;
}

export const roomForServer = (serverId: string) => `server:${serverId}`;

/**
 * Rechte je Socket und Server kurz zwischenspeichern. Ohne Zwischenspeicher
 * kostete jede Logzeile zwei Datenbankabfragen pro Zuschauer. Änderungen an
 * Konten, Rollen und Mitgliedschaften rufen `invalidateSocketAccess()` und
 * greifen damit sofort; alles andere spätestens nach ACCESS_TTL_MS.
 */
const ACCESS_TTL_MS = 5000;
let generation = 0;

interface CachedAccess { expires: number; generation: number; promise: Promise<{ consoleRead: boolean }> }
interface SocketState { access: Map<string, CachedAccess>; chain: Promise<void> }

const states = new WeakMap<Socket, SocketState>();

function stateOf(socket: Socket): SocketState {
  let state = states.get(socket);
  if (!state) {
    state = { access: new Map(), chain: Promise.resolve() };
    states.set(socket, state);
  }
  return state;
}

export function invalidateSocketAccess(): void {
  generation++;
}

function accessFor(socket: Socket, serverId: string): Promise<{ consoleRead: boolean }> {
  const state = stateOf(socket);
  const cached = state.access.get(serverId);
  if (cached && cached.generation === generation && cached.expires > Date.now()) return cached.promise;
  const promise = (async () => {
    const user = await authenticateToken(socket.data.token);
    const access = await getServerAccess(user, serverId);
    return { consoleRead: access.can('console.read') };
  })();
  const entry = { expires: Date.now() + ACCESS_TTL_MS, generation, promise };
  state.access.set(serverId, entry);
  // Fehlschläge nicht zwischenspeichern: ein kurzer Datenbankaussetzer soll
  // beim nächsten Ereignis neu geprüft werden.
  promise.catch(() => { if (state.access.get(serverId) === entry) state.access.delete(serverId); });
  return promise;
}

/**
 * Sendet an alle Zuschauer eines Servers – jeder Empfänger wird vorher erneut
 * geprüft. Je Socket läuft eine Kette, damit Konsolenzeilen trotz asynchroner
 * Prüfung in ihrer Reihenfolge ankommen.
 */
export function emitToServer(serverId: string, event: string, payload: unknown): void {
  const room = io?.sockets.adapter.rooms.get(roomForServer(serverId));
  if (!room) return;
  for (const id of room) {
    const socket = io?.sockets.sockets.get(id);
    if (!socket) continue;
    const state = stateOf(socket);
    const check = accessFor(socket, serverId);
    check.catch(() => {});
    state.chain = state.chain.then(async () => {
      try {
        const access = await check;
        if ((event === 'console' || event === 'console:history') && !access.consoleRead) return;
        if (socket.connected && socket.rooms.has(roomForServer(serverId))) {
          socket.emit(event, typeof payload === 'object' && payload !== null ? { ...payload, serverId } : payload);
        }
      } catch (err) {
        if (!(err instanceof HttpError)) return; // Datenbank/Netz: nichts senden, Verbindung behalten.
        if (err.statusCode === 401) socket.disconnect(true);
        else socket.leave(roomForServer(serverId));
      }
    });
  }
}
