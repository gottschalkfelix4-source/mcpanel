import type { Server } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  state: 'running',
  commands: [] as string[],
  replies: {} as Record<string, string>,
  progress: '',
  logs: '',
  players: 0,
  tps: 20 as number | null,
  chunky: true,
  bluemap: true,
  remaining: Infinity,
}));
vi.mock('./settings.js', () => ({
  getSetting: async (key: string, fallback = '') => m.settings.get(key) ?? fallback,
  setSetting: async (key: string, value: string) => { m.settings.set(key, value); },
}));
vi.mock('../db.js', () => ({ prisma: {} }));
vi.mock('./consoleCommand.js', () => ({
  sendServerCommand: async (_s: Server, line: string) => { m.commands.push(line); return { via: 'rcon', response: m.replies[line.split(' ').slice(0, 2).join(' ')] ?? '' }; },
}));
vi.mock('./rcon.js', () => ({
  rconCommand: async (_s: Server, line: string) => { m.commands.push(line); return line === 'chunky progress' ? m.progress : ''; },
  listPlayers: async () => ({ online: m.players, max: 20, players: [] }),
}));
vi.mock('./docker.js', () => ({ getState: async () => ({ state: m.state }), tailLogs: async () => m.logs }));
vi.mock('./mapAddons.js', () => ({
  installedAddon: async (_s: Server, key: string) => ((key === 'chunky' ? m.chunky : m.bluemap) ? `${key}.jar` : null),
  acceptBlueMapDownload: async () => 'already',
}));
vi.mock('./quota.js', () => ({ remainingDiskBytes: async () => m.remaining }));
vi.mock('./tickMetrics.js', () => ({ getTickMetrics: async () => ({ tps: m.tps }) }));
vi.mock('./regionScan.js', () => ({ levelName: async () => 'world' }));

const pregen = await import('./pregen.js');
const fabric = { id: 'srv', name: 'Welt', type: 'FABRIC', extraEnv: {} } as unknown as Server;
const paper = { ...fabric, type: 'PAPER' } as Server;
const input = pregen.pregenInputSchema.parse({ radius: 3000 });
const job = async () => (await pregen.getMapSettings('srv')).job!;

const running = (percent: number, world = 'minecraft:overworld') =>
  `[Chunky] Task running for ${world}. Processed: 47483 chunks (${percent.toFixed(2)}%), ETA: 0:26:12, Rate: 41.2 cps, Current: 120, -45`;

beforeEach(() => {
  m.settings.clear(); m.commands = []; m.replies = {}; m.progress = ''; m.logs = '';
  m.state = 'running'; m.players = 0; m.tps = 20; m.chunky = true; m.bluemap = true; m.remaining = Infinity;
});

describe('parseChunky', () => {
  it('liest Fortschritt und Abschluss im Format aus Chunkys Sprachdatei', () => {
    const [update, done] = pregen.parseChunky(`${running(43)}\n§a[Chunky] Task finished for minecraft:the_nether. Processed: 9,812 chunks (100.00%), Total time: 0:04:10`);
    expect(update).toEqual({ world: 'minecraft:overworld', processed: 47483, percent: 43, etaSeconds: 1572, rate: 41.2, current: { x: 120, z: -45 }, finished: false });
    expect(done).toMatchObject({ world: 'minecraft:the_nether', processed: 9812, percent: 100, finished: true });
  });

  it('versteht Dezimalkomma und nimmt die letzte Meldung der richtigen Welt', () => {
    const text = `${running(10)}\n[Chunky] Task running for world_nether. Processed: 5 chunks (1,50%), ETA: 1:00:00, Rate: 3,5 cps, Current: 0, 0\n${running(11)}`;
    expect(pregen.latestFor('minecraft:overworld', pregen.parseChunky(text))?.percent).toBe(11);
    expect(pregen.latestFor('world_nether', pregen.parseChunky(text))).toMatchObject({ percent: 1.5, rate: 3.5 });
  });
});

describe('startPregen', () => {
  it('startet Chunky mit Welt, Form, Mittelpunkt und Radius und hält BlueMap an', async () => {
    const started = await pregen.startPregen(fabric, { ...input, centerX: 100, centerZ: -50 }, 'u1');
    expect(m.commands).toEqual(['chunky quiet 30', 'chunky start minecraft:overworld circle 100 -50 3000', 'bluemap stop']);
    expect(started).toMatchObject({ status: 'running', world: 'minecraft:overworld', total: pregen.estimateChunks('circle', 3000) });
  });

  it('nutzt auf Paper die Weltordner und bestätigt einen alten gespeicherten Auftrag', async () => {
    m.replies['chunky start'] = "A task was already started for this world. To continue running it, type 'chunky continue'. To start a new task, type 'chunky confirm'.";
    await pregen.startPregen(paper, { ...input, dimension: 'nether', shape: 'square', pauseRender: false }, 'u1');
    expect(m.commands).toEqual(['chunky quiet 30', 'chunky start world_nether square 0 0 3000', 'chunky confirm']);
  });

  it('lehnt ab: Server aus, Chunky fehlt, Kontingent zu klein, schon laufend', async () => {
    m.state = 'stopped';
    await expect(pregen.startPregen(fabric, input, 'u1')).rejects.toMatchObject({ statusCode: 409 });
    m.state = 'running'; m.chunky = false;
    await expect(pregen.startPregen(fabric, input, 'u1')).rejects.toMatchObject({ statusCode: 400 });
    m.chunky = true; m.remaining = 1024 ** 3;
    await expect(pregen.startPregen(fabric, input, 'u1')).rejects.toThrow('Speicherkontingent');
    m.remaining = Infinity;
    await pregen.startPregen(fabric, input, 'u1');
    await expect(pregen.startPregen(fabric, input, 'u1')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('Überwachung', () => {
  it('übernimmt den Fortschritt und schließt ab, wenn Chunky fertig meldet', async () => {
    await pregen.startPregen(fabric, input, 'u1');
    m.progress = running(43);
    await pregen.monitorServer(fabric);
    expect(await job()).toMatchObject({ status: 'running', percent: 43, processed: 47483, rate: 41.2, etaSeconds: 1572, current: { x: 120, z: -45 } });

    m.commands = [];
    m.progress = 'No tasks running.';
    m.logs = '[Chunky] Task finished for minecraft:overworld. Processed: 110427 chunks (100.00%), Total time: 0:45:00';
    await pregen.monitorServer(fabric);
    expect(await job()).toMatchObject({ status: 'done', percent: 100, processed: 110427 });
    expect(m.commands).toContain('bluemap start');
  });

  it('setzt nach einem Neustart des Servers selbst fort', async () => {
    await pregen.startPregen(fabric, input, 'u1');
    m.state = 'stopped';
    await pregen.monitorServer(fabric);
    expect((await job()).autoPaused).toBe('stopped');

    m.state = 'running'; m.commands = [];
    m.progress = 'No tasks running.';
    m.replies['chunky continue'] = 'Task continuing for minecraft:overworld.';
    await pregen.monitorServer(fabric);
    expect(m.commands).toContain('chunky continue minecraft:overworld');
    expect(await job()).toMatchObject({ status: 'running', autoPaused: null });
  });

  it('pausiert bei Spielern bzw. niedrigen TPS und macht danach weiter', async () => {
    await pregen.startPregen(fabric, { ...input, onlyWhenEmpty: true }, 'u1');
    m.progress = running(10);
    m.players = 2;
    await pregen.monitorServer(fabric);
    expect(m.commands).toContain('chunky pause minecraft:overworld');
    expect((await job()).autoPaused).toBe('players');

    m.commands = []; m.progress = 'No tasks running.'; m.players = 0;
    await pregen.monitorServer(fabric);
    expect(m.commands).toContain('chunky continue minecraft:overworld');
    expect((await job()).autoPaused).toBeNull();

    m.commands = []; m.progress = running(12); m.tps = 12;
    await pregen.monitorServer(fabric);
    expect((await job()).autoPaused).toBe('tps');
    m.commands = []; m.progress = 'No tasks running.'; m.tps = 16;
    await pregen.monitorServer(fabric);
    expect(m.commands).not.toContain('chunky continue minecraft:overworld');
    m.tps = 19.5;
    await pregen.monitorServer(fabric);
    expect((await job()).autoPaused).toBeNull();
  });

  it('pausieren, fortsetzen und abbrechen auf Wunsch', async () => {
    await pregen.startPregen(fabric, input, 'u1');
    await pregen.pausePregen(fabric);
    expect((await job()).status).toBe('paused');
    // Eine pausierte Generierung fasst die Überwachung nicht an.
    m.commands = []; m.progress = 'No tasks running.';
    await pregen.monitorServer(fabric);
    expect(m.commands.filter((c) => c.startsWith('chunky continue'))).toEqual([]);

    m.replies['chunky continue'] = 'Task continuing for minecraft:overworld.';
    await pregen.resumePregen(fabric);
    expect((await job()).status).toBe('running');

    m.replies['chunky cancel'] = "Cancelled tasks cannot be continued. If you are sure you want to cancel, type 'chunky confirm'.";
    m.commands = [];
    await pregen.cancelPregen(fabric);
    expect(m.commands).toEqual(['chunky cancel minecraft:overworld', 'chunky confirm', 'bluemap start']);
    expect((await job()).status).toBe('cancelled');
    await pregen.clearPregen('srv');
    expect(await job()).toBeNull();
  });
});
