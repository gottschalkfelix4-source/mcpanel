import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ prisma: {} }));
vi.mock('../config.js', () => ({ serverDir: () => '/x' }));

const { STORAGE_SHIM, injectStorageShim, isDocumentPath } = await import('./bluemapProxy.js');

function windowWith(storage: 'wirft' | 'geht') {
  const echt = { echt: true };
  const window: Record<string, unknown> = {};
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(window, name, {
      configurable: true,
      get() {
        if (storage === 'wirft') throw new Error('SecurityError: The document is sandboxed');
        return echt;
      },
    });
  }
  vm.runInNewContext(STORAGE_SHIM, { window, Map, Array, String, Object });
  return { window, echt };
}

it('ersetzt einen Speicher, der in der Sandbox wirft, durch einen im Arbeitsspeicher', () => {
  const { window } = windowWith('wirft');
  const store = window.localStorage as Storage;
  expect(store.getItem('fehlt')).toBeNull();
  store.setItem('bluemap-settings', '{"a":1}');
  expect(store.getItem('bluemap-settings')).toBe('{"a":1}');
  expect(store.length).toBe(1);
  expect(store.key(0)).toBe('bluemap-settings');
  expect(store.key(5)).toBeNull();
  store.removeItem('bluemap-settings');
  expect(store.length).toBe(0);
  expect(window.sessionStorage).not.toBe(store);
});

it('lässt einen funktionierenden Speicher unangetastet', () => {
  const { window, echt } = windowWith('geht');
  expect(window.localStorage).toBe(echt);
});

it('erkennt Dokumentpfade', () => {
  expect(isDocumentPath('/')).toBe(true);
  expect(isDocumentPath('/index.html?x=1')).toBe(true);
  expect(isDocumentPath('/assets/index.js')).toBe(false);
  expect(isDocumentPath('/maps/world/settings.json')).toBe(false);
});

it('setzt das Skript ohne <head> an den Anfang', () => {
  expect(injectStorageShim('<p>x</p>')).toBe(`<script>${STORAGE_SHIM}</script><p>x</p>`);
});
