import { readJsonList } from './properties.js';

/** Minecraft's profile cache persists known identities; expiry is not last login. */
export async function readKnownPlayers(serverId: string): Promise<{ uuid: string; name: string }[]> {
  const cache = await readJsonList<unknown>(serverId, 'usercache.json');
  const known = new Map<string, { uuid: string; name: string }>();
  for (const row of cache) {
    if (!row || typeof row !== 'object') continue;
    const { uuid, name } = row as Record<string, unknown>;
    if (typeof name !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(name)) continue;
    if (typeof uuid !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(uuid)) continue;
    known.set(name.toLowerCase(), { uuid, name });
  }
  return [...known.values()].sort((a, b) => a.name.localeCompare(b.name));
}
