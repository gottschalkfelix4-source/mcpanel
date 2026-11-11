import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ root: '', state: 'running', commands: [] as string[], reply: '' }));
vi.mock('../config.js', () => ({ serverDir: (id: string) => path.join(m.root, id) }));
vi.mock('./docker.js', () => ({ getState: async () => ({ state: m.state }) }));
vi.mock('./consoleCommand.js', () => ({
  sendServerCommand: async (_s: Server, line: string) => { m.commands.push(line); return { via: 'rcon', response: line === 'save-all' ? '' : m.reply }; },
}));
vi.mock('./knownPlayers.js', () => ({ readKnownPlayers: async () => [{ uuid: 'cccccccc-0000-0000-0000-000000000003', name: 'Tom' }] }));

const { applyTeamAction, createParty, listTeams, shortName } = await import('./ftbTeams.js');
const { parseSnbt } = await import('../lib/snbt.js');

const server = { id: 'srv', name: 'Welt' } as Server;
const A = 'aaaaaaaa-0000-0000-0000-000000000001', B = 'bbbbbbbb-0000-0000-0000-000000000002', C = 'cccccccc-0000-0000-0000-000000000003';
const P = '11111111-2222-3333-4444-555555555555';

async function put(relative: string, content: string) {
  const file = path.join(m.root, 'srv', relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

// So schreibt FTB Library die Dateien: zeilenweise, ohne Kommas.
const PARTY = `{
	id: "${P}"
	type: "party"
	owner: "${A}"
	ranks: {
		"${A}": "owner"
		"${B}": "member"
		"${C}": "invited"
	}
	properties: {
		"ftbteams:display_name": "Felix' Basis!"
		"ftbteams:description": ""
		"ftbteams:color": "#FFAA00"
		"ftbteams:free_to_join": false
		"ftbteams:max_msg_history_size": 1000
	}
	message_history: [ ]
	extra: { ftbchunks: { max_claim_chunks: 500, list: [I; 1, 2, 3] } }
}`;

beforeEach(async () => {
  m.root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-ftbteams-'));
  m.state = 'running'; m.commands = []; m.reply = '';
  await put('server.properties', 'level-name=world\n');
  await put(`world/ftbteams/party/${P}.snbt`, PARTY);
  await put(`world/ftbteams/player/${A}.snbt`, `{ id: "${A}", type: "player", player_name: "Felix" }`);
  await put(`world/ftbteams/player/${B}.snbt`, `{ id: "${B}", type: "player", player_name: "Lena" }`);
});
afterEach(async () => { await fs.rm(m.root, { recursive: true, force: true }); });

describe('SNBT', () => {
  it('liest das Format der FTB-Mods', () => {
    expect(parseSnbt(PARTY)).toMatchObject({
      type: 'party',
      properties: { 'ftbteams:display_name': "Felix' Basis!", 'ftbteams:free_to_join': false, 'ftbteams:max_msg_history_size': 1000 },
      extra: { ftbchunks: { max_claim_chunks: 500, list: [1, 2, 3] } },
    });
    expect(parseSnbt('{ a: 1b, b: 2.5d, c: -3L, d: "x\\"y", e: [ { f: true } ] }')).toEqual({ a: 1, b: 2.5, c: -3, d: 'x"y', e: [{ f: true }] });
    expect(() => parseSnbt('{ a: ')).toThrow();
  });
});

describe('listTeams', () => {
  it('liest Partys mit Mitgliedern, Rängen und Kurznamen', async () => {
    const teams = await listTeams(server);
    expect(teams.available).toBe(true);
    expect(teams.parties).toHaveLength(1);
    expect(teams.parties[0]).toMatchObject({
      name: "Felix' Basis!", shortName: 'Felix__Basis_#11111111', color: '#FFAA00', owner: A,
      members: [{ name: 'Felix', rank: 'owner' }, { name: 'Lena', rank: 'member' }],
      invited: [{ name: 'Tom', rank: 'invited' }],
    });
    expect(teams.players).toEqual([
      { uuid: A, name: 'Felix', partyId: P }, { uuid: B, name: 'Lena', partyId: P }, { uuid: C, name: 'Tom', partyId: null },
    ]);
  });

  it('meldet einen Server ohne FTB Teams und übersteht kaputte Dateien', async () => {
    await put(`world/ftbteams/party/kaputt.snbt`, '{ id: ');
    expect((await listTeams(server)).parties).toHaveLength(1);
    await fs.rm(path.join(m.root, 'srv/world/ftbteams'), { recursive: true });
    expect(await listTeams(server)).toEqual({ available: false, parties: [], players: [] });
  });

  it('bildet den Kurznamen wie der Mod', () => {
    expect(shortName('Die Besten 2', P)).toBe('Die_Besten_2#11111111');
    expect(shortName('x'.repeat(80), P)).toBe(`${'x'.repeat(50)}#11111111`);
  });
});

describe('Aktionen', () => {
  it('schickt die Admin-Befehle des Mods mit dem Kurznamen', async () => {
    await applyTeamAction(server, P, { type: 'add', player: 'Tom' });
    await applyTeamAction(server, P, { type: 'remove', player: 'Lena' });
    await applyTeamAction(server, P, { type: 'transfer', player: 'Lena' });
    await applyTeamAction(server, P, { type: 'rename', name: 'Neue Basis' });
    await applyTeamAction(server, P, { type: 'disband' });
    await createParty(server, 'Tom', 'Toms Party');
    expect(m.commands.filter((c) => c !== 'save-all')).toEqual([
      'ftbteams force-add Felix__Basis_#11111111 Tom',
      'ftbteams force-remove Felix__Basis_#11111111 Lena',
      'ftbteams party transfer_ownership_for Felix__Basis_#11111111 Lena',
      'ftbteams party settings_for Felix__Basis_#11111111 ftbteams:display_name Neue Basis',
      'ftbteams force-disband Felix__Basis_#11111111',
      'execute as Tom run ftbteams party create Toms Party',
    ]);
  });

  it('lehnt eingeschleuste Befehle, den Besitzer und unbekannte Partys ab', async () => {
    await expect(applyTeamAction(server, P, { type: 'add', player: 'Tom\nop Tom' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(applyTeamAction(server, P, { type: 'add', player: 'Tom @a' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(applyTeamAction(server, P, { type: 'rename', name: 'x\nstop' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(applyTeamAction(server, P, { type: 'remove', player: 'Felix' })).rejects.toThrow('Besitzer');
    await expect(applyTeamAction(server, 'ffffffff-0000-0000-0000-000000000000', { type: 'disband' })).rejects.toMatchObject({ statusCode: 404 });
    expect(m.commands).toEqual([]);
  });

  it('braucht einen laufenden Server und meldet Absagen des Mods', async () => {
    m.state = 'stopped';
    await expect(applyTeamAction(server, P, { type: 'disband' })).rejects.toMatchObject({ statusCode: 409 });
    m.state = 'running';
    m.reply = 'Unknown or incomplete command, see below for error\nftbteams force-add<--[HERE]';
    await expect(applyTeamAction(server, P, { type: 'add', player: 'Tom' })).rejects.toThrow('FTB Teams hat abgelehnt');
  });
});
