import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  AlarmClock, ArrowUpCircle, CalendarClock, HardDriveDownload, Pencil, Play, Plus,
  RotateCw, Square, Terminal, Trash2, TriangleAlert, Zap,
} from 'lucide-react';
import { api } from '../../lib/api';
import { formatDate, formatRelative } from '../../lib/format';
import type { Automation, AutomationAction, AutomationTrigger } from '../../lib/types';
import {
  Badge, Button, ConfirmDialog, EmptyState, ErrorNote, Field, InfoNote, LoadingBlock,
  Modal, Panel, Toggle, useToast,
} from '../../components/ui';
import NotificationChannels from '../../components/NotificationChannels';
import { useServer } from './ServerLayout';

interface ListResponse {
  automations: Automation[];
  canManage: boolean;
}

/** Beschreibung, Symbol und Farbe je Aktion. */
const ACTIONS: Record<
  AutomationAction,
  { label: string; hint: string; Icon: typeof Terminal; tint: string }
> = {
  COMMAND: {
    label: 'Befehl senden',
    hint: 'Schickt einen Konsolenbefehl über RCON, z. B. eine Ansage oder /save-all.',
    Icon: Terminal,
    tint: '#4AEDD9',
  },
  BACKUP: {
    label: 'Backup erstellen',
    hint: 'Sichert Welt, Mods und Konfiguration. Alte Backups lassen sich automatisch aufräumen.',
    Icon: HardDriveDownload,
    tint: '#FFAA00',
  },
  RESTART: {
    label: 'Neu starten',
    hint: 'Fährt den Server sauber herunter und wieder hoch.',
    Icon: RotateCw,
    tint: '#7FB238',
  },
  START: { label: 'Starten', hint: 'Startet den Server, falls er aus ist.', Icon: Play, tint: '#17DD62' },
  STOP: { label: 'Stoppen', hint: 'Fährt den Server herunter.', Icon: Square, tint: '#E8453C' },
  MODPACK_UPDATE: {
    label: 'Modpack aktualisieren',
    hint: 'Prüft auf eine neue Version und spielt sie ein – mit vorherigem Backup.',
    Icon: ArrowUpCircle,
    tint: '#3C44AA',
  },
};

/** Fertige Zeitpläne – der Cron-Ausdruck bleibt im Hintergrund. */
const PRESETS: { label: string; cron: string }[] = [
  { label: 'Alle 15 Minuten', cron: '*/15 * * * *' },
  { label: 'Stündlich', cron: '0 * * * *' },
  { label: 'Alle 6 Stunden', cron: '0 */6 * * *' },
  { label: 'Täglich 04:00', cron: '0 4 * * *' },
  { label: 'Täglich 04:00 & 16:00', cron: '0 4,16 * * *' },
  { label: 'Montags 05:00', cron: '0 5 * * 1' },
  { label: 'Monatlich am 1.', cron: '0 5 1 * *' },
];

const EMPTY_FORM = {
  name: '',
  enabled: true,
  trigger: 'SCHEDULE' as AutomationTrigger,
  cron: '0 4 * * *',
  action: 'BACKUP' as AutomationAction,
  command: '',
  backupName: '',
  keepBackups: '' as string,
  onlyWhenRunning: false,
};

type FormState = typeof EMPTY_FORM;

export default function AutomationTab() {
  const { server } = useServer();
  const toast = useToast();

  const [editing, setEditing] = useState<Automation | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Automation | null>(null);

  const list = useQuery({
    queryKey: ['automations', server.id],
    queryFn: () => api.get<ListResponse>(`/servers/${server.id}/automations`),
    refetchInterval: 20_000,
  });

  const canManage = list.data?.canManage ?? false;
  const open = creating || Boolean(editing);

  // Vorschau des Zeitplans, während getippt wird
  const preview = useQuery({
    queryKey: ['cron-preview', server.id, form.cron],
    queryFn: () =>
      api.get<{ valid: boolean; text: string; next: string[] }>(
        `/servers/${server.id}/automations/preview?cron=${encodeURIComponent(form.cron)}`,
      ),
    enabled: open && form.trigger === 'SCHEDULE' && form.cron.trim().length > 0,
  });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        enabled: form.enabled,
        trigger: form.trigger,
        cron: form.trigger === 'SCHEDULE' ? form.cron.trim() : undefined,
        action: form.action,
        onlyWhenRunning: form.onlyWhenRunning,
        config: {
          ...(form.action === 'COMMAND' ? { command: form.command.trim() } : {}),
          ...(form.action === 'BACKUP'
            ? {
                backupName: form.backupName.trim() || undefined,
                keepBackups: form.keepBackups ? Number(form.keepBackups) : undefined,
              }
            : {}),
        },
      };
      return editing
        ? api.patch(`/servers/${server.id}/automations/${editing.id}`, body)
        : api.post(`/servers/${server.id}/automations`, body);
    },
    onSuccess: () => {
      toast.success(editing ? 'Automatisierung gespeichert.' : 'Automatisierung angelegt.');
      closeDialog();
      void list.refetch();
    },
    onError: (err: Error) => setError(err.message),
  });

  const toggle = useMutation({
    mutationFn: (item: Automation) =>
      api.patch(`/servers/${server.id}/automations/${item.id}`, { enabled: !item.enabled }),
    onSuccess: () => void list.refetch(),
    onError: (err: Error) => toast.error(err.message),
  });

  const runNow = useMutation({
    mutationFn: (item: Automation) =>
      api.post<{ ok: boolean; status: string; message: string }>(
        `/servers/${server.id}/automations/${item.id}/run`,
      ),
    onSuccess: (res) => {
      res.ok ? toast.success(res.message) : toast.error(res.message);
      void list.refetch();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: (item: Automation) => api.del(`/servers/${server.id}/automations/${item.id}`),
    onSuccess: () => {
      toast.success('Automatisierung gelöscht.');
      void list.refetch();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function startCreate() {
    setError(null);
    setForm(EMPTY_FORM);
    setEditing(null);
    setCreating(true);
  }

  function startEdit(item: Automation) {
    setError(null);
    setForm({
      name: item.name,
      enabled: item.enabled,
      trigger: item.trigger,
      cron: item.cron ?? '0 4 * * *',
      action: item.action,
      command: item.config.command ?? '',
      backupName: item.config.backupName ?? '',
      keepBackups: item.config.keepBackups ? String(item.config.keepBackups) : '',
      onlyWhenRunning: item.onlyWhenRunning,
    });
    setCreating(false);
    setEditing(item);
  }

  function closeDialog() {
    setCreating(false);
    setEditing(null);
  }

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <Panel
        title="Automatisierungen"
        icon={<Zap size={16} />}
        subtitle="Wiederkehrende Aufgaben – Backups, Neustarts, Ansagen, Modpack-Updates."
        bodyClassName="!p-0"
        actions={
          canManage && (
            <Button
              variant="primary"
              className="!px-3 !py-1.5 !text-xs"
              icon={<Plus size={13} />}
              onClick={startCreate}
            >
              Neue Regel
            </Button>
          )
        }
      >
        {list.isLoading ? (
          <LoadingBlock />
        ) : (list.data?.automations.length ?? 0) === 0 ? (
          <EmptyState
            icon={<AlarmClock size={44} />}
            title="Noch nichts automatisiert"
            description="Typisch sind ein nächtliches Backup um 04:00, ein täglicher Neustart und eine Ansage fünf Minuten vorher."
            action={
              canManage && (
                <Button variant="primary" icon={<Plus size={16} />} onClick={startCreate}>
                  Erste Regel anlegen
                </Button>
              )
            }
          />
        ) : (
          <ul className="divide-y divide-stone-875">
            {list.data!.automations.map((item, i) => (
              <AutomationRow
                key={item.id}
                item={item}
                index={i}
                canManage={canManage}
                busy={runNow.isPending || toggle.isPending}
                onToggle={() => toggle.mutate(item)}
                onRun={() => runNow.mutate(item)}
                onEdit={() => startEdit(item)}
                onDelete={() => setDeleteTarget(item)}
              />
            ))}
          </ul>
        )}
      </Panel>

      {!canManage && (
        <InfoNote>
          Du kannst die Regeln einsehen, aber nicht ändern – dafür fehlt dir das Recht
          „Automatisierungen verwalten".
        </InfoNote>
      )}

      <NotificationChannels
        basePath={`/servers/${server.id}/notifications`}
        queryKey={['notify', server.id]}
        scope="server"
      />

      {/* Anlegen / Bearbeiten */}
      <Modal
        open={open}
        onClose={closeDialog}
        title={editing ? 'Automatisierung bearbeiten' : 'Neue Automatisierung'}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog}>
              Abbrechen
            </Button>
            <Button
              variant="primary"
              loading={save.isPending}
              disabled={form.name.trim().length < 2}
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

          <Field label="Name" hint="Nur zur Wiedererkennung in dieser Liste.">
            <input
              className="mc-input"
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
              placeholder="z. B. Nächtliches Backup"
              autoFocus
            />
          </Field>

          {/* Auslöser */}
          <div>
            <label className="mc-label">Wann?</label>
            <div className="grid gap-2 sm:grid-cols-2">
              <ChoiceCard
                active={form.trigger === 'SCHEDULE'}
                onClick={() => update('trigger', 'SCHEDULE')}
                icon={<CalendarClock size={16} />}
                title="Nach Zeitplan"
                description="Wiederkehrend zu festen Zeiten"
              />
              <ChoiceCard
                active={form.trigger === 'ON_CRASH'}
                onClick={() => update('trigger', 'ON_CRASH')}
                icon={<TriangleAlert size={16} />}
                title="Bei Absturz"
                description="Wenn der Server unerwartet endet"
              />
            </div>
          </div>

          {form.trigger === 'SCHEDULE' && (
            <div className="mc-well space-y-3 p-3">
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.cron}
                    onClick={() => update('cron', preset.cron)}
                    className={clsx(
                      'border px-2.5 py-1 text-xs font-bold transition',
                      form.cron === preset.cron
                        ? 'border-grass-dark bg-grass/25 text-white'
                        : 'border-stone-700 bg-stone-800/60 text-stone-350 hover:text-stone-50',
                    )}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              <Field
                label="Zeitplan (Cron)"
                hint="Minute Stunde Tag Monat Wochentag – die Knöpfe oben füllen das Feld."
              >
                <input
                  className="mc-input font-mono"
                  value={form.cron}
                  onChange={(e) => update('cron', e.target.value)}
                  spellCheck={false}
                />
              </Field>

              {preview.data &&
                (preview.data.valid ? (
                  <div className="text-xs text-stone-350">
                    <p className="font-bold text-grass-light">{preview.data.text}</p>
                    <p className="mt-1">
                      Nächste Läufe:{' '}
                      <span className="font-mono">
                        {preview.data.next.map((d) => formatDate(d)).join(' · ')}
                      </span>
                    </p>
                  </div>
                ) : (
                  <ErrorNote>{preview.data.text}</ErrorNote>
                ))}
            </div>
          )}

          {/* Aktion */}
          <div>
            <label className="mc-label">Was soll passieren?</label>
            <div className="grid gap-2 sm:grid-cols-2">
              {(Object.keys(ACTIONS) as AutomationAction[]).map((key) => {
                const meta = ACTIONS[key];
                return (
                  <ChoiceCard
                    key={key}
                    active={form.action === key}
                    onClick={() => update('action', key)}
                    icon={<meta.Icon size={16} />}
                    tint={meta.tint}
                    title={meta.label}
                    description={meta.hint}
                  />
                );
              })}
            </div>
          </div>

          {form.action === 'COMMAND' && (
            <Field label="Befehl" hint="Ohne führenden Schrägstrich, z. B. say Neustart in 5 Minuten">
              <input
                className="mc-input font-mono"
                value={form.command}
                onChange={(e) => update('command', e.target.value)}
                placeholder="say Der Server startet in 5 Minuten neu"
              />
            </Field>
          )}

          {form.action === 'BACKUP' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name des Backups" hint="Leer lassen für Datum und Uhrzeit.">
                <input
                  className="mc-input"
                  value={form.backupName}
                  onChange={(e) => update('backupName', e.target.value)}
                  placeholder="Automatisch"
                />
              </Field>
              <Field
                label="Nur letzte N Backups behalten"
                hint="Leer lassen, um nichts zu löschen."
              >
                <input
                  className="mc-input"
                  type="number"
                  min={1}
                  max={200}
                  value={form.keepBackups}
                  onChange={(e) => update('keepBackups', e.target.value)}
                  placeholder="z. B. 7"
                />
              </Field>
            </div>
          )}

          <div className="space-y-2.5 border-t border-stone-875 pt-3">
            <Toggle
              checked={form.onlyWhenRunning}
              onChange={(v) => update('onlyWhenRunning', v)}
              label="Nur ausführen, wenn der Server läuft"
            />
            <Toggle
              checked={form.enabled}
              onChange={(v) => update('enabled', v)}
              label="Regel ist aktiv"
            />
          </div>

          {form.action === 'MODPACK_UPDATE' && (
            <InfoNote>
              Vor dem Update wird automatisch ein Backup angelegt. Welt,{' '}
              <code>server.properties</code>, Whitelist und OP-Liste bleiben erhalten.
            </InfoNote>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && remove.mutateAsync(deleteTarget)}
        title="Automatisierung löschen?"
        message={`"${deleteTarget?.name}" wird entfernt und läuft nicht mehr.`}
        confirmLabel="Löschen"
        danger
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function AutomationRow({
  item,
  index,
  canManage,
  busy,
  onToggle,
  onRun,
  onEdit,
  onDelete,
}: {
  item: Automation;
  index: number;
  canManage: boolean;
  busy: boolean;
  onToggle: () => void;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const meta = ACTIONS[item.action];
  const statusTone =
    item.lastStatus === 'OK' ? 'green' : item.lastStatus === 'FEHLER' ? 'red' : 'neutral';

  return (
    <li
      className={clsx(
        'flex animate-slide-in flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-stone-600/[0.28]',
        !item.enabled && 'opacity-60',
      )}
      style={{ animationDelay: `${Math.min(index, 10) * 0.04}s` }}
    >
      <span
        className="grid h-9 w-9 shrink-0 place-items-center border border-stone-950"
        style={{
          background: `${meta.tint}22`,
          color: meta.tint,
          boxShadow: 'inset 1px 1px 0 rgba(255,255,255,.12)',
        }}
      >
        <meta.Icon size={17} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-bold text-stone-50">{item.name}</p>
          <Badge tone={item.enabled ? 'green' : 'neutral'}>
            {item.enabled ? 'aktiv' : 'pausiert'}
          </Badge>
          {item.onlyWhenRunning && <Badge tone="blue">nur wenn online</Badge>}
        </div>

        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-stone-350">
          <span className="font-mono">{meta.label}</span>
          <span className="text-stone-550">·</span>
          <span>{item.scheduleText}</span>
        </p>

        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-stone-450">
          {item.nextRunAt && (
            <span className="font-mono">Nächster Lauf: {formatDate(item.nextRunAt)}</span>
          )}
          {item.lastRunAt && (
            <>
              {item.nextRunAt && <span className="text-stone-550">·</span>}
              <Badge tone={statusTone} className="!text-[9px]">
                {item.lastStatus === 'UEBERSPRUNGEN' ? 'übersprungen' : item.lastStatus}
              </Badge>
              <span className="truncate">
                {formatRelative(item.lastRunAt)}
                {item.lastMessage ? ` – ${item.lastMessage}` : ''}
              </span>
            </>
          )}
        </p>
      </div>

      {canManage && (
        /* Mobil eigene Zeile: sonst bleiben dem Text nur ~100 px und der Name
           wird auf wenige Zeichen zusammengestrichen. */
        <div className="flex w-full shrink-0 items-center justify-end gap-1.5 border-t border-stone-875 pt-2 sm:w-auto sm:border-0 sm:pt-0">
          <Button
            variant="ghost"
            className="!px-2 !py-1 !text-[11px]"
            icon={<Play size={12} />}
            loading={busy}
            onClick={onRun}
            title="Jetzt ausführen"
          />
          <Button
            variant="ghost"
            className="!px-2 !py-1 !text-[11px]"
            icon={<Pencil size={12} />}
            onClick={onEdit}
            title="Bearbeiten"
          />
          <Button
            variant="danger"
            className="!px-2 !py-1 !text-[11px]"
            icon={<Trash2 size={12} />}
            onClick={onDelete}
            title="Löschen"
          />
          <span className="ml-1">
            <Toggle checked={item.enabled} onChange={onToggle} />
          </span>
        </div>
      )}
    </li>
  );
}

function ChoiceCard({
  active,
  onClick,
  icon,
  title,
  description,
  tint,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
  tint?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex items-start gap-2.5 border p-2.5 text-left transition',
        active
          ? 'border-grass-dark bg-grass/15'
          : 'border-stone-700 bg-stone-800/50 hover:border-stone-500',
      )}
    >
      <span
        className="mt-0.5 shrink-0"
        style={{ color: active ? '#7FB238' : (tint ?? '#8c8c96') }}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-bold text-stone-50">{title}</span>
        <span className="mt-0.5 block text-xs leading-snug text-stone-450">{description}</span>
      </span>
    </button>
  );
}
