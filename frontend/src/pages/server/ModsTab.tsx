import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Plus, Puzzle, Search, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { formatBytes, formatDate } from '../../lib/format';
import type { ModFile } from '../../lib/types';
import { ModpackBrowser } from '../../components/ModpackBrowser';
import {
  Badge, Button, ConfirmDialog, EmptyState, LoadingBlock, Modal, Panel, Toggle, useToast,
} from '../../components/ui';
import { useServer } from './ServerLayout';

export default function ModsTab() {
  const { server, can } = useServer();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBrowser, setShowBrowser] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const mods = useQuery({
    queryKey: ['mods', server.id],
    queryFn: () => api.get<{ mods: ModFile[] }>(`/servers/${server.id}/modpack/mods`),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['mods', server.id] });

  const toggle = useMutation({
    mutationFn: (filename: string) =>
      api.post(`/servers/${server.id}/modpack/mods/toggle`, { filename }),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: (filenames: string[]) =>
      api.del(`/servers/${server.id}/modpack/mods`, { filenames }),
    onSuccess: () => {
      toast.success('Mods gelöscht.');
      setSelected(new Set());
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const install = useMutation({
    mutationFn: (body: { provider: string; projectId: string; versionId: string }) =>
      api.post<{ filename: string }>(`/servers/${server.id}/modpack/mods/install`, body),
    onSuccess: (res) => {
      toast.success(`${res.filename} installiert. Neustart nötig.`);
      setShowBrowser(false);
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const list = useMemo(() => {
    const all = mods.data?.mods ?? [];
    const q = search.trim().toLowerCase();
    return q ? all.filter((m) => m.displayName.toLowerCase().includes(q)) : all;
  }, [mods.data, search]);

  const enabledCount = (mods.data?.mods ?? []).filter((m) => m.enabled).length;

  function toggleSelection(filename: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <Panel
        title="Mods"
        icon={<Puzzle size={16} />}
        subtitle={
          mods.data
            ? `${mods.data.mods.length} Dateien · ${enabledCount} aktiv`
            : 'Inhalt von mods/'
        }
        bodyClassName="!p-0"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-450" />
              <input
                className="mc-input !w-44 !py-1.5 pl-8 !text-xs"
                placeholder="Mod suchen …"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {can('modpack.manage') && (
              <>
                {selected.size > 0 && (
                  <Button
                    variant="danger"
                    className="!px-3 !py-1.5 !text-xs"
                    icon={<Trash2 size={13} />}
                    onClick={() => setConfirmDelete(true)}
                  >
                    {selected.size} löschen
                  </Button>
                )}
                <Button
                  variant="primary"
                  className="!px-3 !py-1.5 !text-xs"
                  icon={<Plus size={13} />}
                  onClick={() => setShowBrowser(true)}
                >
                  Mod hinzufügen
                </Button>
              </>
            )}
          </div>
        }
      >
        {mods.isLoading ? (
          <LoadingBlock />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<Puzzle size={40} />}
            title={mods.data?.mods.length ? 'Nichts gefunden' : 'Keine Mods installiert'}
            description={
              mods.data?.mods.length
                ? 'Passe deinen Suchbegriff an.'
                : 'Installiere ein Modpack oder füge einzelne Mods hinzu.'
            }
          />
        ) : (
          <ul className="divide-y divide-stone-875">
            {list.map((mod, i) => (
              <li
                key={mod.filename}
                className={clsx(
                  'flex animate-slide-in items-center gap-3 px-4 py-2.5 transition-colors',
                  selected.has(mod.filename) ? 'bg-grass/10' : 'hover:bg-stone-600/[0.28]',
                )}
                style={{ animationDelay: `${Math.min(i, 12) * 0.03}s` }}
              >
                {can('modpack.manage') && (
                  <input
                    type="checkbox"
                    checked={selected.has(mod.filename)}
                    onChange={() => toggleSelection(mod.filename)}
                    className="h-4 w-4 shrink-0 accent-[#5B8731]"
                  />
                )}

                <div className="min-w-0 flex-1">
                  <p
                    className={clsx(
                      'truncate font-mono text-[13px]',
                      mod.enabled ? 'text-stone-100' : 'text-stone-450 line-through',
                    )}
                  >
                    {mod.displayName}
                  </p>
                  <p className="mt-0.5 font-mono text-[11px] text-stone-450">
                    {formatBytes(mod.size)} · {formatDate(mod.modified)}
                  </p>
                </div>

                {!mod.enabled && <Badge>deaktiviert</Badge>}

                {can('modpack.manage') && (
                  <Toggle
                    checked={mod.enabled}
                    disabled={toggle.isPending}
                    onChange={() => toggle.mutate(mod.filename)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Modal
        open={showBrowser}
        onClose={() => setShowBrowser(false)}
        title="Einzelne Mod installieren"
        size="xl"
      >
        <div className="space-y-3">
          <p className="text-sm text-stone-400">
            Achte darauf, dass Loader und Minecraft-Version zu deinem Server passen
            ({server.mcVersion}). Nach der Installation ist ein Neustart nötig.
          </p>
          <ModpackBrowser
            type="mod"
            onPick={(project, version) =>
              install.mutateAsync({
                provider: project.provider,
                projectId: project.id,
                versionId: version.id,
              })
            }
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutateAsync([...selected])}
        title="Mods löschen?"
        message={`${selected.size} Datei(en) werden unwiderruflich gelöscht.`}
        confirmLabel="Löschen"
        danger
      />
    </div>
  );
}
