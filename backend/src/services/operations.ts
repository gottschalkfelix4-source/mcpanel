import { AsyncLocalStorage } from 'node:async_hooks';
import { conflict } from '../lib/errors.js';

const active = new Map<string, { token: symbol; label: string }>();
const context = new AsyncLocalStorage<Map<string, symbol>>();
const queues = new Map<string, Promise<unknown>>();

/**
 * Vorbedingung für jede neue (nicht verschachtelte) Serveroperation. Die
 * Nodes hängen hier ihre Erreichbarkeitsprüfung ein: liegt ein Server auf
 * einer getrennten Node, ist auch ihre Freigabe weg – eine Operation würde
 * dann ins leere lokale Einhängeverzeichnis schreiben. Als Rückruf gelöst,
 * damit dieses Modul nichts importieren muss.
 */
/** Interne Kennungen in dem Deutsch, das der Nutzer in der Meldung liest. */
const LABELS: Record<string, string> = {
  createBackup: 'Eine Sicherung',
  deleteBackup: 'Das Löschen einer Sicherung',
  restoreBackup: 'Eine Wiederherstellung',
  installModpack: 'Eine Modpack-Installation',
  deleteServer: 'Das Löschen des Servers',
  updateServerSettings: 'Eine Änderung der Einstellungen',
  recreateContainer: 'Der Neuaufbau des Containers',
  removeContainer: 'Das Entfernen des Containers',
  start: 'Der Start',
  stop: 'Das Stoppen',
  restart: 'Ein Neustart',
  createDir: 'Eine Dateiänderung',
  writeFile: 'Eine Dateiänderung',
  rename: 'Eine Dateiänderung',
  remove: 'Eine Dateiänderung',
  unzip: 'Das Entpacken eines Archivs',
  saveProperties: 'Eine Konfigurationsänderung',
};

let operationGuard: ((serverId: string) => void) | null = null;
export function setOperationGuard(fn: ((serverId: string) => void) | null): void {
  operationGuard = fn;
}

export async function withQueuedOperation<T>(id: string, label: string, fn: () => Promise<T>): Promise<T> {
  if (active.get(id)?.token && context.getStore()?.get(id) === active.get(id)?.token) return fn();
  const previous = queues.get(id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => withServerOperation(id, label, fn));
  queues.set(id, next);
  try { return await next; }
  finally { if (queues.get(id) === next) queues.delete(id); }
}

/** Reentrant for internal steps of one operation, exclusive against other requests/tasks. */
export async function withServerOperation<T>(serverId: string, label: string, fn: () => Promise<T>): Promise<T> {
  const existing = active.get(serverId);
  if (existing) {
    if (context.getStore()?.get(serverId) === existing.token) return fn();
    throw conflict(`${LABELS[existing.label] ?? existing.label} läuft für diesen Server bereits. Bitte abwarten.`);
  }
  operationGuard?.(serverId);
  const token = Symbol(label);
  active.set(serverId, { token, label });
  const owned = new Map(context.getStore());
  owned.set(serverId, token);
  try {
    return await context.run(owned, fn);
  } finally {
    if (active.get(serverId)?.token === token) active.delete(serverId);
  }
}

/**
 * Wie withServerOperation, wartet aber, bis eine laufende Operation fertig ist
 * (höchstens `timeoutMs`). Für kurze Schritte am Ende langer Übertragungen –
 * ein fertig hochgeladenes Modpack soll nicht an einem gerade laufenden
 * Backup scheitern.
 */
export async function waitForServerOperation<T>(serverId: string, label: string, fn: () => Promise<T>, timeoutMs = 15 * 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const existing = active.get(serverId);
    if (!existing || context.getStore()?.get(serverId) === existing.token || Date.now() >= deadline) {
      return withServerOperation(serverId, label, fn);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
