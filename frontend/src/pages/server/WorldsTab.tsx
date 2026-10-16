import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, Globe2, Plus, RefreshCcw, Trash2, Upload } from 'lucide-react';
import { api, downloadFile, uploadFiles } from '../../lib/api';
import { formatBytes, formatRelative } from '../../lib/format';
import type { World, WorldList } from '../../lib/types';
import { TaskProgress } from '../../components/TaskProgress';
import {
  Badge, Button, ConfirmDialog, EmptyState, ErrorNote, Field, InfoNote, LoadErrorBlock, LoadingBlock, Modal,
  Panel, ProgressBar, Toggle, useToast,
} from '../../components/ui';
import { useServer } from './ServerLayout';

const TASK_TYPES = ['world.reset', 'world.import'];

/** Nimmt dem Dateinamen die Endung – ergibt einen brauchbaren Vorschlag. */
const nameFromFile = (file: File) => file.name.replace(/\.zip$/i, '').replace(/[^\w .-]/g, '').trim().slice(0, 64);

export default function WorldsTab() {
  const { server, can, liveState } = useServer();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canWrite = can('files.write');
  const running = liveState === 'running' || liveState === 'starting';

  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createSeed, setCreateSeed] = useState('');
  const [resetOpen, setResetOpen] = useState(false);
  const [resetSeed, setResetSeed] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<World | null>(null);
  const [upload, setUpload] = useState<{ file: File; name: string; activate: boolean } | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const worlds = useQuery({
    queryKey: ['worlds', server.id],
    queryFn: () => api.get<WorldList>(`/servers/${server.id}/worlds`),
  });

  const refresh = () => {
    void worlds.refetch();
    void queryClient.invalidateQueries({ queryKey: ['backups', server.id] });
  };

  const changed = (res: { active: string; restartRequired: boolean }) => {
    toast.success(
      res.restartRequired
        ? `„${res.active}“ ist eingetragen und gilt ab dem nächsten Neustart.`
        : `„${res.active}“ ist jetzt die aktive Welt.`,
    );
    refresh();
  };

  const activate = useMutation({
    mutationFn: (world: World) =>
      api.post<{ active: string; restartRequired: boolean }>(`/servers/${server.id}/worlds/${encodeURIComponent(world.name)}/activate`),
    onSuccess: changed,
    onError: (err: Error) => toast.error(err.message),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<{ active: string; restartRequired: boolean }>(`/servers/${server.id}/worlds`, {
        name: createName.trim(),
        seed: createSeed.trim(),
      }),
    onSuccess: (res) => {
      setShowCreate(false);
      setCreateName('');
      setCreateSeed('');
      changed(res);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const reset = useMutation({
    mutationFn: () => api.post(`/servers/${server.id}/worlds/reset`, { seed: resetSeed.trim() }),
    onSuccess: () => {
      toast.info('Welt wird zurückgesetzt – vorher entsteht ein Sicherheits-Backup.');
      setResetSeed('');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: (world: World) => api.del(`/servers/${server.id}/worlds/${encodeURIComponent(world.name)}`),
    onSuccess: () => {
      toast.success('Welt gelöscht.');
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const sendUpload = useMutation({
    mutationFn: (job: NonNullable<typeof upload>) => {
      const query = new URLSearchParams({ name: job.name.trim(), activate: String(job.activate) });
      setUploadProgress(0);
      return uploadFiles(`/servers/${server.id}/worlds/upload?${query}`, [job.file], setUploadProgress);
    },
    onSuccess: () => {
      toast.info('Welt wird entpackt …');
      setUpload(null);
    },
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => setUploadProgress(null),
  });

  const download = (world: World) =>
    downloadFile(`/servers/${server.id}/worlds/${encodeURIComponent(world.name)}/download`).catch((err: Error) =>
      toast.error(err.message),
    );

  if (worlds.isLoading) return <LoadingBlock />;
  if (!worlds.data) return <LoadErrorBlock error={worlds.error} onRetry={() => void worlds.refetch()} />;
  const data = worlds.data;

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <TaskProgress serverId={server.id} types={TASK_TYPES} onFinished={refresh} />

      <Panel
        title="Welten"
        icon={<Globe2 size={16} />}
        subtitle={`Aktiv: ${data.active}${data.seed ? ` · Seed ${data.seed}` : ''}`}
        bodyClassName="!p-0"
        actions={
          canWrite && (
            <div className="flex flex-wrap gap-2">
              <Button className="!px-3 !py-1.5 !text-xs" icon={<Upload size={13} />} onClick={() => fileInput.current?.click()}>
                ZIP hochladen
              </Button>
              <Button variant="primary" className="!px-3 !py-1.5 !text-xs" icon={<Plus size={13} />} onClick={() => setShowCreate(true)}>
                Neue Welt
              </Button>
            </div>
          )
        }
      >
        <input
          ref={fileInput}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) setUpload({ file, name: nameFromFile(file) || 'Hochgeladen', activate: false });
          }}
        />
        {data.worlds.length === 0 ? (
          <EmptyState icon={<Globe2 size={40} />} title="Noch keine Welt" description="Der Server erzeugt seine Welt beim ersten Start." />
        ) : (
          <ul className="divide-y divide-stone-875">
            {data.worlds.map((world) => (
              <li key={world.name} className="flex flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-stone-600/[0.28]">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-stone-50">
                    <span className="truncate">{world.name}</span>
                    {world.active && <Badge tone="green">Aktiv</Badge>}
                    {!world.exists && <Badge tone="gold">Entsteht beim nächsten Start</Badge>}
                  </p>
                  {world.exists && (
                    <p className="mt-0.5 font-mono text-xs text-stone-450">
                      {formatBytes(world.sizeBytes)} · geändert {formatRelative(world.modifiedAt)}
                      {world.dimensions.length > 0 && ` · mit ${world.dimensions.join(', ')}`}
                    </p>
                  )}
                </div>
                <div className="flex gap-1.5">
                  {canWrite && !world.active && world.exists && (
                    <Button
                      className="!px-2.5 !py-1.5 !text-xs"
                      icon={<Check size={13} />}
                      loading={activate.isPending && activate.variables?.name === world.name}
                      onClick={() => activate.mutate(world)}
                    >
                      Aktivieren
                    </Button>
                  )}
                  {world.exists && (
                    <Button
                      variant="ghost"
                      className="!px-2.5 !py-1.5 !text-xs"
                      icon={<Download size={13} />}
                      title="Als Archiv herunterladen"
                      aria-label="Herunterladen"
                      onClick={() => void download(world)}
                    />
                  )}
                  {canWrite && world.active && world.exists && (
                    <Button
                      variant="gold"
                      className="!px-2.5 !py-1.5 !text-xs"
                      icon={<RefreshCcw size={13} />}
                      onClick={() => setResetOpen(true)}
                    >
                      Zurücksetzen
                    </Button>
                  )}
                  {canWrite && !world.active && world.exists && (
                    <Button
                      variant="danger"
                      className="!px-2.5 !py-1.5 !text-xs"
                      icon={<Trash2 size={13} />}
                      aria-label="Löschen"
                      onClick={() => setDeleteTarget(world)}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <InfoNote>
        Ein Wechsel trägt die Welt in <code>server.properties</code> ein und greift beim nächsten Start. Andere Welten
        bleiben unangetastet liegen; vor dem Zurücksetzen entsteht automatisch ein Sicherheits-Backup.
      </InfoNote>

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Neue Welt"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Abbrechen</Button>
            <Button variant="primary" loading={create.isPending} disabled={!createName.trim()} onClick={() => create.mutate()}>
              Anlegen
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name" hint="Wird zum Ordnernamen. Buchstaben, Ziffern, Leerzeichen, Punkt, Binde- und Unterstrich.">
            <input className="mc-input" value={createName} onChange={(e) => setCreateName(e.target.value)} maxLength={64} autoFocus />
          </Field>
          <Field label="Seed (optional)" hint="Leer lassen für einen zufälligen Seed.">
            <input className="mc-input font-mono" value={createSeed} onChange={(e) => setCreateSeed(e.target.value)} maxLength={64} />
          </Field>
          <InfoNote>Die bisherige Welt bleibt erhalten. Der Server erzeugt die neue Welt beim nächsten Start.</InfoNote>
        </div>
      </Modal>

      <Modal
        open={Boolean(upload)}
        onClose={() => !sendUpload.isPending && setUpload(null)}
        title="Welt hochladen"
        size="sm"
        footer={
          <>
            <Button variant="ghost" disabled={sendUpload.isPending} onClick={() => setUpload(null)}>Abbrechen</Button>
            <Button
              variant="primary"
              loading={sendUpload.isPending}
              disabled={!upload?.name.trim()}
              onClick={() => upload && sendUpload.mutate(upload)}
            >
              Hochladen
            </Button>
          </>
        }
      >
        {upload && (
          <div className="space-y-4">
            <p className="text-sm text-stone-300">
              <span className="font-mono text-stone-100">{upload.file.name}</span> · {formatBytes(upload.file.size)}
            </p>
            <Field label="Name der Welt" hint="Der Name darf noch nicht vergeben sein – bestehende Welten werden nie überschrieben.">
              <input
                className="mc-input"
                value={upload.name}
                maxLength={64}
                onChange={(e) => setUpload({ ...upload, name: e.target.value })}
              />
            </Field>
            <Toggle
              checked={upload.activate}
              onChange={(activate) => setUpload({ ...upload, activate })}
              label="Danach als aktive Welt eintragen"
            />
            <p className="text-xs text-stone-450">
              Das ZIP muss eine <code>level.dat</code> enthalten – direkt oder in einem Ordner, etwa eine
              Einzelspieler-Welt aus dem <code>saves</code>-Ordner.
            </p>
            {uploadProgress !== null && <ProgressBar value={uploadProgress} showLabel />}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        onConfirm={() => reset.mutateAsync()}
        title="Welt zurücksetzen?"
        message={
          <div className="space-y-3">
            {running && <ErrorNote>Bitte den Server zuerst stoppen.</ErrorNote>}
            <p>
              <strong className="text-stone-100">{data.active}</strong> wird samt Nether und End gelöscht; beim
              nächsten Start entsteht eine neue Welt. Vorher wird ein Sicherheits-Backup angelegt.
            </p>
            <Field label="Neuer Seed (optional)" hint="Leer lassen für einen zufälligen Seed.">
              <input className="mc-input font-mono" value={resetSeed} onChange={(e) => setResetSeed(e.target.value)} maxLength={64} />
            </Field>
          </div>
        }
        confirmLabel="Zurücksetzen"
        danger
        requireText="ZURÜCKSETZEN"
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && remove.mutateAsync(deleteTarget)}
        title="Welt löschen?"
        message={`„${deleteTarget?.name}“ wird samt Dimensionen endgültig entfernt. Vorher bei Bedarf herunterladen.`}
        confirmLabel="Löschen"
        danger
      />
    </div>
  );
}
