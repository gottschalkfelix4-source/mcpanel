/**
 * FTB-Teams-Partys verwalten.
 *
 * Gelesen wird aus den Dateien des Mods im Weltordner
 * (`<welt>/ftbteams/party/<uuid>.snbt`, `…/player/<uuid>.snbt`) – das geht
 * auch bei gestopptem Server. Geändert wird ausschließlich über die
 * Admin-Befehle des Mods (`ftbteams force-disband`, `force-add`,
 * `force-remove`, `party transfer_ownership_for`, `party settings_for`),
 * damit der laufende Server und die Spieler die Änderung sofort mitbekommen;
 * die Dateien selbst fasst das Panel nie an.
 *
 * Eine Party spricht der Mod über ihren Kurznamen an: Anzeigename mit `_`
 * statt Sonderzeichen, dazu `#` und die ersten acht Zeichen der ID
 * (AbstractTeamBase.getShortName). Den bildet das Panel selbst aus den
 * Dateien – es gelangt also nie frei eingegebener Text an diese Stelle.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from '@prisma/client';
import { serverDir } from '../config.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { safePath } from '../lib/safePath.js';
import { parseSnbt, type SnbtValue } from '../lib/snbt.js';
import { sendServerCommand } from './consoleCommand.js';
import * as dockerSvc from './docker.js';
import { readKnownPlayers } from './knownPlayers.js';
import { levelName } from './regionScan.js';

export type PartyRank = 'owner' | 'officer' | 'member' | 'invited' | 'ally';

export interface PartyMember {
  uuid: string;
  name: string;
  rank: PartyRank;
}

export interface Party {
  id: string;
  name: string;
  /** So spricht der Mod die Party in Befehlen an */
  shortName: string;
  description: string;
  color: string | null;
  owner: string | null;
  members: PartyMember[];
  invited: PartyMember[];
  allies: PartyMember[];
}

export interface TeamPlayer {
  uuid: string;
  name: string;
  /** ID der Party, in der der Spieler ist */
  partyId: string | null;
}

export interface TeamsOverview {
  /** Der Mod hat in dieser Welt schon Daten angelegt */
  available: boolean;
  parties: Party[];
  players: TeamPlayer[];
}

const MAX_FILES = 2000;
const MAX_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Java-Namen, dazu Bedrock-Spieler über Geyser/Floodgate mit Präfix */
const PLAYER = /^[.*]?[A-Za-z0-9_]{1,32}$/;

const asRecord = (value: SnbtValue | undefined): Record<string, SnbtValue> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const asString = (value: SnbtValue | undefined): string => (typeof value === 'string' ? value : '');

export function shortName(displayName: string, id: string): string {
  const clean = displayName.replace(/\W/g, '_');
  return `${clean.length > 50 ? clean.slice(0, 50) : clean}#${id.slice(0, 8)}`;
}

async function readDir(root: string, relative: string): Promise<Record<string, SnbtValue>[]> {
  let names: string[];
  try {
    names = (await fs.readdir(safePath(root, relative))).filter((name) => name.endsWith('.snbt')).slice(0, MAX_FILES);
  } catch {
    return [];
  }
  const out: Record<string, SnbtValue>[] = [];
  for (const name of names) {
    try {
      const file = safePath(root, path.posix.join(relative, name));
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > MAX_BYTES) continue;
      out.push(asRecord(parseSnbt(await fs.readFile(file, 'utf8'))));
    } catch {
      // Eine einzelne kaputte Datei soll die Liste nicht verhindern.
    }
  }
  return out;
}

export async function listTeams(server: Pick<Server, 'id'>): Promise<TeamsOverview> {
  const root = serverDir(server.id);
  const base = `${await levelName(server.id)}/ftbteams`;
  const exists = await fs.stat(safePath(root, base)).then((s) => s.isDirectory(), () => false);
  if (!exists) return { available: false, parties: [], players: [] };

  const [partyFiles, playerFiles, known] = await Promise.all([
    readDir(root, `${base}/party`),
    readDir(root, `${base}/player`),
    readKnownPlayers(server.id).catch(() => []),
  ]);

  // Namen: erst aus den Dateien des Mods, sonst aus Minecrafts Profil-Cache.
  const names = new Map<string, string>();
  for (const entry of known) names.set(entry.uuid.toLowerCase(), entry.name);
  for (const file of playerFiles) {
    const id = asString(file.id).toLowerCase();
    const name = asString(file.player_name);
    if (UUID.test(id) && name) names.set(id, name);
  }
  const member = (uuid: string, rank: PartyRank): PartyMember => ({ uuid, name: names.get(uuid) ?? uuid.slice(0, 8), rank });

  const inParty = new Map<string, string>();
  const parties: Party[] = [];
  for (const file of partyFiles) {
    const id = asString(file.id).toLowerCase();
    if (!UUID.test(id) || asString(file.type) !== 'party') continue;
    const properties = asRecord(file.properties);
    const name = asString(properties['ftbteams:display_name']) || 'Unbenannt';
    const owner = asString(file.owner).toLowerCase();
    const party: Party = {
      id, name, shortName: shortName(name, id),
      description: asString(properties['ftbteams:description']),
      color: /^#[0-9a-fA-F]{6}$/.test(asString(properties['ftbteams:color'])) ? asString(properties['ftbteams:color']) : null,
      owner: UUID.test(owner) ? owner : null,
      members: [], invited: [], allies: [],
    };
    for (const [uuidRaw, rankRaw] of Object.entries(asRecord(file.ranks))) {
      const uuid = uuidRaw.toLowerCase();
      const rank = asString(rankRaw) as PartyRank;
      if (!UUID.test(uuid)) continue;
      if (rank === 'owner' || rank === 'officer' || rank === 'member') {
        party.members.push(member(uuid, rank));
        inParty.set(uuid, id);
      } else if (rank === 'invited') party.invited.push(member(uuid, rank));
      else if (rank === 'ally') party.allies.push(member(uuid, rank));
    }
    const order: Record<string, number> = { owner: 0, officer: 1, member: 2 };
    party.members.sort((a, b) => order[a.rank] - order[b.rank] || a.name.localeCompare(b.name, 'de'));
    parties.push(party);
  }
  parties.sort((a, b) => a.name.localeCompare(b.name, 'de'));

  const players: TeamPlayer[] = [...names.entries()]
    .filter(([, name]) => PLAYER.test(name))
    .map(([uuid, name]) => ({ uuid, name, partyId: inParty.get(uuid) ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return { available: true, parties, players };
}

// ---------------------------------------------------------------------------
// Ändern – nur über Befehle des Mods
// ---------------------------------------------------------------------------

export type TeamAction =
  | { type: 'disband' }
  | { type: 'add'; player: string }
  | { type: 'remove'; player: string }
  | { type: 'transfer'; player: string }
  | { type: 'rename'; name: string };

/** Antworten, an denen ein abgelehnter Befehl zu erkennen ist. */
const FAILED = /unknown or incomplete command|incorrect argument|unbekannter oder unvollständiger befehl|no player was found|no entity was found|that player does not exist|can't find team|team not found|not in a party|already in a party|an unexpected error|<--\[HERE\]/i;

function assertPlayer(name: string): string {
  if (!PLAYER.test(name)) throw badRequest('Ungültiger Spielername');
  return name;
}

function assertTeamName(name: string): string {
  const clean = name.trim();
  if (clean.length < 1 || clean.length > 50 || /[\r\n\0§]/.test(clean)) throw badRequest('Der Name darf 1 bis 50 Zeichen haben');
  return clean;
}

async function run(server: Server, line: string): Promise<string> {
  const { state } = await dockerSvc.getState(server);
  if (state !== 'running') throw conflict('Der Server muss laufen, damit FTB Teams die Änderung annimmt.');
  const response = (await sendServerCommand(server, line)).response.replace(/§./g, '').trim();
  if (FAILED.test(response)) {
    throw badRequest(`FTB Teams hat abgelehnt: ${response.slice(0, 300)}`);
  }
  // Damit die Dateien – und damit die Anzeige im Panel – gleich stimmen.
  await sendServerCommand(server, 'save-all').catch(() => null);
  return response;
}

export async function applyTeamAction(server: Server, partyId: string, action: TeamAction): Promise<string> {
  const party = (await listTeams(server)).parties.find((entry) => entry.id === partyId.toLowerCase());
  if (!party) throw notFound('Party nicht gefunden');
  const team = party.shortName;
  switch (action.type) {
    case 'disband':
      return run(server, `ftbteams force-disband ${team}`);
    case 'add':
      return run(server, `ftbteams force-add ${team} ${assertPlayer(action.player)}`);
    case 'remove': {
      const player = assertPlayer(action.player);
      if (party.members.find((m) => m.name === player)?.rank === 'owner') {
        throw badRequest('Der Besitzer lässt sich nicht entfernen – erst die Party übertragen oder auflösen.');
      }
      return run(server, `ftbteams force-remove ${team} ${player}`);
    }
    case 'transfer':
      return run(server, `ftbteams party transfer_ownership_for ${team} ${assertPlayer(action.player)}`);
    case 'rename':
      return run(server, `ftbteams party settings_for ${team} ftbteams:display_name ${assertTeamName(action.name)}`);
  }
}

/**
 * Neue Party für einen Spieler. Der Mod kennt dafür keinen Admin-Befehl –
 * `party create` muss der Spieler selbst ausführen. Das Panel lässt den
 * Server den Befehl in seinem Namen ausführen; dafür muss er online sein.
 */
export async function createParty(server: Server, player: string, name: string): Promise<string> {
  return run(server, `execute as ${assertPlayer(player)} run ftbteams party create ${assertTeamName(name)}`);
}
