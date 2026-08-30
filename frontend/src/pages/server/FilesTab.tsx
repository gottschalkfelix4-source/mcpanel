import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ChevronRight, Download, File as FileIcon, FileArchive, FileCode2, FileText, Folder,
  FolderPlus, HardDrive, Home, PencilLine, Save, Trash2, Upload,
} from 'lucide-react';
import { api, authedUrl, uploadFiles } from '../../lib/api';
import { formatBytes, formatDate } from '../../lib/format';
import type { FileEntry } from '../../lib/types';
import {
  Button, ConfirmDialog, EmptyState, ErrorNote, LoadingBlock, Modal, Panel, ProgressBar, useToast,
} from '../../components/ui';
import { useServer } from './ServerLayout';

function iconFor(entry: FileEntry) {
  if (entry.isDir) return <Folder size={16} className="text-gold" />;
  if (/\.(zip|jar|gz|tar|rar)$/i.test(entry.name)) return <FileArchive size={16} className="text-lapis" />;
  if (/\.(json|toml|yml|yaml|properties|cfg|conf|snbt)$/i.test(entry.name))
    return <FileCode2 size={16} className="text-diamond" />;
  if (/\.(txt|log|md)$/i.test(entry.name)) return <FileText size={16} className="text-stone-400" />;
  return <FileIcon size={16} className="text-stone-500" />;
}

export default function FilesTab() {
  const { server, can } = useServer();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [path, setPath] = useState('/');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ path: string; content: string } | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [renaming, setRenaming] = useState<FileEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);

  const listing = useQuery({
    queryKey: ['files', server.id, path],
    queryFn: () =>
      api.get<{ path: string; entries: FileEntry[] }>(
        `/servers/${server.id}/files?path=${encodeURIComponent(path)}`,
      ),
  });

  useEffect(() => setSelected(new Set()), [path]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['files', server.id] });

  const saveFile = useMutation({
    mutationFn: (payload: { path: string; content: string }) =>
      api.put(`/servers/${server.id}/files/content`, payload),
    onSuccess: () => {
      toast.success('Datei gespeichert.');
      setEditing(null);
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const createFolder = useMutation({
    mutationFn: (name: string) =>
      api.post(`/servers/${server.id}/files/dir`, { path: joinPath(path, name) }),
    onSuccess: () => {
      setNewFolder(false);
      setFolderName('');
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const rename = useMutation({
    mutationFn: (payload: { from: string; to: string }) =>
      api.post(`/servers/${server.id}/files/rename`, payload),
    onSuccess: () => {
      setRenaming(null);
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: (paths: string[]) => api.del(`/servers/${server.id}/files`, { paths }),
    onSuccess: () => {
      toast.success('Gelöscht.');
      setSelected(new Set());
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const unzip = useMutation({
    mutationFn: (target: string) =>
      api.post(`/servers/${server.id}/files/unzip`, { path: target, target: path }),
    onSuccess: () => {
      toast.success('Archiv entpackt.');
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  async function openFile(entry: FileEntry) {
    if (entry.isDir) {
      setPath(entry.path);
      return;
    }
    if (!entry.editable) {
      window.open(authedUrl(`/servers/${server.id}/files/download?path=${encodeURIComponent(entry.path)}`), '_blank');
      return;
    }
    try {
      const res = await api.get<{ content: string }>(
        `/servers/${server.id}/files/content?path=${encodeURIComponent(entry.path)}`,
      );
      setEditing({ path: entry.path, content: res.content });
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploadPercent(0);
    try {
      await uploadFiles(
        `/servers/${server.id}/files/upload?path=${encodeURIComponent(path)}`,
        files,
        setUploadPercent,
      );
      toast.success(`${files.length} Datei(en) hochgeladen.`);
      invalidate();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setUploadPercent(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const crumbs = path.split('/').filter(Boolean);

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <Panel
        title="Dateien"
        icon={<HardDrive size={16} />}
        bodyClassName="!p-0"
        subtitle={
          <nav className="flex flex-wrap items-center gap-1 text-xs">
            <button
              onClick={() => setPath('/')}
              className="flex items-center gap-1 text-stone-400 transition hover:text-grass-light"
            >
              <Home size={12} /> /data
            </button>
            {crumbs.map((crumb, i) => (
              <span key={i} className="flex items-center gap-1">
                <ChevronRight size={11} className="text-stone-600" />
                <button
                  onClick={() => setPath('/' + crumbs.slice(0, i + 1).join('/'))}
                  className="text-stone-400 transition hover:text-grass-light"
                >
                  {crumb}
                </button>
              </span>
            ))}
          </nav>
        }
        actions={
          can('files.write') && (
            <div className="flex flex-wrap gap-2">
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
                variant="ghost"
                className="!px-3 !py-1.5 !text-xs"
                icon={<FolderPlus size={13} />}
                onClick={() => setNewFolder(true)}
              >
                Ordner
              </Button>
              <Button
                variant="primary"
                className="!px-3 !py-1.5 !text-xs"
                icon={<Upload size={13} />}
                onClick={() => fileInput.current?.click()}
              >
                Hochladen
              </Button>
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => handleUpload(e.target.files)}
              />
            </div>
          )
        }
      >
        {uploadPercent !== null && (
          <div className="border-b border-stone-890 bg-stone-well/40 px-4 py-2.5">
            <p className="mb-1.5 text-xs text-stone-400">Upload läuft …</p>
            <ProgressBar value={uploadPercent} showLabel />
          </div>
        )}

        {listing.isLoading ? (
          <LoadingBlock />
        ) : listing.error ? (
          <div className="p-4">
            <ErrorNote>{(listing.error as Error).message}</ErrorNote>
          </div>
        ) : listing.data!.entries.length === 0 ? (
          <EmptyState icon={<Folder size={40} />} title="Ordner ist leer" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-890 bg-stone-well/40 text-left text-[10px] font-bold uppercase tracking-[0.12em] text-stone-450">
                  {can('files.write') && <th className="w-8 px-4 py-2" />}
                  {/* max-w-0 + w-full zwingt die Namensspalte zum Kürzen,
                      sonst schiebt sie die Aktionen aus dem Bild. */}
                  <th className="w-full max-w-0 px-2 py-2">Name</th>
                  <th className="hidden px-2 py-2 sm:table-cell">Größe</th>
                  <th className="hidden px-2 py-2 md:table-cell">Geändert</th>
                  <th className="w-24 px-3 py-2 text-right sm:w-32 sm:px-4">Aktionen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-875">
                {path !== '/' && (
                  <tr className="transition-colors hover:bg-stone-600/[0.28]">
                    <td colSpan={5} className="px-4 py-2">
                      <button
                        onClick={() => setPath('/' + crumbs.slice(0, -1).join('/'))}
                        className="flex items-center gap-2 text-stone-400 transition hover:text-grass-light"
                      >
                        <Folder size={16} className="text-stone-600" /> ..
                      </button>
                    </td>
                  </tr>
                )}

                {listing.data!.entries.map((entry) => (
                  <tr
                    key={entry.path}
                    className={clsx(
                      'group transition-colors hover:bg-stone-600/[0.28]',
                      selected.has(entry.path) && 'bg-grass/10',
                    )}
                  >
                    {can('files.write') && (
                      <td className="px-4 py-2">
                        <input
                          type="checkbox"
                          checked={selected.has(entry.path)}
                          onChange={() =>
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (next.has(entry.path)) next.delete(entry.path);
                              else next.add(entry.path);
                              return next;
                            })
                          }
                          className="h-4 w-4 accent-[#5B8731]"
                        />
                      </td>
                    )}

                    <td className="w-full max-w-0 px-2 py-2">
                      <button
                        onClick={() => openFile(entry)}
                        className="flex w-full items-center gap-2 text-left text-stone-100 transition hover:text-grass-light"
                      >
                        <span className="shrink-0">{iconFor(entry)}</span>
                        <span className="truncate">{entry.name}</span>
                      </button>
                    </td>
                    <td className="hidden px-2 py-2 font-mono text-xs text-stone-450 sm:table-cell">
                      {entry.isDir ? '–' : formatBytes(entry.size)}
                    </td>
                    <td className="hidden px-2 py-2 font-mono text-xs text-stone-450 md:table-cell">
                      {formatDate(entry.modified)}
                    </td>
                    <td className="px-4 py-2">
                      {/* Auf Touch-Geräten immer sichtbar – Hover gibt es dort nicht */}
                      <div className="flex justify-end gap-1 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100">
                        {!entry.isDir && (
                          <a
                            href={authedUrl(
                              `/servers/${server.id}/files/download?path=${encodeURIComponent(entry.path)}`,
                            )}
                            className="p-1 text-stone-450 transition-colors hover:text-grass-light"
                            title="Herunterladen"
                          >
                            <Download size={15} />
                          </a>
                        )}
                        {can('files.write') && /\.zip$/i.test(entry.name) && (
                          <button
                            onClick={() => unzip.mutate(entry.path)}
                            className="p-1 text-stone-450 transition-colors hover:text-gold"
                            title="Hier entpacken"
                          >
                            <FileArchive size={15} />
                          </button>
                        )}
                        {can('files.write') && (
                          <button
                            onClick={() => {
                              setRenaming(entry);
                              setRenameValue(entry.name);
                            }}
                            className="p-1 text-stone-450 transition-colors hover:text-diamond"
                            title="Umbenennen"
                          >
                            <PencilLine size={15} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Editor */}
      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        size="xl"
        title={<span className="font-mono text-sm">{editing?.path}</span>}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Abbrechen
            </Button>
            <Button
              variant="primary"
              icon={<Save size={15} />}
              loading={saveFile.isPending}
              disabled={!can('files.write')}
              onClick={() => editing && saveFile.mutate(editing)}
            >
              Speichern
            </Button>
          </>
        }
      >
        <textarea
          className="mc-input h-[55vh] resize-none font-mono !text-[12.5px] leading-relaxed"
          spellCheck={false}
          value={editing?.content ?? ''}
          onChange={(e) => setEditing((prev) => (prev ? { ...prev, content: e.target.value } : prev))}
        />
      </Modal>

      {/* Neuer Ordner */}
      <Modal
        open={newFolder}
        onClose={() => setNewFolder(false)}
        title="Neuer Ordner"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setNewFolder(false)}>
              Abbrechen
            </Button>
            <Button
              variant="primary"
              loading={createFolder.isPending}
              disabled={!folderName.trim()}
              onClick={() => createFolder.mutate(folderName.trim())}
            >
              Anlegen
            </Button>
          </>
        }
      >
        <input
          className="mc-input"
          placeholder="Ordnername"
          value={folderName}
          onChange={(e) => setFolderName(e.target.value)}
          autoFocus
        />
      </Modal>

      {/* Umbenennen */}
      <Modal
        open={Boolean(renaming)}
        onClose={() => setRenaming(null)}
        title="Umbenennen"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Abbrechen
            </Button>
            <Button
              variant="primary"
              loading={rename.isPending}
              onClick={() =>
                renaming &&
                rename.mutate({ from: renaming.path, to: joinPath(path, renameValue.trim()) })
              }
            >
              Umbenennen
            </Button>
          </>
        }
      >
        <input
          className="mc-input"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          autoFocus
        />
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutateAsync([...selected])}
        title="Wirklich löschen?"
        message={`${selected.size} Eintrag/Einträge werden unwiderruflich entfernt. Ordner werden samt Inhalt gelöscht.`}
        confirmLabel="Löschen"
        danger
      />
    </div>
  );
}

function joinPath(base: string, name: string): string {
  return `${base.replace(/\/+$/, '')}/${name}`.replace(/\/{2,}/g, '/');
}
