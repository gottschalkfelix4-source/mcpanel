import { serverBackupDir, serverDir } from '../config.js';
import { dirSize } from './files.js';

export interface DiskUsage {
  data: number;
  backups: number;
  total: number;
  /** Die Zahlen werden gerade neu berechnet und sind evtl. veraltet. */
  pending: boolean;
  computedAt: string | null;
}

interface CacheEntry {
  data: number;
  backups: number;
  total: number;
  computedAt: number;
}

/** Modpack-Server haben leicht 100.000 Dateien – so lange gilt ein Ergebnis. */
const TTL_MS = 5 * 60_000;

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();

function compute(serverId: string): Promise<CacheEntry> {
  const existing = inflight.get(serverId);
  if (existing) return existing;

  const job = (async () => {
    const [data, backups] = await Promise.all([
      dirSize(serverDir(serverId)),
      dirSize(serverBackupDir(serverId)),
    ]);
    const entry: CacheEntry = { data, backups, total: data + backups, computedAt: Date.now() };
    cache.set(serverId, entry);
    return entry;
  })().finally(() => inflight.delete(serverId));

  inflight.set(serverId, job);
  return job;
}

const toResult = (entry: CacheEntry, pending: boolean): DiskUsage => ({
  data: entry.data,
  backups: entry.backups,
  total: entry.total,
  pending,
  computedAt: new Date(entry.computedAt).toISOString(),
});

/**
 * Speicherverbrauch eines Servers – gecacht, damit das Dashboard nicht bei
 * jedem Aufruf den kompletten Verzeichnisbaum durchläuft (bei Modpacks sind
 * das schnell sechsstellig viele Dateien und über zehn Sekunden).
 *
 * Der Aufruf blockiert nie: Vorhandene Werte kommen sofort zurück und werden
 * bei Bedarf im Hintergrund erneuert. Ist noch nichts berechnet, meldet die
 * Antwort `pending` – der nächste Poll der Oberfläche hat dann die Zahlen.
 */
export function getDiskUsage(serverId: string): DiskUsage {
  const hit = cache.get(serverId);

  if (!hit) {
    void compute(serverId).catch(() => {});
    return { data: 0, backups: 0, total: 0, pending: true, computedAt: null };
  }

  const stale = Date.now() - hit.computedAt > TTL_MS;
  if (stale) void compute(serverId).catch(() => {});
  return toResult(hit, stale);
}

/** Nach Installationen, Backups oder Löschungen den Wert verwerfen. */
export function invalidateDiskUsage(serverId: string): void {
  cache.delete(serverId);
}

/**
 * Wie getDiskUsage, wartet aber auf frische Zahlen. Fuer Kontingent-Pruefungen
 * vor einer Sicherung: dort zaehlt Genauigkeit mehr als Antwortzeit, und der
 * Vorgang dauert ohnehin Minuten.
 */
export async function computeDiskUsage(serverId: string, maxAgeMs = QUOTA_FRESH_MS): Promise<DiskUsage> {
  // Ein frisch gemessener Wert reicht – sonst liefe bei jedem Upload und jeder
  // gespeicherten Datei ein kompletter Verzeichnisdurchlauf (Modpacks:
  // sechsstellige Dateizahlen). Eigene Schreibvorgänge zählt adjustDiskUsage mit.
  const hit = cache.get(serverId);
  if (hit && Date.now() - hit.computedAt <= maxAgeMs) return toResult(hit, false);
  const entry = await compute(serverId);
  return toResult(entry, false);
}

/** So lange gilt eine Messung für Kontingentprüfungen als aktuell. */
const QUOTA_FRESH_MS = 30_000;

/**
 * Rechnet eine bekannte Änderung (Upload, gespeicherte Datei) in den
 * zwischengespeicherten Wert ein, statt ihn zu verwerfen.
 */
export function adjustDiskUsage(serverId: string, deltaBytes: number): void {
  const hit = cache.get(serverId);
  if (!hit || !Number.isFinite(deltaBytes)) return;
  hit.data = Math.max(0, hit.data + deltaBytes);
  hit.total = hit.data + hit.backups;
}
