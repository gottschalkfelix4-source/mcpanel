import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ArrowDownToLine, Eraser, Send, Terminal } from 'lucide-react';
import { getSocket } from '../../lib/socket';
import { Button, Panel, useToast } from '../../components/ui';
import { useServer } from './ServerLayout';

const MAX_LINES = 3000;

/** ANSI-Steuersequenzen — der itzg-Entrypoint schreibt mit TTY. */
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[ -/]*[@-~]', 'g');
/** Minecraft-Farbcodes wie §a oder §l. */
const MC_COLORS = new RegExp(String.fromCharCode(0xa7) + '[0-9a-fk-or]', 'gi');
/** Reine Prompt-Zeilen des Server-Runners (">...."). */
const PROMPT_ONLY = /^>[\s.]*$/;

/**
 * Aus einer rohen Log-Zeile den lesbaren Text herausziehen.
 * Carriage-Returns überschreiben die Zeile – es zählt nur das letzte Segment.
 */
function cleanLine(raw: string): string {
  const segments = raw.split('\r').filter((s) => s.trim().length > 0);
  const line = (segments[segments.length - 1] ?? '')
    .replace(ANSI, '')
    .replace(MC_COLORS, '')
    .trimEnd();

  return PROMPT_ONLY.test(line) ? '' : line;
}

function lineClass(line: string): string {
  if (/^>/.test(line)) return 'text-diamond';
  if (/\b(ERROR|FATAL|SEVERE)\b/.test(line) || /Exception|at [a-z]+\./.test(line)) return 'text-red-400';
  if (/\bWARN(ING)?\b/.test(line)) return 'text-gold';
  if (/joined the game|logged in with entity id/i.test(line)) return 'text-emerald';
  if (/left the game|lost connection/i.test(line)) return 'text-orange-300';
  if (/Done \(|For help, type/i.test(line)) return 'text-grass-light font-semibold';
  return 'text-stone-300';
}

export default function ConsoleTab() {
  const { server, can, liveState } = useServer();
  const toast = useToast();

  const [lines, setLines] = useState<string[]>([]);
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [filter, setFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [connected, setConnected] = useState(false);

  const viewRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const append = useCallback((incoming: string[]) => {
    setLines((prev) => {
      const next = [...prev, ...incoming.map(cleanLine).filter((l) => l.length > 0)];
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }, []);

  useEffect(() => {
    const socket = getSocket();

    const onHistory = (payload: { serverId?: string; lines: string[] }) => {
      if (payload.serverId && payload.serverId !== server.id) return;
      setLines(payload.lines.map(cleanLine).filter((l) => l.length > 0).slice(-MAX_LINES));
    };
    const onConsole = (payload: { serverId?: string; lines: string[] }) => {
      if (!payload.serverId || payload.serverId === server.id) append(payload.lines);
    };
    const onConnect = () => socket.emit('subscribe', { serverId: server.id }, (res: { ok: boolean; error?: string }) => {
      setConnected(Boolean(res?.ok));
      if (res?.error) toast.error(res.error);
    });
    const onDisconnect = () => setConnected(false);

    socket.on('console:history', onHistory);
    socket.on('console', onConsole);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    if (socket.connected) onConnect();

    return () => {
      socket.off('console:history', onHistory);
      socket.off('console', onConsole);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, [server.id, append, toast]);

  // Nach einem Neustart hängt der alte Log-Stream am toten Container
  useEffect(() => {
    if (liveState === 'running') {
      const timer = setTimeout(() => getSocket().emit('reattach', { serverId: server.id }), 1500);
      return () => clearTimeout(timer);
    }
  }, [liveState, server.id]);

  const visible = useMemo(() => {
    if (!filter.trim()) return lines;
    const q = filter.toLowerCase();
    return lines.filter((l) => l.toLowerCase().includes(q));
  }, [lines, filter]);

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [visible, autoScroll]);

  function onScroll() {
    const el = viewRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setAutoScroll(atBottom);
  }

  function send() {
    const value = command.trim();
    if (!value) return;
    getSocket().emit(
      'command',
      { serverId: server.id, command: value },
      (res: { ok: boolean; error?: string }) => {
        if (!res?.ok && res?.error) toast.error(res.error);
      },
    );
    setHistory((h) => [value, ...h.filter((x) => x !== value)].slice(0, 60));
    setHistoryIndex(-1);
    setCommand('');
    setAutoScroll(true);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      send();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.min(history.length - 1, historyIndex + 1);
      if (next >= 0) {
        setHistoryIndex(next);
        setCommand(history[next]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setCommand(next >= 0 ? history[next] : '');
    }
  }

  function downloadLog() {
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${server.name}-konsole.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Panel
      title="Konsole"
      icon={<Terminal size={16} />}
      subtitle={
        <span className="flex items-center gap-1.5">
          <span
            className={clsx('h-1.5 w-1.5', connected ? 'bg-emerald' : 'bg-redstone animate-pulse-soft')}
          />
          {connected ? 'Live verbunden' : 'Getrennt – versuche erneut …'}
        </span>
      }
      bodyClassName="!p-0"
      actions={
        <div className="flex items-center gap-2">
          <input
            className="mc-input !w-40 !py-1.5 !text-xs"
            placeholder="Filtern …"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <Button
            variant="ghost"
            className="!px-2.5 !py-1.5 !text-xs"
            icon={<ArrowDownToLine size={13} />}
            onClick={downloadLog}
            title="Log herunterladen"
          >
            Log
          </Button>
          <Button
            variant="ghost"
            className="!px-2.5 !py-1.5 !text-xs"
            icon={<Eraser size={13} />}
            onClick={() => setLines([])}
            title="Ansicht leeren"
          >
            Leeren
          </Button>
        </div>
      }
    >
      <div
        ref={viewRef}
        onScroll={onScroll}
        className="console-view mc-well h-[58vh] min-h-[360px] overflow-y-auto border-x-0 px-3 py-2.5"
      >
        {visible.length === 0 ? (
          <p className="py-10 text-center text-stone-450">
            {liveState === 'running'
              ? 'Warte auf Ausgaben …'
              : 'Der Server ist offline. Starte ihn, um die Konsole zu sehen.'}
          </p>
        ) : (
          visible.map((line, i) => (
            <div key={i} className={clsx('whitespace-pre-wrap break-words', lineClass(line))}>
              {line}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {!autoScroll && (
        <button
          onClick={() => {
            setAutoScroll(true);
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
          }}
          className="w-full border-y border-stone-890 bg-stone-800/80 py-1.5 text-xs font-bold uppercase tracking-[0.1em] text-grass-light transition-colors hover:bg-stone-700/70"
        >
          Zum Ende springen
        </button>
      )}

      <div className="flex items-center gap-2 border-t border-stone-890 bg-stone-well/60 p-3">
        <span className="pl-1 font-mono text-grass-light">&gt;</span>
        <input
          className="mc-input font-mono"
          placeholder={
            can('console.command')
              ? 'Befehl eingeben (z. B. say Hallo) – ↑ für Verlauf'
              : 'Du darfst keine Befehle senden'
          }
          value={command}
          disabled={!can('console.command') || liveState !== 'running'}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button
          variant="primary"
          icon={<Send size={15} />}
          disabled={!can('console.command') || liveState !== 'running' || !command.trim()}
          onClick={send}
        >
          Senden
        </Button>
      </div>
    </Panel>
  );
}
