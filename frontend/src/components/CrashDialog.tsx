import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Play, Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import type { CrashDiagnosis, PowerState } from '../lib/types';
import { AssistantDialog, useAssistantAvailable } from './AssistantDialog';
import { Button, InfoNote, Modal, Spinner, Toggle, useToast } from './ui';

/**
 * Meldet sich, wenn ein Server abgestuerzt ist und sich im Protokoll eine
 * einzelne Mod als Ursache benennen laesst. Der Schalter deaktiviert sie
 * direkt – das ist in aller Regel genau der naechste Schritt, den man ohnehin
 * von Hand im Reiter Mods gegangen waere.
 */
export function CrashDialog({
  serverId,
  state,
  canManage,
  onRestart,
}: {
  serverId: string;
  state: PowerState;
  canManage: boolean;
  onRestart: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [offen, setOffen] = useState(false);
  // Je Absturz nur einmal aufpoppen: wer wegklickt, soll nicht bei jedem
  // Statuswechsel erneut angesprungen werden.
  const gezeigt = useRef(false);

  useEffect(() => {
    if (state === 'error' && !gezeigt.current) {
      gezeigt.current = true;
      setOffen(true);
    }
    if (state === 'running' || state === 'starting') gezeigt.current = false;
  }, [state]);

  const diagnose = useQuery({
    queryKey: ['diagnose', serverId],
    queryFn: () =>
      api.get<{ diagnosis: CrashDiagnosis | null }>(`/servers/${serverId}/content/diagnose`),
    enabled: offen,
    staleTime: 0,
  });

  const verdacht = diagnose.data?.diagnosis?.suspect ?? null;

  const umschalten = useMutation({
    mutationFn: (filename: string) =>
      api.post<{ enabled: boolean }>(`/servers/${serverId}/content/toggle`, { filename }),
    onSuccess: (res) => {
      toast.success(res.enabled ? 'Wieder eingeschaltet.' : 'Deaktiviert – der Server kann neu starten.');
      void queryClient.invalidateQueries({ queryKey: ['content', serverId] });
      void diagnose.refetch();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const ki = useAssistantAvailable();
  const [kiOffen, setKiOffen] = useState(false);

  // Nichts Belastbares gefunden: dann gar nicht erst aufpoppen. Dass der
  // Server abgestuerzt ist, sagt das Abzeichen im Kopf ohnehin schon. Mit
  // angebundenem KI-Dienst ist genau das aber der Moment, ihn anzubieten.
  if (offen && diagnose.isFetched && !verdacht && !ki) return null;

  const d = diagnose.data?.diagnosis;

  return (
    <>
    <Modal
      open={offen}
      onClose={() => setOffen(false)}
      size="lg"
      title={
        <span className="flex items-center gap-2.5">
          <AlertTriangle size={18} className="text-redstone" />
          Server abgestürzt
        </span>
      }
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => setOffen(false)}>
            Schließen
          </Button>
          {ki && (
            <Button
              variant="ghost"
              icon={<Sparkles size={15} className="text-gold" />}
              onClick={() => setKiOffen(true)}
            >
              KI fragen
            </Button>
          )}
          <Button
            icon={<Play size={15} />}
            onClick={() => {
              setOffen(false);
              onRestart();
            }}
          >
            Jetzt starten
          </Button>
        </div>
      }
    >
      {diagnose.isLoading ? (
        <div className="flex items-center gap-3 py-6 text-sm text-stone-400">
          <Spinner /> Protokoll wird ausgewertet …
        </div>
      ) : d && verdacht ? (
        <div className="space-y-4">
          <div>
            <p className="text-sm font-bold text-stone-100">{d.headline}</p>
            <p className="mt-1.5 text-sm leading-relaxed text-stone-350">{d.reason}</p>
          </div>

          <div className="mc-well space-y-3 p-3.5">
            <div>
              <p className="mc-label">Verantwortlich</p>
              <p className="mt-1 break-all font-mono text-sm text-stone-100">
                {verdacht.filename ?? verdacht.reference}
              </p>
            </div>

            {verdacht.filename ? (
              canManage ? (
                <Toggle
                  checked={verdacht.enabled}
                  disabled={umschalten.isPending}
                  onChange={() => umschalten.mutate(verdacht.filename!)}
                  label={verdacht.enabled ? 'Aktiv – zum Abschalten umlegen' : 'Deaktiviert'}
                />
              ) : (
                <InfoNote>
                  Zum Abschalten fehlt dir das Recht „Modpacks verwalten“.
                </InfoNote>
              )
            ) : (
              <InfoNote>
                Diese Datei liegt nicht mehr im Ordner – vermutlich wurde sie schon entfernt.
              </InfoNote>
            )}
          </div>

          <details className="text-sm">
            <summary className="cursor-pointer text-stone-400 hover:text-stone-100">
              Protokollauszug
            </summary>
            <pre className="mc-well mt-2 max-h-52 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-stone-350">
              {d.excerpt.join('\n')}
            </pre>
          </details>
        </div>
      ) : diagnose.isFetched ? (
        <div className="space-y-3">
          <p className="text-sm leading-relaxed text-stone-350">
            Das Panel konnte im Protokoll keine einzelne Mod als Ursache benennen. Der
            KI-Assistent liest das ganze Protokoll und kann meist sagen, woran es liegt.
          </p>
          {d && d.excerpt.length > 0 && (
            <pre className="mc-well max-h-52 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-stone-350">
              {d.excerpt.join('\n')}
            </pre>
          )}
        </div>
      ) : null}
    </Modal>
    <AssistantDialog serverId={serverId} open={kiOffen} onClose={() => setKiOffen(false)} />
    </>
  );
}
