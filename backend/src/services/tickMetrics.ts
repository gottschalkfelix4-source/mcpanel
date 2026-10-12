import type { Server } from '@prisma/client';
import { performance } from 'node:perf_hooks';
import { rconCommand } from './rcon.js';
import { getState } from './docker.js';
import { serverLoader } from './content.js';

type Source = 'spark' | 'paper' | 'forge' | 'minecraft';
interface Sample { at: string; tps: number | null; mspt: number | null }
interface GameTime { ticks: number; at: number }
interface Measurement extends Sample { source: Source | 'gametime' | null; msptSource: Source | null; tpsWindowSeconds: number | null; available: boolean; message: string; history: Sample[] }
const entries = new Map<string, { at: number; startedAt: string | null; counter: GameTime | null; result: Measurement }>();
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
  } else if (source === 'forge') {
    const overall = text.split('\n').find(line => /Overall/i.test(line));
    if (overall) {
      tps = value(overall.match(/(?:Mean )?TPS\s*:\s*([\d.,]+)/i)?.[1]);
      mspt = value(overall.match(/(?:Mean )?tick time\s*:\s*([\d.,]+)/i)?.[1]);
    }
  } else {
    // „Target tick rate“ ist eine Vorgabe, kein gemessener TPS-Wert.
    mspt = value(text.match(/Average time per tick:\s*([\d.,]+)\s*ms/i)?.[1]);
  }
  return { tps: tps !== null && tps >= 0 && tps <= 20.1 ? Math.min(20, tps) : null,
    mspt: mspt !== null && mspt >= 0 && mspt < 60_000 ? mspt : null };
}

export function parseGameTime(raw: string): number | null {
  // 1.20 meldet „The time is …“, ab 26.1 „The game time is … tick(s)“.
  const match = clean(raw).trim().match(/^The (?:game )?time is (\d+)(?: tick\(s\))?$/i);
  if (!match) return null;
  const ticks = Number(match[1]);
  return Number.isSafeInteger(ticks) ? ticks : null;
}

export function gameTimeTps(previous: GameTime, current: GameTime): number | null {
  const seconds = (current.at - previous.at) / 1000;
  const ticks = current.ticks - previous.ticks;
  // Neustarts, zurückgesetzte/übergelaufene Zähler und lange Messlücken verwerfen.
  if (seconds < 4 || seconds > 120 || ticks < 0) return null;
  const tps = ticks / seconds;
  return tps <= 20.5 ? Math.min(20, tps) : null;
}

export async function getTickMetrics(server: Server): Promise<Measurement> {
  const existing = pending.get(server.id);
  if (existing) return existing;
  const execute = async (): Promise<Measurement> => {
    const state = await getState(server);
    const at = new Date().toISOString();
    if (state.state !== 'running') {
      entries.delete(server.id);
      return { at, tps: null, mspt: null, source: null, msptSource: null, tpsWindowSeconds: null, available: false, message: 'Der Server läuft noch nicht.', history: [] };
    }
    const previous = entries.get(server.id);
    const reusable = previous?.startedAt === state.startedAt ? previous : undefined;
    if (reusable && Date.now() - reusable.at < 30_000) return reusable.result;
    const ask = (command: string) => rconCommand(server, command).catch(() => '');
    let source: Source | 'gametime' = 'spark';
    let metrics = parseTickMetrics(await ask('spark tps'), source);
    const loader = serverLoader(server);
    if (metrics.tps === null && ['PAPER', 'PURPUR', 'SPIGOT'].includes(loader)) {
      source = 'paper';
      metrics = parseTickMetrics((await ask('tps')) + '\n' + (await ask('mspt')), source);
    } else if (metrics.tps === null && ['FORGE', 'NEOFORGE'].includes(loader)) {
      source = 'forge'; metrics = parseTickMetrics(await ask('forge tps'), source);
    }
    if (metrics.tps === null && metrics.mspt === null) {
      source = 'minecraft'; metrics = parseTickMetrics(await ask('tick query'), source);
    }
    const msptSource = metrics.mspt !== null ? source as Source : null;
    let counter: GameTime | null = null, tpsWindowSeconds: number | null = null;
    if (metrics.tps === null) {
      const readCounter = async (): Promise<GameTime | null> => {
        const begin = performance.now();
        const ticks = parseGameTime(await ask('time query gametime'));
        const end = performance.now();
        // Langsame RCON-Antworten liefern keinen ausreichend genauen Messzeitpunkt.
        return ticks !== null && end - begin < 1000 ? { ticks, at: (begin + end) / 2 } : null;
      };
      counter = await readCounter();
      let baseline = reusable?.counter ?? null;
      if (counter && (!baseline || gameTimeTps(baseline, counter) === null)) {
        baseline = counter;
        // Beim ersten Aufruf direkt messen; weitere Aufrufe nutzen das Poll-Intervall.
        await new Promise(resolve => setTimeout(resolve, 5000));
        counter = await readCounter();
      }
      if (baseline && counter) {
        const tps = gameTimeTps(baseline, counter);
        if (tps !== null) {
          metrics.tps = tps; source = 'gametime';
          tpsWindowSeconds = (counter.at - baseline.at) / 1000;
        }
      }
    }
    const measuredAt = new Date().toISOString();
    const available = metrics.tps !== null || metrics.mspt !== null;
    const history = available ? [...(reusable?.result.history ?? []), { at: measuredAt, ...metrics }].slice(-240) : reusable?.result.history ?? [];
    const result: Measurement = { at: measuredAt, ...metrics, source: available ? source : null, msptSource, tpsWindowSeconds, available, history,
      message: available ? '' : 'Keine Tick-Messwerte verfügbar. Spark oder ein unterstützter Serverbefehl muss vorhanden und über RCON erreichbar sein.' };
    entries.set(server.id, { at: Date.now(), startedAt: state.startedAt, counter, result });
    return result;
  };
  const request = execute();
  pending.set(server.id, request);
  try { return await request; } finally { pending.delete(server.id); }
}
