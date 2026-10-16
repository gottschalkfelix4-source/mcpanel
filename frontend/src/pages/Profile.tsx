import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut, Monitor, Shield, User } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import TotpPanel from '../components/TotpPanel';
import { formatDate, formatRelative } from '../lib/format';
import type { AuthSession } from '../lib/types';
import { Badge, Button, ConfirmDialog, ErrorNote, Field, LoadErrorBlock, LoadingBlock, Panel, useToast } from '../components/ui';

/** Alle angemeldeten Geräte des Kontos, jedes einzeln abmeldbar. */
function SessionList() {
  const { logout } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: ['auth-sessions'],
    queryFn: () => api.get<AuthSession[]>('/auth/sessions'),
  });

  const revoke = useMutation({
    mutationFn: (session: AuthSession) => api.del<{ ok: boolean; current: boolean }>(`/auth/sessions/${session.id}`),
    onSuccess: (res) => {
      if (res.current) return logout();
      toast.success('Gerät wurde abgemeldet.');
      void queryClient.invalidateQueries({ queryKey: ['auth-sessions'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (sessions.isLoading) return <LoadingBlock label="Geräte werden geladen …" />;
  if (sessions.isError) return <LoadErrorBlock error={sessions.error} onRetry={() => void sessions.refetch()} />;
  if (!sessions.data?.length) return <p className="text-sm text-stone-400">Keine aktiven Sitzungen gefunden.</p>;

  return (
    <ul className="divide-y divide-stone-700 border border-stone-950">
      {sessions.data.map((session) => (
        <li key={session.id} className="flex flex-wrap items-center gap-3 p-3">
          <Monitor size={18} className="shrink-0 text-stone-400" />
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-stone-100">
              <span className="truncate" title={session.userAgent || undefined}>{session.device}</span>
              {session.current && <Badge tone="green">Dieses Gerät</Badge>}
            </p>
            <p className="text-xs text-stone-400">
              {session.ip || 'Adresse unbekannt'} · zuletzt aktiv {formatRelative(session.lastSeenAt)} · angemeldet {formatDate(session.createdAt)}
            </p>
          </div>
          <Button
            variant={session.current ? 'ghost' : 'default'}
            icon={<LogOut size={14} />}
            loading={revoke.isPending && revoke.variables?.id === session.id}
            onClick={() => revoke.mutate(session)}
          >
            Abmelden
          </Button>
        </li>
      ))}
    </ul>
  );
}

export default function ProfilePage() {
  const { user, adoptToken } = useAuth();
  const [confirmLogoutAll, setConfirmLogoutAll] = useState(false);
  const toast = useToast();
  const queryClient = useQueryClient();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: () => api.post<{ token: string }>('/auth/password', { currentPassword, newPassword }),
    onSuccess: (res) => {
      adoptToken(res.token);
      toast.success('Passwort geändert. Andere Geräte wurden abgemeldet.');
      setCurrentPassword('');
      setNewPassword('');
      setRepeat('');
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  const logoutAll = useMutation({
    mutationFn: () => api.post<{ token: string }>('/auth/logout-all'),
    onSuccess: (res) => {
      adoptToken(res.token);
      toast.success('Alle anderen Sitzungen wurden abgemeldet.');
      void queryClient.invalidateQueries({ queryKey: ['auth-sessions'] });
    },
    onError: (err: Error) => toast.error(err.message),
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

      <TotpPanel />

      <Panel title="Angemeldete Geräte" icon={<LogOut size={16} />}>
        <div className="space-y-3">
          <SessionList />
          <p className="text-sm text-stone-350">
            Ein unbekanntes Gerät in der Liste? Einzeln abmelden – oder alles außer diesem Fenster auf einmal,
            etwa nach einem verlorenen Handy. Ein geändertes Passwort meldet ebenfalls alle anderen ab.
          </p>
          <Button variant="danger" icon={<LogOut size={15} />} loading={logoutAll.isPending} onClick={() => setConfirmLogoutAll(true)}>
            Überall sonst abmelden
          </Button>
        </div>
      </Panel>

      <ConfirmDialog
        open={confirmLogoutAll}
        onClose={() => setConfirmLogoutAll(false)}
        onConfirm={() => logoutAll.mutateAsync().then(() => {})}
        title="Überall abmelden?"
        message="Alle anderen Sitzungen dieses Kontos werden sofort beendet."
        confirmLabel="Abmelden"
        danger
      />
    </div>
  );
}
