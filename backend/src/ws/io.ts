import type { Server as IOServer } from 'socket.io';
import { authenticateToken, getServerAccess } from '../auth/context.js';

let io: IOServer | null = null;

export function setIO(instance: IOServer) {
  io = instance;
}

export function getIO(): IOServer | null {
  return io;
}

export const roomForServer = (serverId: string) => `server:${serverId}`;

export function emitToServer(serverId: string, event: string, payload: unknown): void {
  const room = io?.sockets.adapter.rooms.get(roomForServer(serverId));
  if (!room) return;
  for (const id of room) {
    const socket = io?.sockets.sockets.get(id);
    if (!socket) continue;
    void (async () => {
      try {
        const user = await authenticateToken(socket.data.token);
        const access = await getServerAccess(user, serverId);
        if ((event === 'console' || event === 'console:history') && !access.can('console.read')) return;
        if (socket.connected && socket.rooms.has(roomForServer(serverId))) socket.emit(event, typeof payload === 'object' && payload !== null ? { ...payload, serverId } : payload);
      } catch {
        socket.disconnect(true);
      }
    })();
  }
}
