import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { Server } from '@prisma/client';
import { z } from 'zod';
import { serverDir } from '../config.js';
import { badRequest } from '../lib/errors.js';
import { safePath } from '../lib/safePath.js';
import { parseProperties } from './properties.js';

export const reinstallSchema = z.object({
  name: z.string().trim().min(2).max(48),
  description: z.string().max(280).default(''),
  type: z.enum(['VANILLA', 'PAPER', 'PURPUR', 'SPIGOT', 'FABRIC', 'FORGE', 'NEOFORGE', 'QUILT', 'MODPACK']),
  mcVersion: z.string().min(1).max(80).regex(/^[a-zA-Z0-9._+-]+$/, 'Ungültige Minecraft-Version'),
  memoryMb: z.number().int().min(512).max(65536),
  keepWorld: z.boolean().default(true),
  startAfter: z.boolean().default(false),
  modpack: z.object({ provider: z.enum(['modrinth', 'curseforge']), projectId: z.string().min(1), versionId: z.string().min(1) }).strict().optional(),
}).strict().superRefine((value, context) => {
  if ((value.type === 'MODPACK') !== Boolean(value.modpack)) context.addIssue({ code: 'custom', path: ['modpack'], message: 'Für einen Modpack-Server muss ein Modpack ausgewählt sein.' });
});
export type ReinstallRequest = z.infer<typeof reinstallSchema>;
export type ReinstallOptions = Pick<ReinstallRequest, 'name' | 'description' | 'memoryMb' | 'keepWorld'>;

/** Administrativ vorgegebene Laufzeit-, Port- und RCON-Werte bleiben erhalten. */
export function reinstallEnvironment(server: Server): Record<string, string> {
  const environment = { ...server.extraEnv as Record<string, string> };
  for (const key of Object.keys(environment)) {
    if (/^(TYPE|VERSION|WORLD|WORLD_URL|FORGE_.*|NEOFORGE_.*|FABRIC_.*|QUILT_.*|MODPACK|MODPACK_URL|MODS|PLUGINS|PACKWIZ_URL|GENERIC_PACKS?|MRPACK_FILE|USE_MODPACK_START_SCRIPT|MODRINTH_.*|CF_.*|CURSEFORGE_.*|FTB_.*|PAPER_.*|PURPUR_.*|SPIGOT_.*|CUSTOM_SERVER)$/.test(key)) delete environment[key];
  }
  return environment;
}

export function reinstallMetadata(server: Server) {
  return Object.fromEntries(['name', 'description', 'memoryMb', 'type', 'mcVersion', 'extraEnv',
    'modpackProvider', 'modpackProjectId', 'modpackVersionId', 'modpackName', 'modpackVersionName', 'modpackIconUrl']
    .map(key => [key, server[key as keyof Server]]));
}

/** Frischer Installationsordner mit unabhängigen Kopien der gewählten Nutzerdaten. */
export async function prepareReinstallData(server: Server, stage: string, keepWorld: boolean): Promise<void> {
  const original = serverDir(server.id);
  const propertiesFile = safePath(original, 'server.properties');
  const raw = await fs.readFile(propertiesFile, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''; throw error;
  });
  const properties = parseProperties(raw);
  const worldName = properties['level-name'] || 'world';
  if (keepWorld && (['.', '..'].includes(worldName) || /[/\\\r\n\0]/.test(worldName))) throw badRequest('Der konfigurierte Weltname ist für eine sichere Neuinstallation ungültig.');
  safePath(original, '');
  await fs.mkdir(safePath(stage, ''), { recursive: true });
  const copy = async (relative: string): Promise<void> => {
    const info = await fs.lstat(safePath(original, relative));
    if (info.isDirectory()) {
      await fs.mkdir(safePath(stage, relative), { recursive: true });
      for (const name of await fs.readdir(safePath(original, relative))) await copy(path.join(relative, name));
    } else if (info.isFile()) {
      await fs.copyFile(safePath(original, relative), safePath(stage, relative), constants.COPYFILE_FICLONE);
    } else throw badRequest('Besondere Dateien sind bei einer Neuinstallation nicht erlaubt.');
  };
  const names = new Set(['ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'usercache.json']);
  if (keepWorld) for (const name of ['world', worldName]) for (const suffix of ['', '_nether', '_the_end']) names.add(name + suffix);
  for (const name of names) {
    const exists = await fs.lstat(safePath(original, name)).catch(error => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    if (exists) await copy(name);
  }
  if (!keepWorld) for (const key of ['level-name', 'level-seed', 'level-type', 'generator-settings']) delete properties[key];
  Object.assign(properties, { 'server-port': '25565', 'server-ip': '', 'enable-rcon': 'true', 'rcon.port': String(server.rconPort), 'rcon.password': server.rconPassword });
  await fs.writeFile(safePath(stage, 'server.properties'), Object.entries(properties).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
  await fs.writeFile(safePath(stage, 'eula.txt'), 'eula=true\n');
}
