import { beforeEach, describe, expect, it, vi } from 'vitest';

const { values, upsert } = vi.hoisted(() => ({
  values: new Map<string, string>(),
  upsert: vi.fn(),
}));
vi.mock('../db.js', () => ({ prisma: { setting: {
  findUnique: vi.fn(async ({ where }: { where: { key: string } }) =>
    values.has(where.key) ? { value: values.get(where.key) } : null),
  upsert,
} } }));
vi.mock('../config.js', () => ({ config: { sftp: { host: '192.168.188.129' } } }));

import { getPanelUrl, getSftpHost, panelUrlSchema, setSetting } from './settings.js';

beforeEach(async () => {
  values.clear();
  upsert.mockImplementation(async ({ create }: { create: { key: string; value: string } }) => {
    values.set(create.key, create.value);
  });
  await setSetting('panel.url', '');
  upsert.mockClear();
});

describe('Externe Panel-URL und SFTP-Adresse', () => {
  it('normalisiert die Webadresse und verwendet die Domain vor der lokalen SFTP-Adresse', async () => {
    const url = panelUrlSchema.parse('  https://PANEL.example.de:8443/panel/  ');
    await setSetting('panel.url', url);
    expect(await getPanelUrl()).toBe('https://panel.example.de:8443/panel');
    expect(await getSftpHost()).toBe('panel.example.de');
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: { key: 'panel.url', value: url },
    }));
  });

  it('setzt den zwischengespeicherten Host sofort auf die bisherige Adresse zurück', async () => {
    await setSetting('panel.url', 'http://panel.example.de');
    expect(await getSftpHost()).toBe('panel.example.de');
    await setSetting('panel.url', panelUrlSchema.parse('  '));
    expect(await getPanelUrl()).toBe('');
    expect(await getSftpHost()).toBe('192.168.188.129');
  });

  it('trennt bei IPv6 den SFTP-Host vom Webport', async () => {
    await setSetting('panel.url', panelUrlSchema.parse('http://[2001:db8::1]:8080'));
    expect(await getSftpHost()).toBe('[2001:db8::1]');
  });

  it.each([
    'panel.example.de', 'sftp://panel.example.de', 'javascript:alert(1)',
    'https://name:geheim@panel.example.de', 'https://name@panel.example.de',
    'https://panel.example.de/?token=geheim', 'https://panel.example.de/#token',
    'https://', 'http:panel.example.de', 'https://' + 'a'.repeat(2048),
  ])('weist eine ungeeignete oder vertrauliche Adresse ab: %s', (url) => {
    expect(panelUrlSchema.safeParse(url).success).toBe(false);
  });
});
