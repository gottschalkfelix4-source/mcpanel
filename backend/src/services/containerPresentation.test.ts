import { expect, it } from 'vitest';
import { containerIcon, containerNames, LOADER_ICONS } from './containerPresentation.js';

it.each([
  ['Meine Survival Welt', 'Meine-Survival-Welt'],
  ['Übergrößen & Spaß!', 'Uebergroessen-Spass'],
  ['... _! Café / 1.21', 'Cafe-1.21'],
  ['🔥🔥', 'Minecraft'],
  ['ATM10', 'ATM10'],
])('uses a valid readable Docker name for %s', (name, expected) => {
  expect(containerNames({ name, id: 'abc123' })).toEqual([expected, `${expected}-abc123`]);
});

it('prefers modpack artwork and falls back to the actual loader', () => {
  const server = { type: 'MODPACK' as const, extraEnv: { TYPE: 'FABRIC' }, modpackIconUrl: 'https://cdn.modrinth.com/icon.png' };
  expect(containerIcon(server)).toBe(server.modpackIconUrl);
  for (const modpackIconUrl of [null, '', 'broken', 'file:///etc/passwd', 'https://user:password@example.com/icon.png']) {
    expect(containerIcon({ ...server, modpackIconUrl })).toBe(LOADER_ICONS.FABRIC);
  }
  expect(containerIcon({ ...server, type: 'NEOFORGE', extraEnv: {} })).toBe(LOADER_ICONS.NEOFORGE);
});

it('keeps a name with only one remaining ASCII character valid for Docker', () => {
  expect(containerNames({ name: '🔥A', id: 'abc123' })).toEqual(['A-abc123', 'A-abc123']);
});

it('covers every supported loader and provides an unknown-type fallback', () => {
  for (const type of ['VANILLA', 'PAPER', 'PURPUR', 'SPIGOT', 'FABRIC', 'FORGE', 'NEOFORGE', 'QUILT'] as const) {
    expect(containerIcon({ type, extraEnv: {}, modpackIconUrl: null })).toBe(LOADER_ICONS[type]);
  }
  expect(containerIcon({ type: 'MODPACK', extraEnv: {}, modpackIconUrl: null })).toBe(LOADER_ICONS.FORGE);
  expect(containerIcon({ type: 'PAPER', extraEnv: { TYPE: 'CUSTOM' }, modpackIconUrl: null })).toBe(LOADER_ICONS.VANILLA);
});
