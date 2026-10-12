import type { Server } from '@prisma/client';
import { rconCommand } from './rcon.js';
import { getState } from './docker.js';
import { serverLoader } from './content.js';

type Source = 'spark' | 'paper' | 'forge';
interface Sample { at: string; tps: number | null; mspt: number | null }
interface Measurement extends Sample { source: Source | null; available: boolean; message: string; history: Sample[] }
const entries = new Map<string, { at: number; startedAt: string | null; result: Measurement }>();
const pending = new Map<string, Promise<Measurement>>();
const clean = (raw: string) => raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/§[0-9a-fk-or]/gi, '');
const value = (text?: string) => {
  const match = text?.match(/\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const number = Number(match[0].replace(',', '.'));
  return Number.isFinite(number) ? number : null;
};

export function parseTickMetrics(raw: string, source: Source): { tps: number | null; mspt: number | null } {
  const text = clean(raw);
  let tps: number | null = null, mspt: number | null = null;
  if (source === 'spark') {
    tps = value(text.match(/TPS[^:\n]*:\s*([^\n]+)/i)?.[1]);
    const durations = text.match(/Tick durations[^:\n]*:\s*([^\n]+)/i)?.[1];
    mspt = durations ? value(durations.split('/')[1]) : null;
  } else if (source === 'paper') {
    tps = value(text.match(/TPS[^:\n]*:\s*([^\n]+)/i)?.[1]);
    const durations = text.match(/(?:Server tick times|MSPT|Tick times)[^:\n]*:\s*([^\n]+)/i)?.[1];
    mspt = value(durations);
  } else {
    const overall = text.split('\n').find(line => /Overall/i.test(line));
    if (overall) {
      tps = value(overall.match(/(?:Mean )?TPS\s*:\s*([\d.,]+)/i)?.[1]);
      mspt = value(overall.match(/(?:Mean )?tick time\s*:\s*([\d.,]+)/i)?.[1]);
    }
  }
  return { tps: tps !== null && tps >= 0 && tps <= 20.1 ? Math.min(20, tps) : null,
    mspt: mspt !== null && mspt >= 0 && mspt < 60_000 ? mspt : null };
}

export async function getTickMetrics(server: Server): Promise<Measurement> {
  const existing = pending.get(server.id);
  if (existing) return existing;
  const execute = async (): Promise<Measurement> => {
    const state = await getState(server);
    const at = new Date().toISOString();
    if (state.state !== 'running') return { at, tps: null, mspt: null, source: null, available: false, message: 'Der Server läuft noch nicht.', history: [] };
    const previous = entries.get(server.id);
    const reusable = previous?.startedAt === state.startedAt ? previous : undefined;
    if (reusable && Date.now() - reusable.at < 30_000) return reusable.result;
    const ask = (command: string) => rconCommand(server, command).catch(() => '');
    let source: Source = 'spark';
    let metrics = parseTickMetrics(await ask('spark tps'), source);
    const loader = serverLoader(server);
    if (metrics.tps === null && ['PAPER', 'PURPUR', 'SPIGOT'].includes(loader)) {
      source = 'paper';
      metrics = parseTickMetrics((await ask('tps')) + '\n' + (await ask('mspt')), source);
    } else if (metrics.tps === null && ['FORGE', 'NEOFORGE'].includes(loader)) {
      source = 'forge'; metrics = parseTickMetrics(await ask('forge tps'), source);
    }
    const available = metrics.tps !== null || metrics.mspt !== null;
    const history = available ? [...(reusable?.result.history ?? []), { at, ...metrics }].slice(-240) : reusable?.result.history ?? [];
    const result: Measurement = { at, ...metrics, source: available ? source : null, available, history,
      message: available ? '' : 'Keine Tick-Messwerte verfügbar. Spark oder ein unterstützter Serverbefehl muss vorhanden und über RCON erreichbar sein.' };
    entries.set(server.id, { at: Date.now(), startedAt: state.startedAt, result });
    return result;
  };
  const request = execute();
  pending.set(server.id, request);
  try { return await request; } finally { pending.delete(server.id); }
}
