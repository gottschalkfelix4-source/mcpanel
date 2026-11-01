import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Ban, CheckCircle2, RotateCcw, Send, ShieldAlert, Sparkles, Wrench, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { AssistantAction, AssistantMessage } from '../lib/types';
import { TaskProgress } from './TaskProgress';
import { Badge, Button, ErrorNote, InfoNote, Modal, Spinner, Toggle } from './ui';

/** Eine Antwort samt der Reparaturen, die der Assistent dazu vorschlaegt. */
type Eintrag = AssistantMessage & { actions?: AssistantAction[] };

/** Was aus einem Vorschlag geworden ist – lebt wie der Verlauf nur im Dialog. */
interface AktionsStand {
  stand: 'abgelehnt' | 'laeuft' | 'erledigt' | 'fehler';
  taskId?: string;
  fehler?: string;
}

const AKTIONS_TASKS = ['assistant.action'];

/**
 * Ob ein Administrator einen KI-Dienst angebunden hat. Entscheidet, ob der
 * Absturz-Dialog und die Konsole den Knopf ueberhaupt zeigen – ein Knopf, der
 * nur eine Fehlermeldung liefert, ist schlimmer als keiner.
 */
export function useAssistantAvailable(): boolean {
  return usePublicSettings().data?.assistantAvailable ?? false;
}

function usePublicSettings() {
  return useQuery({
    queryKey: ['settings-public'],
    queryFn: () =>
      api.get<{ assistantAvailable?: boolean; assistantActions?: boolean }>('/settings/public'),
    staleTime: 300_000,
  });
}

/**
 * Der Verlauf fuer die naechste Frage: unter jeder Antwort steht, was aus
 * ihren Vorschlaegen geworden ist. Sonst schlaegt der Assistent Abgelehntes
 * erneut vor oder haelt Ausgefuehrtes fuer offen.
 */
function fuerVerlauf(verlauf: Eintrag[], staende: Record<string, AktionsStand>): AssistantMessage[] {
  return verlauf.map(({ role, content, actions }) => {
    if (!actions?.length) return { role, content };
    const notizen = actions.map((a) => {
      if (a.blockiert) return `„${a.titel}“: vom Panel gesperrt (${a.blockiert})`;
      const s = a.id ? staende[a.id] : undefined;
      if (!s) return `„${a.titel}“: noch nicht freigegeben`;
      if (s.stand === 'abgelehnt') return `„${a.titel}“: vom Nutzer abgelehnt`;
      if (s.stand === 'laeuft') return `„${a.titel}“: läuft gerade`;
      if (s.stand === 'erledigt') return `„${a.titel}“: ausgeführt`;
      return `„${a.titel}“: fehlgeschlagen (${s.fehler ?? 'unbekannt'})`;
    });
    return { role, content: `${content}\n\n[Panel: ${notizen.join('; ')}]` };
  });
}

/**
 * Gespraech mit dem KI-Assistenten ueber einen Server. Beim Oeffnen fragt das
 * Panel von sich aus nach der Absturzursache; danach kann der Nutzer
 * nachhaken. Der Verlauf lebt nur in diesem Dialog – nichts wird gespeichert.
 *
 * Schlaegt der Assistent Reparaturen vor, erscheinen sie als Karten unter
 * seiner Antwort. Jede muss einzeln geprueft und freigegeben werden.
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
  const reparaturen = usePublicSettings().data?.assistantActions ?? false;
  const [verlauf, setVerlauf] = useState<Eintrag[]>([]);
  const [staende, setStaende] = useState<Record<string, AktionsStand>>({});
  const [frage, setFrage] = useState('');
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [modell, setModell] = useState<string | null>(null);
  const endeRef = useRef<HTMLDivElement>(null);
  // Die erste Analyse nur einmal je Oeffnen anstossen, nicht bei jedem Render.
  const gestartet = useRef(false);

  async function fragen(text: string | null, basis: Eintrag[]) {
    setBusy(true);
    setFehler(null);
    try {
      const res = await api.post<{ answer: string; model: string; actions?: AssistantAction[] }>(
        `/servers/${serverId}/assistant/ask`,
        // Hoechstens 20 Eintraege nimmt das Panel an – die aeltesten fallen weg.
        { question: text ?? undefined, history: fuerVerlauf(basis, staende).slice(-20) },
      );
      setModell(res.model);
      setVerlauf([
        ...basis,
        ...(text ? [{ role: 'user' as const, content: text }] : []),
        { role: 'assistant', content: res.answer, actions: res.actions ?? [] },
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
    setStaende({});
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
              setStaende({});
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
          den eingerichteten KI-Dienst.{' '}
          {reparaturen
            ? 'Der Assistent kann Reparaturen vorschlagen – ausgeführt wird nur, was du einzeln prüfst und freigibst, und nur im Rahmen deiner eigenen Rechte.'
            : 'Der Assistent liest nur – abschalten oder starten musst du selbst.'}
        </p>

        {verlauf.map((m, i) => (
          <Fragment key={i}>
            <div
              className={clsx(
                'text-sm leading-relaxed',
                m.role === 'user'
                  ? 'ml-8 border border-stone-700 bg-stone-800/70 px-3 py-2 text-stone-200'
                  : 'mc-well px-3.5 py-3 text-stone-100',
              )}
            >
              {m.role === 'user' ? m.content : <Antwort text={m.content} />}
            </div>
            {m.actions?.map((a, j) => (
              <AktionsKarte
                key={a.id ?? `${i}-${j}`}
                serverId={serverId}
                aktion={a}
                stand={a.id ? staende[a.id] : undefined}
                onStand={(s) => {
                  if (a.id) setStaende((alt) => ({ ...alt, [a.id!]: s }));
                }}
              />
            ))}
          </Fragment>
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

const RISIKO: Record<AssistantAction['risiko'], { label: string; tone: 'green' | 'gold' | 'red' }> = {
  niedrig: { label: 'geringes Risiko', tone: 'green' },
  mittel: { label: 'mittleres Risiko', tone: 'gold' },
  hoch: { label: 'hohes Risiko', tone: 'red' },
};

/**
 * Ein Reparaturvorschlag. Ausgefuehrt wird erst nach den Sicherheitsfragen:
 * gelesen bestaetigen, bei Dateiaenderungen ueber ein Backup entscheiden und
 * bei hohem Risiko den Servernamen abtippen. Das Backend prueft dasselbe noch
 * einmal – die Karte ist nur die Oberflaeche dafuer.
 */
function AktionsKarte({
  serverId,
  aktion,
  stand,
  onStand,
}: {
  serverId: string;
  aktion: AssistantAction;
  stand?: AktionsStand;
  onStand: (s: AktionsStand) => void;
}) {
  const queryClient = useQueryClient();
  const [pruefen, setPruefen] = useState(false);
  const [gelesen, setGelesen] = useState(false);
  const [sicherung, setSicherung] = useState(aktion.sicherung === 'empfohlen');
  const [getippt, setGetippt] = useState('');
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  const risiko = RISIKO[aktion.risiko];
  const nameOk = !aktion.bestaetigungsText || getippt.trim() === aktion.bestaetigungsText;
  const bereit = gelesen && nameOk && !busy;

  async function freigeben() {
    if (!aktion.id || !bereit) return;
    setBusy(true);
    setFehler(null);
    try {
      const res = await api.post<{ taskId: string }>(
        `/servers/${serverId}/assistant/actions/${aktion.id}/execute`,
        { sicherung, bestaetigung: aktion.bestaetigungsText ? getippt.trim() : undefined },
      );
      onStand({ stand: 'laeuft', taskId: res.taskId });
    } catch (err) {
      setFehler(err instanceof Error ? err.message : 'Freigabe fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  const kopf = (
    <div className="flex flex-wrap items-center gap-2">
      <Wrench size={15} className="shrink-0 text-gold" />
      <span className="heading text-[13px]">{aktion.titel}</span>
      {!aktion.blockiert && <Badge tone={risiko.tone}>{risiko.label}</Badge>}
    </div>
  );

  // Vom Panel gesperrt: zeigen, was die KI wollte und warum es nicht geht.
  if (aktion.blockiert) {
    return (
      <div className="ml-4 space-y-1.5 border border-stone-700 bg-stone-900/60 px-3.5 py-2.5 text-sm text-stone-400">
        {kopf}
        <p className="flex items-start gap-2 text-xs">
          <Ban size={14} className="mt-0.5 shrink-0 text-stone-500" />
          Nicht ausführbar: {aktion.blockiert}
        </p>
      </div>
    );
  }

  return (
    <div
      className={clsx(
        'ml-4 space-y-2.5 border px-3.5 py-3 text-sm',
        aktion.risiko === 'hoch' ? 'border-redstone/40 bg-redstone/[0.06]' : 'border-gold/30 bg-gold/[0.05]',
      )}
    >
      {kopf}

      <div>
        <p className="mb-1 text-xs text-stone-450">Das Panel würde:</p>
        <ul className="list-disc space-y-1 pl-5 text-stone-200">
          {aktion.schritte.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </div>

      {aktion.grund && (
        <p className="text-xs text-stone-400">
          <span className="text-stone-450">Begründung der KI (ungeprüft):</span> {aktion.grund}
        </p>
      )}
      {aktion.rueckgaengig && (
        <p className="text-xs text-stone-400">
          <span className="text-stone-450">Rückgängig:</span> {aktion.rueckgaengig}
        </p>
      )}

      {stand?.stand === 'laeuft' && stand.taskId && (
        <TaskProgress
          serverId={serverId}
          types={AKTIONS_TASKS}
          taskId={stand.taskId}
          onFinished={(t) => {
            onStand(t.status === 'DONE' ? { stand: 'erledigt' } : { stand: 'fehler', fehler: t.error ?? t.message });
            // Mods, Konfiguration, Zustand – was sich geaendert hat, neu laden.
            void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes(serverId) });
          }}
        />
      )}
      {stand?.stand === 'erledigt' && (
        <p className="flex items-center gap-2 text-emerald">
          <CheckCircle2 size={15} /> Ausgeführt.
        </p>
      )}
      {stand?.stand === 'fehler' && (
        <p className="flex items-start gap-2 text-redstone">
          <XCircle size={15} className="mt-0.5 shrink-0" /> Fehlgeschlagen: {stand.fehler}
        </p>
      )}
      {stand?.stand === 'abgelehnt' && (
        <p className="text-xs text-stone-450">Abgelehnt – es wurde nichts geändert.</p>
      )}

      {!stand && !pruefen && (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" icon={<ShieldAlert size={15} />} onClick={() => setPruefen(true)}>
            Prüfen &amp; freigeben
          </Button>
          <Button variant="ghost" onClick={() => onStand({ stand: 'abgelehnt' })}>
            Ablehnen
          </Button>
        </div>
      )}

      {!stand && pruefen && (
        <div className="space-y-3 border-t border-stone-700/70 pt-3">
          {aktion.risiko !== 'niedrig' && (
            <ErrorNote>
              Die KI kann sich irren oder durch Text im Protokoll (etwa Chatnachrichten von Spielern)
              getäuscht werden. Gib nur frei, was du selbst nachvollziehen kannst.
            </ErrorNote>
          )}

          <label className="flex cursor-pointer items-start gap-2.5 text-stone-200">
            <input
              type="checkbox"
              className="mt-1"
              checked={gelesen}
              onChange={(e) => setGelesen(e.target.checked)}
            />
            Ich habe gelesen, was das Panel tun wird, und will es ausführen.
          </label>

          {aktion.sicherung !== 'keine' && (
            <Toggle
              checked={sicherung}
              onChange={setSicherung}
              label={`Vorher ein Backup anlegen${aktion.sicherung === 'empfohlen' ? ' (empfohlen)' : ''}`}
            />
          )}

          {aktion.bestaetigungsText && (
            <div>
              <label className="mc-label">
                Tippe <span className="text-redstone">{aktion.bestaetigungsText}</span> zum Bestätigen
              </label>
              <input
                className="mc-input"
                value={getippt}
                onChange={(e) => setGetippt(e.target.value)}
                autoComplete="off"
              />
            </div>
          )}

          {fehler && <ErrorNote>{fehler}</ErrorNote>}

          <div className="flex flex-wrap gap-2">
            <Button
              variant={aktion.risiko === 'hoch' ? 'danger' : 'primary'}
              loading={busy}
              disabled={!bereit}
              onClick={() => void freigeben()}
            >
              Jetzt ausführen
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setPruefen(false)}>
              Abbrechen
            </Button>
          </div>
        </div>
      )}
    </div>
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
