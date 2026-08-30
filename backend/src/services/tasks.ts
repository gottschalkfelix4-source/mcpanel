import { prisma } from '../db.js';
import { emitToServer } from '../ws/io.js';

export interface TaskHandle {
  id: string;
  /** Fortschritt 0-100 und Statuszeile setzen. */
  update(progress: number, message: string): Promise<void>;
  /** Zeile ins Task-Log schreiben (wird live an die UI gepusht). */
  log(line: string): Promise<void>;
  done(message?: string): Promise<void>;
  fail(error: unknown): Promise<void>;
}

const MAX_LOG_CHARS = 60_000;

export async function createTask(
  serverId: string | null,
  type: string,
  message = 'Wird vorbereitet …',
): Promise<TaskHandle> {
  const task = await prisma.task.create({
    data: { serverId, type, status: 'RUNNING', message, progress: 0 },
  });

  const push = (payload: Record<string, unknown>) => {
    if (serverId) emitToServer(serverId, 'task', { id: task.id, type, ...payload });
  };

  let logBuffer = '';

  const handle: TaskHandle = {
    id: task.id,
    async update(progress, message) {
      await prisma.task.update({
        where: { id: task.id },
        data: { progress: Math.max(0, Math.min(100, Math.round(progress))), message },
      });
      push({ status: 'RUNNING', progress: Math.round(progress), message });
    },
    async log(line) {
      logBuffer = (logBuffer + line + '\n').slice(-MAX_LOG_CHARS);
      await prisma.task.update({ where: { id: task.id }, data: { log: logBuffer } });
      push({ logLine: line });
    },
    async done(message?: string) {
      // Ohne Angabe die zuletzt gesetzte Statuszeile behalten – die ist
      // aussagekräftiger als ein generisches "Fertig".
      const current = await prisma.task.findUnique({
        where: { id: task.id },
        select: { message: true },
      });
      const finalMessage = message ?? current?.message ?? 'Fertig';

      await prisma.task.update({
        where: { id: task.id },
        data: { status: 'DONE', progress: 100, message: finalMessage },
      });
      push({ status: 'DONE', progress: 100, message: finalMessage });
    },
    async fail(error) {
      const msg = error instanceof Error ? error.message : String(error);
      await prisma.task.update({
        where: { id: task.id },
        data: { status: 'FAILED', message: 'Fehlgeschlagen', error: msg },
      });
      push({ status: 'FAILED', message: 'Fehlgeschlagen', error: msg });
    },
  };

  push({ status: 'RUNNING', progress: 0, message });
  return handle;
}

/** Führt eine lange Aktion im Hintergrund aus und protokolliert sie als Task. */
export function runTask(
  serverId: string | null,
  type: string,
  fn: (task: TaskHandle) => Promise<void>,
): Promise<string> {
  return createTask(serverId, type).then((task) => {
    void (async () => {
      try {
        await fn(task);
        await task.done();
      } catch (err) {
        await task.fail(err);
      }
    })();
    return task.id;
  });
}
