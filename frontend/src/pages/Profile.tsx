import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { KeyRound, Shield, User } from 'lucide-react';
import { api, tokenStore } from '../lib/api';
import { resetSocket } from '../lib/socket';
import { useAuth } from '../lib/auth';
import { formatDate } from '../lib/format';
import { Badge, Button, ErrorNote, Field, Panel, useToast } from '../components/ui';

export default function ProfilePage() {
  const { user } = useAuth();
  const toast = useToast();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: () => api.post<{ token: string }>('/auth/password', { currentPassword, newPassword }),
    onSuccess: (res) => {
      tokenStore.set(res.token);
      resetSocket();
      toast.success('Passwort geändert.');
      setCurrentPassword('');
      setNewPassword('');
      setRepeat('');
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 8) return setError('Das neue Passwort braucht mindestens 8 Zeichen.');
    if (newPassword !== repeat) return setError('Die Passwörter stimmen nicht überein.');
    change.mutate();
  }

  if (!user) return null;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 animate-fade-in">
      <h1 className="heading-pixel text-base">Mein Konto</h1>

      <Panel title="Profil" icon={<User size={16} />}>
        <div className="flex items-center gap-4">
          <span
            className="grid h-14 w-14 shrink-0 place-items-center border border-stone-950 bg-dirt text-xl font-bold text-white"
            style={{ boxShadow: 'inset 1px 1px 0 rgba(255,255,255,.2), 0 4px 0 0 rgba(0,0,0,.5)' }}
          >
            {user.username.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-lg font-bold text-stone-100">{user.username}</p>
            <p className="truncate text-sm text-stone-400">{user.email}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge tone={user.role === 'ADMIN' ? 'gold' : 'neutral'}>
                {user.role === 'ADMIN' && <Shield size={11} />}
                {user.role === 'ADMIN' ? 'Administrator' : 'Benutzer'}
              </Badge>
              <Badge>{user.serverCount} Server</Badge>
              <Badge>seit {formatDate(user.createdAt)}</Badge>
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="Passwort ändern" icon={<KeyRound size={16} />}>
        <form onSubmit={submit} className="space-y-4">
          {error && <ErrorNote>{error}</ErrorNote>}

          <Field label="Aktuelles Passwort">
            <input
              className="mc-input"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
          </Field>

          <Field label="Neues Passwort" hint="Mindestens 8 Zeichen.">
            <input
              className="mc-input"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
          </Field>

          <Field label="Neues Passwort wiederholen">
            <input
              className="mc-input"
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              required
            />
          </Field>

          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={change.isPending}>
              Passwort ändern
            </Button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
