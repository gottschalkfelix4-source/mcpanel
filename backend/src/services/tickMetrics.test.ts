import { afterEach, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
vi.mock('./rcon.js', () => ({ rconCommand: vi.fn() }));
vi.mock('./docker.js', () => ({ getState: vi.fn() }));
vi.mock('./content.js', () => ({ serverLoader: (server: any) => server.type }));
import { parseTickMetrics, parseGameTime, gameTimeTps, getTickMetrics } from './tickMetrics.js';
import { rconCommand } from './rcon.js';
import { getState } from './docker.js';

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });

it('liest Spark-TPS und den MSPT-Median ohne Zeitfenster oder Farbcode als Messwert zu verwechseln', () => {
  const response = '§aTPS from last 5s, 10s, 1m, 5m, 15m:\n *20.0, 19.5, 19.8, 20.0, 20.0\nTick durations (min/med/95%ile/max ms) from last 10s, 1m:\n 0.5/7.3/22.0/80.0; 0.4/6.0/20.0/70.0';
  expect(parseTickMetrics(response, 'spark')).toEqual({ tps: 20, mspt: 7.3 });
});
it('liest die Paper-Mittelwerte', () => {
  expect(parseTickMetrics('TPS from last 1m, 5m, 15m: *19.8, 20.0, 20.0\nServer tick times (avg/min/max) from last 5s, 10s, 1m:\n 12.3/1.1/100.0, 10.0/1.0/40.0', 'paper')).toEqual({ tps: 19.8, mspt: 12.3 });
});
it('verwendet bei Forge den Gesamtwert statt einer einzelnen Dimension', () => {
  expect(parseTickMetrics('Dim minecraft:overworld : Mean tick time: 7.0 ms. Mean TPS: 20.0\nOverall : Mean tick time: 14.5 ms. Mean TPS: 19.7', 'forge')).toEqual({ tps: 19.7, mspt: 14.5 });
});
it('erfindet bei unbekannten Befehlen keine Messwerte', () => {
  expect(parseTickMetrics('Unknown command at position 0', 'spark')).toEqual({ tps: null, mspt: null });
});
it('liest die eingebaute Minecraft-Tickzeit und gibt die Zieltickrate nicht als gemessene TPS aus', () => {
  const response = 'The game is running normallyTarget tick rate: 20.0 per second.\nAverage time per tick: 0.1ms (Target: 50.0ms)Percentiles: P50: 0.1ms P95: 0.2ms P99: 0.2ms. Sample: 100';
  expect(parseTickMetrics(response, 'minecraft')).toEqual({ tps: null, mspt: 0.1 });
});
it('bündelt gleichzeitige Messungen und verwirft den Verlauf nach einem Serverneustart', async () => {
  vi.mocked(getState).mockResolvedValue({ state: 'running', health: 'healthy', startedAt: 'start-1' });
  vi.mocked(rconCommand).mockResolvedValue('TPS from last 5s, 10s, 1m:\n20.0, 20.0, 20.0');
  const server = { id: 'tick-test', type: 'FABRIC' } as any;
  const result = await Promise.all([getTickMetrics(server), getTickMetrics(server)]);
  expect(rconCommand).toHaveBeenCalledTimes(1); expect(result[0].history).toHaveLength(1);
  vi.mocked(getState).mockResolvedValue({ state: 'running', health: 'healthy', startedAt: 'start-2' });
  expect((await getTickMetrics(server)).history).toHaveLength(1);
  expect(rconCommand).toHaveBeenCalledTimes(2);
});

it('liest ausschließlich Spieltick-Antworten alter und neuer Minecraft-Versionen', () => {
  expect(parseGameTime('The time is 318067')).toBe(318067);
  expect(parseGameTime('The game time is 5995 tick(s)')).toBe(5995);
  expect(parseGameTime('Unknown command at position 0')).toBeNull();
  expect(parseGameTime('Target tick rate: 20.0 per second.')).toBeNull();
  expect(parseGameTime('The time is 9007199254740993')).toBeNull();
});

it('misst reduzierte TPS und pausierte Server statt TPS aus der Tickzeit zu schätzen', () => {
  expect(gameTimeTps({ ticks: 100, at: 0 }, { ticks: 175, at: 5000 })).toBe(15);
  expect(gameTimeTps({ ticks: 100, at: 0 }, { ticks: 100, at: 5000 })).toBe(0);
  expect(gameTimeTps({ ticks: 100, at: 0 }, { ticks: 200, at: 5000 })).toBe(20);
});

it('verwirft Zählersprünge, Rücksetzungen und ungültige Messintervalle', () => {
  const before = { ticks: 100, at: 1000 };
  expect(gameTimeTps(before, { ticks: 99, at: 6000 })).toBeNull();
  expect(gameTimeTps(before, { ticks: 99999, at: 6000 })).toBeNull();
  expect(gameTimeTps(before, { ticks: 120, at: 2000 })).toBeNull();
  expect(gameTimeTps(before, { ticks: 100, at: 500 })).toBeNull();
  expect(gameTimeTps(before, { ticks: 3000, at: 122000 })).toBeNull();
});

it('liefert ohne Spark echte TPS, erhält die Tickzeit und bündelt die erste Fünf-Sekunden-Messung', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  vi.mocked(getState).mockResolvedValue({ state: 'running', health: 'healthy', startedAt: 'spiel-start-1' });
  const counters = [100, 200, 350, 10, 110];
  vi.mocked(rconCommand).mockImplementation(async (_server, command) => command === 'tick query'
    ? 'Average time per tick: 7.2ms (Target: 50.0ms)'
    : command === 'time query gametime' ? `The time is ${counters.shift()}` : 'Unknown command');
  const server = { id: 'spiel-ticks', type: 'FABRIC' } as any;
  const first = Promise.all([getTickMetrics(server), getTickMetrics(server)]);
  await vi.advanceTimersByTimeAsync(5000);
  const [a, b] = await first;
  expect(a).toMatchObject({ source: 'gametime', tps: 20, mspt: 7.2, msptSource: 'minecraft', tpsWindowSeconds: 5 });
  expect(a).toBe(b); expect(a.history).toHaveLength(1);
  expect(rconCommand).toHaveBeenCalledTimes(4);
  await getTickMetrics(server); expect(rconCommand).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(30001);
  const next = await getTickMetrics(server);
  expect(next.tps).toBeCloseTo(5, 2); expect(next.history).toHaveLength(2);
  vi.mocked(getState).mockResolvedValue({ state: 'running', health: 'healthy', startedAt: 'spiel-start-2' });
  const restarted = getTickMetrics(server);
  await vi.advanceTimersByTimeAsync(5000);
  const result = await restarted;
  expect(result.tps).toBe(20); expect(result.history).toHaveLength(1);
});

it('lässt fehlende TPS unverfügbar, wenn der Server die Spielzeit-Abfrage nicht unterstützt', async () => {
  vi.mocked(getState).mockResolvedValue({ state: 'running', health: 'healthy', startedAt: 'ohne-messquelle' });
  vi.mocked(rconCommand).mockResolvedValue('Unknown command at position 0');
  const result = await getTickMetrics({ id: 'ohne-spielzeit', type: 'FABRIC' } as any);
  expect(result).toMatchObject({ tps: null, mspt: null, available: false, source: null });
  expect(result.history).toHaveLength(0);
});

it('verwendet langsame RCON-Antworten nicht als TPS-Messung', async () => {
  vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(1500);
  vi.mocked(getState).mockResolvedValue({ state: 'running', health: 'healthy', startedAt: 'langsame-antwort' });
  vi.mocked(rconCommand).mockImplementation(async (_server, command) => command === 'time query gametime' ? 'The time is 100' : 'Unknown command');
  expect((await getTickMetrics({ id: 'langsame-spielzeit', type: 'FABRIC' } as any)).tps).toBeNull();
  expect(rconCommand).toHaveBeenCalledTimes(3);
});
