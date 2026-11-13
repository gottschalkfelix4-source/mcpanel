/**
 * Laufende Übertragungen gegen das Speicherkontingent eines Servers.
 *
 * Ein Upload zählt erst nach dem Umbenennen in den Platzverbrauch. Bis dahin
 * sah jeder gleichzeitige Upload dasselbe Restkontingent – zehn parallele
 * Übertragungen (Dateimanager, SFTP, Welt-ZIP) durften zusammen das Zehnfache
 * schreiben. Hier melden alle laufenden Übertragungen ihren Stand an einen
 * gemeinsamen Zähler; die Grenze gilt für alle zusammen.
 */
import { Transform } from 'node:stream';
import type { Server } from '@prisma/client';
import { badRequest } from '../lib/errors.js';
import { getDiskUsage } from './diskUsage.js';

const MB = 1024 * 1024;
const reservations = new Map<string, Map<symbol, number>>();

/** Summe der gerade laufenden, noch nicht verbuchten Übertragungen. */
export function reservedBytes(serverId: string): number {
  let total = 0;
  for (const bytes of reservations.get(serverId)?.values() ?? []) total += bytes;
  return total;
}

export interface DiskReservation {
  /** Aktuelle Größe der Übertragung; wirft, wenn alle zusammen das Kontingent sprengen. */
  update(totalBytes: number): void;
  /** Nach dem Verbuchen (oder Abbruch) – muss immer aufgerufen werden. */
  release(): void;
}

/**
 * `credit`: Größe einer Datei, die ersetzt wird – bis dahin wächst der
 * Verbrauch nicht.
 */
export function reserveDisk(server: Pick<Server, 'id' | 'quotaDiskMb'>, credit = 0): DiskReservation {
  const key = Symbol('upload');
  let map = reservations.get(server.id);
  if (!map) reservations.set(server.id, (map = new Map()));
  map.set(key, 0);
  return {
    update(totalBytes: number) {
      map!.set(key, Math.max(0, totalBytes - credit));
      if (!(server.quotaDiskMb > 0)) return;
      const used = getDiskUsage(server.id).total;
      if (used + reservedBytes(server.id) > server.quotaDiskMb * MB) {
        throw badRequest('Speicherkontingent reicht für diese Datei nicht aus – andere Übertragungen laufen noch');
      }
    },
    release() {
      map!.delete(key);
      if (map!.size === 0 && reservations.get(server.id) === map) reservations.delete(server.id);
    },
  };
}

/** Zählt einen Datenstrom gegen die Reservierung. */
export function reservationMeter(reservation: DiskReservation): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      try {
        reservation.update(bytes);
        callback(null, chunk);
      } catch (err) {
        callback(err as Error);
      }
    },
  });
}
