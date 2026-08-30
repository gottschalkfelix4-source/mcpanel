import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Bell, Check, Globe2, Link2, Pencil, Send, Trash2, Plus, Webhook } from 'lucide-react';
import { api } from '../lib/api';
import { formatRelative } from '../lib/format';
import type { NotifyChannel, NotifyChannelType, NotifyListResponse } from '../lib/types';
import {
  Badge, Button, ConfirmDialog, EmptyState, ErrorNote, Field, InfoNote, LoadingBlock,
  Modal, Panel, Toggle, useToast,
} from './ui';

interface FormState {
  name: string;
  enabled: boolean;
  type: NotifyChannelType;
  target: string;
  events: string[];
}

const EMPTY: FormState = { name: '', enabled: true, type: 'DISCORD', target: '', events: [] };

const TYPE_LOOK: Record<NotifyChannelType, { label: string; hint: string; Icon: typeof Webhook; tint: string }> = {
  DISCORD: {
    label: 'Discord',
    hint: 'Server-Einstellungen → Integrationen → Webhooks → „Neuer Webhook“ → URL kopieren.',
    Icon: Bell,
    tint: '#5865F2',
  },
  WEBHOOK: {
    label: 'Eigener Webhook',
    hint: 'Beliebige Adresse, die einen JSON-POST entgegennimmt – etwa ntfy, Gotify oder ein eigenes Skript.',
    Icon: Webhook,
    tint: '#4AEDD9',
  },
};

/**
 * Liste der Benachrichtigungsziele. Wird an zwei Stellen verwendet:
 * im Automations-Tab eines Servers und in den Panel-Einstellungen für
 * Kanäle, die für alle Server gelten.
 */
export default function NotificationChannels({
  basePath,
  queryKey,
  scope,
}: {
  /** z. B. `/servers/abc/notifications` oder `/settings/notifications` */
  basePath: string;
  queryKey: unknown[];
  scope: 'server' | 'global';
}) {
  const toast = useToast();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<NotifyChannel | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<NotifyChannel | null>(null);

  const list = useQuery({
    queryKey,
    queryFn: () => api.get<NotifyListResponse>(basePath),
    refetchInterval: 30_000,
  });

  const canManage = list.data?.canManage ?? false;
  const catalog = list.data?.catalog ?? [];
  const open = creating || Boolean(editing);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        enabled: form.enabled,
        type: form.type,
        target: form.target.trim(),
        events: form.events,
      };
      return editing ? api.patch(`${basePath}/${editing.id}`, body) : api.post(basePath, body);
    },
    onSuccess: () => {
      toast.success(editing ? 'Kanal gespeichert.' : 'Kanal angelegt.');
      close();
      void list.refetch();
    },
    onError: (err: Error) => setError(err.message),
  });

  const toggle = useMutation({
    mutationFn: (c: NotifyChannel) => api.patch(`${basePath}/${c.id}`, { enabled: !c.enabled }),
    onSuccess: () => void list.refetch(),
    onError: (err: Error) => toast.error(err.message),
  });

  const test = useMutation({
    mutationFn: (c: NotifyChannel) =>
      api.post<{ ok: boolean; message: string }>(`${basePath}/${c.id}/test`),
    onSuccess: (res) => {
      res.ok ? toast.success(res.message) : toast.error(res.message);
      void list.refetch();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: (c: NotifyChannel) => api.del(`${basePath}/${c.id}`),
    onSuccess: () => {
      toast.success('Kanal gelöscht.');
      void list.refetch();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function startCreate() {
    setError(null);
    setForm({ ...EMPTY, events: list.data?.defaults ?? [] });
    setEditing(null);
    setCreating(true);
  }

  function startEdit(c: NotifyChannel) {
    setError(null);
    // Die echte URL verlässt den Server nicht – beim Bearbeiten neu eingeben.
    setForm({ name: c.name, enabled: c.enabled, type: c.type, target: '', events: c.events });
    setCreating(false);
    setEditing(c);
  }

  const close = () => {
    setCreating(false);
    setEditing(null);
  };

  const toggleEvent = (key: string) =>
    setForm((prev) => ({
      ...prev,
      events: prev.events.includes(key)
        ? prev.events.filter((e) => e !== key)
        : [...prev.events, key],
    }));

  const channels = list.data?.channels ?? [];
  const inherited = list.data?.globalChannels ?? [];

  return (
    <>
      <Panel
        title="Benachrichtigungen"
        icon={<Bell size={16} />}
        subtitle={
          scope === 'server'
            ? 'Discord oder Webhook – melden, wenn dieser Server abstürzt oder eine Aufgabe scheitert.'
            : 'Kanäle, die für alle Server des Panels gelten.'
        }
        bodyClassName="!p-0"
        actions={
          canManage && (
            <Button
              variant="primary"
              className="!px-3 !py-1.5 !text-xs"
              icon={<Plus size={13} />}
              onClick={startCreate}
            >
              Neuer Kanal
            </Button>
          )
        }
      >
        {list.isLoading ? (
          <LoadingBlock />
        ) : channels.length === 0 ? (
          <EmptyState
            icon={<Bell size={44} />}
            title="Noch kein Ziel eingerichtet"
            description="Ohne Kanal bleibt ein nächtlicher Absturz unbemerkt, bis jemand ins Panel schaut."
            action={
              canManage && (
                <Button variant="primary" icon={<Plus size={16} />} onClick={startCreate}>
                  Kanal anlegen
                </Button>
              )
            }
          />
        ) : (
          <ul className="divide-y divide-stone-875">
            {channels.map((c, i) => (
              <ChannelRow
                key={c.id}
                channel={c}
                index={i}
                catalogSize={catalog.length}
                canManage={canManage}
                busy={test.isPending || toggle.isPending}
                onToggle={() => toggle.mutate(c)}
                onTest={() => test.mutate(c)}
                onEdit={() => startEdit(c)}
                onDelete={() => setDeleteTarget(c)}
              />
            ))}
          </ul>
        )}
      </Panel>

      {/* Global geerbte Kanäle nur anzeigen, damit niemand rätselt, woher eine
          Nachricht kommt, die in der Liste oben nicht steht. */}
      {scope === 'server' && inherited.length > 0 && (
        <div className="mc-well flex flex-col gap-2 p-3.5 text-xs text-stone-350">
          <div className="flex items-center gap-2 font-bold uppercase tracking-[0.08em] text-stone-300">
            <Globe2 size={13} className="text-grass-light" />
            Zusätzlich aus den Panel-Einstellungen
          </div>
          {inherited.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-2">
              <Badge tone={c.enabled ? 'green' : 'neutral'}>{c.enabled ? 'aktiv' : 'pausiert'}</Badge>
              <span className="font-bold text-stone-200">{c.name}</span>
              <span className="font-mono text-[11px] text-stone-450">{c.targetMasked}</span>
              <span className="text-stone-450">· {c.events.length} Ereignisse</span>
            </div>
          ))}
        </div>
      )}

      {!canManage && scope === 'server' && (
        <InfoNote>
          Du siehst die Kanäle, kannst sie aber nicht ändern – dafür fehlt dir das Recht
          „Automatisierungen verwalten“.
        </InfoNote>
      )}

      <Modal
        open={open}
        onClose={close}
        title={editing ? 'Kanal bearbeiten' : 'Neuer Benachrichtigungskanal'}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Abbrechen
            </Button>
            <Button
              variant="primary"
              loading={save.isPending}
              disabled={
                form.name.trim().length < 2 || form.target.trim().length < 8 || form.events.length === 0
              }
              onClick={() => {
                setError(null);
                save.mutate();
              }}
            >
              {editing ? 'Speichern' : 'Anlegen'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error && <ErrorNote>{error}</ErrorNote>}

          <Field label="Name" hint="Nur zur Wiedererkennung, z. B. „Discord #serverlog“.">
            <input
              className="mc-input w-full"
              value={form.name}
              maxLength={60}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              placeholder="Discord"
            />
          </Field>

          <Field label="Art">
            <div className="grid gap-2 sm:grid-cols-2">
              {(Object.keys(TYPE_LOOK) as NotifyChannelType[]).map((key) => {
                const look = TYPE_LOOK[key];
                const active = form.type === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setForm((p) => ({ ...p, type: key }))}
                    className={clsx(
                      'flex items-start gap-3 border p-3 text-left transition',
                      active
                        ? 'border-grass-light bg-grass/[0.14]'
                        : 'border-stone-700 bg-stone-900/60 hover:border-stone-550',
                    )}
                  >
                    <look.Icon size={18} style={{ color: look.tint }} className="mt-0.5 shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-sm font-bold text-stone-100">{look.label}</span>
                      <span className="mt-1 block text-xs leading-snug text-stone-350">{look.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Field>

          <Field
            label={editing ? 'Ziel-URL neu eingeben' : 'Ziel-URL'}
            hint={
              editing
                ? 'Die gespeicherte Adresse enthält ein Token und wird nie zurückgegeben – darum hier erneut einfügen.'
                : form.type === 'DISCORD'
                  ? 'Die Webhook-URL aus den Discord-Kanaleinstellungen.'
                  : 'Adresse, die einen JSON-POST annimmt.'
            }
          >
            <div className="flex items-center gap-2">
              <Link2 size={15} className="shrink-0 text-stone-450" />
              <input
                className="mc-input w-full font-mono text-xs"
                value={form.target}
                maxLength={500}
                onChange={(e) => setForm((p) => ({ ...p, target: e.target.value }))}
                placeholder={
                  form.type === 'DISCORD'
                    ? 'https://discord.com/api/webhooks/…'
                    : 'https://beispiel.de/hook'
                }
              />
            </div>
          </Field>

          <Field label="Wobei soll gemeldet werden?" hint={`${form.events.length} von ${catalog.length} ausgewählt`}>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {catalog.map((event) => {
                const active = form.events.includes(event.key);
                return (
                  <button
                    key={event.key}
                    type="button"
                    onClick={() => toggleEvent(event.key)}
                    className={clsx(
                      'flex items-center gap-2 border px-2.5 py-2 text-left text-xs transition',
                      active
                        ? 'border-grass-light bg-grass/[0.14] text-stone-100'
                        : 'border-stone-700 bg-stone-900/60 text-stone-350 hover:border-stone-550',
                    )}
                  >
                    <span
                      className={clsx(
                        'grid h-4 w-4 shrink-0 place-items-center border',
                        active ? 'border-grass-light bg-grass/40' : 'border-stone-550',
                      )}
                    >
                      {active && <Check size={11} className="text-stone-100" />}
                    </span>
                    <span className="min-w-0 truncate font-bold">{event.label}</span>
                  </button>
                );
              })}
            </div>
          </Field>

          <Toggle
            checked={form.enabled}
            onChange={(v) => setForm((p) => ({ ...p, enabled: v }))}
            label="Kanal aktiv"
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) remove.mutate(deleteTarget);
          setDeleteTarget(null);
        }}
        title="Kanal löschen?"
        message={`„${deleteTarget?.name}“ bekommt dann keine Meldungen mehr.`}
        confirmLabel="Löschen"
        danger
      />
    </>
  );
}

function ChannelRow({
  channel,
  index,
  catalogSize,
  canManage,
  busy,
  onToggle,
  onTest,
  onEdit,
  onDelete,
}: {
  channel: NotifyChannel;
  index: number;
  catalogSize: number;
  canManage: boolean;
  busy: boolean;
  onToggle: () => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const look = TYPE_LOOK[channel.type];

  return (
    <li
      className="flex flex-wrap items-center gap-3 p-3.5 transition-colors hover:bg-stone-800/40 animate-fade-in"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <span
        className="grid h-9 w-9 shrink-0 place-items-center border"
        style={{ borderColor: `${look.tint}55`, background: `${look.tint}18`, color: look.tint }}
      >
        <look.Icon size={17} />
      </span>

      <div className="min-w-0 flex-1 basis-48">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-bold text-stone-100">{channel.name}</span>
          <Badge tone={channel.enabled ? 'green' : 'neutral'}>
            {channel.enabled ? 'aktiv' : 'pausiert'}
          </Badge>
          {channel.lastStatus === 'FEHLER' && <Badge tone="red">letzter Versand fehlgeschlagen</Badge>}
        </div>

        <div className="mt-1 truncate font-mono text-[11px] text-stone-450">{channel.targetMasked}</div>

        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-stone-350">
          <span>
            {channel.events.length === catalogSize
              ? 'Alle Ereignisse'
              : `${channel.events.length} Ereignisse`}
          </span>
          {channel.sentCount > 0 && <span>· {channel.sentCount} gesendet</span>}
          {channel.lastSentAt && <span>· zuletzt {formatRelative(channel.lastSentAt)}</span>}
        </div>

        {channel.lastStatus === 'FEHLER' && channel.lastMessage && (
          <div className="mt-1 truncate text-xs text-red-300">{channel.lastMessage}</div>
        )}
      </div>

      {canManage && (
        /* Mobil eigene Zeile – sonst quetschen die Knöpfe den Namen zusammen. */
        <div className="flex w-full shrink-0 items-center justify-end gap-1.5 border-t border-stone-875 pt-2 sm:w-auto sm:border-0 sm:pt-0">
          <Button
            variant="ghost"
            className="!px-2 !py-1.5"
            title="Testnachricht senden"
            disabled={busy}
            onClick={onTest}
          >
            <Send size={14} />
          </Button>
          <Button variant="ghost" className="!px-2 !py-1.5" title="Bearbeiten" onClick={onEdit}>
            <Pencil size={14} />
          </Button>
          <Button variant="danger" className="!px-2 !py-1.5" title="Löschen" onClick={onDelete}>
            <Trash2 size={14} />
          </Button>
          <Toggle checked={channel.enabled} onChange={onToggle} />
        </div>
      )}
    </li>
  );
}
