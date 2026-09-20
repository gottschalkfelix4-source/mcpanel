import fs from 'node:fs/promises';
import type { Server } from '@prisma/client';
import { badRequest } from '../lib/errors.js';
import { contentDir, serverLoader } from './content.js';
import { analyseCrash } from './crashAnalysis.js';
import * as dockerSvc from './docker.js';
import { cleanLog } from './notify.js';
import { getSetting, setSetting } from './settings.js';

/**
 * KI-Assistent für Absturzprotokolle.
 *
 * Angebunden wird ein beliebiger Dienst mit OpenAI-kompatibler
 * `chat/completions`-Schnittstelle – OpenRouter, OpenAI selbst, ein lokales
 * Ollama oder vLLM. Das Panel schickt Protokoll und Serverdaten hin und zeigt
 * die Antwort; mehr Rechte hat der Assistent nicht. Was er vorschlägt, führt
 * der Nutzer selbst aus – der Schalter zum Abschalten einer Mod steht direkt
 * daneben im Absturz-Dialog.
 */

export interface AssistantConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Zeilen vom Ende des Protokolls, die der Assistent zu sehen bekommt. */
const LOG_ZEILEN = 400;
/** Obergrenze fürs Protokoll in Zeichen – bei kleinen Kontextfenstern zählt jedes Token. */
const LOG_ZEICHEN = 28_000;
/** Mehr Mod-Namen helfen nicht, sie verdrängen nur das Protokoll. */
const MODS_MAX = 250;
/** Antwortzeit, bevor wir aufgeben – große Modelle brauchen für ein langes Protokoll gern eine Minute. */
const TIMEOUT_MS = 120_000;

const SCHLUESSEL = {
  baseUrl: 'assistant.baseUrl',
  apiKey: 'assistant.apiKey',
  model: 'assistant.model',
} as const;

export async function getAssistantConfig(): Promise<AssistantConfig> {
  return {
    baseUrl: (await getSetting(SCHLUESSEL.baseUrl, '')).replace(/\/+$/, ''),
    apiKey: await getSetting(SCHLUESSEL.apiKey, ''),
    model: await getSetting(SCHLUESSEL.model, ''),
  };
}

export async function saveAssistantConfig(next: AssistantConfig): Promise<void> {
  await setSetting(SCHLUESSEL.baseUrl, next.baseUrl.trim().replace(/\/+$/, ''));
  await setSetting(SCHLUESSEL.apiKey, next.apiKey.trim());
  await setSetting(SCHLUESSEL.model, next.model.trim());
}

/** Adresse und Modell sind Pflicht; ein Key nicht – lokale Dienste haben keinen. */
export function isConfigured(cfg: AssistantConfig): boolean {
  return Boolean(cfg.baseUrl && cfg.model);
}

/** Was die Oberfläche sehen darf: alles außer dem Key selbst. */
export function publicAssistantConfig(cfg: AssistantConfig) {
  return {
    configured: isConfigured(cfg),
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    hasKey: Boolean(cfg.apiKey),
    masked: cfg.apiKey ? `${cfg.apiKey.slice(0, 6)}…${cfg.apiKey.slice(-4)}` : null,
  };
}

// ---------------------------------------------------------------------------
// Aufruf des Dienstes
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatResponse {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string } | string;
}

/**
 * Ein `chat/completions`-Aufruf. Fehler kommen als verständlicher deutscher
 * Satz zurück – der Nutzer sieht sie in einem Dialog, nicht in einem Log.
 */
export async function chatCompletion(
  cfg: AssistantConfig,
  messages: ChatMessage[],
  opts: { maxTokens?: number } = {},
): Promise<string> {
  if (!isConfigured(cfg)) {
    throw badRequest('Der KI-Assistent ist nicht eingerichtet. Ein Administrator kann ihn unter Panel-Einstellungen anbinden.');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // OpenRouter ordnet Anfragen damit einer App zu; andere Dienste ignorieren es.
    'HTTP-Referer': 'https://github.com/gottschalkfelix4-source/mcpanel',
    'X-Title': 'MCPanel',
  };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: 0.2,
        max_tokens: opts.maxTokens ?? 1500,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const grund = err instanceof Error ? err.message : String(err);
    if (/abort|timeout/i.test(grund)) {
      throw new Error('Der KI-Dienst hat nicht rechtzeitig geantwortet (2 Minuten).');
    }
    throw new Error(`Der KI-Dienst ist nicht erreichbar: ${grund}`);
  }

  const text = await res.text();
  let data: ChatResponse = {};
  try {
    data = JSON.parse(text) as ChatResponse;
  } catch {
    /* kein JSON – der Text landet unten in der Fehlermeldung */
  }

  if (!res.ok) {
    const detail =
      typeof data.error === 'string' ? data.error : data.error?.message ?? text.slice(0, 200);
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Der KI-Dienst hat den API-Key abgelehnt (HTTP ${res.status}).`);
    }
    if (res.status === 404) {
      throw new Error(
        `Der KI-Dienst kennt den Pfad oder das Modell "${cfg.model}" nicht (HTTP 404). ` +
          'Die Adresse muss auf /v1 enden und das Modell so heißen, wie der Anbieter es listet.',
      );
    }
    if (res.status === 429) {
      throw new Error('Der KI-Dienst bremst: zu viele Anfragen oder kein Guthaben mehr (HTTP 429).');
    }
    throw new Error(`Der KI-Dienst meldet HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  const antwort = data.choices?.[0]?.message?.content?.trim();
  if (!antwort) throw new Error('Der KI-Dienst hat eine leere Antwort geschickt.');
  return antwort;
}

/** Kurzer Aufruf, um Adresse, Key und Modell beim Speichern zu prüfen. */
export async function testAssistant(cfg: AssistantConfig): Promise<string> {
  return chatCompletion(
    cfg,
    [{ role: 'user', content: 'Antworte mit genau einem Wort: OK' }],
    { maxTokens: 20 },
  );
}

// ---------------------------------------------------------------------------
// Kontext für die Frage
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Du bist der Absturz-Assistent von MCPanel, einem Web-Panel für Minecraft-Server. Die Server laufen als Docker-Container mit dem Abbild itzg/minecraft-server; der Nutzer verwaltet Mods, Konfiguration und Start über das Panel, nicht über eine Shell.

Deine Aufgabe: Aus dem Protokoll herausfinden, warum der Server nicht läuft, und dem Nutzer sagen, was er als Nächstes tun soll.

Regeln:
- Antworte auf Deutsch, du-Form, knapp und konkret.
- Nenne zuerst die eigentliche Ursache in ein bis zwei Sätzen. Dann die Schritte zur Behebung als kurze Liste.
- Nenne Mods immer beim Dateinamen aus der Modliste, damit der Nutzer sie im Reiter "Mods" findet.
- Unterscheide echte Absturzursachen von harmlosem Rauschen: "Error loading class" bei Mixins, fehlende Refmaps, "No data fixer registered" und abgefangene Konfigurationsfehler (etwa SpectreLib/NightConfig "Unimplemented method 'toArray'") sind normalerweise keine Ursache. Sag dem Nutzer, wenn die Zeile, nach der er fragt, nur Rauschen ist.
- Ein Server hat keine Grafikausgabe: HeadlessException, LWJGL/OpenGL, "environment type SERVER" heißen "Client-Mod auf dem Server".
- Wenn Abhängigkeiten fehlen ("requires ... which is missing"), nenne die fehlende Mod und dass sie im Reiter "Mods" nachinstalliert werden kann.
- Wenn das Protokoll keine Ursache zeigt, sag das offen und frage nach dem, was fehlt.
- Schreibe schlichten Text: Absätze, Listen mit "- ", keine Tabellen, keine Überschriften, kein Code außer Dateinamen.`;

/** Alles, was der Assistent über den Server wissen muss, in einer Nachricht. */
export async function buildContext(server: Server): Promise<string> {
  const roh = await dockerSvc.tailLogs(server, LOG_ZEILEN).catch(() => '');
  let log = cleanLog(roh).trim();
  if (log.length > LOG_ZEICHEN) log = '[…]\n' + log.slice(-LOG_ZEICHEN);

  const dir = contentDir(server);
  const dateien = dir ? await fs.readdir(dir).catch(() => [] as string[]) : [];
  const jars = dateien.filter((f) => /\.jar(\.disabled)?$/i.test(f)).sort();
  const diagnose = dir ? analyseCrash(roh, dateien, dir) : null;

  const { state } = await dockerSvc.getState(server);
  const extra = (server.extraEnv ?? {}) as Record<string, string>;

  const teile = [
    '## Server',
    `Name: ${server.name}`,
    `Zustand: ${state}`,
    `Minecraft: ${server.mcVersion} · Loader: ${serverLoader(server)}` +
      (extra.FORGE_VERSION ? ` ${extra.FORGE_VERSION}` : '') +
      (extra.NEOFORGE_VERSION ? ` ${extra.NEOFORGE_VERSION}` : '') +
      (extra.FABRIC_LOADER_VERSION ? ` ${extra.FABRIC_LOADER_VERSION}` : '') +
      (extra.QUILT_LOADER_VERSION ? ` ${extra.QUILT_LOADER_VERSION}` : ''),
    `Java-Abbild: ${dockerSvc.imageForServer(server)}`,
    `Arbeitsspeicher (Heap): ${server.memoryMb} MB`,
    server.modpackName
      ? `Modpack: ${server.modpackName} – ${server.modpackVersionName ?? ''} (${server.modpackProvider})`
      : 'Modpack: keines',
  ];

  if (diagnose) {
    teile.push(
      '',
      '## Einschätzung des Panels (regelbasiert, kann irren)',
      diagnose.headline,
      diagnose.reason,
      diagnose.suspect
        ? `Verdächtige Datei: ${diagnose.suspect.filename ?? diagnose.suspect.reference}` +
            (diagnose.suspect.enabled ? '' : ' (bereits deaktiviert)')
        : 'Keine einzelne Datei benannt.',
    );
  }

  if (jars.length > 0) {
    const liste = jars.slice(0, MODS_MAX);
    teile.push(
      '',
      `## Dateien im Ordner ${dir ? dir.split(/[\\/]/).pop() : 'mods'} (${jars.length}${jars.length > MODS_MAX ? `, gezeigt ${MODS_MAX}` : ''}; ".disabled" = abgeschaltet)`,
      ...liste,
    );
  }

  teile.push('', `## Protokoll (letzte ${LOG_ZEILEN} Zeilen)`, log || '(leer – der Container hat noch nichts ausgegeben)');

  return teile.join('\n');
}

/**
 * Eine Runde Gespräch. Ohne Frage bittet das Panel um die Absturzanalyse;
 * mit Verlauf bleibt der Kontext derselbe und die Frage schließt an.
 */
export async function askAssistant(
  server: Server,
  question: string | null,
  history: AssistantMessage[],
): Promise<{ answer: string; model: string }> {
  const cfg = await getAssistantConfig();
  if (!isConfigured(cfg)) {
    throw badRequest('Der KI-Assistent ist nicht eingerichtet. Ein Administrator kann ihn unter Panel-Einstellungen anbinden.');
  }

  const kontext = await buildContext(server);
  const auftrag =
    question?.trim() ||
    'Warum läuft dieser Server nicht bzw. was ist das Problem im Protokoll, und was soll ich tun?';

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `${kontext}\n\n## Frage\n${history.length ? 'Siehe Verlauf.' : auftrag}` },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];
  if (history.length) messages.push({ role: 'user', content: auftrag });

  const answer = await chatCompletion(cfg, messages);
  return { answer, model: cfg.model };
}
