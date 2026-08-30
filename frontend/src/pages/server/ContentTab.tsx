import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Plus, Puzzle, Search, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { formatBytes, formatDate } from '../../lib/format';
import { CONTENT_KIND_BY_TYPE, type ContentKind, type ContentListing } from '../../lib/types';
import { ModpackBrowser } from '../../components/ModpackBrowser';
import {
  Badge, Button, ConfirmDialog, EmptyState, LoadingBlock, Modal, Panel, Toggle, useToast,
} from '../../components/ui';
import { useServer } from './ServerLayout';

/** Beschriftungen je Inhaltsart – spart Ternaeroperatoren an jeder Textstelle. */
const WORDS: Record<ContentKind, { singular: string; plural: string; dir: string }> = {
  mod: { singular: 'Mod', plural: 'Mods', dir: 'mods' },
  plugin: { singular: 'Plugin', plural: 'Plugins', dir: 'plugins' },
};

export default function ContentTab() {
  const { server, can } = useServer();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBrowser, setShowBrowser] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const content = useQuery({
    queryKey: ['content', server.id],
    queryFn: () => api.get<ContentListing>(`/servers/${server.id}/content`),
  });

  // Bis die Antwort da ist, beschriftet der Servertyp den Reiter – sonst
  // stuende auf einem Paper-Server kurz „Mods“.
  const kind = content.data?.kind ?? CONTENT_KIND_BY_TYPE[server.type];
  const words = WORDS[kind ?? 'mod'];
  const dirName = content.data?.dirName ?? words.dir;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['content', server.id] });

  const toggle = useMutation({
    mutationFn: (filename: string) =>
      api.post(`/servers/${server.id}/content/toggle`, { filename }),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: (filenames: string[]) =>
      api.del(`/servers/${server.id}/content`, { filenames }),
    onSuccess: () => {
      toast.success(`${words.plural} gelöscht.`);
      setSelected(new Set());
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const install = useMutation({
    mutationFn: (body: { provider: string; projectId: string; versionId: string }) =>
      api.post<{ filename: string }>(`/servers/${server.id}/content/install`, body),
    onSuccess: (res) => {
      toast.success(`${res.filename} installiert. Neustart nötig.`);
      setShowBrowser(false);
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const items = content.data?.items ?? [];

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? items.filter((item) => item.displayName.toLowerCase().includes(q)) : items;
  }, [items, search]);

  const enabledCount = items.filter((item) => item.enabled).length;

  function toggleSelection(filename: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  }

  // Vanilla kennt keinen Ordner für Zusatzinhalte – hier hilft nur die
  // Erklaerung, wie man daraus einen Plugin-Server macht.
  if (!content.isLoading && kind === null) {
    return (
      <div className="flex flex-col gap-5 animate-fade-in">
        <Panel title="Inhalte" icon={<Puzzle size={16} />} bodyClassName="!p-0">
          <EmptyState
            icon={<Puzzle size={40} />}
            title="Vanilla kennt weder Mods noch Plugins"
            description={
              <>
                Ein reiner Vanilla-Server lädt keine Erweiterungen. Wenn du Plugins nutzen
                möchtest, stelle den Servertyp unter <strong className="text-stone-200">Einstellungen</strong>{' '}
                auf Paper um – danach erscheint hier der Ordner{' '}
                <code className="text-stone-200">plugins/</code>.
              </>
            }
          />
        </Panel>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <Panel
        title={words.plural}
        icon={<Puzzle size={16} />}
        subtitle={
          content.data
            ? `${items.length} Dateien · ${enabledCount} aktiv`
            : `Inhalt von ${dirName}/`
        }
        bodyClassName="!p-0"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-450" />
              <input
                className="mc-input !w-44 !py-1.5 pl-8 !text-xs"
                placeholder={`${words.singular} suchen …`}
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
                  {words.singular} hinzufügen
                </Button>
              </>
            )}
          </div>
        }
      >
        {content.isLoading ? (
          <LoadingBlock />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<Puzzle size={40} />}
            title={items.length ? 'Nichts gefunden' : `Keine ${words.plural} installiert`}
            description={
              items.length
                ? 'Passe deinen Suchbegriff an.'
                : kind === 'plugin'
                  ? `Lege einzelne Plugins in ${dirName}/ ab oder füge sie hier hinzu.`
                  : 'Installiere ein Modpack oder füge einzelne Mods hinzu.'
            }
          />
        ) : (
          <ul className="divide-y divide-stone-875">
            {list.map((item, i) => (
              <li
                key={item.filename}
                className={clsx(
                  'flex animate-slide-in items-center gap-3 px-4 py-2.5 transition-colors',
                  selected.has(item.filename) ? 'bg-grass/10' : 'hover:bg-stone-600/[0.28]',
                )}
                style={{ animationDelay: `${Math.min(i, 12) * 0.03}s` }}
              >
                {can('modpack.manage') && (
                  <input
                    type="checkbox"
                    checked={selected.has(item.filename)}
                    onChange={() => toggleSelection(item.filename)}
                    className="h-4 w-4 shrink-0 accent-[#5B8731]"
                  />
                )}

                <div className="min-w-0 flex-1">
                  <p
                    className={clsx(
                      'truncate font-mono text-[13px]',
                      item.enabled ? 'text-stone-100' : 'text-stone-450 line-through',
                    )}
                  >
                    {item.displayName}
                  </p>
                  <p className="mt-0.5 font-mono text-[11px] text-stone-450">
                    {formatBytes(item.size)} · {formatDate(item.modified)}
                  </p>
                </div>

                {!item.enabled && <Badge>deaktiviert</Badge>}

                {can('modpack.manage') && (
                  <Toggle
                    checked={item.enabled}
                    disabled={toggle.isPending}
                    onChange={() => toggle.mutate(item.filename)}
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
        title={`Einzelnes ${words.singular} installieren`}
        size="xl"
      >
        <div className="space-y-3">
          <p className="text-sm text-stone-400">
            {kind === 'plugin' ? (
              <>
                Achte darauf, dass das Plugin zu deiner Minecraft-Version passt
                ({server.mcVersion}). Nach der Installation ist ein Neustart nötig.
              </>
            ) : (
              <>
                Achte darauf, dass Loader und Minecraft-Version zu deinem Server passen
                ({server.mcVersion}). Nach der Installation ist ein Neustart nötig.
              </>
            )}
          </p>
          <ModpackBrowser
            type={kind === 'plugin' ? 'plugin' : 'mod'}
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
        title={`${words.plural} löschen?`}
        message={`${selected.size} Datei(en) werden unwiderruflich gelöscht.`}
        confirmLabel="Löschen"
        danger
      />
    </div>
  );
}
