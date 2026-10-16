import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Copy, Download, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';
import qrcode from 'qrcode-generator';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, ErrorNote, Field, InfoNote, Panel, useToast } from './ui';

/** QR-Code als SVG – ohne innerHTML und ohne Anfrage an einen fremden Dienst. */
function QrCode({ value }: { value: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`;
      }
    }
    return { size: count + 8, path: d };
  }, [value]);
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="h-48 w-48 border border-stone-950 bg-white"
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR-Code für die Authenticator-App"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}

const cleanCode = (value: string) => value.replace(/[^0-9]/g, '').slice(0, 6);

/**
 * Wiederherstellungscodes werden genau einmal gezeigt. Erst mit der
 * Bestätigung geht es weiter – bei vorgeschriebenem zweiten Faktor wechselt
 * danach die ganze Oberfläche, und die Codes wären sonst weg.
 */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const toast = useToast();
  const text = `MCPanel – Wiederherstellungscodes\nJeder Code gilt genau einmal.\n\n${codes.join('\n')}\n`;

  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'mcpanel-wiederherstellungscodes.txt';
    link.click();
    URL.revokeObjectURL(url);
  }

  function copy() {
    navigator.clipboard.writeText(text).then(
      () => toast.success('Codes kopiert.'),
      () => toast.error('Kopieren nicht möglich – bitte als Datei speichern.'),
    );
  }

  return (
    <div className="space-y-4">
      <InfoNote>
        Mit diesen Codes kommst du ohne Authenticator-App ins Konto – etwa wenn das Handy verloren ist. Jeder Code
        gilt genau einmal. Bewahre sie getrennt vom Passwort auf; sie werden nur jetzt angezeigt.
      </InfoNote>
      <ul className="grid grid-cols-2 gap-2 border border-stone-950 bg-stone-950/40 p-3 font-mono text-sm text-stone-100">
        {codes.map((c) => <li key={c} className="text-center">{c}</li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button icon={<Copy size={15} />} onClick={copy}>Kopieren</Button>
        <Button icon={<Download size={15} />} onClick={download}>Als Datei speichern</Button>
        <Button variant="primary" onClick={onDone}>Ich habe die Codes gesichert</Button>
      </div>
    </div>
  );
}

export default function TotpPanel() {
  const { user, adoptToken, refresh } = useAuth();
  const toast = useToast();
  const [setup, setSetup] = useState<{ secret: string; url: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [disabling, setDisabling] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () => api.post<{ secret: string; url: string }>('/auth/totp/setup'),
    onSuccess: (res) => { setSetup(res); setCode(''); setError(null); },
    onError: (err: Error) => setError(err.message),
  });

  const enable = useMutation({
    mutationFn: () => api.post<{ token: string; recoveryCodes: string[] }>('/auth/totp/enable', { code }),
    onSuccess: (res) => {
      adoptToken(res.token);
      setSetup(null);
      setCode('');
      setError(null);
      // Erst nach dem Sichern der Codes neu laden (siehe RecoveryCodes).
      setCodes(res.recoveryCodes);
      toast.success('Zweiter Faktor ist aktiv. Andere Geräte wurden abgemeldet.');
    },
    onError: (err: Error) => setError(err.message),
  });

  const disable = useMutation({
    mutationFn: () => api.post('/auth/totp/disable', { password, code }),
    onSuccess: async () => {
      setDisabling(false);
      setPassword('');
      setCode('');
      setError(null);
      toast.success('Zweiter Faktor wurde abgeschaltet.');
      await refresh();
    },
    onError: (err: Error) => setError(err.message),
  });

  const regenerate = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>('/auth/totp/recovery-codes', { password, code }),
    onSuccess: (res) => {
      setRegenerating(false);
      setPassword('');
      setCode('');
      setError(null);
      setCodes(res.recoveryCodes);
    },
    onError: (err: Error) => setError(err.message),
  });

  if (!user) return null;
  const active = user.totpEnabled || codes !== null;

  function cancel() {
    setDisabling(false);
    setRegenerating(false);
    setPassword('');
    setCode('');
    setError(null);
  }

  return (
    <Panel
      title="Zwei-Faktor-Anmeldung"
      icon={<ShieldCheck size={16} />}
      actions={<Badge tone={active ? 'green' : 'neutral'}>{active ? 'Aktiv' : 'Aus'}</Badge>}
    >
      <div className="space-y-4">
        {error && <ErrorNote>{error}</ErrorNote>}

        {codes && <RecoveryCodes codes={codes} onDone={() => { setCodes(null); void refresh(); }} />}

        {!active && !setup && (
          <>
            <p className="text-sm text-stone-350">
              Zusätzlich zum Passwort fragt das Panel bei der Anmeldung nach einem sechsstelligen Code aus
              einer Authenticator-App (z. B. Aegis, Google Authenticator, 1Password). Das gilt auch für SFTP:
              dort wird der Code direkt an das Passwort angehängt.
            </p>
            <Button variant="primary" icon={<ShieldCheck size={15} />} loading={start.isPending} onClick={() => start.mutate()}>
              Einrichten
            </Button>
          </>
        )}

        {!active && setup && (
          <form
            className="space-y-4"
            onSubmit={(e) => { e.preventDefault(); enable.mutate(); }}
          >
            <div className="flex flex-col items-start gap-4 sm:flex-row">
              <QrCode value={setup.url} />
              <div className="min-w-0 space-y-2 text-sm text-stone-350">
                <p>1. Den Code mit der Authenticator-App scannen.</p>
                <p>
                  Ohne Kamera den Schlüssel von Hand eintragen:
                  <code className="mt-1 block break-all font-mono text-xs text-stone-100">{setup.secret}</code>
                </p>
                <p>2. Den angezeigten sechsstelligen Code unten eintragen.</p>
              </div>
            </div>
            <Field label="Code aus der App">
              <input
                className="mc-input max-w-[12rem] text-center font-mono tracking-[0.3em]"
                value={code}
                onChange={(e) => setCode(cleanCode(e.target.value))}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
              />
            </Field>
            <InfoNote>
              Nach dem Aktivieren werden alle anderen Sitzungen abgemeldet. Du bekommst zehn
              Wiederherstellungscodes für den Fall, dass die App einmal nicht greifbar ist.
            </InfoNote>
            <div className="flex gap-2">
              <Button type="submit" variant="primary" loading={enable.isPending} disabled={code.length !== 6}>
                Aktivieren
              </Button>
              <Button type="button" variant="ghost" onClick={() => { setSetup(null); setError(null); }}>
                Abbrechen
              </Button>
            </div>
          </form>
        )}

        {user.totpEnabled && !codes && !disabling && !regenerating && (
          <>
            <p className="text-sm text-stone-350">
              Die Anmeldung verlangt zusätzlich einen Code aus deiner Authenticator-App. Ohne die App hilft ein
              Wiederherstellungscode; geht beides verloren, kann ein Administrator den zweiten Faktor zurücksetzen.
            </p>
            {user.recoveryCodesLeft <= 2 ? (
              <ErrorNote>
                Nur noch {user.recoveryCodesLeft} von 10 Wiederherstellungscodes übrig – am besten neue erzeugen.
              </ErrorNote>
            ) : (
              <p className="text-sm text-stone-300">Noch {user.recoveryCodesLeft} von 10 Wiederherstellungscodes übrig.</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button icon={<KeyRound size={15} />} onClick={() => { setRegenerating(true); setError(null); }}>
                Neue Wiederherstellungscodes
              </Button>
              <Button variant="danger" icon={<ShieldOff size={15} />} onClick={() => { setDisabling(true); setError(null); }}>
                Abschalten
              </Button>
            </div>
          </>
        )}

        {user.totpEnabled && !codes && (disabling || regenerating) && (
          <form
            className="space-y-4"
            onSubmit={(e) => { e.preventDefault(); if (regenerating) regenerate.mutate(); else disable.mutate(); }}
          >
            {regenerating && (
              <p className="text-sm text-stone-350">
                Die bisherigen Wiederherstellungscodes verlieren damit ihre Gültigkeit.
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Passwort">
                <input
                  className="mc-input"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </Field>
              <Field label="Aktueller Code">
                <input
                  className="mc-input text-center font-mono tracking-[0.3em]"
                  value={code}
                  onChange={(e) => setCode(cleanCode(e.target.value))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                />
              </Field>
            </div>
            <div className="flex gap-2">
              {regenerating ? (
                <Button type="submit" variant="primary" loading={regenerate.isPending} disabled={code.length !== 6}>
                  Neue Codes erzeugen
                </Button>
              ) : (
                <Button type="submit" variant="danger" loading={disable.isPending} disabled={code.length !== 6}>
                  Zweiten Faktor abschalten
                </Button>
              )}
              <Button type="button" variant="ghost" onClick={cancel}>
                Abbrechen
              </Button>
            </div>
          </form>
        )}
      </div>
    </Panel>
  );
}
