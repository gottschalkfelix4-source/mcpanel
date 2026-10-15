import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Boxes, LogIn, ShieldCheck } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { api, ApiError, NETWORK_ERROR_MESSAGE, NetworkError } from '../lib/api';
import { Button, ErrorNote } from '../components/ui';
import { BlockIcon, Motes } from '../components/pixel';

export default function LoginPage() {
  const { login, loginTotp } = useAuth();

  // Fassung und Anzahl der Konten - hilft bei der Frage, warum hier die
  // Anmeldung steht und nicht der Einrichtungsassistent.
  const status = useQuery({
    queryKey: ['setup-status'],
    queryFn: () =>
      api.get<{
        needsSetup: boolean;
        build: { version: string | null; revision: string | null; date: string | null };
      }>('/setup/status'),
    staleTime: 300_000,
  });
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mfaToken) {
        await loginTotp(mfaToken, code);
      } else {
        const pending = await login(loginName, password);
        if (pending) {
          setMfaToken(pending.mfaToken);
          setPassword('');
        }
      }
    } catch (err) {
      // Das Zwischen-Token gilt nur kurz – abgelaufen heißt: von vorn.
      if (mfaToken && err instanceof ApiError && err.status === 401 && !/Code/.test(err.message)) {
        setMfaToken(null);
        setCode('');
      }
      // Ein stummes Backend darf nicht als abgelehntes Passwort erscheinen,
      // sonst zweifelt man an Zugangsdaten, die voellig in Ordnung sind.
      if (err instanceof NetworkError) setError(NETWORK_ERROR_MESSAGE);
      else setError(err instanceof ApiError ? err.message : 'Anmeldung fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative z-10 flex min-h-screen items-center justify-center p-6">
      <Motes />

      <div className="relative w-full max-w-[420px] animate-fade-in">
        <div className="mb-[30px] flex flex-col items-center gap-3.5 text-center">
          <BlockIcon size={76} grass bob icon={<Boxes size={30} />} />
          <h1
            className="font-pixel text-xl text-white"
            style={{ textShadow: '3px 3px 0 rgba(0,0,0,.7), 0 0 22px rgba(127,178,56,.35)' }}
          >
            MCPanel
          </h1>
          <p className="text-sm text-stone-300">Melde dich an, um deine Server zu verwalten.</p>
        </div>

        <div className="mc-frame !p-[5px]">
          <div className="grass-strip-thin h-1.5 w-full" />
          <form onSubmit={submit} className="mc-frame-inner flex flex-col gap-4 px-5 py-[22px]">
            {error && <ErrorNote>{error}</ErrorNote>}

            {mfaToken ? (
              <div>
                <label className="mc-label flex items-center gap-1.5">
                  <ShieldCheck size={13} /> Code aus der Authenticator-App
                </label>
                <input
                  className="mc-input text-center font-mono text-lg tracking-[0.4em]"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/[^0-9 ]/g, ''))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={7}
                  autoFocus
                  required
                />
                <button
                  type="button"
                  className="mt-2 text-xs text-stone-450 hover:text-stone-200 hover:underline"
                  onClick={() => { setMfaToken(null); setCode(''); setError(null); }}
                >
                  Mit anderem Konto anmelden
                </button>
              </div>
            ) : (
            <>
            <div>
              <label className="mc-label">Benutzername oder E-Mail</label>
              <input
                className="mc-input font-mono"
                value={loginName}
                onChange={(e) => setLoginName(e.target.value)}
                autoFocus
                autoComplete="username"
                required
              />
            </div>

            <div>
              <label className="mc-label">Passwort</label>
              <input
                className="mc-input font-mono"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            </>
            )}

            <Button
              type="submit"
              variant="primary"
              loading={busy}
              icon={<LogIn size={16} />}
              className="mt-1 w-full"
            >
              {mfaToken ? 'Bestätigen' : 'Anmelden'}
            </Button>
          </form>
        </div>

        <p className="mt-[22px] text-center text-xs text-stone-450">
          Zugang bekommst du von einem Panel-Administrator.
          {status.data?.build.version && (
            <>
              <br />
              <span className="font-mono">
                {status.data.build.version}
                {status.data.build.revision ? ` · ${status.data.build.revision}` : ''}
              </span>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
