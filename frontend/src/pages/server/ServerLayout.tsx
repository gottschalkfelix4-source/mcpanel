import { createContext, Suspense, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { copyText } from '../../lib/clipboard';
import { Link, NavLink, Outlet, useOutletContext, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ArrowLeft, Check, Copy, FileCode2, FolderTree, Globe2, HardDriveDownload, LayoutDashboard,
  AlarmClock, Map as MapIcon, Package, Play, Puzzle, RotateCw, Settings2, Square, Terminal, Users, Zap,
} from 'lucide-react';
import { api } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import { CONTENT_KIND_BY_TYPE } from '../../lib/types';
import type { ContainerStats, PowerState, ServerDetail } from '../../lib/types';
import { Button, ConfirmDialog, LoadErrorBlock, LoadingBlock, StateBadge, useToast } from '../../components/ui';
import { BlockIcon } from '../../components/pixel';
import { CrashDialog } from '../../components/CrashDialog';
import { TYPE_LOOK } from '../../components/ServerCard';

export interface ServerContext {
  server: ServerDetail;
  can: (permission: string) => boolean;
  liveState: PowerState;
  liveHealth: string | null;
  players: { online: number; max: number; players: string[] } | null;
  refresh: () => void;
}

export function useServer(): ServerContext {
  return useOutletContext<ServerContext>();
}

/**
 * CPU und Arbeitsspeicher kommen alle paar Sekunden neu. Sie stecken in einem
 * eigenen Context, damit nur die Übersicht neu zeichnet – nicht jeder Reiter
 * samt Dateiliste oder Konsole.
 */
const LiveStatsContext = createContext<ContainerStats | null>(null);
export function useLiveStats(): ContainerStats | null {
  return useContext(LiveStatsContext);
}

type PlayerList = { online: number; max: number; players: string[] };
const samePlayers = (a: PlayerList | null, b: PlayerList | null) =>
  a === b || (a !== null && b !== null && a.online === b.online && a.max === b.max && a.players.join('\n') === b.players.join('\n'));
const sameStats = (a: ContainerStats | null, b: ContainerStats | null) => a === b || JSON.stringify(a) === JSON.stringify(b);

const TABS = [
  { to: '', label: 'Übersicht', icon: LayoutDashboard, permission: null, end: true },
  { to: 'console', label: 'Konsole', icon: Terminal, permission: 'console.read' },
  { to: 'modpack', label: 'Modpack', icon: Package, permission: null },
  { to: 'content', label: 'Mods', icon: Puzzle, permission: 'files.read' },
  { to: 'files', label: 'Dateien', icon: FolderTree, permission: 'files.read' },
  { to: 'config', label: 'Konfiguration', icon: FileCode2, permission: 'files.read' },
  { to: 'backups', label: 'Backups', icon: HardDriveDownload, permission: 'files.read' },
  { to: 'worlds', label: 'Welten', icon: Globe2, permission: 'files.read' },
  { to: 'map', label: 'Karte', icon: MapIcon, permission: 'console.read' },
  { to: 'players', label: 'Spieler', icon: Users, permission: null },
  { to: 'automation', label: 'Automation', icon: AlarmClock, permission: null },
  { to: 'access', label: 'Zugriff', icon: Zap, permission: null },
  { to: 'settings', label: 'Einstellungen', icon: Settings2, permission: 'settings.edit' },
  { to: 'reinstall', label: 'Neuinstallation', icon: RotateCw, permission: 'server.reinstall' },
] as const;

export default function ServerLayout() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [liveState, setLiveState] = useState<PowerState | null>(null);
  const [liveHealth, setLiveHealth] = useState<string | null>(null);
  const [liveStats, setLiveStats] = useState<ContainerStats | null>(null);
  /** Spieler aus dem Live-Status; `undefined` = noch kein Status über den Socket. */
  const [socketPlayers, setSocketPlayers] = useState<PlayerList | null | undefined>(undefined);
  const socketLive = socketPlayers !== undefined;
  const [copied, setCopied] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);

  const { data: server, isLoading, error, refetch } = useQuery({
    queryKey: ['server', id],
    queryFn: () => api.get<ServerDetail>(`/servers/${id}`),
    enabled: Boolean(id),
    // Mit Live-Verbindung genügt ein seltener Abgleich.
    refetchInterval: socketLive ? 60_000 : 15_000,
  });

  // Spieler kommen mit dem Live-Status. Ohne Konsolenrecht oder Socket gibt es
  // den nicht – dann fragt die Seite selbst nach.
  const playerQuery = useQuery({
    queryKey: ['online-players', id],
    queryFn: () => api.get<{ online: number; max: number; players: string[]; available: boolean }>(`/servers/${id}/players`),
    enabled: Boolean(id) && !socketLive && (liveState ?? server?.state) === 'running',
    refetchInterval: 5000,
    retry: false,
  });
  const polledPlayers = !playerQuery.isError && playerQuery.data?.available ? playerQuery.data : null;
  const players = (liveState ?? server?.state) === 'running' ? (socketLive ? socketPlayers ?? null : polledPlayers) : null;

  // Live-Status über Socket.IO
  useEffect(() => {
    if (!id) return;
    const socket = getSocket();
    const clearLive = () => { setLiveState(null); setLiveHealth(null); setLiveStats(null); setSocketPlayers(undefined); };
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
      // Nur Änderungen setzen: gleiche Werte im neuen Objekt zeichneten sonst
      // alle drei Sekunden die ganze Seite neu.
      setLiveState(payload.state);
      setLiveHealth(payload.health);
      setLiveStats((current) => (sameStats(current, payload.stats) ? current : payload.stats));
      const next = payload.players ?? null;
      setSocketPlayers((current) => (current !== undefined && samePlayers(current, next) ? current : next));
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
    setLiveStats((current) => (sameStats(current, server.stats) ? current : server.stats));
  }, [server]);

  const effectiveState = liveState ?? server?.state ?? null;
  const effectiveHealth = liveState !== null ? liveHealth : server?.health ?? null;
  const stablePlayers = useRef<PlayerList | null>(null);
  if (!samePlayers(stablePlayers.current, players)) stablePlayers.current = players;
  const playersStable = stablePlayers.current;
  const context = useMemo<ServerContext | null>(() => (server && effectiveState ? {
    server,
    can: (permission: string) => server.permissions.includes(permission),
    liveState: effectiveState,
    liveHealth: effectiveHealth,
    players: playersStable,
    refresh: () => void refetch(),
  } : null), [server, effectiveState, effectiveHealth, playersStable, refetch]);

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
  // Nur ohne Daten die Fehlerseite: ein kurzer Aussetzer beim Nachladen (z. B.
  // Neustart des Panels) soll Konsole und ungespeicherte Eingaben nicht wegwerfen.
  if (!server || !context) return <LoadErrorBlock error={error} onRetry={() => void refetch()} />;

  const state = liveState ?? server.state;
  const running = state === 'running' || state === 'starting';
  const { can } = context;
  const look = TYPE_LOOK[server.type] ?? TYPE_LOOK.PAPER;
  // Paper & Co. verwalten plugins/, die Loader mods/ – Vanilla gar nichts,
  // dort faellt der Reiter weg.
  const contentKind = CONTENT_KIND_BY_TYPE[server.type];


  const copyAddress = async () => {
    if (!(await copyText(server.address))) {
      toast.error('Kopieren nicht möglich – bitte die Adresse von Hand markieren.');
      return;
    }
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
                    <StateBadge state={state} health={context.liveHealth} />
                  </span>
                </div>

                <div className="mt-[7px] flex flex-wrap items-center gap-x-[18px] gap-y-1.5 text-xs text-stone-350">
                  <span className="sm:hidden">
                    <StateBadge state={state} health={context.liveHealth} />
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

          {/* Reiter – ab Tablet-Breite umbrechen statt unsichtbar zu scrollen,
              sonst verschwinden die hinteren Reiter (Neuinstallation) rechts. */}
          <nav className="flex overflow-x-auto border-t border-stone-890 bg-stone-well/60 no-scrollbar sm:flex-wrap sm:overflow-x-visible">
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

      <LiveStatsContext.Provider value={liveState !== null ? liveStats : server.stats}>
        {/* Reiter werden bei Bedarf nachgeladen – Kopf und Navigation bleiben stehen. */}
        <Suspense fallback={<LoadingBlock label="Reiter wird geladen …" />}>
          <Outlet context={context} />
        </Suspense>
      </LiveStatsContext.Provider>

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
