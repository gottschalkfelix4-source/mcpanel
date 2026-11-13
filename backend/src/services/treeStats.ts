/**
 * Größe und Dateizahl eines Ordners samt Unterordnern – für die Ordnergrößen
 * im Dateimanager und die Weltgröße im Reiter „Karte“.
 *
 * Mehrere Abfragen laufen gleichzeitig (eine große Welt oder BlueMap-Kacheln
 * sind schnell sechsstellig viele Dateien), Verknüpfungen werden nicht verfolgt
 * und nicht mitgezählt. Ein Ergebnis gilt eine Weile; dauert der Durchlauf zu
 * lange oder wird es zu viel, gibt es den Stand bis dahin mit `partial`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export interface TreeStats {
  bytes: number;
  files: number;
  /** Abgebrochen (Zeit- oder Mengengrenze) – die Zahlen sind eine Untergrenze. */
  partial: boolean;
}

const PARALLEL_DIRS = 8;
const PARALLEL_STATS = 64;
const MAX_ENTRIES = 2_000_000;
const DEADLINE_MS = 20_000;
const TTL_MS = 20_000;
const MAX_CACHE = 500;

const cache = new Map<string, { at: number; value: TreeStats }>();
const inflight = new Map<string, Promise<TreeStats>>();

async function compute(root: string): Promise<TreeStats> {
  const stats: TreeStats = { bytes: 0, files: 0, partial: false };
  const deadline = Date.now() + DEADLINE_MS;
  let seen = 0;
  const queue: string[] = [root];
  let active = 0;

  const visit = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      if (++seen > MAX_ENTRIES || Date.now() > deadline) {
        stats.partial = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
    for (let i = 0; i < files.length; i += PARALLEL_STATS) {
      const batch = await Promise.all(files.slice(i, i + PARALLEL_STATS).map((file) => fs.lstat(file).catch(() => null)));
      for (const stat of batch) {
        if (!stat?.isFile()) continue;
        stats.bytes += stat.size;
        stats.files += 1;
      }
    }
  };

  await new Promise<void>((resolve) => {
    const pump = () => {
      while (active < PARALLEL_DIRS && queue.length > 0 && !stats.partial) {
        const dir = queue.pop()!;
        active += 1;
        void visit(dir).finally(() => {
          active -= 1;
          pump();
        });
      }
      if (active === 0 && (queue.length === 0 || stats.partial)) resolve();
    };
    pump();
  });
  return stats;
}

/** Größe eines Ordners; mehrere gleichzeitige Anfragen teilen sich einen Durchlauf. */
export function treeStats(absolute: string): Promise<TreeStats> {
  const hit = cache.get(absolute);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.value);
  const running = inflight.get(absolute);
  if (running) return running;
  const job = compute(absolute)
    .then((value) => {
      cache.set(absolute, { at: Date.now(), value });
      if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
      return value;
    })
    .finally(() => inflight.delete(absolute));
  inflight.set(absolute, job);
  return job;
}

/** Nach Änderungen unterhalb von `root` (Dateimanager, Chunks zurücksetzen) neu zählen. */
export function forgetTreeStats(root: string): void {
  const base = path.resolve(root);
  for (const key of cache.keys()) {
    if (key === base || key.startsWith(base + path.sep) || base.startsWith(key + path.sep)) cache.delete(key);
  }
}
