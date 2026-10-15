import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ShieldCheck, ShieldOff } from 'lucide-react';
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

export default function TotpPanel() {
  const { user, adoptToken, refresh } = useAuth();
  const toast = useToast();
  const [setup, setSetup] = useState<{ secret: string; url: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [disabling, setDisabling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () => api.post<{ secret: string; url: string }>('/auth/totp/setup'),
    onSuccess: (res) => { setSetup(res); setCode(''); setError(null); },
    onError: (err: Error) => setError(err.message),
  });

  const enable = useMutation({
    mutationFn: () => api.post<{ token: string }>('/auth/totp/enable', { code }),
    onSuccess: async (res) => {
      adoptToken(res.token);
      setSetup(null);
      setCode('');
      setError(null);
      toast.success('Zweiter Faktor ist aktiv. Andere Geräte wurden abgemeldet.');
      await refresh();
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

  if (!user) return null;

  return (
    <Panel
      title="Zwei-Faktor-Anmeldung"
      icon={<ShieldCheck size={16} />}
      actions={<Badge tone={user.totpEnabled ? 'green' : 'neutral'}>{user.totpEnabled ? 'Aktiv' : 'Aus'}</Badge>}
    >
      <div className="space-y-4">
        {error && <ErrorNote>{error}</ErrorNote>}

        {!user.totpEnabled && !setup && (
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

        {!user.totpEnabled && setup && (
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
            <InfoNote>Nach dem Aktivieren werden alle anderen Sitzungen abgemeldet.</InfoNote>
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

        {user.totpEnabled && !disabling && (
          <>
            <p className="text-sm text-stone-350">
              Die Anmeldung verlangt zusätzlich einen Code aus deiner Authenticator-App. Geht das Gerät
              verloren, kann ein Administrator den zweiten Faktor zurücksetzen.
            </p>
            <Button variant="danger" icon={<ShieldOff size={15} />} onClick={() => { setDisabling(true); setError(null); }}>
              Abschalten
            </Button>
          </>
        )}

        {user.totpEnabled && disabling && (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); disable.mutate(); }}>
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
              <Button type="submit" variant="danger" loading={disable.isPending} disabled={code.length !== 6}>
                Zweiten Faktor abschalten
              </Button>
              <Button type="button" variant="ghost" onClick={() => { setDisabling(false); setError(null); }}>
                Abbrechen
              </Button>
            </div>
          </form>
        )}
      </div>
    </Panel>
  );
}
