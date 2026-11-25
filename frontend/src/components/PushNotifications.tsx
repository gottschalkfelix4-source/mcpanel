import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Monitor, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import type { PushChannel, PushDevice, PushStateResponse } from '../lib/types';
import {
  Badge, Button, ConfirmDialog, InfoNote, LoadingBlock,
  Modal, Panel, Toggle, useToast, LoadErrorBlock, Field, EmptyState } from './ui';

/** applicationServerKey will base64url ohne Auffüllung als Uint8Array. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/**
 * Web-Push für die installierte App: Geräte anmelden/abmelden und eigene
 * Kanäle mit Ereignis-Auswahl. Läuft nur über HTTPS oder localhost – auf
 * einer nackten LAN-IP verweigert der Browser `pushManager.subscribe`.
 */
export default function PushNotifications() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
  /** Endpoint des aktuellen Browsers – um „dieses Gerät“ zu erkennen. */
  const [currentEndpoint, setCurrentEndpoint] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) return;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setCurrentEndpoint(sub?.endpoint ?? null))
      .catch(() => setCurrentEndpoint(null));
  }, [supported]);

  const state = useQuery({
    queryKey: ['push-state'],
    queryFn: async () => {
      const [devices, channels] = await Promise.all([
        api.get<{ subscriptions: PushDevice[] }>('/push/subscriptions'),
        api.get<{ channels: PushChannel[]; catalog: PushStateResponse['catalog']; defaults: string[] }>('/push/channels'),
      ]);
      return {
        devices: devices.subscriptions,
        channels: channels.channels,
        catalog: channels.catalog,
        defaults: channels.defaults,
      };
    },
  });

  const currentDevice = state.data?.devices.find((d) => d.endpoint === currentEndpoint) ?? null;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['push-state'] });
    queryClient.invalidateQueries({ queryKey: ['push-channels'] });
  };

  const activate = useMutation({
    mutationFn: async () => {
      if (!('Notification' in window)) throw new Error('Dieser Browser unterstützt keine Benachrichtigungen');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Benachrichtigungen wurden nicht erlaubt – erst in den Browser-Einstellungen freigeben');
      const { publicKey } = await api.get<{ publicKey: string }>('/push/vapid-key');
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
        });
      }
      const json = sub.toJSON() as { endpoint: string; keys?: { p256dh: string; auth: string } };
      if (!json.keys) throw new Error('Der Browser liefert keine Schlüssel für Push-Benachrichtigungen');
      await api.post('/push/subscribe', { endpoint: json.endpoint, keys: json.keys });
      setCurrentEndpoint(json.endpoint);
    },
    onSuccess: () => {
      toast.success('Dieses Gerät erhält jetzt Benachrichtigungen.');
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const removeDevice = useMutation({
    mutationFn: async (device: PushDevice) => {
      // Ist es der Browser hier im Fenster, auch das Abo im Push-Dienst lösen.
      if (device.endpoint === currentEndpoint) {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) await sub.unsubscribe().catch(() => {});
        setCurrentEndpoint(null);
      }
      await api.del(`/push/subscriptions/${device.id}`);
    },
    onSuccess: () => {
      toast.success('Gerät abgemeldet.');
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <Panel
      title="Push-Benachrichtigungen"
      icon={<BellRing size={16} />}
      subtitle="Ereignisse direkt auf dem Handy – die App muss dafür installiert sein (PWA) und über HTTPS laufen."
    >
      <div className="space-y-5">
        {!supported ? (
          <InfoNote>Dieser Browser unterstützt keine Push-Benachrichtigungen. Aktuell geht das in Chrome, Edge, Firefox und Safari ab Version 16.4.</InfoNote>
        ) : state.isLoading ? (
          <LoadingBlock label="Geräte werden geladen …" />
        ) : state.isError ? (
          <LoadErrorBlock error={state.error} onRetry={() => void state.refetch()} />
        ) : (
          <>
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-stone-100">Angemeldete Geräte</h3>
                {!currentDevice && (
                  <Button
                    variant="primary"
                    className="!px-3 !py-1 !text-xs"
                    icon={<Plus size={13} />}
                    loading={activate.isPending}
                    onClick={() => activate.mutate()}
                  >
                    Dieses Gerät aktivieren
                  </Button>
                )}
              </div>
              {state.data!.devices.length === 0 ? (
                <p className="text-sm text-stone-400">
                  Noch kein Gerät angemeldet. Mit „Dieses Gerät aktivieren“ fragt der Browser nach
                  Erlaubnis und das Panel bekommt die Zustelladresse.
                </p>
              ) : (
                <ul className="divide-y divide-stone-700 border border-stone-950">
                  {state.data!.devices.map((device) => (
                    <li key={device.id} className="flex flex-wrap items-center gap-3 p-3">
                      <Monitor size={16} className="shrink-0 text-stone-400" />
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-stone-100">
                          <span className="truncate">{device.device}</span>
                          {currentDevice?.id === device.id && <Badge tone="green">Dieses Gerät</Badge>}
                        </p>
                        <p className="text-xs text-stone-400">angemeldet seit {formatDate(device.createdAt)}</p>
                      </div>
                      <Button
                        variant="ghost"
                        className="!px-3 !py-1.5 !text-xs"
                        icon={<Trash2 size={13} />}
                        loading={removeDevice.isPending && removeDevice.variables?.id === device.id}
                        onClick={() => removeDevice.mutate(device)}
                      >
                        Abmelden
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <ChannelList invalidate={invalidate} />
          </>
        )}
      </div>
    </Panel>
  );
}


// ---------------------------------------------------------------------------
// Kanäle: Ereignis-Auswahl je Konto
// ---------------------------------------------------------------------------

interface ChannelFormState {
  name: string;
  enabled: boolean;
  events: string[];
}

function ChannelList({ invalidate }: { invalidate: () => void }) {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PushChannel | null>(null);
  const [form, setForm] = useState<ChannelFormState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PushChannel | null>(null);

  const list = useQuery({
    queryKey: ['push-channels'],
    queryFn: () =>
      api.get<{ channels: PushChannel[]; catalog: PushStateResponse['catalog']; defaults: string[] }>('/push/channels'),
  });

  const catalog = list.data?.catalog ?? [];
  const channels = list.data?.channels ?? [];

  function openCreate() {
    setEditing(null);
    setForm({ name: 'Push', enabled: true, events: [...(list.data?.defaults ?? [])] });
    setCreating(true);
  }

  function openEdit(channel: PushChannel) {
    setEditing(channel);
    setForm({ name: channel.name, enabled: channel.enabled, events: channel.events });
    setCreating(true);
  }

  function toggleEvent(key: string) {
    setForm((prev) => {
      if (!prev) return prev;
      const events = prev.events.includes(key)
        ? prev.events.filter((e) => e !== key)
        : [...prev.events, key];
      return { ...prev, events };
    });
  }

  const save = useMutation({
    mutationFn: () => {
      if (!form) throw new Error('Formular fehlt');
      const body = { name: form.name, enabled: form.enabled, events: form.events };
      return editing
        ? api.patch(`/push/channels/${editing.id}`, body)
        : api.post('/push/channels', body);
    },
    onSuccess: () => {
      toast.success(editing ? 'Kanal gespeichert.' : 'Kanal angelegt.');
      setCreating(false);
      setForm(null);
      void list.refetch();
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const toggleChannel = useMutation({
    mutationFn: (channel: PushChannel) => api.patch(`/push/channels/${channel.id}`, { enabled: !channel.enabled }),
    onSuccess: () => void list.refetch(),
    onError: (err: Error) => toast.error(err.message),
  });

  const test = useMutation({
    mutationFn: (channel: PushChannel) =>
      api.post<{ ok: boolean; message: string }>(`/push/channels/${channel.id}/test`),
    onSuccess: (res) => {
      res.ok ? toast.success(res.message) : toast.error(res.message);
      void list.refetch();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: (channel: PushChannel) => api.del(`/push/channels/${channel.id}`),
    onSuccess: () => {
      toast.success('Kanal gelöscht.');
      setDeleteTarget(null);
      void list.refetch();
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-stone-100">Benachrichtigen bei</h3>
        <Button
          variant="ghost"
          className="!px-3 !py-1 !text-xs"
          icon={<Plus size={13} />}
          onClick={openCreate}
        >
          Kanal hinzufügen
        </Button>
      </div>
      {list.isLoading ? (
        <LoadingBlock label="Kanäle werden geladen …" />
      ) : list.isError ? (
        <LoadErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : channels.length === 0 ? (
        <EmptyState
          icon={<BellRing size={32} />}
          title="Noch kein Kanal"
          description="Lege einen Kanal an und wähle, bei welchen Ereignissen das Panel deine Geräte benachrichtigen soll – Standard sind die Störungen."
        />
      ) : (
        <ul className="divide-y divide-stone-700 border border-stone-950">
          {channels.map((channel) => (
            <li key={channel.id} className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-stone-100">
                  <span className="truncate">{channel.name}</span>
                  <Badge>{channel.events.length} Ereignisse</Badge>
                  {channel.lastStatus === 'FEHLER' && channel.lastMessage && (
                    <Badge tone="red" title={channel.lastMessage}>{channel.lastMessage.slice(0, 40)}</Badge>
                  )}
                </p>
                <p className="text-xs text-stone-400">
                  {channel.sentCount > 0
                    ? `${channel.sentCount} zugestellt · zuletzt ${channel.lastStatus === 'OK' ? 'erfolgreich' : 'mit Fehler'}`
                    : 'noch keine Zustellung'}
                </p>
              </div>
              <Button variant="ghost" className="!px-2 !py-1.5" title="Testnachricht senden" icon={<Send size={14} />}
                loading={test.isPending && test.variables?.id === channel.id}
                onClick={() => test.mutate(channel)} />
              <Button variant="ghost" className="!px-2 !py-1.5" title="Ereignisse bearbeiten" icon={<Pencil size={14} />}
                onClick={() => openEdit(channel)} />
              <Button variant="ghost" className="!px-2 !py-1.5" title="Kanal löschen" icon={<Trash2 size={14} />}
                onClick={() => setDeleteTarget(channel)} />
              <Toggle checked={channel.enabled} disabled={toggleChannel.isPending}
                onChange={() => toggleChannel.mutate(channel)} />
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={creating && Boolean(form)}
        onClose={() => { setCreating(false); setForm(null); }}
        title={editing ? 'Kanal bearbeiten' : 'Kanal anlegen'}
      >
        <div className="space-y-4">
          <Field label="Name">
            <input className="mc-input" value={form?.name ?? ''} maxLength={60}
              onChange={(e) => setForm((prev) => (prev ? { ...prev, name: e.target.value } : prev))} />
          </Field>
          <div>
            <p className="mb-2 text-sm font-semibold text-stone-200">Ereignisse</p>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {catalog.map((entry) => (
                <label key={entry.key}
                  className="flex cursor-pointer items-center gap-2 rounded border border-stone-800 px-2.5 py-1.5 text-sm text-stone-300 hover:bg-stone-700/40">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[#5B8731]"
                    checked={form?.events.includes(entry.key) ?? false}
                    onChange={() => toggleEvent(entry.key)}
                  />
                  <span className="flex-1">{entry.label}</span>
                  {entry.standard && !form?.events.includes(entry.key) && (
                    <span className="text-[10px] text-stone-450">Standard</span>
                  )}
                </label>
              ))}
            </div>
          </div>
          {form && form.events.length === 0 && (
            <p className="text-sm text-redstone">Mindestens ein Ereignis auswählen.</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => { setCreating(false); setForm(null); }}>Abbrechen</Button>
            <Button variant="primary" loading={save.isPending}
              disabled={!form || form.events.length === 0 || form.name.trim().length < 2}
              onClick={() => save.mutate()}>
              Speichern
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget)}
        title="Kanal löschen?"
        message={`„${deleteTarget?.name ?? ''}“ wird gelöscht – deine Geräte bleiben angemeldet, bekommen dann aber keine Meldungen mehr.`}
        confirmLabel="Löschen"
        danger
      />
    </div>
  );
}

