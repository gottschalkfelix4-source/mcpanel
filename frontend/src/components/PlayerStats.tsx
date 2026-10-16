import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { BarChart3 } from 'lucide-react';
import { api } from '../lib/api';
import { formatDate, formatRelative } from '../lib/format';
import type { PlayerStats as Stats } from '../lib/types';
import { Badge, EmptyState, LoadErrorBlock, LoadingBlock, Panel } from './ui';
import { PixelHead } from './pixel';

const RANGES = [
  { days: 1, label: '24 h' },
  { days: 7, label: '7 Tage' },
  { days: 30, label: '30 Tage' },
  { days: 90, label: '90 Tage' },
];

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} T ${hours % 24} h`;
}

/** Spielerzahl über die Zeit als einfache Fläche; die Spitzen als dünne Linie. */
function Timeline({ data, days }: { data: Stats['timeline']; days: number }) {
  const W = 600;
  const H = 140;
  const { area, line, top, ticks } = useMemo(() => {
    const end = Date.now();
    const start = end - days * 86_400_000;
    const top = Math.max(1, ...data.map((p) => p.max));
    const x = (iso: string) => ((new Date(iso).getTime() - start) / (end - start)) * W;
    const y = (v: number) => H - (v / top) * (H - 10);
    const pts = data.map((p) => [x(p.at), y(p.count)] as const);
    const area = pts.length
      ? `M${pts[0][0]},${H} ${pts.map(([px, py]) => `L${px},${py}`).join(' ')} L${pts[pts.length - 1][0]},${H} Z`
      : '';
    const line = data.map((p, i) => `${i ? 'L' : 'M'}${x(p.at)},${y(p.max)}`).join(' ');
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const at = new Date(start + f * (end - start));
      return {
        x: f * W,
        label: days <= 1
          ? at.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
          : at.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }),
      };
    });
    return { area, line, top, ticks };
  }, [data, days]);

  return (
    <div>
      <div className="flex justify-between text-[11px] text-stone-450">
        <span>max. {top}</span>
        <span className="flex gap-3">
          <span className="flex items-center gap-1"><span className="h-2 w-3 bg-grass/60" />Durchschnitt</span>
          <span className="flex items-center gap-1"><span className="h-0.5 w-3 bg-gold" />Spitze</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mc-well mt-1 h-36 w-full" role="img" aria-label="Spielerzahl im Zeitverlauf">
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="currentColor" className="text-stone-700" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        {area && <path d={area} fill="#7FB238" fillOpacity={0.45} />}
        {line && <path d={line} fill="none" stroke="#FFAA00" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="relative mt-1 h-4 text-[10px] text-stone-450">
        {ticks.map((t, i) => (
          <span
            key={i}
            className="absolute"
            style={{ left: `${(t.x / W) * 100}%`, transform: i === 0 ? 'none' : i === ticks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}
          >
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function PlayerStats({ serverId }: { serverId: string }) {
  const [days, setDays] = useState(7);
  const stats = useQuery({
    queryKey: ['player-stats', serverId, days],
    queryFn: () => api.get<Stats>(`/servers/${serverId}/players/stats?days=${days}`),
    refetchInterval: 60_000,
  });

  return (
    <Panel
      title="Statistik"
      icon={<BarChart3 size={16} />}
      subtitle="Wird alle paar Sekunden erfasst – auch wenn niemand das Panel geöffnet hat."
      actions={
        <div className="flex">
          {RANGES.map((range) => (
            <button
              key={range.days}
              type="button"
              onClick={() => setDays(range.days)}
              className={clsx(
                'border border-stone-950 px-2 py-1 text-[11px] font-semibold',
                days === range.days ? 'bg-grass text-white' : 'bg-stone-700 text-stone-300 hover:bg-stone-600',
              )}
            >
              {range.label}
            </button>
          ))}
        </div>
      }
    >
      {stats.isLoading ? (
        <LoadingBlock />
      ) : !stats.data ? (
        <LoadErrorBlock error={stats.error} onRetry={() => void stats.refetch()} />
      ) : stats.data.timeline.length === 0 && stats.data.players.length === 0 ? (
        <EmptyState
          icon={<BarChart3 size={36} />}
          title="Noch keine Daten"
          description="Sobald der Server läuft, zeichnet das Panel Spielerzahl und Spielzeiten auf."
        />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap gap-2">
            <Badge tone="green">Spitze: {stats.data.peak.count}{stats.data.peak.at && ` · ${formatDate(stats.data.peak.at)}`}</Badge>
            <Badge tone="blue">{stats.data.uniquePlayers} verschiedene Spieler</Badge>
            <Badge tone="gold">Spielzeit gesamt: {formatDuration(stats.data.totalSeconds)}</Badge>
          </div>

          <Timeline data={stats.data.timeline} days={stats.data.days} />

          {stats.data.players.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[28rem] text-sm">
                <thead>
                  <tr className="border-b border-stone-700 text-left text-[11px] uppercase tracking-[0.06em] text-stone-450">
                    <th className="py-2 pr-3 font-semibold">Spieler</th>
                    <th className="py-2 pr-3 text-right font-semibold">Spielzeit</th>
                    <th className="py-2 pr-3 text-right font-semibold">Sitzungen</th>
                    <th className="py-2 text-right font-semibold">Zuletzt</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-875">
                  {stats.data.players.map((player) => (
                    <tr key={player.name}>
                      <td className="py-2 pr-3">
                        <span className="flex items-center gap-2">
                          <PixelHead name={player.name} size={20} />
                          <span className="truncate font-mono text-[13px] text-stone-100">{player.name}</span>
                          {player.online && <Badge tone="green">online</Badge>}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-stone-200">{formatDuration(player.totalSeconds)}</td>
                      <td className="py-2 pr-3 text-right font-mono text-stone-350">{player.sessions}</td>
                      <td className="py-2 text-right text-xs text-stone-400">
                        {player.online ? 'jetzt' : formatRelative(player.lastSeen)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
