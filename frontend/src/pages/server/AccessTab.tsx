import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Crown, KeyRound, ShieldPlus, Trash2, UserPlus } from 'lucide-react';
import { api } from '../../lib/api';
import { formatDate } from '../../lib/format';
import type { Member } from '../../lib/types';
import {
  Badge, Button, ConfirmDialog, EmptyState, InfoNote, LoadErrorBlock, LoadingBlock, Modal, Panel, useToast,
} from '../../components/ui';
import { useServer } from './ServerLayout';

interface MembersResponse {
  owner: { id: string; username: string; email: string } | null;
  members: Member[];
  availablePermissions: { key: string; label: string }[];
  defaultPermissions: string[];
  canManage: boolean;
}

export default function AccessTab() {
  const { server } = useServer();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [showAdd, setShowAdd] = useState(false);
  const [newUser, setNewUser] = useState('');
  const [newPermissions, setNewPermissions] = useState<string[]>([]);
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);

  const data = useQuery({
    queryKey: ['members', server.id],
    queryFn: () => api.get<MembersResponse>(`/servers/${server.id}/members`),
  });

  const directory = useQuery({
    queryKey: ['user-directory'],
    queryFn: () => api.get<{ id: string; username: string }[]>('/users/directory'),
    enabled: showAdd,
  });

  const invalidate = () => {
    void data.refetch();
    queryClient.invalidateQueries({ queryKey: ['server', server.id] });
  };

  const add = useMutation({
    mutationFn: () =>
      api.post(`/servers/${server.id}/members`, {
        user: newUser.trim(),
        permissions: newPermissions,
      }),
    onSuccess: () => {
      toast.success('Zugriff erteilt.');
      setShowAdd(false);
      setNewUser('');
      setNewPermissions([]);
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const update = useMutation({
    mutationFn: (payload: { memberId: string; permissions: string[] }) =>
      api.patch(`/servers/${server.id}/members/${payload.memberId}`, {
        permissions: payload.permissions,
      }),
    onSuccess: () => {
      toast.success('Rechte gespeichert.');
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: (member: Member) => api.del(`/servers/${server.id}/members/${member.id}`),
    onSuccess: () => {
      toast.success('Zugriff entzogen.');
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (data.isLoading) return <LoadingBlock />;
  if (!data.data) return <LoadErrorBlock error={data.error} onRetry={() => void data.refetch()} />;
  const response = data.data;
  const canManage = response.canManage;

  function openAdd() {
    setNewPermissions(response.defaultPermissions);
    setShowAdd(true);
  }

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <Panel
        title="Zugriff & Rechte"
        icon={<KeyRound size={16} />}
        subtitle="Lade Freunde ein und lege genau fest, was sie dürfen."
        actions={
          canManage && (
            <Button
              variant="primary"
              className="!px-3 !py-1.5 !text-xs"
              icon={<UserPlus size={13} />}
              onClick={openAdd}
            >
              Person hinzufügen
            </Button>
          )
        }
      >
        {/* Besitzer */}
        <div className="mb-4 flex animate-slide-in items-center gap-3 border border-gold/40 bg-gold/[0.09] p-3">
          <span
            className="grid h-9 w-9 shrink-0 place-items-center border border-stone-950 bg-gold text-stone-950"
            style={{ boxShadow: 'inset 1px 1px 0 rgba(255,255,255,.28), 0 3px 0 0 rgba(0,0,0,.5)' }}
          >
            <Crown size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold text-stone-50">
              {response.owner?.username ?? 'Unbekannt'}
            </p>
            <p className="truncate text-xs text-stone-350">{response.owner?.email}</p>
          </div>
          <Badge tone="gold">Besitzer · alle Rechte</Badge>
        </div>

        {response.members.length === 0 ? (
          <EmptyState
            icon={<UserPlus size={38} />}
            title="Noch niemand eingeladen"
            description="Füge Freunde hinzu, damit sie den Server starten, die Konsole sehen oder Dateien bearbeiten können."
            action={
              canManage && (
                <Button variant="primary" icon={<UserPlus size={16} />} onClick={openAdd}>
                  Person hinzufügen
                </Button>
              )
            }
          />
        ) : (
          <div className="space-y-3">
            {response.members.map((member) => (
              <MemberRow
                key={member.id}
                member={member}
                permissions={response.availablePermissions}
                canManage={canManage}
                saving={update.isPending}
                onSave={(permissions) => update.mutate({ memberId: member.id, permissions })}
                onRemove={() => setRemoveTarget(member)}
              />
            ))}
          </div>
        )}
      </Panel>

      {/* Hinzufügen */}
      <Modal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        title="Person hinzufügen"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowAdd(false)}>
              Abbrechen
            </Button>
            <Button
              variant="primary"
              loading={add.isPending}
              disabled={!newUser.trim()}
              onClick={() => add.mutate()}
            >
              Zugriff geben
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="mc-label">Benutzername oder E-Mail</label>
            <input
              className="mc-input"
              list="user-directory"
              value={newUser}
              onChange={(e) => setNewUser(e.target.value)}
              placeholder="z. B. steve"
              autoFocus
            />
            <datalist id="user-directory">
              {(directory.data ?? []).map((u) => (
                <option key={u.id} value={u.username} />
              ))}
            </datalist>
            <p className="mt-1 text-xs text-stone-450">
              Die Person braucht bereits ein Panel-Konto. Neue Konten legt ein Administrator an.
            </p>
          </div>

          <div>
            <label className="mc-label">Rechte</label>
            <PermissionGrid
              all={response.availablePermissions}
              value={newPermissions}
              onChange={setNewPermissions}
            />
          </div>

          <InfoNote>
            Rechte lassen sich jederzeit anpassen. Ohne „Starten / Stoppen“ kann die Person den
            Server nur ansehen.
          </InfoNote>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => removeTarget && remove.mutateAsync(removeTarget)}
        title="Zugriff entziehen?"
        message={`${removeTarget?.user.username} verliert den Zugriff auf diesen Server.`}
        confirmLabel="Entziehen"
        danger
      />
    </div>
  );
}

function MemberRow({
  member,
  permissions,
  canManage,
  saving,
  onSave,
  onRemove,
}: {
  member: Member;
  permissions: { key: string; label: string }[];
  canManage: boolean;
  saving: boolean;
  onSave: (permissions: string[]) => void;
  onRemove: () => void;
}) {
  const [value, setValue] = useState<string[]>(member.permissions);
  const dirty =
    value.length !== member.permissions.length ||
    value.some((p) => !member.permissions.includes(p));

  return (
    <div className="mc-well animate-slide-in p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className="grid h-9 w-9 shrink-0 place-items-center border border-stone-950 bg-dirt text-sm font-bold text-white"
          style={{ boxShadow: 'inset 1px 1px 0 rgba(255,255,255,.2), 0 3px 0 0 rgba(0,0,0,.5)' }}
        >
          {member.user.username.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-stone-50">{member.user.username}</p>
          <p className="truncate text-xs text-stone-450">
            {member.user.email}
            {member.createdAt && ` · seit ${formatDate(member.createdAt)}`}
          </p>
        </div>
        <Badge>{value.length} Rechte</Badge>
        {canManage && (
          <div className="flex gap-1.5">
            {dirty && (
              <Button
                variant="primary"
                className="!px-2.5 !py-1.5 !text-xs"
                loading={saving}
                icon={<ShieldPlus size={13} />}
                onClick={() => onSave(value)}
              >
                Speichern
              </Button>
            )}
            <Button
              variant="danger"
              className="!px-2.5 !py-1.5 !text-xs"
              icon={<Trash2 size={13} />}
              onClick={onRemove}
            />
          </div>
        )}
      </div>

      <div className="mt-3 border-t border-stone-875 pt-3">
        <PermissionGrid all={permissions} value={value} onChange={setValue} disabled={!canManage} />
      </div>
    </div>
  );
}

function PermissionGrid({
  all,
  value,
  onChange,
  disabled,
}: {
  all: { key: string; label: string }[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
      {all.map((permission) => {
        const active = value.includes(permission.key);
        return (
          <button
            key={permission.key}
            type="button"
            disabled={disabled}
            onClick={() =>
              onChange(
                active ? value.filter((p) => p !== permission.key) : [...value, permission.key],
              )
            }
            className={clsx(
              'flex items-center gap-2 border px-2.5 py-1.5 text-left text-xs transition disabled:cursor-not-allowed disabled:opacity-60',
              active
                ? 'border-grass-dark bg-grass/20 text-stone-100'
                : 'border-stone-700 bg-stone-800/50 text-stone-400 hover:border-stone-600',
            )}
          >
            <span
              className={clsx(
                'h-3 w-3 shrink-0 border',
                active ? 'border-grass-light bg-grass-light' : 'border-stone-600',
              )}
            />
            <span className="truncate">{permission.label}</span>
          </button>
        );
      })}
    </div>
  );
}
