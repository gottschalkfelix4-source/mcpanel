import { expect, it, vi } from 'vitest';
vi.mock('./rcon.js', () => ({ rconCommand: vi.fn() }));
vi.mock('./docker.js', () => ({ getState: vi.fn() }));
vi.mock('./content.js', () => ({ serverLoader: (server: any) => server.type }));
import { parseTickMetrics, getTickMetrics } from './tickMetrics.js';
import { rconCommand } from './rcon.js';
import { getState } from './docker.js';

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
