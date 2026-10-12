import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Button, useToast } from './ui';

interface Preview {
  version: string; versionId: string; serverPack: boolean;
  minecraft: { current: string; next: string };
  loader: { current: string; next: string; version: string | null };
  added: string[]; removed: string[]; updated: { before: string; after: string }[]; unchanged: number;
}
export default function ModpackPreview({ serverId, provider, projectId, versionId, busy }: {
  serverId: string; provider: string; projectId: string; versionId: string; busy: boolean;
}) {
  const queries = useQueryClient();
  const toast = useToast();
  const result = useQuery({ queryKey: ['modpack-preview', serverId], queryFn: () => api.get<Preview | null>(`/servers/${serverId}/modpack/preview`), refetchInterval: busy ? 3000 : false });
  const start = useMutation({ mutationFn: () => api.post(`/servers/${serverId}/modpack/preview`, { provider, projectId, versionId }),
    onSuccess: () => { toast.info('Paketvergleich gestartet. Der Server läuft weiter.'); void queries.invalidateQueries({ queryKey: ['server-tasks', serverId] }); void result.refetch(); },
    onError: (err: Error) => toast.error(err.message) });
  const preview = result.data?.versionId === versionId ? result.data : null;
  const changes = (label: string, files: string[]) => <details className="border-t border-stone-700 py-2"><summary className="cursor-pointer text-sm">{label} ({files.length})</summary><ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs text-stone-400">{files.map(name => <li key={name} className="break-all">{name}</li>)}</ul></details>;
  return <div className="space-y-3">
    <Button disabled={busy} loading={start.isPending} onClick={() => start.mutate()}>Änderungen vor dem Update prüfen</Button>
    {preview && <div>
      <p className="text-sm font-semibold">Paketvergleich: {preview.version}</p>
      <dl className="my-3 grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-stone-450">Minecraft</dt><dd>{preview.minecraft.current} → {preview.minecraft.next}</dd></div>
        <div><dt className="text-stone-450">Loader</dt><dd>{preview.loader.current} → {preview.loader.next}{preview.loader.version ? ` ${preview.loader.version}` : ''}</dd></div>
      </dl>
      {changes('Neue Mods', preview.added)}{changes('Entfernte Mods', preview.removed)}
      {changes('Aktualisierte Mods', preview.updated.map(item => `${item.before} → ${item.after}`))}
      <p className="mt-2 text-xs text-stone-450">{preview.unchanged} unveränderte Mods. {preview.serverPack ? 'Serverpaket des Autors.' : 'Die zusätzliche Client-Mod-Prüfung erfolgt bei der Installation.'} Eigene Mods, die im neuen Paket fehlen, werden beim Update entfernt.</p>
    </div>}
  </div>;
}
