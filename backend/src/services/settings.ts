import { prisma } from '../db.js';
import { config } from '../config.js';
import { z } from 'zod';

export const panelUrlSchema = z.string().trim().max(2048, 'Die Panel-URL ist zu lang.').transform((value, ctx) => {
  if (!value) return '';
  const invalid = () => {
    ctx.addIssue({ code: z.ZodIssueCode.custom,
      message: 'Bitte eine gültige Panel-URL mit http:// oder https:// ohne Zugangsdaten, Suchparameter oder Fragment angeben.' });
    return z.NEVER;
  };
  try {
    const url = new URL(value);
    if (!/^https?:\/\//i.test(value) || !['http:', 'https:'].includes(url.protocol) ||
        !url.hostname || url.username || url.password || url.search || url.hash) return invalid();
    return url.toString().replace(/\/+$/, '');
  } catch {
    return invalid();
  }
});

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

/**
 * Adresse, die den Spielern angezeigt wird. Der Einrichtungsassistent schreibt
 * sie in die Datenbank; die Umgebungsvariable bleibt als Vorgabe bestehen.
 */
export async function getPublicHost(): Promise<string> {
  const fromDb = await getSetting('panel.publicHost', '');
  return fromDb || config.publicHost;
}

export async function getPanelUrl(): Promise<string> {
  return getSetting('panel.url');
}

/** Die Webadresse liefert nur den Hostnamen; der SFTP-Port bleibt unabhängig. */
export async function getSftpHost(): Promise<string> {
  const panelUrl = await getPanelUrl();
  return panelUrl ? new URL(panelUrl).hostname : config.sftp.host;
}
