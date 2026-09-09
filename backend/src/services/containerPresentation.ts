import type { Server } from '@prisma/client';

const DEFAULT_ICON = 'https://raw.githubusercontent.com/gottschalkfelix4-source/mcpanel/main/frontend/public/icons/icon-192.png';

// Direct PNGs: Unraid caches these files as .png, even when the source is SVG.
export const LOADER_ICONS: Readonly<Record<string, string>> = {
  VANILLA: DEFAULT_ICON,
  PAPER: 'https://papermc.io/assets/logo/256x.png',
  PURPUR: 'https://github.com/PurpurMC.png?size=256',
  SPIGOT: 'https://static.spigotmc.org/img/spigot-og.png',
  FABRIC: 'https://fabricmc.net/assets/logo.png',
  FORGE: 'https://files.minecraftforge.net/static/images/apple-touch-icon.png',
  NEOFORGE: 'https://neoforged.net/img/authors/neoforged.png',
  QUILT: 'https://quiltmc.org/favicon/android-chrome-192x192.png',
};

/** Docker permits only ASCII letters, digits, dots, underscores and hyphens. */
export function containerNames(server: Pick<Server, 'id' | 'name'>): [string, string] {
  const name = server.name
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/-+/g, '-')
    .replace(/^[^a-zA-Z0-9]+|[-_.]+$/g, '').slice(0, 80) || 'Minecraft';
  const fallback = `${name}-${server.id}`;
  return [name.length >= 2 ? name : fallback, fallback];
}

export function containerIcon(server: Pick<Server, 'type' | 'extraEnv' | 'modpackIconUrl'>): string {
  if (server.type === 'MODPACK' && server.modpackIconUrl) {
    try {
      const url = new URL(server.modpackIconUrl);
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
    } catch { /* Missing or malformed provider artwork: use the loader logo. */ }
  }
  const extra = (server.extraEnv ?? {}) as Record<string, string>;
  const loader = (extra.TYPE || (server.type === 'MODPACK' ? 'FORGE' : server.type)).toUpperCase();
  return LOADER_ICONS[loader] ?? DEFAULT_ICON;
}
