import { io, type Socket } from 'socket.io-client';
import { tokenStore } from './api';

let socket: Socket | null = null;

/** Gemeinsame Socket.IO-Verbindung für Konsole, Status und Tasks. */
export function getSocket(): Socket {
  if (socket && socket.connected) return socket;
  if (!socket) {
    const created = io({
      path: '/socket.io',
      // Als Funktion: jeder Verbindungsversuch nimmt das aktuelle Token.
      auth: (cb) => cb({ token: tokenStore.get() }),
      transports: ['websocket', 'polling'],
      reconnectionDelay: 800,
      reconnectionDelayMax: 5000,
    });
    // Trennt der Server (z. B. beim Neustart oder nach geänderten Rechten),
    // verbindet Socket.IO von sich aus nicht neu – sonst bliebe die Konsole
    // bis zum Neuladen der Seite stumm.
    created.on('disconnect', (reason) => {
      if (reason !== 'io server disconnect') return;
      setTimeout(() => {
        if (socket === created && tokenStore.get() && !created.connected) created.connect();
      }, 2000);
    });
    socket = created;
  } else if (!socket.active) {
    socket.connect();
  }
  return socket;
}

export function resetSocket() {
  socket?.disconnect();
  socket = null;
}
