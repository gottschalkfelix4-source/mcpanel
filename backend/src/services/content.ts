import path from 'node:path';
import type { Server } from '@prisma/client';
import { serverDir } from '../config.js';

/**
 * Womit ein Server erweitert wird. Die Unterscheidung haengt allein am
 * Servertyp: Bukkit-Abkoemmlinge laden `plugins/`, die Mod-Loader `mods/`.
 * Eine Datei aus dem falschen Ordner wird schlicht ignoriert - deshalb darf
 * das nie geraten werden.
 */
export type ContentKind = 'mod' | 'plugin';

const KIND_BY_TYPE: Record<string, ContentKind> = {
  PAPER: 'plugin',
  PURPUR: 'plugin',
  SPIGOT: 'plugin',
  FABRIC: 'mod',
  FORGE: 'mod',
  NEOFORGE: 'mod',
  QUILT: 'mod',
  MODPACK: 'mod',
  // VANILLA fehlt bewusst: ein unveraenderter Server laedt weder das eine
  // noch das andere.
};

const DIR_BY_KIND: Record<ContentKind, string> = {
  mod: 'mods',
  plugin: 'plugins',
};

/** `null` bei Servertypen, die gar nichts nachladen (VANILLA). */
export function contentKindFor(serverType: string): ContentKind | null {
  return KIND_BY_TYPE[serverType] ?? null;
}

export function contentDirName(kind: ContentKind): string {
  return DIR_BY_KIND[kind];
}

/** Absoluter Pfad des Inhaltsverzeichnisses, `null` wie bei contentKindFor. */
export function contentDir(server: Server): string | null {
  const kind = contentKindFor(server.type);
  return kind ? path.join(serverDir(server.id), DIR_BY_KIND[kind]) : null;
}

/**
 * Wonach im Katalog gesucht wird. Modrinth kennt die Facette
 * `project_type:plugin`, CurseForge die Klasse "Bukkit Plugins" - beides
 * getrennt von den Mods, obwohl viele Projekte in beiden Listen stehen.
 */
export function catalogTypeFor(kind: ContentKind): 'mod' | 'plugin' {
  return kind;
}

/**
 * Loader-Filter fuer die Katalogsuche. Fuer Plugins gibt es keinen: Bukkit,
 * Spigot und Paper sind bei Modrinth Kategorien desselben Projekttyps, und
 * CurseForge kennt bei Plugins gar keinen Loader.
 */
export function catalogLoaderFor(serverType: string): string | null {
  const kind = contentKindFor(serverType);
  if (kind !== 'mod') return null;
  return serverType === 'MODPACK' ? null : serverType.toLowerCase();
}
