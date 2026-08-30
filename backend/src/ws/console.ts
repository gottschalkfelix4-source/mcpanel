import type { Server as IOServer, Socket } from 'socket.io';
import type { Server } from '@prisma/client';
import { prisma } from '../db.js';
import { verifyToken } from '../auth/jwt.js';
import { getServerAccess } from '../auth/context.js';
import { PERMISSIONS } from '../auth/permissions.js';
import * as dockerSvc from '../services/docker.js';
import { listPlayers, rconCommand } from '../services/rcon.js';
import { roomForServer, setIO } from './io.js';

interface StreamEntry {
  stop: () => void;
  refs: number;
}

const streams = new Map<string, StreamEntry>();
const statusTimers = new Map<string, NodeJS.Timeout>();

/** Startet (oder teilt) den Live-Log-Stream eines Servers. */
async function attachStream(io: IOServer, server: Server) {
  const existing = streams.get(server.id);
  if (existing) {
    existing.refs++;
    return;
  }

  const entry: StreamEntry = { refs: 1, stop: () => {} };
  streams.set(server.id, entry);

  const room = roomForServer(server.id);
  let buffer = '';

  const stop = await dockerSvc.followLogs(server, (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    if (lines.length > 0) io.to(room).emit('console', { lines });
  });

  entry.stop = stop;
}

function detachStream(serverId: string) {
  const entry = streams.get(serverId);
  if (!entry) return;
  entry.refs--;
  if (entry.refs <= 0) {
    entry.stop();
    streams.delete(serverId);
  }
}

/** Pollt Status/Stats/Spieler und schickt sie an alle Zuschauer. */
function startStatusPolling(io: IOServer, serverId: string) {
  if (statusTimers.has(serverId)) return;

  const timer = setInterval(async () => {
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

    io.to(roomForServer(serverId)).emit('status', {
      serverId,
      state,
      health,
      startedAt,
      stats,
      players,
      memoryLimitMb: server.memoryMb,
    });
  }, 3000);

  statusTimers.set(serverId, timer);
}

export function setupConsoleGateway(io: IOServer) {
  setIO(io);

  io.use(async (socket, next) => {
    try {
      const token =
        (socket.handshake.auth as { token?: string })?.token ??
        (socket.handshake.query.token as string | undefined);
      if (!token) return next(new Error('Nicht angemeldet'));

      const payload = verifyToken(token);
      const user = await prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user || !user.active) return next(new Error('Konto deaktiviert'));

      socket.data.user = user;
      next();
    } catch {
      next(new Error('Sitzung ungültig'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const subscribed = new Set<string>();

    socket.on('subscribe', async (payload: { serverId: string }, ack?: (r: unknown) => void) => {
      try {
        const access = await getServerAccess(socket.data.user, payload.serverId);
        if (!access.can(PERMISSIONS.CONSOLE_READ)) {
          ack?.({ ok: false, error: 'Keine Berechtigung für die Konsole' });
          return;
        }

        socket.join(roomForServer(access.server.id));
        // Derselbe Socket abonniert zweimal: einmal aus dem Server-Layout, einmal
        // aus der Konsole. Nur das erste Abo darf den Zähler erhöhen – sonst
        // haelt jedes weitere den Log-Stream fest, den "unsubscribe" nur einmal
        // wieder freigibt.
        const bereitsAbonniert = subscribed.has(access.server.id);
        subscribed.add(access.server.id);

        const history = await dockerSvc.tailLogs(access.server, 400);
        socket.emit('console:history', { lines: history.split('\n') });

        if (!bereitsAbonniert) await attachStream(io, access.server);
        startStatusPolling(io, access.server.id);

        ack?.({ ok: true, permissions: access.permissions });
      } catch (err) {
        ack?.({ ok: false, error: err instanceof Error ? err.message : 'Fehler' });
      }
    });

    socket.on('unsubscribe', (payload: { serverId: string }) => {
      if (!subscribed.has(payload.serverId)) return;
      socket.leave(roomForServer(payload.serverId));
      subscribed.delete(payload.serverId);
      detachStream(payload.serverId);
    });

    socket.on(
      'command',
      async (payload: { serverId: string; command: string }, ack?: (r: unknown) => void) => {
        try {
          const access = await getServerAccess(socket.data.user, payload.serverId);
          if (!access.can(PERMISSIONS.CONSOLE_COMMAND)) {
            ack?.({ ok: false, error: 'Keine Berechtigung zum Senden von Befehlen' });
            return;
          }

          const command = payload.command.trim().replace(/^\//, '');
          if (!command) return;

          io.to(roomForServer(payload.serverId)).emit('console', {
            lines: [`> ${command}   [${socket.data.user.username}]`],
            local: true,
          });

          try {
            const response = await rconCommand(access.server, command);
            if (response.trim()) {
              socket.emit('console', { lines: response.split('\n'), local: true });
            }
            ack?.({ ok: true, via: 'rcon' });
          } catch {
            await dockerSvc.writeStdin(access.server, command);
            ack?.({ ok: true, via: 'stdin' });
          }

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
          ack?.({ ok: false, error: err instanceof Error ? err.message : 'Fehler' });
        }
      },
    );

    /** Container wurde neu gestartet – Log-Stream neu aufsetzen. */
    socket.on('reattach', async (payload: { serverId: string }) => {
      if (!subscribed.has(payload.serverId)) return;
      const server = await prisma.server.findUnique({ where: { id: payload.serverId } });
      if (!server) return;
      const entry = streams.get(payload.serverId);
      // Zuschauerzahl vor dem Abräumen sichern: der neue Stream muss sie
      // übernehmen, sonst beendet ihn der erste Abgang für alle anderen mit.
      const zuschauer = entry?.refs ?? 1;
      if (entry) {
        entry.stop();
        streams.delete(payload.serverId);
      }
      await attachStream(io, server);
      streams.get(payload.serverId)!.refs = Math.max(1, zuschauer);
    });

    socket.on('disconnect', () => {
      for (const serverId of subscribed) detachStream(serverId);
      subscribed.clear();
    });
  });
}
