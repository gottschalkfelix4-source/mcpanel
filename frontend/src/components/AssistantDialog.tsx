import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { RotateCcw, Send, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { AssistantMessage } from '../lib/types';
import { Button, InfoNote, Modal, Spinner } from './ui';

/**
 * Ob ein Administrator einen KI-Dienst angebunden hat. Entscheidet, ob der
 * Absturz-Dialog und die Konsole den Knopf ueberhaupt zeigen – ein Knopf, der
 * nur eine Fehlermeldung liefert, ist schlimmer als keiner.
 */
export function useAssistantAvailable(): boolean {
  const q = useQuery({
    queryKey: ['settings-public'],
    queryFn: () => api.get<{ assistantAvailable?: boolean }>('/settings/public'),
    staleTime: 300_000,
  });
  return q.data?.assistantAvailable ?? false;
}

/**
 * Gespraech mit dem KI-Assistenten ueber einen Server. Beim Oeffnen fragt das
 * Panel von sich aus nach der Absturzursache; danach kann der Nutzer
 * nachhaken. Der Verlauf lebt nur in diesem Dialog – nichts wird gespeichert.
 */
export function AssistantDialog({
  serverId,
  open,
  onClose,
}: {
  serverId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const [verlauf, setVerlauf] = useState<AssistantMessage[]>([]);
  const [frage, setFrage] = useState('');
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [modell, setModell] = useState<string | null>(null);
  const endeRef = useRef<HTMLDivElement>(null);
  // Die erste Analyse nur einmal je Oeffnen anstossen, nicht bei jedem Render.
  const gestartet = useRef(false);

  async function fragen(text: string | null, basis: AssistantMessage[]) {
    setBusy(true);
    setFehler(null);
    try {
      const res = await api.post<{ answer: string; model: string }>(
        `/servers/${serverId}/assistant/ask`,
        { question: text ?? undefined, history: basis },
      );
      setModell(res.model);
      setVerlauf([
        ...basis,
        ...(text ? [{ role: 'user' as const, content: text }] : []),
        { role: 'assistant', content: res.answer },
      ]);
    } catch (err) {
      setFehler(err instanceof Error ? err.message : 'Anfrage fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!open) {
      gestartet.current = false;
      return;
    }
    if (gestartet.current) return;
    gestartet.current = true;
    setVerlauf([]);
    setFrage('');
    void fragen(null, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, serverId]);

  useEffect(() => {
    endeRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [verlauf, busy]);

  function nachhaken() {
    const text = frage.trim();
    if (!text || busy) return;
    setFrage('');
    void fragen(text, verlauf);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={
        <span className="flex items-center gap-2.5">
          <Sparkles size={18} className="text-gold" />
          KI-Assistent
          {modell && (
            <span className="font-mono text-[10px] font-normal text-stone-450">{modell}</span>
          )}
        </span>
      }
      footer={
        <div className="flex w-full items-center gap-2">
          <input
            className="mc-input flex-1"
            placeholder="Nachfragen … (z. B. „Ist die Zeile mit veinmining das Problem?“)"
            value={frage}
            disabled={busy}
            onChange={(e) => setFrage(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && nachhaken()}
          />
          <Button
            variant="primary"
            icon={<Send size={15} />}
            disabled={busy || !frage.trim()}
            onClick={nachhaken}
          >
            Fragen
          </Button>
          <Button
            variant="ghost"
            icon={<RotateCcw size={15} />}
            disabled={busy}
            title="Protokoll neu einlesen und von vorn analysieren"
            onClick={() => {
              setVerlauf([]);
              void fragen(null, []);
            }}
          >
            Neu
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-stone-450">
          Das Panel schickt die letzten 400 Protokollzeilen, die Modliste und die Serverdaten an
          den eingerichteten KI-Dienst. Der Assistent liest nur – abschalten oder starten musst du
          selbst.
        </p>

        {verlauf.map((m, i) => (
          <div
            key={i}
            className={clsx(
              'text-sm leading-relaxed',
              m.role === 'user'
                ? 'ml-8 border border-stone-700 bg-stone-800/70 px-3 py-2 text-stone-200'
                : 'mc-well px-3.5 py-3 text-stone-100',
            )}
          >
            {m.role === 'user' ? m.content : <Antwort text={m.content} />}
          </div>
        ))}

        {busy && (
          <div className="flex items-center gap-3 py-2 text-sm text-stone-400">
            <Spinner /> {verlauf.length ? 'Antwort kommt …' : 'Protokoll wird analysiert …'}
          </div>
        )}

        {fehler && (
          <InfoNote>
            {fehler}
            {user?.role === 'ADMIN' && /nicht eingerichtet|API-Key|erreichbar|Modell/.test(fehler) && (
              <>
                {' '}
                <Link to="/admin/settings" className="text-gold hover:underline" onClick={onClose}>
                  Zu den Panel-Einstellungen →
                </Link>
              </>
            )}
          </InfoNote>
        )}

        <div ref={endeRef} />
      </div>
    </Modal>
  );
}

/**
 * Antworten sind schlichter Text mit Absaetzen und "- "-Listen; das System-
 * prompt bittet darum. Modelle streuen trotzdem gern **fett** und `Code`
 * ein – das wird hier abgefangen, alles andere bleibt, wie es ist.
 */
function Antwort({ text }: { text: string }) {
  const zeilen = text.replace(/\r/g, '').split('\n');
  const bloecke: ReactNode[] = [];
  let liste: string[] = [];
  let absatz: string[] = [];

  const flush = () => {
    if (absatz.length) {
      bloecke.push(<p key={bloecke.length}>{inline(absatz.join(' '))}</p>);
      absatz = [];
    }
    if (liste.length) {
      bloecke.push(
        <ul key={bloecke.length} className="list-disc space-y-1 pl-5">
          {liste.map((l, i) => (
            <li key={i}>{inline(l)}</li>
          ))}
        </ul>,
      );
      liste = [];
    }
  };

  for (const roh of zeilen) {
    const zeile = roh.replace(/^#{1,4}\s+/, '').trim();
    const punkt = zeile.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (punkt) {
      if (absatz.length) flush();
      liste.push(punkt[1]);
    } else if (!zeile) {
      flush();
    } else {
      if (liste.length) flush();
      absatz.push(zeile);
    }
  }
  flush();

  return <div className="space-y-2.5">{bloecke}</div>;
}

function inline(text: string): ReactNode {
  const teile = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return teile.map((t, i) => {
    if (/^\*\*[^*]+\*\*$/.test(t)) return <strong key={i} className="text-stone-50">{t.slice(2, -2)}</strong>;
    if (/^`[^`]+`$/.test(t)) {
      return (
        <code key={i} className="rounded-sm bg-stone-900/80 px-1 font-mono text-[12px] text-gold">
          {t.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={i}>{t}</Fragment>;
  });
}
