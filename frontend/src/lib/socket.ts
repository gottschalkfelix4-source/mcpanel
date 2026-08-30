import { io, type Socket } from 'socket.io-client';
import { tokenStore } from './api';

let socket: Socket | null = null;

/** Gemeinsame Socket.IO-Verbindung für Konsole, Status und Tasks. */
export function getSocket(): Socket {
  if (socket && socket.connected) return socket;
  if (!socket) {
    socket = io({
      path: '/socket.io',
      auth: { token: tokenStore.get() },
      transports: ['websocket', 'polling'],
      reconnectionDelay: 800,
      reconnectionDelayMax: 5000,
    });
  }
  return socket;
}

export function resetSocket() {
  socket?.disconnect();
  socket = null;
}
