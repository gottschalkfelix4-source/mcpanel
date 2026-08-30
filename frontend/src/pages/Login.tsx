import { useState } from 'react';
import { Boxes, LogIn } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { Button, ErrorNote } from '../components/ui';
import { BlockIcon, Motes } from '../components/pixel';

export default function LoginPage() {
  const { login } = useAuth();
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(loginName, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Anmeldung fehlgeschlagen');
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

            <Button
              type="submit"
              variant="primary"
              loading={busy}
              icon={<LogIn size={16} />}
              className="mt-1 w-full"
            >
              Anmelden
            </Button>
          </form>
        </div>

        <p className="mt-[22px] text-center text-xs text-stone-500">
          Zugang bekommst du von einem Panel-Administrator.
        </p>
      </div>
    </div>
  );
}
