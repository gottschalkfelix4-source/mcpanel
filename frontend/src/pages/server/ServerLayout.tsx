import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useOutletContext, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ArrowLeft, Check, Copy, FileCode2, FolderTree, HardDriveDownload, LayoutDashboard,
  AlarmClock, Package, Play, Puzzle, RotateCw, Settings2, Square, Terminal, Users, Zap,
} from 'lucide-react';
import { api } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import { CONTENT_KIND_BY_TYPE } from '../../lib/types';
import type { ContainerStats, PowerState, ServerDetail } from '../../lib/types';
import { Button, ConfirmDialog, ErrorNote, LoadingBlock, StateBadge, useToast } from '../../components/ui';
import { BlockIcon } from '../../components/pixel';
import { CrashDialog } from '../../components/CrashDialog';
import { TYPE_LOOK } from '../../components/ServerCard';

export interface ServerContext {
  server: ServerDetail;
  can: (permission: string) => boolean;
  liveState: PowerState;
  liveHealth: string | null;
  liveStats: ContainerStats | null;
  players: { online: number; max: number; players: string[] } | null;
  refresh: () => void;
}

export function useServer(): ServerContext {
  return useOutletContext<ServerContext>();
}

const TABS = [
  { to: '', label: 'Übersicht', icon: LayoutDashboard, permission: null, end: true },
  { to: 'console', label: 'Konsole', icon: Terminal, permission: 'console.read' },
  { to: 'modpack', label: 'Modpack', icon: Package, permission: null },
  { to: 'content', label: 'Mods', icon: Puzzle, permission: 'files.read' },
  { to: 'files', label: 'Dateien', icon: FolderTree, permission: 'files.read' },
  { to: 'config', label: 'Konfiguration', icon: FileCode2, permission: 'files.read' },
  { to: 'backups', label: 'Backups', icon: HardDriveDownload, permission: 'files.read' },
  { to: 'players', label: 'Spieler', icon: Users, permission: null },
  { to: 'automation', label: 'Automation', icon: AlarmClock, permission: null },
  { to: 'access', label: 'Zugriff', icon: Zap, permission: null },
  { to: 'settings', label: 'Einstellungen', icon: Settings2, permission: 'settings.edit' },
] as const;

export default function ServerLayout() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [liveState, setLiveState] = useState<PowerState | null>(null);
  const [liveHealth, setLiveHealth] = useState<string | null>(null);
  const [liveStats, setLiveStats] = useState<ContainerStats | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);

  const { data: server, isLoading, error, refetch } = useQuery({
    queryKey: ['server', id],
    queryFn: () => api.get<ServerDetail>(`/servers/${id}`),
    enabled: Boolean(id),
    refetchInterval: 15_000,
  });

  // Player visibility must not depend on console permission or Socket.IO.
  const playerQuery = useQuery({
    queryKey: ['online-players', id],
    queryFn: () => api.get<{ online: number; max: number; players: string[]; available: boolean }>(`/servers/${id}/players`),
    enabled: Boolean(id) && (liveState ?? server?.state) === 'running',
    refetchInterval: 5000,
    retry: false,
  });
  const players = (liveState ?? server?.state) === 'running' && !playerQuery.isError && playerQuery.data?.available
    ? playerQuery.data : null;

  // Live-Status über Socket.IO
  useEffect(() => {
    if (!id) return;
    const socket = getSocket();
    const clearLive = () => { setLiveState(null); setLiveHealth(null); setLiveStats(null); };
    clearLive();
    const subscribe = () => socket.emit('subscribe', { serverId: id }, () => {});

    const onStatus = (payload: {
      serverId: string;
      state: PowerState;
      health: string | null;
      stats: ContainerStats | null;
      players: { online: number; max: number; players: string[] } | null;
    }) => {
      if (payload.serverId !== id) return;
      setLiveState(payload.state);
      setLiveHealth(payload.health);
      setLiveStats(payload.stats);
    };

    socket.on('status', onStatus);
    socket.on('connect', subscribe);
    socket.on('disconnect', clearLive);
    if (socket.connected) subscribe();

    return () => {
      socket.off('status', onStatus);
      socket.off('connect', subscribe);
      socket.off('disconnect', clearLive);
      socket.emit('unsubscribe', { serverId: id });
    };
  }, [id]);

  // Fresh HTTP snapshots remain authoritative when a live stream stalls.
  useEffect(() => {
    if (!server) return;
    setLiveState(server.state);
    setLiveHealth(server.health ?? null);
    setLiveStats(server.stats);
  }, [server]);

  const power = useMutation({
    mutationFn: (action: 'start' | 'stop' | 'restart' | 'kill') =>
      api.post(`/servers/${id}/power`, { action }),
    onSuccess: (_data, action) => {
      const labels = {
        start: 'Server wird gestartet …',
        stop: 'Server wird gestoppt …',
        restart: 'Server startet neu …',
        kill: 'Server wurde hart beendet.',
      };
      toast.success(labels[action]);
      setTimeout(() => {
        void refetch();
        queryClient.invalidateQueries({ queryKey: ['servers'] });
        getSocket().emit('reattach', { serverId: id });
      }, 1200);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (isLoading) return <LoadingBlock label="Server wird geladen …" />;
  if (error) return <ErrorNote>{(error as Error).message}</ErrorNote>;
  if (!server) return null;

  const state = liveState ?? server.state;
  const running = state === 'running' || state === 'starting';
  const can = (permission: string) => server.permissions.includes(permission);
  const look = TYPE_LOOK[server.type] ?? TYPE_LOOK.PAPER;
  // Paper & Co. verwalten plugins/, die Loader mods/ – Vanilla gar nichts,
  // dort faellt der Reiter weg.
  const contentKind = CONTENT_KIND_BY_TYPE[server.type];

  const context: ServerContext = {
    server,
    can,
    liveState: state,
    liveHealth: liveState !== null ? liveHealth : server.health ?? null,
    liveStats: liveState !== null ? liveStats : server.stats,
    players,
    refresh: () => void refetch(),
  };

  const copyAddress = async () => {
    await navigator.clipboard.writeText(server.address).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Kopfbereich */}
      <div className="mc-frame animate-fade-in">
        <span className="mc-frame-stud-light" />
        <span className="mc-frame-stud-dark" />

        <div className="mc-frame-inner">
          <div className="grass-strip-thin h-2 w-full" />

          <div className="flex flex-wrap items-center gap-4 p-[18px]">
            {/* Pfeil + Icon + Titel als feste Gruppe – zerreißt beim Umbruch nicht */}
            <div className="flex min-w-0 flex-1 basis-full items-center gap-4 sm:basis-auto">
              <Link
                to="/"
                className="grid h-[34px] w-[34px] shrink-0 place-items-center border border-stone-700 bg-stone-900/70 transition hover:border-grass-light hover:bg-grass/[0.18]"
                title="Zurück zur Übersicht"
              >
                <ArrowLeft size={18} className="text-stone-300" />
              </Link>

              <BlockIcon
                size={54}
                color={look.color}
                imageUrl={server.modpack?.iconUrl}
                icon={<look.Icon size={24} />}
              />

              <div className="min-w-0 flex-1">
                {/* Kein flex-wrap: sonst springt der lange Titel auf eine
                    eigene Zeile über das Icon, statt gekürzt zu werden.
                    Auf Mobil bekommt der Titel die volle Breite, das Badge
                    wandert in die Meta-Zeile darunter. */}
                <div className="flex items-center gap-2 sm:gap-[11px]">
                  <h1 className="heading min-w-0 truncate text-base sm:text-xl">{server.name}</h1>
                  <span className="hidden shrink-0 sm:inline-flex">
                    <StateBadge state={state} />
                  </span>
                </div>

                <div className="mt-[7px] flex flex-wrap items-center gap-x-[18px] gap-y-1.5 text-xs text-stone-350">
                  <span className="sm:hidden">
                    <StateBadge state={state} />
                  </span>
                  <button
                    onClick={copyAddress}
                    disabled={!server.address}
                    className="inline-flex items-center gap-[7px] font-mono transition hover:text-grass-light"
                    title="Adresse kopieren"
                  >
                    {copied ? <Check size={12} className="text-emerald" /> : <Copy size={12} />}
                    {server.address || 'Kein öffentlicher Zugang'}
                  </button>
                  <span>
                    {server.modpack?.name ?? server.type} · MC {server.mcVersion}
                  </span>
                  {players && (
                    <span className="text-[#a3d15c]">
                      {players.online}/{players.max} Spieler online
                    </span>
                  )}
                </div>
              </div>
            </div>

            {can('power') && (
              <div className="flex w-full flex-wrap gap-[9px] sm:w-auto">
                {!running ? (
                  <Button
                    variant="primary"
                    icon={<Play size={15} />}
                    loading={power.isPending}
                    onClick={() => power.mutate('start')}
                  >
                    Starten
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      icon={<RotateCw size={15} />}
                      loading={power.isPending}
                      onClick={() => power.mutate('restart')}
                    >
                      Neustart
                    </Button>
                    <Button
                      variant="danger"
                      icon={<Square size={15} />}
                      loading={power.isPending}
                      onClick={() => setConfirmStop(true)}
                    >
                      Stoppen
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Reiter */}
          <nav className="flex overflow-x-auto border-t border-stone-890 bg-stone-well/60 no-scrollbar">
            {TABS.filter(
              (tab) =>
                (!tab.permission || can(tab.permission)) &&
                (tab.to !== 'content' || contentKind !== null) &&
                // Auf einem Bukkit-Server hat ein Modpack nichts verloren: die
                // Installation ersetzt mods/ und setzt den Typ auf MODPACK um.
                (tab.to !== 'modpack' || contentKind !== 'plugin'),
            ).map((tab) => {
              const Icon = tab.icon;
              const label =
                tab.to === 'content' && contentKind === 'plugin' ? 'Plugins' : tab.label;
              return (
                <NavLink
                  key={tab.to}
                  to={tab.to}
                  end={'end' in tab ? tab.end : false}
                  className={({ isActive }) => clsx('mc-tab', isActive && 'mc-tab-active')}
                >
                  <Icon size={15} />
                  {label}
                </NavLink>
              );
            })}
          </nav>
        </div>
      </div>

      <Outlet context={context} />

      <CrashDialog
        serverId={server.id}
        state={state}
        canManage={can('modpack.manage')}
        onRestart={() => power.mutate('start')}
      />

      <ConfirmDialog
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        onConfirm={() => power.mutate('stop')}
        title="Server stoppen?"
        message="Der Server wird sauber heruntergefahren. Verbundene Spieler werden getrennt."
        confirmLabel="Stoppen"
        danger
      />
    </div>
  );
}
