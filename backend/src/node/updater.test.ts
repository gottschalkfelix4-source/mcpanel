import { describe, expect, it } from 'vitest';
import { replaceAgent, type DockerOps } from './updater.js';

/** Docker-Attrappe: Container nach Namen, Protokolle je Container. */
function fakeDocker(options: { newLogs?: string; newExits?: boolean; createFails?: boolean } = {}) {
  const containers = new Map<string, { spec: string; running: boolean; logs: string }>();
  containers.set('mcpanel-node', { spec: 'alt', running: true, logs: 'Bereit – wartet auf das Panel' });
  const calls: string[] = [];
  const ops: DockerOps = {
    async stop(name) { calls.push(`stop ${name}`); containers.get(name)!.running = false; },
    async start(name) {
      calls.push(`start ${name}`);
      const c = containers.get(name)!;
      c.running = !(c.spec === 'neu' && options.newExits);
    },
    async rename(name, to) {
      calls.push(`rename ${name} ${to}`);
      const c = containers.get(name)!;
      containers.delete(name);
      containers.set(to, c);
    },
    async remove(name) { calls.push(`remove ${name}`); containers.delete(name); },
    async create(name) {
      calls.push(`create ${name}`);
      if (options.createFails) throw new Error('Port belegt');
      containers.set(name, { spec: 'neu', running: false, logs: options.newLogs ?? '[mcpanel-node] Bereit – wartet auf das Panel' });
    },
    async state(name) {
      const c = containers.get(name);
      return c ? { running: c.running, exitCode: c.running ? 0 : 1 } : null;
    },
    async logs(name) { return containers.get(name)?.logs ?? ''; },
  };
  return { ops, containers, calls };
}

const plan = { name: 'mcpanel-node', spec: { Image: 'neu' }, timeoutMs: 10_000 };
const noWait = async () => {};

describe('Austausch des Node-Agenten', () => {
  it('ersetzt den Agenten und räumt den alten erst nach „Bereit“ weg', async () => {
    const { ops, containers, calls } = fakeDocker();
    await replaceAgent(ops, plan, () => {}, noWait);
    expect(containers.get('mcpanel-node')).toMatchObject({ spec: 'neu', running: true });
    expect(containers.has('mcpanel-node-alt')).toBe(false);
    expect(calls).toEqual([
      'stop mcpanel-node', 'rename mcpanel-node mcpanel-node-alt', 'create mcpanel-node', 'start mcpanel-node', 'remove mcpanel-node-alt',
    ]);
  });

  it('startet den bisherigen Agenten wieder, wenn der neue abbricht', async () => {
    const { ops, containers } = fakeDocker({ newLogs: '[mcpanel-node] ABBRUCH: Profil ungültig' });
    await expect(replaceAgent(ops, plan, () => {}, noWait)).rejects.toThrow('Der neue Agent bricht ab: Profil ungültig. Der bisherige Agent läuft wieder.');
    expect(containers.get('mcpanel-node')).toMatchObject({ spec: 'alt', running: true });
    expect(containers.size).toBe(1);
  });

  it('fällt zurück, wenn der neue Container sich beendet oder gar nicht angelegt werden kann', async () => {
    const exited = fakeDocker({ newExits: true, newLogs: '' });
    await expect(replaceAgent(exited.ops, plan, () => {}, noWait)).rejects.toThrow(/beendet/);
    expect(exited.containers.get('mcpanel-node')).toMatchObject({ spec: 'alt', running: true });

    const broken = fakeDocker({ createFails: true });
    await expect(replaceAgent(broken.ops, plan, () => {}, noWait)).rejects.toThrow('Port belegt. Der bisherige Agent läuft wieder.');
    expect(broken.containers.get('mcpanel-node')).toMatchObject({ spec: 'alt', running: true });
  });

  it('gibt auf, wenn der neue Agent nie bereit wird', async () => {
    const { ops, containers } = fakeDocker({ newLogs: 'startet …' });
    await expect(replaceAgent(ops, { ...plan, timeoutMs: -1 }, () => {}, noWait)).rejects.toThrow(/meldet sich nicht/);
    expect(containers.get('mcpanel-node')?.spec).toBe('alt');
  });

  it('holt einen beiseitegelegten Agenten aus einem abgebrochenen Lauf zurück', async () => {
    const { ops, containers } = fakeDocker();
    containers.set('mcpanel-node-alt', containers.get('mcpanel-node')!);
    containers.delete('mcpanel-node');
    await replaceAgent(ops, plan, () => {}, noWait);
    expect(containers.get('mcpanel-node')?.spec).toBe('neu');
    expect(containers.has('mcpanel-node-alt')).toBe(false);
  });
});
