import { Fragment, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowUpRight, MessageSquareText, Send, Sparkles, X } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import type { AssistantMessage, ServerSummary } from '../lib/types';
import { useAssistantAvailable } from './AssistantDialog';

/**
 * Kobi – die kleine Begleitfigur des Panels. Sitzt unten rechts in der Ecke,
 * schwebt, blinzelt und leuchtet mit der Antenne, wenn der KI-Assistent
 * eingerichtet ist. Ein Klick öffnet das Gespräch:
 *
 * - Ist gerade ein Server geöffnet, redet Kobi NUR über diesen Server
 *   (der Server-Endpunkt prüft den Zugriff bei jeder Frage frisch).
 * - Ohne geöffneten Server sieht Kobi keine Serverdaten und beantwortet
 *   nur allgemeine Fragen – der globale Endpunkt bekommt bewusst keinen
 *   Kontext, damit niemand über fremde Server plaudern kann.
 */

interface ChatEintrag extends AssistantMessage {
  /** Vom Server-Endpunkt vorgeschlagene Reparaturen – hier nur als Hinweis. */
  aktionsHinweis?: boolean;
}

/** Server-ID aus dem Pfad, z. B. /servers/abc123/console → abc123. */
function serverIdFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/servers\/([^/]+)/);
  return m ? m[1] : null;
}

export default function AssistantMascot() {
  const assistantAvailable = useAssistantAvailable();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [verlauf, setVerlauf] = useState<ChatEintrag[]>([]);
  const [frage, setFrage] = useState('');
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [modell, setModell] = useState<string | null>(null);
  const endeRef = useRef<HTMLDivElement>(null);

  const serverId = serverIdFromPath(location.pathname);

  // Servername fürs Badge – gleiche Query wie die Serverliste, kein Zusatzaufruf.
  const servers = useQuery({
    queryKey: ['servers'],
    queryFn: () => api.get<ServerSummary[]>('/servers'),
    staleTime: 30_000,
  });
  const server = serverId ? (servers.data ?? []).find((s) => s.id === serverId) : undefined;

  // Beim Wechsel zwischen Servern bzw. von/zu global den Verlauf nicht mischen.
  useEffect(() => {
    setVerlauf([]);
    setFehler(null);
    setModell(null);
  }, [serverId]);

  useEffect(() => {
    endeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [verlauf, busy]);

  async function fragen(text: string) {
    if (busy) return;
    setBusy(true);
    setFehler(null);
    try {
      const res = serverId
        ? await api.post<{ answer: string; model: string; actions?: unknown[] }>(
            `/servers/${serverId}/assistant/ask`,
            // Nur der eigene Verlauf; das Backend prüft den Zugriff frisch.
            { question: text, history: verlauf.slice(-20) },
          )
        : await api.post<{ answer: string; model: string; actions?: unknown[] }>(
            '/assistant/ask',
            { question: text, history: verlauf.slice(-20) },
          );
      setModell(res.model);
      setVerlauf((v) => [
        ...v,
        { role: 'user', content: text },
        { role: 'assistant', content: res.answer, aktionsHinweis: Boolean(res.actions?.length) },
      ]);
    } catch (err) {
      setFehler(err instanceof Error ? err.message : 'Anfrage fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  function senden() {
    const text = frage.trim();
    if (!text || busy) return;
    setFrage('');
    void fragen(text);
  }

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-3">
      {open && (
        <div className="mc-frame w-[380px] max-w-[calc(100vw-2rem)] animate-pop-in bg-[#1b1b20]/[0.97]">
          <div className="mc-frame-inner flex max-h-[70vh] flex-col">
            <div className="flex items-center gap-2.5 border-b border-stone-800 bg-stone-800/40 px-3.5 py-3">
              <KobiFigur size={30} thinking={busy} muted className="shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-sm font-bold text-stone-50">
                  <Sparkles size={13} className="text-gold" />
                  Kobi
                  <span className="font-mono text-[9px] font-normal text-stone-450">
                    {modell ?? 'KI-Assistent'}
                  </span>
                </p>
                {server ? (
                  <Link
                    to={`/servers/${server.id}`}
                    className="mt-0.5 inline-flex max-w-full items-center gap-1 truncate rounded border border-grass-dark/60 bg-grass/[0.14] px-1.5 py-0.5 text-[10px] font-semibold text-grass-light transition hover:bg-grass/25"
                    title="Kobi redet nur über diesen Server"
                  >
                    <MessageSquareText size={10} className="shrink-0" />
                    <span className="truncate">{server.name}</span>
                    <ArrowUpRight size={10} className="shrink-0" />
                  </Link>
                ) : (
                  <p className="mt-0.5 inline-flex items-center gap-1 rounded border border-stone-700 bg-stone-800/70 px-1.5 py-0.5 text-[10px] font-semibold text-stone-400">
                    Ohne Serverkontext – Kobi sieht keine Serverdaten
                  </p>
                )}
              </div>
              <button
                onClick={() => setOpen(false)}
                aria-label="Chat schließen"
                className="rounded border border-stone-700 p-1 text-stone-400 transition hover:border-stone-500 hover:text-white"
              >
                <X size={13} />
              </button>
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto px-3.5 py-3">


              {assistantAvailable === false ? (
                <p className="text-sm leading-relaxed text-stone-400">
                  Ein Administrator muss zuerst unter <em>Einstellungen → KI-Assistent</em> einen
                  Dienst anbinden (Anthropic oder einen OpenAI-kompatiblen Anbieter). Danach
                  plaudere ich gern mit dir.
                </p>
              ) : verlauf.length === 0 ? (
                <p className="text-sm leading-relaxed text-stone-400">
                  {server
                    ? `Ich schaue gerade auf „${server.name}" – Protokoll, Modliste und Serverdaten. Frag mich, was dort los ist, oder ob etwas Bestimmtes im Protokoll verdächtig ist.`
                    : 'Hallo! Ich bin Kobi. Ohne geöffneten Server sehe ich keine Daten aus dem Panel – aber allgemeine Fragen beantworte ich gern: Was ist ein Modpack, wie richte ich Backups ein, welcher Loader ist was? Für deinen eigenen Server öffnest du ihn einfach links.'}
                </p>
              ) : (
                verlauf.map((m, i) => (
                  <Fragment key={i}>
                    {m.role === 'user' ? (
                      <div className="flex justify-end">
                        <p className="max-w-[85%] whitespace-pre-wrap rounded border border-stone-700 bg-stone-800/80 px-3 py-2 text-sm leading-relaxed text-stone-100">
                          {m.content}
                        </p>
                      </div>
                    ) : (
                      <div className="flex items-start gap-2">
                        <KobiFigur size={24} thinking={false} muted className="mt-0.5 shrink-0" />
                        <div className="min-w-0 max-w-[85%]">
                          <p className="whitespace-pre-wrap rounded border border-stone-800 bg-stone-900/60 px-3 py-2 text-sm leading-relaxed text-stone-200">
                            {m.content}
                          </p>
                          {m.aktionsHinweis && (
                            <p className="mt-1 text-[10px] text-stone-450">
                              Kobi hat Reparatur-Vorschläge – im Server-Dialog „KI fragen“ kannst du
                              sie einzeln prüfen und freigeben.
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                  </Fragment>
                ))
              )}

              {busy && (
                <div className="flex items-center gap-2 text-xs text-stone-450">
                  <span className="flex gap-0.5">
                    {[0, 1, 2].map((p) => (
                      <span
                        key={p}
                        className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-grass"
                        style={{ animationDelay: `${p * 0.18}s` }}
                      />
                    ))}
                  </span>
                  {server ? `Kobi denkt über „${server.name}" nach …` : 'Kobi denkt nach …'}
                </div>
              )}
              {fehler && (
                <p className="rounded border border-redstone/40 bg-redstone/10 px-3 py-2 text-xs leading-relaxed text-redstone">
                  {fehler}
                </p>
              )}
              <div ref={endeRef} />
            </div>

            <div className="flex items-center gap-2 border-t border-stone-800 p-3">
              <input
                className="mc-input flex-1 !text-sm"
                placeholder={server ? `Frage zu „${server.name}" …` : 'Frage an Kobi …'}
                value={frage}
                disabled={busy || assistantAvailable === false}
                onChange={(e) => setFrage(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && senden()}
              />
              <button
                onClick={senden}
                disabled={!frage.trim() || busy || assistantAvailable === false}
                aria-label="Senden"
                className="rounded border border-grass-dark bg-grass/90 p-2 text-stone-950 transition hover:bg-grass disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Send size={14} />
              </button>
            </div>
          </div>
        </div>
      )}

      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? 'Chat schließen' : 'Mit Kobi chatten'}
        title={assistantAvailable ? 'Mit Kobi chatten' : 'KI-Assistent ist nicht eingerichtet'}
        className={clsx(
          'group relative rounded-full border-2 transition hover:scale-105 active:scale-95',
          open ? 'border-grass-light bg-[#1b1b20]' : 'border-stone-600 bg-[#1b1b20] hover:border-grass',
        )}
      >
        {assistantAvailable && !open && (
          <span className="absolute -right-1 -top-1 h-3.5 w-3.5 animate-ring rounded-full bg-emerald ring-2 ring-[#1b1b20]" />
        )}
        <KobiFigur size={64} thinking={busy && open} />
      </button>
    </div>
  );
}

/**
 * Die Figur selbst: Antenne mit Leuchtkugel, blinzelnde Pixel-Augen, Display
 * auf dem Bauch. `thinking` wippt schneller, dann pulsiert die Kugel wild
 * und über dem Kopf erscheinen Denkpunkte.
 */
export function KobiFigur({
  size = 64,
  thinking = false,
  muted = false,
  className,
}: {
  size?: number;
  thinking?: boolean;
  muted?: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 64 74"
      width={size}
      height={size * (74 / 64)}
      className={clsx(className, thinking ? 'animate-mascot-think' : 'animate-mascot-float')}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {/* Schatten unter der Figur – atmet gegenläufig zum Schweben */}
      <ellipse cx="32" cy="71" rx="15" ry="3" fill="rgba(0,0,0,.5)" className="animate-shadow-breathe" />

      {/* Antenne */}
      <rect x="30" y="4" width="4" height="10" fill="#2c2c33" />
      <circle
        cx="32"
        cy="3.5"
        r="4.5"
        fill={muted ? '#6b6b76' : '#7FB238'}
        className={thinking ? 'animate-pulse-soft' : 'animate-antenna-pulse'}
      />

      {/* Denkpunkte, während Kobi arbeitet */}
      {thinking && (
        <g>
          {[0, 1, 2].map((p) => (
            <circle
              key={p}
              cx={22 + p * 7}
              cy={9}
              r="2"
              fill="#a9a9b4"
              className="animate-pulse-soft"
              style={{ animationDelay: `${p * 0.2}s` }}
            />
          ))}
        </g>
      )}

      {/* Kopf */}
      <rect x="13" y="13" width="38" height="31" fill="#45454f" stroke="#1c1c21" strokeWidth="2" />

      {/* Augen – blinzeln in der Gruppe */}
      <g className="animate-blink" style={{ transformBox: 'fill-box', transformOrigin: 'center' }}>
        <rect x="19" y="21" width="10" height="12" fill="#f4f4f5" />
        <rect x="35" y="21" width="10" height="12" fill="#f4f4f5" />
        <rect x="22" y="24" width="4" height="5" fill="#1c1c21" />
        <rect x="38" y="24" width="4" height="5" fill="#1c1c21" />
      </g>

      {/* Mund – öffnet sich, während Kobi arbeitet */}
      <rect
        x="25"
        y="37"
        width="14"
        height="4"
        fill="#1c1c21"
        className={thinking ? 'animate-talk' : undefined}
        style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
      />

      {/* Wangen */}
      <rect x="16" y="30" width="3" height="3" fill={muted ? '#4a4a54' : '#6b8b3a'} opacity="0.8" />
      <rect x="45" y="30" width="3" height="3" fill={muted ? '#4a4a54' : '#6b8b3a'} opacity="0.8" />

      {/* Arme */}
      <rect x="8" y="45" width="6" height="14" fill="#3a3a44" stroke="#1c1c21" strokeWidth="1.5" />
      <rect x="50" y="45" width="6" height="14" fill="#3a3a44" stroke="#1c1c21" strokeWidth="1.5" />

      {/* Körper */}
      <rect x="19" y="44" width="26" height="17" fill="#3a3a44" stroke="#1c1c21" strokeWidth="2" />

      {/* Display auf dem Bauch */}
      <rect x="24" y="48" width="16" height="9" fill="#101014" />
      <rect x="26.5" y="50.5" width="4" height="4" fill={muted ? '#4a4a54' : '#7FB238'} />
      <rect x="32" y="50.5" width="3" height="3" fill="#3a3a44" />
      <rect x="26.5" y="55" width="3" height="1.5" fill="#3a3a44" />

      {/* Füße */}
      <rect x="20" y="61" width="10" height="7" fill="#2c2c33" stroke="#1c1c21" strokeWidth="1.5" />
      <rect x="34" y="61" width="10" height="7" fill="#2c2c33" stroke="#1c1c21" strokeWidth="1.5" />
    </svg>
  );
}

