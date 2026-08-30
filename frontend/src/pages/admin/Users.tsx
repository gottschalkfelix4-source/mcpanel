import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { KeyRound, Shield, Trash2, UserPlus, Users as UsersIcon } from 'lucide-react';
import { api } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import type { PanelUser } from '../../lib/types';
import {
  Badge, Button, ConfirmDialog, ErrorNote, Field, LoadingBlock, Modal, Panel, Toggle, useToast,
} from '../../components/ui';

export default function UsersPage() {
  const { user: me } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ username: '', email: '', password: '', role: 'USER' as 'USER' | 'ADMIN' });
  const [error, setError] = useState<string | null>(null);
  const [passwordTarget, setPasswordTarget] = useState<PanelUser | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<PanelUser | null>(null);

  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<PanelUser[]>('/users'),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  const create = useMutation({
    mutationFn: () => api.post('/users', form),
    onSuccess: () => {
      toast.success('Benutzer angelegt.');
      setShowCreate(false);
      setForm({ username: '', email: '', password: '', role: 'USER' });
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const update = useMutation({
    mutationFn: (payload: { id: string; data: Record<string, unknown> }) =>
      api.patch(`/users/${payload.id}`, payload.data),
    onSuccess: () => {
      toast.success('Gespeichert.');
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: (user: PanelUser) => api.del(`/users/${user.id}`),
    onSuccess: () => {
      toast.success('Benutzer gelöscht.');
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="heading-pixel text-base">Benutzer</h1>
          <p className="mt-2.5 text-sm text-stone-350">
            Konten für dich und deine Freunde. Serverrechte vergibst du pro Server im Zugriff-Tab.
          </p>
        </div>
        <Button
          variant="primary"
          icon={<UserPlus size={16} />}
          onClick={() => {
            setError(null);
            setShowCreate(true);
          }}
        >
          Benutzer anlegen
        </Button>
      </div>

      <Panel title="Alle Konten" icon={<UsersIcon size={16} />} bodyClassName="!p-0">
        {users.isLoading ? (
          <LoadingBlock />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-890 bg-stone-well/40 text-left text-[10px] font-bold uppercase tracking-[0.12em] text-stone-450">
                  <th className="px-4 py-2.5">Benutzer</th>
                  <th className="hidden px-4 py-2.5 md:table-cell">Server</th>
                  <th className="px-4 py-2.5">Rolle</th>
                  <th className="hidden px-4 py-2.5 lg:table-cell">Erstellt</th>
                  <th className="px-4 py-2.5 text-right">Aktionen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-875">
                {users.data!.map((user, i) => (
                  <tr
                    key={user.id}
                    className={clsx(
                      'animate-slide-in transition-colors hover:bg-stone-600/[0.28]',
                      !user.active && 'opacity-50',
                    )}
                    style={{ animationDelay: `${Math.min(i, 10) * 0.04}s` }}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span
                          className="grid h-8 w-8 shrink-0 place-items-center border border-stone-950 bg-dirt text-xs font-bold text-white"
                          style={{ boxShadow: 'inset 1px 1px 0 rgba(255,255,255,.2)' }}
                        >
                          {user.username.slice(0, 1).toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-stone-50">{user.username}</p>
                          <p className="truncate text-xs text-stone-450">{user.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="hidden px-4 py-3 font-mono text-xs text-stone-350 md:table-cell">
                      {user._count
                        ? `${user._count.ownedServers} eigene · ${user._count.memberships} geteilt`
                        : '–'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={user.role === 'ADMIN' ? 'gold' : 'neutral'}>
                          {user.role === 'ADMIN' ? 'Admin' : 'Benutzer'}
                        </Badge>
                        {!user.active && <Badge tone="red">deaktiviert</Badge>}
                      </div>
                    </td>
                    <td className="hidden px-4 py-3 font-mono text-xs text-stone-450 lg:table-cell">
                      {formatDate(user.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1.5">
                        <Button
                          variant="ghost"
                          className="!px-2 !py-1 !text-[11px]"
                          icon={<Shield size={12} />}
                          disabled={user.id === me?.id}
                          onClick={() =>
                            update.mutate({
                              id: user.id,
                              data: { role: user.role === 'ADMIN' ? 'USER' : 'ADMIN' },
                            })
                          }
                          title={user.role === 'ADMIN' ? 'Adminrechte entziehen' : 'Zum Admin machen'}
                        />
                        <Button
                          variant="ghost"
                          className="!px-2 !py-1 !text-[11px]"
                          icon={<KeyRound size={12} />}
                          onClick={() => {
                            setPasswordTarget(user);
                            setNewPassword('');
                          }}
                          title="Passwort zurücksetzen"
                        />
                        <Button
                          variant="danger"
                          className="!px-2 !py-1 !text-[11px]"
                          icon={<Trash2 size={12} />}
                          disabled={user.id === me?.id}
                          onClick={() => setDeleteTarget(user)}
                          title="Löschen"
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Anlegen */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Benutzer anlegen"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>
              Abbrechen
            </Button>
            <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
              Anlegen
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error && <ErrorNote>{error}</ErrorNote>}
          <Field label="Benutzername">
            <input
              className="mc-input"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              autoFocus
            />
          </Field>
          <Field label="E-Mail">
            <input
              className="mc-input"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
          <Field label="Passwort" hint="Mindestens 8 Zeichen.">
            <input
              className="mc-input"
              type="text"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </Field>
          <Toggle
            checked={form.role === 'ADMIN'}
            onChange={(v) => setForm({ ...form, role: v ? 'ADMIN' : 'USER' })}
            label="Administrator (darf alles verwalten)"
          />
        </div>
      </Modal>

      {/* Passwort zurücksetzen */}
      <Modal
        open={Boolean(passwordTarget)}
        onClose={() => setPasswordTarget(null)}
        title={`Passwort für ${passwordTarget?.username}`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPasswordTarget(null)}>
              Abbrechen
            </Button>
            <Button
              variant="primary"
              disabled={newPassword.length < 8}
              loading={update.isPending}
              onClick={() => {
                update.mutate({ id: passwordTarget!.id, data: { password: newPassword } });
                setPasswordTarget(null);
              }}
            >
              Setzen
            </Button>
          </>
        }
      >
        <Field label="Neues Passwort" hint="Mindestens 8 Zeichen. Teile es der Person sicher mit.">
          <input
            className="mc-input"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoFocus
          />
        </Field>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && remove.mutateAsync(deleteTarget)}
        title="Benutzer löschen?"
        message={`Das Konto von ${deleteTarget?.username} wird entfernt. Eigene Server müssen vorher übertragen oder gelöscht werden.`}
        confirmLabel="Löschen"
        danger
      />
    </div>
  );
}
