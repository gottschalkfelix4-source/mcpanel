import type { Server } from '@prisma/client';
import { listPlayers } from './rcon.js';

export interface PlayerCount {
  online: number;
  max: number;
}

interface CacheEntry {
  value: PlayerCount;
  fetchedAt: number;
}

/** So lange gilt eine Zählung, bevor im Hintergrund neu gefragt wird. */
const TTL_MS = 10_000;

const cache = new Map<string, CacheEntry>();
const inflight = new Set<string>();

function refresh(server: Server): void {
  if (inflight.has(server.id)) return;
  inflight.add(server.id);

  void listPlayers(server)
    .then(({ online, max }) => {
      cache.set(server.id, { value: { online, max }, fetchedAt: Date.now() });
    })
    .catch(() => {
      // RCON noch nicht bereit – nichts eintragen, beim nächsten Mal erneut.
    })
    .finally(() => inflight.delete(server.id));
}

/**
 * Spielerzahl eines Servers ohne Wartezeit.
 *
 * Die Serverliste wird im Sekundentakt gepollt; ein RCON-Roundtrip je Server
 * würde sie ausbremsen. Deshalb kommt der letzte bekannte Wert sofort zurück
 * und wird bei Bedarf im Hintergrund erneuert.
 */
export function getPlayerCount(server: Server, running: boolean): PlayerCount | null {
  if (!running) {
    cache.delete(server.id);
    return null;
  }

  const hit = cache.get(server.id);
  if (!hit || Date.now() - hit.fetchedAt > TTL_MS) refresh(server);

  return hit?.value ?? null;
}

export function invalidatePlayerCount(serverId: string): void {
  cache.delete(serverId);
}
