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
  serverLoader,
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

/** Kurzform: nur Typ und Umgebung entscheiden über den Loader. */
const srv = (type: string, extraEnv: Record<string, string> | null = {}) =>
  ({ type, extraEnv } as Parameters<typeof catalogLoaderFor>[0]);

describe('catalogLoaderFor', () => {
  it('filtert Mods nach ihrem Loader', () => {
    expect(catalogLoaderFor(srv('FABRIC'))).toBe('fabric');
    expect(catalogLoaderFor(srv('NEOFORGE'))).toBe('neoforge');
  });

  // Bei Modrinth sind bukkit/paper/spigot Kategorien desselben Projekttyps,
  // CurseForge kennt bei Plugins gar keinen Loader.
  it('filtert Plugins nicht nach Loader', () => {
    expect(catalogLoaderFor(srv('PAPER'))).toBeNull();
    expect(catalogLoaderFor(srv('SPIGOT'))).toBeNull();
  });

  it('nimmt bei einem Modpack den Loader aus der Umgebung', () => {
    expect(catalogLoaderFor(srv('MODPACK', { TYPE: 'FABRIC' }))).toBe('fabric');
    expect(catalogLoaderFor(srv('MODPACK', { TYPE: 'NEOFORGE' }))).toBe('neoforge');
  });

  // Ohne installiertes Modpack startet der Container mit Forge - dann darf der
  // Katalog auch nichts anderes anbieten.
  it('faellt beim Modpack ohne Angabe auf Forge zurueck', () => {
    expect(catalogLoaderFor(srv('MODPACK'))).toBe('forge');
    expect(catalogLoaderFor(srv('MODPACK', null))).toBe('forge');
  });

  it('liefert für Vanilla nichts', () => {
    expect(catalogLoaderFor(srv('VANILLA'))).toBeNull();
  });
});

describe('serverLoader', () => {
  it('nennt bei einem gewoehnlichen Server schlicht den Typ', () => {
    expect(serverLoader(srv('PAPER'))).toBe('PAPER');
    expect(serverLoader(srv('FABRIC'))).toBe('FABRIC');
  });

  it('holt den Loader eines Modpacks aus extraEnv.TYPE', () => {
    expect(serverLoader(srv('MODPACK', { TYPE: 'QUILT' }))).toBe('QUILT');
  });

  // buildEnv() breitet extraEnv ueber die Vorgaben - ein von Hand gesetztes
  // TYPE kommt also wirklich im Container an, auch bei einem Paper-Server.
  it('laesst ein von Hand gesetztes TYPE gewinnen, wie es der Container auch tut', () => {
    expect(serverLoader(srv('PAPER', { TYPE: 'fabric' }))).toBe('FABRIC');
  });

  it('nimmt ein leeres TYPE nicht fuer bare Muenze', () => {
    expect(serverLoader(srv('MODPACK', { TYPE: '  ' }))).toBe('FORGE');
  });
});
