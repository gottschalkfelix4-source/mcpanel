import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  root: '',
  log: '',
  settings: new Map<string, string>(),
  fetch: vi.fn(),
}));

vi.mock('../config.js', () => ({
  config: { dockerNetwork: 'net', mcDns: [], mcImageRepo: 'itzg/minecraft-server', mcImage: '' },
  serverDir: (id: string) => path.join(m.root, 'servers', id),
  serverHostDir: (id: string) => `/host/${id}`,
}));
vi.mock('../db.js', () => ({ prisma: {} }));
vi.mock('./settings.js', () => ({
  getSetting: async (key: string, fallback = '') => m.settings.get(key) ?? fallback,
  setSetting: async (key: string, value: string) => {
    if (value) m.settings.set(key, value);
    else m.settings.delete(key);
  },
}));
vi.mock('./docker.js', () => ({
  tailLogs: async () => m.log,
  getState: async () => ({ state: 'error', health: null, startedAt: null }),
  imageForServer: () => 'itzg/minecraft-server:java17',
}));
vi.mock('./notify.js', () => ({ cleanLog: (t: string) => t }));

vi.stubGlobal('fetch', m.fetch);

const { askAssistant, buildContext, chatCompletion, publicAssistantConfig, saveAssistantConfig } =
  await import('./assistant.js');

const server = {
  id: 'srv1', name: 'Fabric Test', type: 'MODPACK', mcVersion: '1.20.1', memoryMb: 6144,
  extraEnv: { TYPE: 'FABRIC', FABRIC_LOADER_VERSION: '0.19.3' },
  modpackName: 'Better MC', modpackVersionName: 'v40', modpackProvider: 'modrinth',
} as unknown as Server;

const cfg = { baseUrl: 'https://ki.example/v1', apiKey: 'sk-geheim-1234', model: 'test-modell' };

function antwort(text: string, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status });
}

beforeAll(async () => {
  m.root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-assistant-'));
  const mods = path.join(m.root, 'servers/srv1/mods');
  await fs.mkdir(mods, { recursive: true });
  await fs.writeFile(path.join(mods, 'sodium.jar'), '');
  await fs.writeFile(path.join(mods, 'missingmodschecker.jar.disabled'), '');
});
afterAll(() => fs.rm(m.root, { recursive: true, force: true }));
afterEach(() => {
  m.fetch.mockReset();
  m.settings.clear();
});

describe('buildContext', () => {
  it('packt Serverdaten, Modliste und Protokoll in eine Nachricht', async () => {
    m.log = '[12:00:00] [main/ERROR]: Kaputt\njava.lang.RuntimeException: boom';
    const text = await buildContext(server);
    expect(text).toContain('Minecraft: 1.20.1 · Loader: FABRIC 0.19.3');
    expect(text).toContain('Modpack: Better MC – v40 (modrinth)');
    expect(text).toContain('missingmodschecker.jar.disabled');
    expect(text).toContain('sodium.jar');
    expect(text).toContain('java.lang.RuntimeException: boom');
  });

  it('kappt ein ausuferndes Protokoll am Anfang, nicht am Ende', async () => {
    m.log = 'ANFANG\n' + 'x'.repeat(40_000) + '\nENDE-WICHTIG';
    const text = await buildContext(server);
    expect(text).not.toContain('ANFANG');
    expect(text).toContain('ENDE-WICHTIG');
    expect(text).toContain('[…]');
  });
});

describe('chatCompletion', () => {
  it('spricht die OpenAI-kompatible Schnittstelle mit Bearer-Key an', async () => {
    m.fetch.mockResolvedValueOnce(antwort('Hallo'));
    const text = await chatCompletion(cfg, [{ role: 'user', content: 'Hi' }]);
    expect(text).toBe('Hallo');

    const [url, init] = m.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ki.example/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-geheim-1234');
    expect(JSON.parse(String(init.body)).model).toBe('test-modell');
  });

  it('kommt ohne Key aus – lokale Dienste haben keinen', async () => {
    m.fetch.mockResolvedValueOnce(antwort('OK'));
    await chatCompletion({ ...cfg, apiKey: '' }, [{ role: 'user', content: 'Hi' }]);
    const [, init] = m.fetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('erklaert einen abgelehnten Key auf Deutsch', async () => {
    m.fetch.mockResolvedValueOnce(new Response('{"error":{"message":"bad key"}}', { status: 401 }));
    await expect(chatCompletion(cfg, [])).rejects.toThrow('API-Key abgelehnt');
  });

  it('weist bei 404 auf Adresse und Modellname hin', async () => {
    m.fetch.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    await expect(chatCompletion(cfg, [])).rejects.toThrow(/test-modell.*\/v1/s);
  });

  it('meldet einen unerreichbaren Dienst statt eines rohen Fehlers', async () => {
    m.fetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(chatCompletion(cfg, [])).rejects.toThrow('nicht erreichbar');
  });

  it('verweigert den Aufruf ohne Einrichtung', async () => {
    await expect(chatCompletion({ baseUrl: '', apiKey: '', model: '' }, [])).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(m.fetch).not.toHaveBeenCalled();
  });
});

describe('askAssistant', () => {
  it('haengt den Verlauf hinter den Kontext und die neue Frage ans Ende', async () => {
    await saveAssistantConfig(cfg);
    m.log = 'irgendwas';
    m.fetch.mockResolvedValueOnce(antwort('Zweite Antwort'));

    const res = await askAssistant(server, 'Und jetzt?', [
      { role: 'assistant', content: 'Erste Antwort' },
    ]);
    expect(res).toEqual({ answer: 'Zweite Antwort', model: 'test-modell' });

    const body = JSON.parse(String((m.fetch.mock.calls[0] as [string, RequestInit])[1].body));
    const rollen = body.messages.map((x: { role: string }) => x.role);
    expect(rollen).toEqual(['system', 'user', 'assistant', 'user']);
    expect(body.messages.at(-1).content).toBe('Und jetzt?');
    expect(body.messages[1].content).toContain('## Protokoll');
  });
});

describe('publicAssistantConfig', () => {
  it('gibt den Key nie heraus, nur eine Maske', () => {
    const pub = publicAssistantConfig(cfg);
    expect(JSON.stringify(pub)).not.toContain('sk-geheim-1234');
    expect(pub.masked).toBe('sk-geh…1234');
    expect(pub.configured).toBe(true);
  });
});

describe('Anthropic', () => {
  const anthropic = {
    provider: 'anthropic' as const, baseUrl: '', apiKey: 'sk-ant-geheim-9876', model: 'claude-opus-5-5',
  };

  function nachricht(text: string, stop_reason = 'end_turn') {
    return new Response(
      JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: anthropic.model,
        content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text }],
        stop_reason, stop_details: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  function anfrage() {
    const [url, init] = m.fetch.mock.calls[0] as [string, RequestInit];
    // Das SDK schickt ein Headers-Objekt, kein einfaches Record.
    const headers = init.headers as Headers;
    return { url: String(url).split('?')[0], headers, body: init.body ? JSON.parse(String(init.body)) : null };
  }

  it('gilt mit Key und Modell als eingerichtet – ohne Adresse', () => {
    expect(publicAssistantConfig(anthropic)).toMatchObject({ configured: true, provider: 'anthropic' });
    expect(publicAssistantConfig({ ...anthropic, apiKey: '' }).configured).toBe(false);
  });

  it('spricht die Messages-API mit dem hinterlegten Key an und zieht den Systemprompt heraus', async () => {
    m.fetch.mockResolvedValueOnce(nachricht('Ursache: Sodium'));
    const text = await chatCompletion(anthropic, [
      { role: 'system', content: 'Du bist ein Assistent.' },
      { role: 'user', content: 'Warum?' },
    ]);
    expect(text).toBe('Ursache: Sodium');

    const { url, headers, body } = anfrage();
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(headers.get('authorization')).toBe('Bearer sk-ant-geheim-9876');
    expect(headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(body.system).toBe('Du bist ein Assistent.');
    expect(body.messages).toEqual([{ role: 'user', content: 'Warum?' }]);
    expect(body.fallbacks).toBe('default');
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.temperature).toBeUndefined();
  });

  it('nimmt eine eigene Adresse und verdoppelt /v1 nicht', async () => {
    m.fetch.mockResolvedValueOnce(nachricht('OK'));
    await chatCompletion({ ...anthropic, baseUrl: 'https://proxy.example/v1/', model: 'claude-haiku-5-5' }, [
      { role: 'user', content: 'Hi' },
    ]);
    const { url, body } = anfrage();
    expect(url).toBe('https://proxy.example/v1/messages');
    // Haiku kennt den serverseitigen Fallback nicht.
    expect(body.fallbacks).toBeUndefined();
  });

  it('erklaert einen abgelehnten Key auf Deutsch', async () => {
    m.fetch.mockResolvedValueOnce(
      new Response('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', {
        status: 401, headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(chatCompletion(anthropic, [{ role: 'user', content: 'Hi' }])).rejects.toThrow(
      'API-Key abgelehnt',
    );
  });

  it('meldet eine Ablehnung durch Claude statt einer leeren Antwort', async () => {
    m.fetch.mockResolvedValueOnce(nachricht('', 'refusal'));
    await expect(chatCompletion(anthropic, [{ role: 'user', content: 'Hi' }])).rejects.toThrow('abgelehnt');
  });

  it('prueft beim Speichern nur Key und Modell, ohne Antwort zu erzeugen', async () => {
    m.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const { testAssistant } = await import('./assistant.js');
    await expect(testAssistant(anthropic)).resolves.toBe('Claude Opus 5.5');
    expect(anfrage().url).toBe('https://api.anthropic.com/v1/models/claude-opus-5-5');
  });

  it('speichert den Anbieter und liest ihn wieder', async () => {
    await saveAssistantConfig(anthropic);
    const { getAssistantConfig } = await import('./assistant.js');
    expect(await getAssistantConfig()).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5' });
  });
});
