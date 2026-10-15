import { AsyncLocalStorage } from 'node:async_hooks';
import { conflict } from '../lib/errors.js';

const active = new Map<string, { token: symbol; label: string }>();
const context = new AsyncLocalStorage<Map<string, symbol>>();
const queues = new Map<string, Promise<unknown>>();

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
    throw conflict(`${existing.label} läuft für diesen Server bereits. Bitte abwarten.`);
  }
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
