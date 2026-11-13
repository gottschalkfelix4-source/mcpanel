import type { Server as IOServer, Socket } from 'socket.io';
import type { Server } from '@prisma/client';
import { prisma } from '../db.js';

import { authenticateToken, enforceTotpPolicy, getServerAccess } from '../auth/context.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { HttpError, badRequest, forbidden } from '../lib/errors.js';
import * as dockerSvc from '../services/docker.js';
import { listPlayers } from '../services/rcon.js';
import { sendServerCommand } from '../services/consoleCommand.js';
import { emitToServer, roomForServer, setIO } from './io.js';
import { clientAddress, isServerNetworkAddress } from '../lib/network.js';

interface StreamEntry {
  stop: () => void;
  /**
   * Sockets, die zuschauen. Ein Set statt eines Zählers: jeder Socket zählt
   * genau einmal und kann nur abziehen, was er selbst beigetragen hat – ein
   * fehlgeschlagenes Abo oder zwei gleichzeitige „reattach“ bringen die Zahl
   * nicht mehr durcheinander (sonst endet der Stream für alle anderen mit).
   */
  viewers: Set<string>;
  /** Zählt Neuaufbauten; nur der jüngste darf seinen Stream behalten. */
  generation: number;
  restartedAt: number;
}

const streams = new Map<string, StreamEntry>();
const statusTimers = new Map<string, NodeJS.Timeout>();

/** Öffnet den Docker-Log-Stream und verteilt ganze Zeilen an die Zuschauer. */
function openLogStream(server: Server): Promise<() => void> {
  let buffer = '';
  return dockerSvc.followLogs(server, (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    if (lines.length > 0) emitToServer(server.id, 'console', { serverId: server.id, lines });
  });
}

/** Stream (neu) aufbauen; übernimmt ihn nur, wenn inzwischen nichts Neueres lief. */
async function connectStream(server: Server, entry: StreamEntry): Promise<void> {
  const generation = ++entry.generation;
  entry.stop();
  entry.stop = () => {};
  const stop = await openLogStream(server);
  if (streams.get(server.id) !== entry || entry.viewers.size === 0 || entry.generation !== generation) stop();
  else entry.stop = stop;
}

/** Startet (oder teilt) den Live-Log-Stream eines Servers. */
async function attachStream(server: Server, socketId: string) {
  const existing = streams.get(server.id);
  if (existing) {
    existing.viewers.add(socketId);
    return;
  }

  const entry: StreamEntry = { viewers: new Set([socketId]), stop: () => {}, generation: 0, restartedAt: Date.now() };
  streams.set(server.id, entry);
  try {
    await connectStream(server, entry);
  } catch (err) {
    // Wer währenddessen dazukam, behält seinen Platz; der Stream kommt mit dem
    // nächsten „reattach“. Dieser Socket selbst gilt als nicht angeschlossen.
    detachStream(server.id, socketId);
    throw err;
  }
}

function detachStream(serverId: string, socketId: string) {
  const entry = streams.get(serverId);
  if (!entry) return;
  entry.viewers.delete(socketId);
  if (entry.viewers.size === 0) {
    entry.stop();
    streams.delete(serverId);
  }
}

/**
 * Container wurde neu gestartet: Stream neu aufsetzen, Zuschauer behalten.
 * Alle Zuschauer melden das gleichzeitig – ein Neuaufbau genügt.
 */
async function restartStream(server: Server, socketId: string) {
  const entry = streams.get(server.id);
  if (!entry) return attachStream(server, socketId);
  entry.viewers.add(socketId);
  if (entry.generation > 0 && Date.now() - entry.restartedAt < 1000) return;
  entry.restartedAt = Date.now();
  await connectStream(server, entry);
}

/** Nur eigene, für Nutzer gedachte Meldungen weitergeben – nie Interna aus Datenbank oder Docker. */
function fehlertext(err: unknown): string {
  return err instanceof HttpError ? err.message : 'Interner Fehler';
}

/** Pollt Status/Stats/Spieler und schickt sie an alle Zuschauer. */
function startStatusPolling(io: IOServer, serverId: string) {
  if (statusTimers.has(serverId)) return;
  let polling = false;

  const timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
    const room = io.sockets.adapter.rooms.get(roomForServer(serverId));
    if (!room || room.size === 0) {
      clearInterval(timer);
      statusTimers.delete(serverId);
      return;
    }

    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server) return;

    const { state, health, startedAt } = await dockerSvc.getState(server);
    const stats = state === 'running' ? await dockerSvc.getStats(server) : null;

    let players: { online: number; max: number; players: string[] } | null = null;
    if (state === 'running') {
      players = await listPlayers(server).catch(() => null);
    }

    emitToServer(serverId, 'status', {
      serverId,
      state,
      health,
      startedAt,
      stats,
      players,
      memoryLimitMb: server.memoryMb,
    });
    } catch { /* A transient database/Docker failure is retried next tick. */ }
    finally { polling = false; }
  }, 3000);

  statusTimers.set(serverId, timer);
}

export function setupConsoleGateway(io: IOServer) {
  setIO(io);

  io.use(async (socket, next) => {
    try {
      // Server-Container im Minecraft-Netz bekommen keine Verbindung.
      const address = clientAddress(socket.request.socket.remoteAddress, socket.request.headers['x-forwarded-for']);
      if (isServerNetworkAddress(address) || isServerNetworkAddress(socket.request.socket.remoteAddress)) {
        return next(new Error('Zugriff aus dem Minecraft-Netz ist gesperrt'));
      }
      // Nur aus dem Handschlag – ein Token in der URL landet in Proxy-Logs.
      const token = (socket.handshake.auth as { token?: string })?.token;
      if (!token || typeof token !== 'string') return next(new Error('Nicht angemeldet'));

      const user = await authenticateToken(token);
      // Ohne vorgeschriebenen zweiten Faktor gibt es keine Live-Verbindung.
      await enforceTotpPolicy(user, null);
      socket.data.token = token;

      socket.data.user = user;
      next();
    } catch {
      next(new Error('Sitzung ungültig'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const subscribed = new Set<string>();

    socket.on('subscribe', async (payload: { serverId: string }, ack?: (r: unknown) => void) => {
      let serverId: string | null = null;
      let bereitsAbonniert = true;
      try {
        if (typeof payload?.serverId !== 'string') throw badRequest('Ungültige Anfrage');
        const access = await getServerAccess(await authenticateToken(socket.data.token), payload.serverId);
        if (!access.can(PERMISSIONS.CONSOLE_READ)) {
          ack?.({ ok: false, error: 'Keine Berechtigung für die Konsole' });
          return;
        }

        socket.join(roomForServer(access.server.id));
        // Derselbe Socket abonniert zweimal: einmal aus dem Server-Layout, einmal
        // aus der Konsole.
        serverId = access.server.id;
        bereitsAbonniert = subscribed.has(access.server.id);
        subscribed.add(access.server.id);

        const history = await dockerSvc.tailLogs(access.server, 400);
        if (!socket.connected || !subscribed.has(access.server.id)) return;
        const currentAccess = await getServerAccess(await authenticateToken(socket.data.token), access.server.id);
        if (!currentAccess.can(PERMISSIONS.CONSOLE_READ)) throw forbidden('Konsolenrecht wurde entzogen');
        socket.emit('console:history', { serverId: access.server.id, lines: history.split('\n') });

        await attachStream(access.server, socket.id);
        // Während des Wartens getrennt oder abbestellt: nicht hängen bleiben.
        if (!socket.connected || !subscribed.has(access.server.id)) {
          detachStream(access.server.id, socket.id);
          return;
        }
        startStatusPolling(io, access.server.id);

        ack?.({ ok: true, permissions: access.permissions });
      } catch (err) {
        // Ein gescheitertes Erst-Abo zählt nicht: sonst überspränge der nächste
        // Versuch das Anschließen und die Konsole bliebe bis zum Neuverbinden stumm.
        if (serverId && !bereitsAbonniert) {
          subscribed.delete(serverId);
          socket.leave(roomForServer(serverId));
          detachStream(serverId, socket.id);
        }
        if (!(err instanceof HttpError)) console.error('[konsole] Abo fehlgeschlagen:', err instanceof Error ? err.message : err);
        ack?.({ ok: false, error: fehlertext(err) });
      }
    });

    socket.on('unsubscribe', (payload: { serverId: string }) => {
      if (!payload || !subscribed.has(payload.serverId)) return;
      socket.leave(roomForServer(payload.serverId));
      subscribed.delete(payload.serverId);
      detachStream(payload.serverId, socket.id);
    });

    socket.on(
      'command',
      async (payload: { serverId: string; command: string }, ack?: (r: unknown) => void) => {
        try {
          if (typeof payload?.serverId !== 'string') throw badRequest('Ungültige Anfrage');
          const access = await getServerAccess(await authenticateToken(socket.data.token), payload.serverId);
          if (!access.can(PERMISSIONS.CONSOLE_COMMAND)) {
            ack?.({ ok: false, error: 'Keine Berechtigung zum Senden von Befehlen' });
            return;
          }

          if (typeof payload.command !== 'string' || payload.command.length > 1000 || /[\r\n]/.test(payload.command)) throw badRequest('Ungültiger Befehl');
          const command = payload.command.trim().replace(/^\//, '');
          if (!command) return;

          // Ohne Serversperre: Befehle gehen per RCON an den laufenden Server und
          // dürfen parallel zu Backups und den Befehlen anderer Nutzer laufen.
          emitToServer(payload.serverId, 'console', {
            lines: [`> ${command}   [${socket.data.user.username}]`],
            local: true,
          });

          const { via, response } = await sendServerCommand(access.server, command);
          if (response.trim()) socket.emit('console', { lines: response.split('\n'), local: true });
          ack?.({ ok: true, via });

          await prisma.auditLog
            .create({
              data: {
                userId: socket.data.user.id,
                serverId: payload.serverId,
                action: 'server.command',
                detail: command.slice(0, 120),
              },
            })
            .catch(() => {});
        } catch (err) {
          if (!(err instanceof HttpError)) console.error('[konsole] Befehl fehlgeschlagen:', err instanceof Error ? err.message : err);
          ack?.({ ok: false, error: fehlertext(err) });
        }
      },
    );

    /** Container wurde neu gestartet – Log-Stream neu aufsetzen. */
    socket.on('reattach', async (payload: { serverId: string }) => {
      if (!payload || typeof payload.serverId !== 'string' || !subscribed.has(payload.serverId)) return;
      try {
      const access = await getServerAccess(await authenticateToken(socket.data.token), payload.serverId);
      if (!access.can(PERMISSIONS.CONSOLE_READ)) return;
      await restartStream(access.server, socket.id);
      } catch { /* Disconnects and revoked access cannot reattach a stream. */ }
    });

    socket.on('disconnect', () => {
      for (const serverId of subscribed) detachStream(serverId, socket.id);
      subscribed.clear();
    });
  });
}
