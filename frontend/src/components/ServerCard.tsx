import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Boxes, Check, Copy, Cpu, Loader2, MemoryStick, Package, Play, Puzzle, RotateCw, Square, Users } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { formatBytes, formatUptime } from '../lib/format';
import type { ServerSummary, ServerType } from '../lib/types';
import { Button, StateBadge, useToast } from './ui';
import { BarChart, BlockIcon, PixelBar, useHistory } from './pixel';

/** Blockfarbe und Symbol je Servertyp. */
export const TYPE_LOOK: Record<ServerType, { color: string; Icon: typeof Boxes }> = {
  VANILLA: { color: '#5B8731', Icon: Boxes },
  PAPER: { color: '#5B8731', Icon: Boxes },
  PURPUR: { color: '#7e22ce', Icon: Boxes },
  SPIGOT: { color: '#FFAA00', Icon: Boxes },
  FABRIC: { color: '#c9a227', Icon: Puzzle },
  FORGE: { color: '#4f4f58', Icon: Puzzle },
  NEOFORGE: { color: '#ea580c', Icon: Puzzle },
  QUILT: { color: '#ec4899', Icon: Puzzle },
  MODPACK: { color: '#3C44AA', Icon: Package },
};

export function ServerCard({ server }: { server: ServerSummary }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const [flash, setFlash] = useState(false);

  const cardRef = useRef<HTMLElement>(null);
  const wasRunning = useRef(server.state === 'running');

  const running = server.state === 'running';
  const starting = server.state === 'starting';

  // Kurzes Aufleuchten, sobald der Server online geht.
  useEffect(() => {
    if (running && !wasRunning.current) {
      setFlash(true);
      const timer = setTimeout(() => setFlash(false), 950);
      return () => clearTimeout(timer);
    }
    wasRunning.current = running;
  }, [running]);

  const memLimit = server.stats?.memoryLimit || server.memoryMb * 1024 * 1024;
  const memPercent = server.stats ? (server.stats.memoryUsed / Math.max(1, memLimit)) * 100 : 0;

  const cpuHistory = useHistory(running ? (server.stats?.cpuPercent ?? 0) : 2, 20);
  const memHistory = useHistory(running ? memPercent : 2, 20);

  const power = useMutation({
    mutationFn: (action: 'start' | 'stop' | 'restart') =>
      api.post(`/servers/${server.id}/power`, { action }),
    onSuccess: (_d, action) => {
      toast.success(
        action === 'start'
          ? `${server.name} wird gestartet …`
          : action === 'stop'
            ? `${server.name} wird gestoppt …`
            : `${server.name} startet neu …`,
      );
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['servers'] }), 800);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const copyAddress = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(server.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error('Kopieren nicht möglich');
    }
  };

  /** Leichte Neigung zum Zeiger – gibt der Karte Tiefe. */
  const tilt = (e: React.MouseEvent) => {
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    el.style.transform = `translateY(-6px) perspective(700px) rotateX(${(-y * 5).toFixed(2)}deg) rotateY(${(x * 6).toFixed(2)}deg)`;
  };
  const untilt = () => {
    if (cardRef.current) cardRef.current.style.transform = '';
  };

  const look = TYPE_LOOK[server.type] ?? TYPE_LOOK.PAPER;
  const players = server.players;
  const playerPercent = players && players.max > 0 ? (players.online / players.max) * 100 : 0;

  return (
    <article
      ref={cardRef}
      onMouseMove={tilt}
      onMouseLeave={untilt}
      onClick={() => navigate(`/servers/${server.id}`)}
      className={clsx(
        'mc-frame cursor-pointer transition-[transform,box-shadow,background-color] duration-200',
        'hover:!bg-[#4a4a53] hover:shadow-bevel-lift',
        flash && 'animate-flash',
      )}
      style={{ transformStyle: 'preserve-3d' }}
    >
      <span className="mc-frame-stud-light" />
      <span className="mc-frame-stud-dark" />

      <div className="mc-frame-inner">
        {/* Kopf */}
        <div className="flex items-start gap-3.5 border-b border-stone-890 p-4">
          <BlockIcon
            size={52}
            color={look.color}
            imageUrl={server.modpack?.iconUrl}
            icon={<look.Icon size={22} />}
          />

          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2.5">
              <h3 className="heading truncate text-base leading-tight">{server.name}</h3>
              <StateBadge state={server.state} />
            </div>

            <p className="mt-1 truncate text-xs text-stone-350">
              {server.modpack?.name
                ? `${server.modpack.name} · ${server.modpack.versionName ?? ''}`
                : `${server.type} ${server.mcVersion}`}
            </p>

            <button
              onClick={copyAddress}
                    disabled={!server.address}
              className="mt-2 inline-flex items-center gap-[7px] font-mono text-xs text-stone-300 transition hover:text-grass-light"
              title="Adresse kopieren"
            >
              {copied ? <Check size={12} className="text-emerald" /> : <Copy size={12} />}
              {server.address || 'Kein öffentlicher Zugang'}
            </button>
          </div>
        </div>

        {/* Werte */}
        <div className="flex flex-col gap-3.5 px-4 pb-4 pt-3.5">
          <div className="grid grid-cols-2 gap-3.5">
            <Meter
              label="CPU"
              icon={<Cpu size={11} />}
              tint="#4AEDD9"
              value={running ? `${(server.stats?.cpuPercent ?? 0).toFixed(0)} %` : '–'}
              history={cpuHistory}
            />
            <Meter
              label="RAM"
              icon={<MemoryStick size={11} />}
              tint="#7FB238"
              value={
                running && server.stats
                  ? `${formatBytes(server.stats.memoryUsed, 1)} / ${formatBytes(memLimit, 0)}`
                  : `– / ${formatBytes(memLimit, 0)}`
              }
              history={memHistory}
            />
          </div>

          <div>
            <MeterLabel
              label="Spieler"
              icon={<Users size={11} />}
              tint="#7FE028"
              value={players ? `${players.online} / ${players.max}` : running ? '…' : '–'}
            />
            <PixelBar percent={playerPercent} color="#7FE028" glow />
          </div>

          <div className="flex items-center justify-between gap-2.5 pt-0.5">
            <span className="font-mono text-[11px] text-stone-450">
              {running
                ? `Läuft seit ${formatUptime(server.startedAt)}`
                : starting
                  ? 'Startet …'
                  : 'Gestoppt'}
            </span>

            <div className="flex gap-[7px]" onClick={(e) => e.stopPropagation()}>
              {!running && !starting ? (
                <Button
                  variant="primary"
                  className="!px-3 !py-[7px] !text-xs"
                  loading={power.isPending}
                  icon={<Play size={13} />}
                  onClick={() => power.mutate('start')}
                >
                  Start
                </Button>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    className="!px-3 !py-[7px] !text-xs"
                    loading={power.isPending}
                    icon={<RotateCw size={13} />}
                    onClick={() => power.mutate('restart')}
                  >
                    Neustart
                  </Button>
                  <Button
                    variant="danger"
                    className="!px-3 !py-[7px] !text-xs"
                    loading={power.isPending}
                    icon={<Square size={13} />}
                    onClick={() => power.mutate('stop')}
                  >
                    Stop
                  </Button>
                </>
              )}
            </div>
          </div>

          {starting && (
            <>
              <div className="flex animate-pop-in items-center gap-2.5 border border-gold/35 bg-gold/[0.09] px-2.5 py-2">
                <Loader2 size={13} className="animate-pulse-soft text-gold" />
                <span className="flex-1 font-mono text-[11px] text-gold">
                  Server fährt hoch – Welt und Mods werden geladen …
                </span>
              </div>
              <PixelBar percent={100} color="#FFAA00" height={8} striped />
            </>
          )}
        </div>
      </div>
    </article>
  );
}

function MeterLabel({
  label,
  icon,
  tint,
  value,
}: {
  label: string;
  icon: React.ReactNode;
  tint: string;
  value: string;
}) {
  return (
    <div className="mb-1.5 flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.1em] text-stone-400">
      <span className="flex items-center gap-[5px]">
        <span style={{ color: tint }}>{icon}</span>
        {label}
      </span>
      <span className="font-mono text-stone-100">{value}</span>
    </div>
  );
}

function Meter({
  label,
  icon,
  tint,
  value,
  history,
}: {
  label: string;
  icon: React.ReactNode;
  tint: string;
  value: string;
  history: number[];
}) {
  return (
    <div>
      <MeterLabel label={label} icon={icon} tint={tint} value={value} />
      <BarChart values={history} color={tint} height={30} />
    </div>
  );
}
