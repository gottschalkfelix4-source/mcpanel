import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Panel } from './ui';

interface Sample { at: string; tps: number | null; mspt: number | null }
interface Metrics extends Sample { available: boolean; source: string | null; msptSource?: string | null; tpsWindowSeconds?: number | null; message: string; history: Sample[] }

export default function TickMetrics({ serverId, running }: { serverId: string; running: boolean }) {
  const query = useQuery({ queryKey: ['ticks', serverId], queryFn: () => api.get<Metrics>(`/servers/${serverId}/ticks`),
    enabled: running, refetchInterval: running ? 30_000 : false });
  const data = running ? query.data : undefined;
  const plot = (key: 'tps' | 'mspt', max: number) => {
    const history = data?.history.slice(-60) ?? [];
    const points = history.map((sample, index) => sample[key] === null ? null : `${history.length < 2 ? 0 : index * 300 / (history.length - 1)},${60 - Math.min(max, sample[key]!) / max * 55}`);
    const segments: string[] = [];
    for (const point of points) {
      if (point === null) segments.push('');
      else if (segments.length) segments[segments.length - 1] += ' ' + point;
      else segments.push(point);
    }
    return <svg viewBox="0 0 300 65" className="h-20 w-full" role="img" aria-label={`${key.toUpperCase()} Verlauf`}>
      <line x1="0" y1="60" x2="300" y2="60" stroke="#444" />
      {segments.filter(Boolean).map((segment, index) => <polyline key={index} fill="none" stroke="#7FB238" strokeWidth="2" points={segment} />)}
    </svg>;
  };
  return <Panel title="Minecraft-Leistung · TPS / MSPT">
    {!data?.available ? <p className="text-sm text-stone-400">{!running ? 'Messung bei laufendem Server.' : query.error ? (query.error as Error).message : query.isLoading ? 'Messquelle wird geprüft …' : data?.message}</p> : <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div><p className="text-sm">TPS: <strong className={data.tps === null ? 'text-stone-400' : data.tps < 18 ? 'text-redstone' : 'text-grass-light'}>{data.tps?.toFixed(1) ?? 'Nicht verfügbar'}</strong>{data.tps !== null && ' / 20'}</p>{plot('tps', 20)}</div>
        <div><p className="text-sm">MSPT: <strong className={data.mspt === null ? 'text-stone-400' : data.mspt > 50 ? 'text-redstone' : 'text-grass-light'}>{data.mspt?.toFixed(1) ?? 'Nicht verfügbar'}</strong>{data.mspt !== null && ' ms'}</p>{plot('mspt', Math.max(50, ...(data.history.map(sample => sample.mspt ?? 0))))}</div>
      </div>
      <p className="mt-2 text-xs text-stone-450">Quelle: {data.source === 'gametime' ? 'Minecraft-Spielticks' : data.source} · {new Date(data.at).toLocaleTimeString('de-DE')} · letzte {Math.min(60, data.history.length)} Messungen, alle 30 Sekunden. {data.source === 'gametime' && `TPS aus gezählten Spielticks über ${(data.tpsWindowSeconds ?? 0).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Sekunden. Ein pausierter Server liefert 0 TPS. `}{(data.msptSource ?? data.source) === 'spark' ? 'Spark liefert bei MSPT den Median.' : data.mspt !== null ? 'MSPT zeigt die mittlere Tickzeit.' : 'Dieser Server liefert keine MSPT-Messwerte.'}</p>
    </>}
  </Panel>;
}
