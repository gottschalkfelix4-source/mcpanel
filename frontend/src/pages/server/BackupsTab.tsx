import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, HardDrive, HardDriveDownload, Pin, PinOff, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { api, downloadFile } from '../../lib/api';
import { formatBytes, formatDate, formatRelative } from '../../lib/format';
import type { Backup } from '../../lib/types';
import { TaskProgress } from '../../components/TaskProgress';
import {
  Button, ConfirmDialog, EmptyState, InfoNote, LoadingBlock, Modal, Panel, Toggle, useToast,
} from '../../components/ui';
import { useServer } from './ServerLayout';

const TASK_TYPES = ['backup.create', 'backup.restore'];

const ORIGIN_LABEL: Record<Backup['origin'], string | null> = {
  MANUAL: null,
  AUTOMATIC: 'Automatisch',
  SAFETY: 'Sicherheitskopie',
};

export default function BackupsTab() {
  const { server, can } = useServer();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [restoreTarget, setRestoreTarget] = useState<Backup | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Backup | null>(null);
  const [safetyBackup, setSafetyBackup] = useState(true);

  const backups = useQuery({
    queryKey: ['backups', server.id],
    queryFn: () => api.get<Backup[]>(`/servers/${server.id}/backups`),
  });

  const invalidate = useCallback(() => {
    void backups.refetch();
    queryClient.invalidateQueries({ queryKey: ['server', server.id] });
  }, [backups, queryClient, server.id]);

  const create = useMutation({
    mutationFn: () => api.post(`/servers/${server.id}/backups`, { name: name.trim(), note: note.trim() }),
    onSuccess: () => {
      toast.info('Backup wird erstellt …');
      setShowCreate(false);
      setName('');
      setNote('');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const restore = useMutation({
    mutationFn: (backup: Backup) => api.post(`/servers/${server.id}/backups/${backup.id}/restore`, { safetyBackup }),
    onSuccess: () => toast.info('Backup wird eingespielt – der Server wird gestoppt.'),
    onError: (err: Error) => toast.error(err.message),
  });

  const pin = useMutation({
    mutationFn: (backup: Backup) => api.patch(`/servers/${server.id}/backups/${backup.id}`, { pinned: !backup.pinned }),
    onSuccess: (_data, backup) => {
      toast.success(backup.pinned ? 'Backup wird wieder normal aufgeräumt.' : 'Backup angepinnt – es wird nie automatisch gelöscht.');
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const download = (backup: Backup) =>
    downloadFile(`/servers/${server.id}/backups/${backup.id}/download`).catch((err: Error) => toast.error(err.message));

  const remove = useMutation({
    mutationFn: (backup: Backup) => api.del(`/servers/${server.id}/backups/${backup.id}`),
    onSuccess: () => {
      toast.success('Backup gelöscht.');
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const total = (backups.data ?? []).reduce((sum, b) => sum + b.sizeBytes, 0);

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <TaskProgress serverId={server.id} types={TASK_TYPES} onFinished={invalidate} />

      <Panel
        title="Backups"
        icon={<HardDriveDownload size={16} />}
        subtitle={
          backups.data
            ? `${backups.data.length} Sicherungen · ${formatBytes(total)} belegt`
            : undefined
        }
        bodyClassName="!p-0"
        actions={
          can('backup.create') && (
            <Button
              variant="primary"
              className="!px-3 !py-1.5 !text-xs"
              icon={<Plus size={13} />}
              onClick={() => setShowCreate(true)}
            >
              Backup erstellen
            </Button>
          )
        }
      >
        {backups.isLoading ? (
          <LoadingBlock />
        ) : (backups.data?.length ?? 0) === 0 ? (
          <EmptyState
            icon={<HardDriveDownload size={40} />}
            title="Noch keine Backups"
            description="Ein Backup sichert Welt, Mods und Konfiguration als tar.gz-Archiv. Vor jedem Modpack-Update wird automatisch eines angelegt."
          />
        ) : (
          <ul className="divide-y divide-stone-875">
            {backups.data!.map((backup, i) => (
              <li
                key={backup.id}
                className="flex animate-slide-in flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-stone-600/[0.28]"
                style={{ animationDelay: `${Math.min(i, 10) * 0.04}s` }}
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate text-sm font-semibold text-stone-50">
                    <span className="truncate">{backup.name}</span>
                    {backup.pinned && (
                      <span
                        className="inline-flex shrink-0 items-center gap-1 border border-gold/40 bg-gold/[0.12] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-gold"
                        title="Wird von keiner Aufbewahrungsregel gelöscht"
                      >
                        <Pin size={10} />
                        Angepinnt
                      </span>
                    )}
                    {ORIGIN_LABEL[backup.origin] && (
                      <span className="shrink-0 border border-stone-600 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-stone-400">
                        {ORIGIN_LABEL[backup.origin]}
                      </span>
                    )}
                    {backup.mirrored && (
                      <span
                        className="inline-flex shrink-0 items-center gap-1 border border-emerald/40 bg-emerald/[0.12] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-emerald"
                        title="Liegt zusätzlich in der Zweitablage"
                      >
                        <HardDrive size={10} />
                        2. Ablage
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-stone-450">
                    {formatDate(backup.createdAt)} · {formatRelative(backup.createdAt)} ·{' '}
                    {formatBytes(backup.sizeBytes)}
                    {backup.createdBy && ` · von ${backup.createdBy.username}`}
                  </p>
                  {backup.note && <p className="mt-1 text-xs italic text-stone-450">{backup.note}</p>}
                </div>

                <div className="flex gap-1.5">
                  {can('backup.create') && (
                    <Button
                      variant="ghost"
                      className="!px-2.5 !py-1.5 !text-xs"
                      icon={backup.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                      title={backup.pinned ? 'Nicht mehr anpinnen' : 'Anpinnen – nie automatisch löschen'}
                      aria-label={backup.pinned ? 'Nicht mehr anpinnen' : 'Anpinnen'}
                      onClick={() => pin.mutate(backup)}
                    />
                  )}
                  {can('backup.download') && (
                    <Button
                      variant="ghost"
                      className="!px-2.5 !py-1.5 !text-xs"
                      icon={<Download size={13} />}
                      title="Herunterladen"
                      aria-label="Herunterladen"
                      onClick={() => void download(backup)}
                    />
                  )}
                  {can('backup.restore') && (
                    <Button
                      variant="gold"
                      className="!px-2.5 !py-1.5 !text-xs"
                      icon={<RotateCcw size={13} />}
                      onClick={() => setRestoreTarget(backup)}
                    >
                      Einspielen
                    </Button>
                  )}
                  {can('backup.delete') && (
                    <Button
                      variant="danger"
                      className="!px-2.5 !py-1.5 !text-xs"
                      icon={<Trash2 size={13} />}
                      onClick={() => setDeleteTarget(backup)}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Backup erstellen"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>
              Abbrechen
            </Button>
            <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
              Erstellen
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <InfoNote>
            Der Server darf weiterlaufen – die Welt wird vorher gespeichert. Große Welten brauchen
            etwas Zeit.
          </InfoNote>
          <div>
            <label className="mc-label">Name</label>
            <input
              className="mc-input"
              placeholder="z. B. Vor dem Nether-Ausflug"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="mc-label">Notiz (optional)</label>
            <input className="mc-input" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(restoreTarget)}
        onClose={() => { setRestoreTarget(null); setSafetyBackup(true); }}
        onConfirm={() => restoreTarget && restore.mutateAsync(restoreTarget)}
        title="Backup einspielen?"
        message={
          <>
            <p>
              Der Server wird gestoppt und der komplette Serverordner durch{' '}
              <strong className="text-stone-100">{restoreTarget?.name}</strong> ersetzt.
            </p>
            <p className="mt-2 text-redstone">
              {safetyBackup
                ? 'Der aktuelle Stand wird vorher als Sicherheitskopie gesichert.'
                : 'Alle Änderungen seit dieser Sicherung gehen verloren.'}
            </p>
            <div className="mt-3">
              <Toggle checked={safetyBackup} onChange={setSafetyBackup} label="Aktuellen Stand vorher sichern" />
            </div>
          </>
        }
        confirmLabel="Einspielen"
        danger
        requireText="EINSPIELEN"
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && remove.mutateAsync(deleteTarget)}
        title="Backup löschen?"
        message={`"${deleteTarget?.name}" wird endgültig entfernt.`}
        confirmLabel="Löschen"
        danger
      />
    </div>
  );
}
