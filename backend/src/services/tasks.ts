import { prisma } from '../db.js';
import { withServerOperation } from './operations.js';
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
/** Höchstens so oft wird ein laufender Task in die Datenbank geschrieben. */
const PERSIST_INTERVAL_MS = 1500;

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
  let lastMessage = message;
  // Die Oberfläche bekommt jede Zeile sofort per Socket. In die Datenbank
  // (für später geöffnete Seiten) reicht ein gebündelter Stand – sonst schreibt
  // ein Modpack mit 300 Mods 300-mal die kompletten 60 000 Zeichen Log.
  let pending: { log?: string; progress?: number; message?: string } = {};
  let flushTimer: NodeJS.Timeout | null = null;
  let writing: Promise<void> = Promise.resolve();

  const flush = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    const data = pending;
    pending = {};
    if (Object.keys(data).length === 0) return writing;
    writing = writing
      .then(() => prisma.task.update({ where: { id: task.id }, data }))
      .then(() => {}, () => {});
    return writing;
  };
  const schedule = () => {
    if (!flushTimer) {
      flushTimer = setTimeout(() => void flush(), PERSIST_INTERVAL_MS);
      flushTimer.unref?.();
    }
  };

  const handle: TaskHandle = {
    id: task.id,
    async update(progress, message) {
      const value = Math.max(0, Math.min(100, Math.round(progress)));
      lastMessage = message;
      pending.progress = value;
      pending.message = message;
      schedule();
      push({ status: 'RUNNING', progress: value, message });
    },
    async log(line) {
      logBuffer = (logBuffer + line + '\n').slice(-MAX_LOG_CHARS);
      pending.log = logBuffer;
      schedule();
      push({ logLine: line });
    },
    async done(message?: string) {
      // Ohne Angabe die zuletzt gesetzte Statuszeile behalten – die ist
      // aussagekräftiger als ein generisches "Fertig".
      const finalMessage = message ?? lastMessage ?? 'Fertig';
      await flush();
      await prisma.task.update({
        where: { id: task.id },
        data: { status: 'DONE', progress: 100, message: finalMessage },
      });
      push({ status: 'DONE', progress: 100, message: finalMessage });
    },
    async fail(error) {
      const msg = error instanceof Error ? error.message : String(error);
      await flush();
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
/**
 * Laufende Aufgabe je Server. Sicherung, Wiederherstellung und
 * Modpack-Installation schreiben alle in dasselbe Verzeichnis: liefe die
 * naechtliche Sicherung waehrend eines Modpack-Updates, entstuende ein Archiv
 * des halb geleerten `mods/`-Ordners, das wie eine gueltige Sicherung aussieht.
 */


const AUFGABEN_NAMEN: Record<string, string> = {
  'server.import': 'Ein ZIP-Import',
  'backup.create': 'Eine Sicherung',
  'backup.restore': 'Eine Wiederherstellung',
  'modpack.install': 'Eine Modpack-Installation',
  'modpack.update': 'Ein Modpack-Update',
  'server.reinstall': 'Eine Neuinstallation',
  'world.reset': 'Ein Weltreset',
  'world.import': 'Ein Welt-Upload',
};

const aufgabenName = (type: string) => AUFGABEN_NAMEN[type] ?? `Die Aufgabe "${type}"`;

export function runTask(
  serverId: string | null,
  type: string,
  fn: (task: TaskHandle) => Promise<void>,
  waitForCompletion = false,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const execute = async () => {
      const task = await createTask(serverId, type);
      if (!waitForCompletion) resolve(task.id);
      try {
        await fn(task);
        await task.done();
        if (waitForCompletion) resolve(task.id);
      } catch (err) {
        await task.fail(err);
        if (waitForCompletion) reject(err);
      }
    };
    const running = serverId === null ? execute() : withServerOperation(serverId, aufgabenName(type), execute);
    void running.catch(reject);
  });
}
