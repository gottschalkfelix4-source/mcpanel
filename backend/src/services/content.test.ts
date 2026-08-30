import path from 'node:path';
import type { Server } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  serverDir: (id: string) => path.join('/data/servers', id),
}));

const {
  catalogLoaderFor,
  catalogTypeFor,
  contentDir,
  contentDirName,
  contentKindFor,
} = await import('./content.js');

const serverOf = (type: string) => ({ id: 'srv-1', type } as unknown as Server);

/**
 * Eine .jar im falschen Ordner wird vom Server kommentarlos ignoriert – der
 * Fehler faellt erst auf, wenn im Spiel etwas fehlt. Deshalb ist die
 * Zuordnung Servertyp -> Verzeichnis hier vollstaendig festgehalten.
 */
describe('contentKindFor', () => {
  it.each(['PAPER', 'PURPUR', 'SPIGOT'])('%s lädt Plugins', (type) => {
    expect(contentKindFor(type)).toBe('plugin');
  });

  it.each(['FABRIC', 'FORGE', 'NEOFORGE', 'QUILT', 'MODPACK'])('%s lädt Mods', (type) => {
    expect(contentKindFor(type)).toBe('mod');
  });

  it('VANILLA lädt weder das eine noch das andere', () => {
    expect(contentKindFor('VANILLA')).toBeNull();
  });

  it('kennt keinen unbekannten Typ', () => {
    expect(contentKindFor('BUNGEECORD')).toBeNull();
  });
});

describe('contentDir', () => {
  it('zeigt bei Paper auf plugins/', () => {
    expect(contentDir(serverOf('PAPER'))).toBe(path.join('/data/servers', 'srv-1', 'plugins'));
  });

  it('zeigt bei NeoForge auf mods/', () => {
    expect(contentDir(serverOf('NEOFORGE'))).toBe(path.join('/data/servers', 'srv-1', 'mods'));
  });

  it('liefert bei Vanilla kein Verzeichnis', () => {
    expect(contentDir(serverOf('VANILLA'))).toBeNull();
  });
});

describe('contentDirName', () => {
  it('benennt beide Verzeichnisse', () => {
    expect(contentDirName('plugin')).toBe('plugins');
    expect(contentDirName('mod')).toBe('mods');
  });
});

describe('catalogTypeFor', () => {
  it('sucht Plugins als Plugins, nicht als Mods', () => {
    expect(catalogTypeFor('plugin')).toBe('plugin');
    expect(catalogTypeFor('mod')).toBe('mod');
  });
});

describe('catalogLoaderFor', () => {
  it('filtert Mods nach ihrem Loader', () => {
    expect(catalogLoaderFor('FABRIC')).toBe('fabric');
    expect(catalogLoaderFor('NEOFORGE')).toBe('neoforge');
  });

  // Bei Modrinth sind bukkit/paper/spigot Kategorien desselben Projekttyps,
  // CurseForge kennt bei Plugins gar keinen Loader.
  it('filtert Plugins nicht nach Loader', () => {
    expect(catalogLoaderFor('PAPER')).toBeNull();
    expect(catalogLoaderFor('SPIGOT')).toBeNull();
  });

  it('legt sich bei einem Modpack nicht auf einen Loader fest', () => {
    expect(catalogLoaderFor('MODPACK')).toBeNull();
  });

  it('liefert für Vanilla nichts', () => {
    expect(catalogLoaderFor('VANILLA')).toBeNull();
  });
});
