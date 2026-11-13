import { describe, expect, it } from 'vitest';
import { isProviderId, providerId } from './providerId.js';

describe('Projekt- und Versionskennungen der Anbieter', () => {
  it('lässt echte IDs und Kurznamen durch', () => {
    for (const id of ['AANobbMI', '238222', 'fabric-api', 'create_fabric', 'all-the-mods-9', "mod.name+1"]) {
      expect(isProviderId(id), id).toBe(true);
    }
  });

  // Die ID landet im Dateinamen des Modpack-Caches und in der API-Adresse.
  it('lehnt alles ab, was einen Pfad oder eine andere Adresse bilden könnte', () => {
    for (const id of ['', '..', '../x', 'a/b', 'a\\b', 'AANobbMI?/../../../servers/x/plugins/a', '123/files/456?', 'a#b', 'a%2e%2e', 'a b', 'a\nb', 'x'.repeat(65)]) {
      expect(isProviderId(id), JSON.stringify(id)).toBe(false);
    }
    expect(() => providerId.parse('AANobbMI?/../../x')).toThrow();
  });
});
