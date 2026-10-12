import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, authedUrl } from '../lib/api';
import { formatBytes, formatDate } from '../lib/format';
import { Button, ConfirmDialog, Field, Panel, Toggle, useToast } from './ui';

interface Schedule { enabled: boolean; cron: string; keep: number; timezone: string; lastRun: string; lastStatus: string }
interface Result {
  backups: { filename: string; sizeBytes: number; createdAt: string }[];
  schedule: Schedule;
  tasks: { id: string; status: string; message: string; error: string | null; progress: number }[];
}
export default function PanelBackups() {
  const toast = useToast();
  const queries = useQueryClient();
  const [draft, setDraft] = useState<{ enabled: boolean; cron: string; keep: number } | null>(null);
  const [remove, setRemove] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['panel-backups'], queryFn: () => api.get<Result>('/settings/panel-backups'),
    refetchInterval: query => query.state.data?.tasks.some(task => task.status === 'RUNNING') ? 2000 : 30_000 });
  const refresh = () => void queries.invalidateQueries({ queryKey: ['panel-backups'] });
  const create = useMutation({ mutationFn: () => api.post('/settings/panel-backups', {}),
    onSuccess: () => { toast.info('Panel-Sicherung gestartet.'); refresh(); }, onError: (err: Error) => toast.error(err.message) });
  const schedule = draft ?? query.data?.schedule ?? { enabled: false, cron: '0 3 * * *', keep: 7 };
  const save = useMutation({ mutationFn: () => api.put('/settings/panel-backups/schedule', { enabled: schedule.enabled, cron: schedule.cron, keep: schedule.keep }),
    onSuccess: () => { toast.success('Zeitplan für Panel-Sicherungen gespeichert.'); refresh(); }, onError: (err: Error) => toast.error(err.message) });
  const deleteBackup = useMutation({ mutationFn: (filename: string) => api.del(`/settings/panel-backups/${encodeURIComponent(filename)}`),
    onSuccess: () => { setRemove(null); refresh(); }, onError: (err: Error) => toast.error(err.message) });
  const busy = query.data?.tasks.some(task => task.status === 'RUNNING') ?? false;
  const task = query.data?.tasks[0];
  return <Panel title="Panel-Sicherungen">
    <div className="space-y-4">
      <p className="text-sm text-stone-400">Sichert Konten, Rechte, Einstellungen, Serverzuordnungen sowie JWT- und SFTP-Hostschlüssel. Welten und Minecraft-Dateien liegen in den separaten Server-Backups. Das Archiv enthält Zugangsdaten und gehört in eine geschützte Ablage.</p>
      <Button variant="primary" loading={create.isPending || busy} onClick={() => create.mutate()}>Panel jetzt sichern</Button>
      {task && <p role="status" className={task.status === 'FAILED' ? 'text-sm text-redstone' : 'text-sm text-stone-400'}>{task.status === 'FAILED' ? task.error : `${task.message}${task.status === 'RUNNING' ? ` · ${task.progress} %` : ''}`}</p>}
      {query.error && <p className="text-sm text-redstone">{(query.error as Error).message}</p>}
      <form className="space-y-3 border-t border-stone-700 pt-4" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
        <Toggle checked={schedule.enabled} onChange={enabled => setDraft({ ...schedule, enabled })} label="Panel automatisch sichern" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Zeitplan" hint={`Fünf Cron-Felder, z. B. 0 3 * * * für täglich 03:00 Uhr (${query.data?.schedule.timezone ?? 'Europe/Berlin'}).`}>
            <input aria-label="Zeitplan für Panel-Sicherungen" className="mc-input font-mono" value={schedule.cron} required onChange={event => setDraft({ ...schedule, cron: event.target.value })} />
          </Field>
          <Field label="Aufbewahrte Panel-Sicherungen" hint="Ältere Archive werden nach einer erfolgreichen Sicherung entfernt.">
            <input aria-label="Aufbewahrte Panel-Sicherungen" className="mc-input" type="number" min={1} max={365} required value={schedule.keep} onChange={event => setDraft({ ...schedule, keep: Number(event.target.value) })} />
          </Field>
        </div>
        <Button type="submit" loading={save.isPending}>Zeitplan speichern</Button>
      </form>
      <ul className="divide-y divide-stone-700">
        {query.data?.backups.map(backup => <li key={backup.filename} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <span className="text-sm">{formatDate(backup.createdAt)} · {formatBytes(backup.sizeBytes)}</span>
          <div className="flex gap-2"><a href={authedUrl(`/settings/panel-backups/${encodeURIComponent(backup.filename)}/download`)} className="text-sm text-grass-light hover:underline">Herunterladen</a>
            <button className="text-sm text-redstone hover:underline" onClick={() => setRemove(backup.filename)}>Löschen</button></div>
        </li>)}
      </ul>
      {query.data && !query.data.backups.length && <p className="text-sm text-stone-450">Noch keine Panel-Sicherung vorhanden.</p>}
      <p className="text-xs text-stone-450">Eine Anleitung zum Wiederherstellen liegt im Archiv unter WIEDERHERSTELLUNG.txt.</p>
    </div>
    <ConfirmDialog open={Boolean(remove)} onClose={() => setRemove(null)} danger title="Panel-Sicherung löschen" message="Dieses Sicherungsarchiv wird dauerhaft gelöscht." confirmLabel="Löschen" onConfirm={() => deleteBackup.mutateAsync(remove!).then(() => {})} />
  </Panel>;
}
