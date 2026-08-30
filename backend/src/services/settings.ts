import { prisma } from '../db.js';
import { config } from '../config.js';

const cache = new Map<string, string>();

export async function getSetting(key: string, fallback = ''): Promise<string> {
  if (cache.has(key)) return cache.get(key)!;
  const row = await prisma.setting.findUnique({ where: { key } });
  const value = row?.value ?? fallback;
  if (value) cache.set(key, value);
  return value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
  if (value) cache.set(key, value);
  else cache.delete(key);
}

/** API-Key aus der Datenbank, sonst aus der Umgebung. */
export async function getCurseforgeKey(): Promise<string> {
  const fromDb = await getSetting('curseforge.apiKey', '');
  return fromDb || config.curseforgeApiKey;
}
