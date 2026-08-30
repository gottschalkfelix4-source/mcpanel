import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronDown, ChevronUp, Loader2, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import { getSocket } from '../lib/socket';
import type { TaskInfo } from '../lib/types';
import { ProgressBar } from './ui';

interface LiveTask {
  id: string;
  type: string;
  status: 'RUNNING' | 'DONE' | 'FAILED';
  progress: number;
  message: string;
  error?: string;
  log: string[];
}

const TYPE_LABELS: Record<string, string> = {
  'modpack.install': 'Modpack wird installiert',
  'modpack.update': 'Modpack wird aktualisiert',
  'backup.create': 'Backup wird erstellt',
  'backup.restore': 'Backup wird eingespielt',
};

/**
 * Zeigt den laufenden Hintergrund-Task eines Servers mit Live-Fortschritt.
 * `onFinished` wird einmal pro abgeschlossenem Task aufgerufen.
 */
export function TaskProgress({
  serverId,
  types,
  onFinished,
  onRunningChange,
}: {
  serverId: string;
  types?: string[];
  onFinished?: (task: LiveTask) => void;
  /** Meldet, ob gerade ein passender Task läuft. */
  onRunningChange?: (running: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [task, setTask] = useState<LiveTask | null>(null);
  const [expanded, setExpanded] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const finishedRef = useRef<string | null>(null);

  // Beim Öffnen einen evtl. schon laufenden Task übernehmen
  const existing = useQuery({
    queryKey: ['server-tasks', serverId],
    queryFn: () => api.get<TaskInfo[]>(`/servers/${serverId}/tasks`),
    refetchInterval: task?.status === 'RUNNING' ? false : 15_000,
  });

  useEffect(() => {
    if (task || !existing.data) return;
    const running = existing.data.find(
      (t) => t.status === 'RUNNING' && (!types || types.includes(t.type)),
    );
    if (running) {
      setTask({
        id: running.id,
        type: running.type,
        status: 'RUNNING',
        progress: running.progress,
        message: running.message,
        log: running.log ? running.log.split('\n').filter(Boolean) : [],
      });
      setExpanded(true);
    }
  }, [existing.data, task, types]);

  useEffect(() => {
    const socket = getSocket();

    const onTask = (payload: {
      id: string;
      type: string;
      status?: LiveTask['status'];
      progress?: number;
      message?: string;
      error?: string;
      logLine?: string;
    }) => {
      if (types && !types.includes(payload.type)) return;

      setTask((prev) => {
        const base: LiveTask =
          prev && prev.id === payload.id
            ? prev
            : { id: payload.id, type: payload.type, status: 'RUNNING', progress: 0, message: '', log: [] };

        return {
          ...base,
          status: payload.status ?? base.status,
          progress: payload.progress ?? base.progress,
          message: payload.message ?? base.message,
          error: payload.error ?? base.error,
          log: payload.logLine ? [...base.log, payload.logLine].slice(-200) : base.log,
        };
      });

      if (payload.status === 'DONE' || payload.status === 'FAILED') {
        queryClient.invalidateQueries({ queryKey: ['server', serverId] });
        queryClient.invalidateQueries({ queryKey: ['server-tasks', serverId] });
      }
    };

    socket.on('task', onTask);
    return () => {
      socket.off('task', onTask);
    };
  }, [serverId, types, queryClient]);

  useEffect(() => {
    onRunningChange?.(task?.status === 'RUNNING');
  }, [task?.status, onRunningChange]);

  useEffect(() => {
    if (!task || task.status === 'RUNNING') return;
    if (finishedRef.current === task.id) return;
    finishedRef.current = task.id;
    onFinished?.(task);
  }, [task, onFinished]);

  useEffect(() => {
    if (expanded) logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [task?.log.length, expanded]);

  if (!task) return null;

  const done = task.status === 'DONE';
  const failed = task.status === 'FAILED';

  // Statusfarbe zieht sich durch Rahmen, Symbol und Balken.
  const tint = failed ? '#E8453C' : done ? '#17DD62' : '#FFAA00';

  return (
    <div
      className="mc-frame animate-pop-in"
      style={{ borderColor: `${tint}59` }}
    >
      <span className="mc-frame-stud-light" />
      <span className="mc-frame-stud-dark" />

      <div className="mc-frame-inner">
        <div className="flex items-center gap-3 p-3.5">
          <span className="shrink-0">
            {failed ? (
              <XCircle size={20} className="text-redstone" />
            ) : done ? (
              <CheckCircle2 size={20} className="text-emerald" />
            ) : (
              <Loader2 size={20} className="animate-spin text-gold" />
            )}
          </span>

          <div className="min-w-0 flex-1">
            <p className="heading text-sm">{TYPE_LABELS[task.type] ?? task.type}</p>
            <p className="mt-0.5 truncate font-mono text-xs text-stone-350">
              {task.error ?? task.message}
            </p>
            {!done && !failed && (
              <ProgressBar className="mt-2" value={task.progress} tone="gold" showLabel />
            )}
          </div>

          {task.log.length > 0 && (
            <button
              onClick={() => setExpanded((e) => !e)}
              className="shrink-0 text-stone-450 transition hover:text-stone-100"
              title="Protokoll anzeigen"
            >
              {expanded ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
            </button>
          )}
        </div>

        {expanded && task.log.length > 0 && (
          <div
            ref={logRef}
            className="console-view mc-well max-h-48 overflow-y-auto border-x-0 border-b-0 px-3 py-2"
          >
            {task.log.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-words">
                {line}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
