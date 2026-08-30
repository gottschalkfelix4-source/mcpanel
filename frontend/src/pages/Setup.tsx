import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ArrowLeft, ArrowRight, Check, Container, Globe, KeyRound, Package, PartyPopper,
  TriangleAlert, UserPlus,
} from 'lucide-react';
import { api, tokenStore } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, ErrorNote, Field, InfoNote, LoadingBlock } from '../components/ui';
import { GrassStrip } from '../components/pixel';

interface SetupStatus {
  needsSetup: boolean;
  docker: { ok: boolean; message: string };
  suggestedHost: string;
  portRange: { min: number; max: number };
  dataRoot: string;
  curseforgeConfigured: boolean;
}

const STEPS = ['Willkommen', 'Konto', 'Adresse', 'Modpacks', 'Fertig'] as const;

/**
 * Ersteinrichtung: läuft nur, solange noch kein Konto existiert. Danach
 * antwortet die Schnittstelle mit 403 und das Panel zeigt die Anmeldung.
 */
export default function SetupPage() {
  const { refresh } = useAuth();

  const status = useQuery({
    queryKey: ['setup-status'],
    queryFn: () => api.get<SetupStatus>('/setup/status'),
  });

  const [step, setStep] = useState(0);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [publicHost, setPublicHost] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [keyProbe, setKeyProbe] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const checkKey = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/setup/check-curseforge', { apiKey }),
    onSuccess: setKeyProbe,
    onError: (err: Error) => setKeyProbe({ ok: false, message: err.message }),
  });

  const finish = useMutation({
    mutationFn: () =>
      api.post<{ token: string }>('/setup', {
        username: username.trim(),
        email: email.trim(),
        password,
        publicHost: publicHost.trim() || undefined,
        curseforgeApiKey: apiKey.trim() || undefined,
      }),
    onSuccess: async (res) => {
      // Die Einrichtung liefert das Token gleich mit – kein zweites Anmelden.
      tokenStore.set(res.token);
      setStep(4);
      await refresh();
    },
    onError: (err: Error) => setError(err.message),
  });

  if (status.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingBlock label="Panel wird vorbereitet …" />
      </div>
    );
  }

  const info = status.data;
  const accountOk =
    username.trim().length >= 3 &&
    /.+@.+\..+/.test(email.trim()) &&
    password.length >= 8 &&
    password === password2;

  const next = () => {
    setError(null);
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  };
  const back = () => {
    setError(null);
    setStep((s) => Math.max(0, s - 1));
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-[620px]">
        <div className="mc-frame animate-fade-in">
          <span className="mc-frame-stud-light" />
          <span className="mc-frame-stud-dark" />

          <div className="mc-frame-inner">
            <GrassStrip />

            {/* Schrittanzeige */}
            <div className="flex items-center gap-1 border-b border-stone-890 bg-stone-well/60 px-4 py-3">
              {STEPS.map((label, i) => (
                <div key={label} className="flex min-w-0 flex-1 items-center gap-1">
                  <span
                    className={clsx(
                      'grid h-6 w-6 shrink-0 place-items-center border text-[11px] font-bold transition',
                      i < step
                        ? 'border-grass-light bg-grass/40 text-stone-50'
                        : i === step
                          ? 'border-grass-light bg-grass/[0.18] text-grass-light'
                          : 'border-stone-700 bg-stone-900/60 text-stone-450',
                    )}
                  >
                    {i < step ? <Check size={12} /> : i + 1}
                  </span>
                  <span
                    className={clsx(
                      'hidden truncate text-[11px] font-bold uppercase tracking-[0.06em] sm:block',
                      i === step ? 'text-stone-100' : 'text-stone-450',
                    )}
                  >
                    {label}
                  </span>
                </div>
              ))}
            </div>

            <div className="space-y-4 p-5">
              {error && <ErrorNote>{error}</ErrorNote>}

              {/* 1 – Willkommen und Systemprüfung */}
              {step === 0 && (
                <>
                  <div>
                    <h1 className="heading text-lg">Willkommen bei MCPanel</h1>
                    <p className="mt-2 text-sm leading-relaxed text-stone-350">
                      Vier kurze Schritte, dann läuft dein Panel. Zuerst ein Blick darauf, ob
                      alles bereitsteht.
                    </p>
                  </div>

                  <div className="mc-well space-y-3 p-3.5 text-xs">
                    <CheckRow
                      ok={info?.docker.ok ?? false}
                      icon={<Container size={14} />}
                      label="Docker"
                      value={info?.docker.message ?? '—'}
                    />
                    <CheckRow
                      ok
                      icon={<Package size={14} />}
                      label="Datenverzeichnis"
                      value={info?.dataRoot ?? '—'}
                    />
                    <CheckRow
                      ok
                      icon={<Globe size={14} />}
                      label="Port-Bereich für Server"
                      value={`${info?.portRange.min} – ${info?.portRange.max}`}
                    />
                  </div>

                  {!info?.docker.ok && (
                    <ErrorNote>
                      Der Docker-Socket ist nicht erreichbar. Ohne ihn kann das Panel keine
                      Minecraft-Server starten. Prüfe, ob <code>/var/run/docker.sock</code> in den
                      Container eingehängt ist. Die Einrichtung lässt sich trotzdem abschließen.
                    </ErrorNote>
                  )}
                </>
              )}

              {/* 2 – Administrator */}
              {step === 1 && (
                <>
                  <div>
                    <h1 className="heading flex items-center gap-2 text-lg">
                      <UserPlus size={18} className="text-grass-light" />
                      Dein Konto
                    </h1>
                    <p className="mt-2 text-sm leading-relaxed text-stone-350">
                      Das erste Konto ist Administrator: nur Administratoren legen Server an und
                      vergeben Rechte. Freunde lädst du später zu einzelnen Servern ein.
                    </p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Benutzername">
                      <input
                        className="mc-input w-full"
                        value={username}
                        maxLength={32}
                        autoFocus
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="steve"
                      />
                    </Field>
                    <Field label="E-Mail">
                      <input
                        className="mc-input w-full"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="du@beispiel.de"
                      />
                    </Field>
                    <Field label="Passwort" hint="Mindestens 8 Zeichen.">
                      <input
                        className="mc-input w-full"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                    </Field>
                    <Field
                      label="Passwort wiederholen"
                      hint={
                        password2 && password !== password2 ? 'Stimmt nicht überein.' : undefined
                      }
                    >
                      <input
                        className={clsx(
                          'mc-input w-full',
                          password2 && password !== password2 && '!border-red-500/60',
                        )}
                        type="password"
                        value={password2}
                        onChange={(e) => setPassword2(e.target.value)}
                      />
                    </Field>
                  </div>
                </>
              )}

              {/* 3 – Adresse */}
              {step === 2 && (
                <>
                  <div>
                    <h1 className="heading flex items-center gap-2 text-lg">
                      <Globe size={18} className="text-grass-light" />
                      Server-Adresse
                    </h1>
                    <p className="mt-2 text-sm leading-relaxed text-stone-350">
                      Unter dieser Adresse tragen deine Freunde die Server in Minecraft ein. Das
                      Panel hängt nur den Port an – die Adresse selbst muss von außen erreichbar
                      sein.
                    </p>
                  </div>

                  <Field
                    label="Adresse oder IP"
                    hint="Leer lassen, wenn du erst einmal nur lokal spielst."
                  >
                    <input
                      className="mc-input w-full"
                      value={publicHost}
                      onChange={(e) => setPublicHost(e.target.value)}
                      placeholder={info?.suggestedHost ?? 'localhost'}
                    />
                  </Field>

                  <InfoNote>
                    Damit von außen jemand verbinden kann, brauchst du zusätzlich eine
                    Portfreigabe im Router für {info?.portRange.min}–{info?.portRange.max}. Die
                    Adresse lässt sich später jederzeit ändern.
                  </InfoNote>
                </>
              )}

              {/* 4 – CurseForge */}
              {step === 3 && (
                <>
                  <div>
                    <h1 className="heading flex items-center gap-2 text-lg">
                      <KeyRound size={18} className="text-grass-light" />
                      Modpack-Quellen
                    </h1>
                    <p className="mt-2 text-sm leading-relaxed text-stone-350">
                      <strong className="text-stone-100">Modrinth funktioniert sofort</strong> –
                      dafür ist nichts einzurichten. Für CurseForge braucht es einen kostenlosen
                      API-Schlüssel.
                    </p>
                  </div>

                  <Field
                    label="CurseForge API-Schlüssel"
                    hint="Optional. Zu holen unter console.curseforge.com → API Keys."
                  >
                    <div className="flex flex-wrap gap-2">
                      <input
                        className="mc-input min-w-0 flex-1 font-mono text-xs"
                        type="password"
                        value={apiKey}
                        onChange={(e) => {
                          setApiKey(e.target.value);
                          setKeyProbe(null);
                        }}
                        placeholder="$2a$10$…"
                      />
                      <Button
                        variant="ghost"
                        loading={checkKey.isPending}
                        disabled={!apiKey.trim()}
                        onClick={() => checkKey.mutate()}
                      >
                        Prüfen
                      </Button>
                    </div>
                  </Field>

                  {keyProbe && (
                    <div
                      className={clsx(
                        'flex items-start gap-2 border px-3 py-2.5 text-xs',
                        keyProbe.ok
                          ? 'border-emerald/40 bg-emerald/[0.10] text-emerald'
                          : 'border-red-500/40 bg-red-500/[0.10] text-red-300',
                      )}
                    >
                      {keyProbe.ok ? (
                        <Check size={14} className="mt-0.5 shrink-0" />
                      ) : (
                        <TriangleAlert size={14} className="mt-0.5 shrink-0" />
                      )}
                      <span className="min-w-0 break-words">{keyProbe.message}</span>
                    </div>
                  )}

                  <InfoNote>
                    Ohne Schlüssel bleibt CurseForge in der Modpack-Suche ausgeblendet. Du kannst
                    ihn jederzeit in den Panel-Einstellungen nachtragen.
                  </InfoNote>
                </>
              )}

              {/* 5 – Fertig */}
              {step === 4 && (
                <div className="py-6 text-center">
                  <PartyPopper size={44} className="mx-auto text-grass-light" />
                  <h1 className="heading mt-4 text-lg">Alles bereit</h1>
                  <p className="mx-auto mt-2 max-w-[420px] text-sm leading-relaxed text-stone-350">
                    Du bist angemeldet. Leg deinen ersten Server an – Vanilla, Paper oder direkt
                    ein komplettes Modpack.
                  </p>
                  <div className="mt-5 flex justify-center">
                    <Button variant="primary" onClick={() => window.location.assign('/')}>
                      Zum Panel
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* Navigation */}
            {step < 4 && (
              <div className="flex items-center justify-between gap-3 border-t border-stone-890 bg-stone-well/60 px-4 py-3">
                <Button variant="ghost" icon={<ArrowLeft size={15} />} disabled={step === 0} onClick={back}>
                  Zurück
                </Button>

                {step < 3 ? (
                  <Button
                    variant="primary"
                    icon={<ArrowRight size={15} />}
                    disabled={step === 1 && !accountOk}
                    onClick={next}
                  >
                    Weiter
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    icon={<Check size={15} />}
                    loading={finish.isPending}
                    disabled={!accountOk}
                    onClick={() => {
                      setError(null);
                      finish.mutate();
                    }}
                  >
                    Einrichtung abschließen
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>

        <p className="mt-4 text-center text-xs text-stone-450">
          MCPanel · selbstgehostet · Modpacks von Modrinth &amp; CurseForge
        </p>
      </div>
    </div>
  );
}

function CheckRow({
  ok,
  icon,
  label,
  value,
}: {
  ok: boolean;
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span className={clsx('mt-0.5 shrink-0', ok ? 'text-grass-light' : 'text-red-400')}>
        {ok ? <Check size={14} /> : <TriangleAlert size={14} />}
      </span>
      <span className="shrink-0 text-stone-450">{icon}</span>
      <span className="w-[150px] shrink-0 font-bold uppercase tracking-[0.06em] text-stone-300">
        {label}
      </span>
      <span className="min-w-0 flex-1 break-words font-mono text-stone-350">{value}</span>
    </div>
  );
}
