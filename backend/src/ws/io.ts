import type { Server as IOServer } from 'socket.io';

let io: IOServer | null = null;

export function setIO(instance: IOServer) {
  io = instance;
}

export function getIO(): IOServer | null {
  return io;
}

export const roomForServer = (serverId: string) => `server:${serverId}`;

export function emitToServer(serverId: string, event: string, payload: unknown) {
  io?.to(roomForServer(serverId)).emit(event, payload);
}
