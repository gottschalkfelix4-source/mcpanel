import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpCircle, ExternalLink, History, Loader2, Package, RefreshCw, Unlink,
} from 'lucide-react';
import { api } from '../../lib/api';
import { formatDate } from '../../lib/format';
import type { ProjectVersion } from '../../lib/types';
import { ModpackBrowser } from '../../components/ModpackBrowser';
import { TaskProgress } from '../../components/TaskProgress';
import {
  Badge, Button, ConfirmDialog, EmptyState, ErrorNote, InfoNote, LoadingBlock, Modal, Panel,
  Toggle, useToast,
} from '../../components/ui';
import { useServer } from './ServerLayout';

interface ModpackState {
  installed: {
    provider: 'modrinth' | 'curseforge';
    projectId: string;
    versionId: string;
    name: string;
    versionName: string;
    iconUrl: string | null;
    minecraftVersion: string;
    loader: string;
  } | null;
  update:
    | { latest: ProjectVersion; current: ProjectVersion | null; updateAvailable: boolean; behindBy: number | null }
    | { error: string }
    | null;
}

const TASK_TYPES = ['modpack.install', 'modpack.update'];

export default function ModpackTab() {
  const { server, can, refresh } = useServer();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [showBrowser, setShowBrowser] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [backupFirst, setBackupFirst] = useState(true);
  const [keepConfig, setKeepConfig] = useState(false);
  const [installing, setInstalling] = useState(false);

  const state = useQuery({
    queryKey: ['modpack', server.id],
    queryFn: () => api.get<ModpackState>(`/servers/${server.id}/modpack`),
  });

  const install = useMutation({
    mutationFn: (body: {
      provider: string;
      projectId: string;
      versionId: string;
      backupFirst: boolean;
      keepConfig: boolean;
    }) => api.post(`/servers/${server.id}/modpack/install`, body),
    onSuccess: () => {
      toast.info('Installation gestartet – du siehst den Fortschritt hier.');
      setShowBrowser(false);
      setShowVersions(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const update = useMutation({
    mutationFn: () =>
      api.post<{ alreadyLatest?: boolean }>(`/servers/${server.id}/modpack/update`, {
        backupFirst,
        keepConfig,
      }),
    onSuccess: (res) => {
      if (res.alreadyLatest) toast.info('Bereits auf der neuesten Version.');
      else toast.info('Update gestartet.');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const unlink = useMutation({
    mutationFn: () => api.del(`/servers/${server.id}/modpack`),
    onSuccess: () => {
      toast.success('Modpack-Bindung gelöst. Die Dateien bleiben erhalten.');
      void state.refetch();
      refresh();
    },
  });

  const onTaskFinished = useCallback(() => {
    void state.refetch();
    refresh();
    queryClient.invalidateQueries({ queryKey: ['servers'] });
  }, [state, refresh, queryClient]);

  const installed = state.data?.installed ?? null;
  const updateInfo = state.data?.update ?? null;
  const hasUpdate = updateInfo && 'updateAvailable' in updateInfo && updateInfo.updateAvailable;
  const updateError = updateInfo && 'error' in updateInfo ? updateInfo.error : null;

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <TaskProgress
        serverId={server.id}
        types={TASK_TYPES}
        onFinished={onTaskFinished}
        onRunningChange={setInstalling}
      />

      {state.isLoading ? (
        <LoadingBlock />
      ) : installing && !installed ? (
        /*
         * Während der Installation gibt es noch keinen Datensatz – ohne diesen
         * Zweig stünde hier "Kein Modpack installiert", direkt unter dem
         * laufenden Fortschrittsbalken.
         */
        <Panel title="Modpack wird eingerichtet" icon={<Package size={16} />}>
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <Loader2 size={34} className="animate-spin text-grass-light" />
            <h3 className="heading text-base">Installation läuft</h3>
            <p className="max-w-md text-sm text-stone-350">
              Den Fortschritt siehst du oben. Du kannst die Seite verlassen – die Installation
              läuft im Hintergrund weiter, Loader und Minecraft-Version werden danach automatisch
              passend gesetzt.
            </p>
          </div>
        </Panel>
      ) : !installed ? (
        <Panel title="Modpack" icon={<Package size={16} />}>
          {showBrowser ? (
            <ModpackBrowser
              onPick={(project, version) =>
                install.mutateAsync({
                  provider: project.provider,
                  projectId: project.id,
                  versionId: version.id,
                  backupFirst: false,
                  keepConfig: false,
                })
              }
            />
          ) : (
            <EmptyState
              icon={<Package size={44} />}
              title="Kein Modpack installiert"
              description="Installiere ein Modpack von Modrinth oder CurseForge. Loader und Minecraft-Version werden automatisch passend gesetzt."
              action={
                can('modpack.manage') ? (
                  <Button variant="primary" icon={<Package size={16} />} onClick={() => setShowBrowser(true)}>
                    Modpack suchen
                  </Button>
                ) : (
                  <p className="text-xs text-stone-450">Dir fehlt das Recht, Modpacks zu verwalten.</p>
                )
              }
            />
          )}
        </Panel>
      ) : (
        <>
          {/* Installiertes Pack */}
          <Panel
            title="Installiertes Modpack"
            icon={<Package size={16} />}
            actions={
              can('modpack.manage') && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="ghost"
                    className="!px-3 !py-1.5 !text-xs"
                    icon={<History size={13} />}
                    disabled={installing}
                    onClick={() => setShowVersions(true)}
                  >
                    Version wechseln
                  </Button>
                  <Button
                    variant="ghost"
                    className="!px-3 !py-1.5 !text-xs"
                    icon={<RefreshCw size={13} />}
                    loading={state.isFetching}
                    onClick={() => state.refetch()}
                  >
                    Prüfen
                  </Button>
                </div>
              )
            }
          >
            <div className="flex flex-wrap items-start gap-4">
              {installed.iconUrl && (
                <img
                  src={installed.iconUrl}
                  alt=""
                  className="h-20 w-20 border border-stone-950 object-cover shadow-block-sm"
                />
              )}
              <div className="min-w-0 flex-1">
                <h3 className="heading text-lg">{installed.name}</h3>
                <p className="mt-1 text-sm text-stone-400">{installed.versionName}</p>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  <Badge tone={installed.provider === 'modrinth' ? 'green' : 'gold'}>
                    {installed.provider}
                  </Badge>
                  <Badge tone="blue">MC {installed.minecraftVersion}</Badge>
                  <Badge tone="purple">{installed.loader}</Badge>
                </div>
                <a
                  href={
                    installed.provider === 'modrinth'
                      ? `https://modrinth.com/modpack/${installed.projectId}`
                      : `https://www.curseforge.com/projects/${installed.projectId}`
                  }
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex items-center gap-1.5 text-xs text-stone-450 transition hover:text-grass-light"
                >
                  <ExternalLink size={12} /> Projektseite öffnen
                </a>
              </div>
            </div>
          </Panel>

          {/* Update */}
          <Panel title="Aktualisierung" icon={<ArrowUpCircle size={16} />}>
            {updateError ? (
              <ErrorNote>{updateError}</ErrorNote>
            ) : hasUpdate && updateInfo && 'latest' in updateInfo ? (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3 border border-gold/40 bg-gold/10 p-3">
                  <div>
                    <p className="text-sm font-bold text-gold">Neue Version verfügbar</p>
                    <p className="mt-0.5 text-sm text-stone-300">
                      {updateInfo.latest.name}
                      <span className="ml-2 text-xs text-stone-450">
                        {formatDate(updateInfo.latest.datePublished)}
                      </span>
                    </p>
                    {updateInfo.behindBy !== null && updateInfo.behindBy > 0 && (
                      <p className="mt-0.5 text-xs text-stone-450">
                        Du bist {updateInfo.behindBy} Version(en) hinterher.
                      </p>
                    )}
                  </div>
                  {can('modpack.manage') && (
                    <Button
                      variant="gold"
                      icon={<ArrowUpCircle size={16} />}
                      loading={update.isPending}
                      disabled={installing}
                      onClick={() => update.mutate()}
                    >
                      Jetzt aktualisieren
                    </Button>
                  )}
                </div>

                <div className="space-y-2.5">
                  <Toggle
                    checked={backupFirst}
                    onChange={setBackupFirst}
                    label="Vorher automatisch ein Backup erstellen (empfohlen)"
                  />
                  <Toggle
                    checked={keepConfig}
                    onChange={setKeepConfig}
                    label="Eigene Änderungen in config/ behalten"
                  />
                </div>

                <InfoNote>
                  Welt, <code className="text-stone-200">server.properties</code>, Whitelist und
                  OP-Liste bleiben beim Update immer erhalten. Der Ordner{' '}
                  <code className="text-stone-200">mods/</code> wird ersetzt.
                </InfoNote>
              </div>
            ) : (
              <div className="flex items-center gap-2.5 text-sm text-stone-300">
                <Badge tone="green">Aktuell</Badge>
                Du nutzt die neueste veröffentlichte Version.
              </div>
            )}
          </Panel>

          {can('modpack.manage') && (
            <Panel title="Weitere Aktionen">
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" icon={<Package size={15} />} disabled={installing} onClick={() => setShowBrowser(true)}>
                  Anderes Modpack installieren
                </Button>
                <Button variant="danger" icon={<Unlink size={15} />} onClick={() => setConfirmUnlink(true)}>
                  Bindung lösen
                </Button>
              </div>
              <p className="mt-3 text-xs text-stone-450">
                „Bindung lösen“ entfernt nur die Verknüpfung für den Updater – die installierten
                Dateien bleiben auf dem Server.
              </p>
            </Panel>
          )}
        </>
      )}

      {/* Modpack-Suche als Overlay */}
      <Modal
        open={showBrowser && Boolean(installed)}
        onClose={() => setShowBrowser(false)}
        title="Modpack installieren"
        size="xl"
      >
        <div className="space-y-4">
          <ErrorNote>
            Ein anderes Modpack ersetzt den Ordner <code>mods/</code> und die Modpack-Konfiguration.
            Lege vorher ein Backup an!
          </ErrorNote>
          <ModpackBrowser
            onPick={(project, version) =>
              install.mutateAsync({
                provider: project.provider,
                projectId: project.id,
                versionId: version.id,
                backupFirst: true,
                keepConfig: false,
              })
            }
          />
        </div>
      </Modal>

      <VersionSwitcher
        open={showVersions}
        onClose={() => setShowVersions(false)}
        serverId={server.id}
        currentVersionId={installed?.versionId ?? null}
        onSelect={(version) =>
          install.mutateAsync({
            provider: installed!.provider,
            projectId: installed!.projectId,
            versionId: version.id,
            backupFirst: true,
            keepConfig,
          })
        }
      />

      <ConfirmDialog
        open={confirmUnlink}
        onClose={() => setConfirmUnlink(false)}
        onConfirm={() => unlink.mutateAsync()}
        title="Modpack-Bindung lösen?"
        message="Der Updater verliert die Verknüpfung zum Projekt. Installierte Mods bleiben erhalten."
        confirmLabel="Lösen"
        danger
      />
    </div>
  );
}

function VersionSwitcher({
  open,
  onClose,
  serverId,
  currentVersionId,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  serverId: string;
  currentVersionId: string | null;
  onSelect: (version: ProjectVersion) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const versions = useQuery({
    queryKey: ['modpack-versions', serverId],
    queryFn: () => api.get<{ versions: ProjectVersion[] }>(`/servers/${serverId}/modpack/versions`),
    enabled: open,
  });

  const sorted = [...(versions.data?.versions ?? [])].sort(
    (a, b) => new Date(b.datePublished).getTime() - new Date(a.datePublished).getTime(),
  );

  return (
    <Modal open={open} onClose={onClose} title="Version wechseln" size="lg">
      {versions.isLoading ? (
        <LoadingBlock />
      ) : (
        <div className="mc-well max-h-[60vh] divide-y divide-stone-875 overflow-y-auto">
          {sorted.map((version, i) => {
            const current = version.id === currentVersionId;
            return (
              <div
                key={version.id}
                className="flex animate-slide-in items-center gap-3 p-2.5 transition-colors hover:bg-stone-600/[0.28]"
                style={{ animationDelay: `${Math.min(i, 10) * 0.03}s` }}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-stone-50">
                    {version.name}
                    {current && (
                      <Badge tone="green" className="ml-2">
                        aktuell
                      </Badge>
                    )}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-stone-450">
                    <span>
                      {version.gameVersions.slice(0, 3).join(', ')} ·{' '}
                      {formatDate(version.datePublished)}
                    </span>
                    {version.provider === 'curseforge' && (
                      <Badge
                        tone={version.serverPackFileId ? 'green' : 'neutral'}
                        className="!text-[9px]"
                      >
                        {version.serverPackFileId ? 'Serverpaket' : 'nur Client-Paket'}
                      </Badge>
                    )}
                  </p>
                </div>
                <Button
                  variant={current ? 'ghost' : 'default'}
                  className="!px-3 !py-1.5 !text-xs"
                  disabled={current}
                  loading={busy === version.id}
                  onClick={async () => {
                    setBusy(version.id);
                    try {
                      await onSelect(version);
                      onClose();
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {current ? 'Installiert' : 'Wechseln'}
                </Button>
              </div>
            );
          })}
          {sorted.length === 0 && (
            <p className="p-6 text-center text-sm text-stone-450">Keine Versionen gefunden.</p>
          )}
        </div>
      )}
    </Modal>
  );
}
