import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';

/**
 * Anbindung des KI-Assistenten direkt an die Anthropic-API (Claude) – über
 * das offizielle SDK statt über eine OpenAI-kompatible Zwischenschicht.
 *
 * Die Nachrichtenform ist dieselbe wie im OpenAI-Pfad (system/user/assistant);
 * die Systemnachricht wandert hier in das eigene `system`-Feld.
 */

export const ANTHROPIC_STANDARD_MODELL = 'claude-opus-5-5';

/** Antwortzeit, bevor wir aufgeben – wie beim OpenAI-Pfad. */
const TIMEOUT_MS = 120_000;
/**
 * Großzügig, weil bei aktuellen Modellen das Nachdenken mitzählt. Ein zu
 * knappes Limit schneidet die Antwort mitten im Satz ab.
 */
const MAX_TOKENS = 16_000;

/**
 * Modelle, bei denen Anthropic eine abgelehnte Anfrage serverseitig an ein
 * anderes Modell weiterreicht. Andere Modelle kennen den Parameter nicht.
 */
const MIT_FALLBACK = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export interface AnthropicConfig {
  /** Leer = offizielle Adresse https://api.anthropic.com. */
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface Nachricht {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const OFFIZIELLE_ADRESSE = 'https://api.anthropic.com';

/**
 * Das SDK hängt selbst /v1/messages an – ein mitkopiertes /v1 würde doppelt.
 * Leer heißt ausdrücklich die offizielle Adresse, damit ein zufällig gesetztes
 * ANTHROPIC_BASE_URL im Container den Key nicht anderswohin schickt.
 */
export function anthropicBaseUrl(baseUrl: string): string {
  const url = baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  return url || OFFIZIELLE_ADRESSE;
}

function client(cfg: AnthropicConfig): Anthropic {
  return new Anthropic({
    // Ausdrücklich gesetzt – dann liest das SDK keine Zugangsdaten aus der
    // Umgebung oder aus Profilen. Es schickt ihn als Authorization: Bearer.
    apiKey: cfg.apiKey,
    baseURL: anthropicBaseUrl(cfg.baseUrl),
    timeout: TIMEOUT_MS,
    // Ein Wiederholungsversuch reicht – der Nutzer wartet im Dialog.
    maxRetries: 1,
  });
}

/** SDK-Fehler in einen verständlichen deutschen Satz übersetzen. */
function uebersetze(err: unknown, model: string): Error {
  // APIConnectionTimeoutError erbt von APIConnectionError, das von APIError –
  // deshalb von speziell nach allgemein prüfen.
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new Error('Anthropic hat nicht rechtzeitig geantwortet (2 Minuten).');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new Error(`Anthropic ist nicht erreichbar: ${err.message}`);
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new Error(`Anthropic hat den API-Key abgelehnt (HTTP ${err.status}).`);
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new Error(
      `Anthropic kennt das Modell "${model}" nicht (HTTP 404). ` +
        `Gültig ist z. B. ${ANTHROPIC_STANDARD_MODELL}.`,
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new Error('Anthropic bremst: zu viele Anfragen in kurzer Zeit (HTTP 429).');
  }
  if (err instanceof Anthropic.APIError) {
    if (err.status === 402) {
      return new Error('Anthropic meldet: kein Guthaben mehr auf dem Konto (HTTP 402).');
    }
    if (err.status === 529) {
      return new Error('Anthropic ist gerade überlastet (HTTP 529). Bitte gleich noch einmal versuchen.');
    }
    return new Error(`Anthropic meldet HTTP ${err.status ?? '?'}: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** Ein Gesprächsaufruf an die Messages-API. */
export async function anthropicCompletion(cfg: AnthropicConfig, messages: Nachricht[]): Promise<string> {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const verlauf: BetaMessageParam[] = messages
    .filter((m): m is Nachricht & { role: 'user' | 'assistant' } => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));

  const fallback = MIT_FALLBACK.has(cfg.model);

  let res: Anthropic.Beta.BetaMessage;
  try {
    res = await client(cfg).beta.messages.create({
      model: cfg.model,
      max_tokens: MAX_TOKENS,
      ...(system ? { system } : {}),
      messages: verlauf,
      // Systemprompt + Serverkontext bleiben bei Nachfragen gleich – Anthropic
      // berechnet den wiederholten Anfang dann nur zu einem Bruchteil.
      cache_control: { type: 'ephemeral' },
      ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    });
  } catch (err) {
    throw uebersetze(err, cfg.model);
  }

  if (res.stop_reason === 'refusal') {
    throw new Error('Claude hat die Anfrage abgelehnt. Bitte die Frage anders formulieren.');
  }

  const antwort = res.content
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('')
    .trim();
  if (!antwort) throw new Error('Anthropic hat eine leere Antwort geschickt.');
  return antwort;
}

/**
 * Prüft Key und Modell, ohne eine Antwort erzeugen zu lassen – das kostet
 * nichts und schlägt bei falschem Key (401) oder Modell (404) genauso fehl.
 */
export async function testAnthropic(cfg: AnthropicConfig): Promise<string> {
  try {
    const info = await client(cfg).models.retrieve(cfg.model);
    return info.display_name || info.id;
  } catch (err) {
    throw uebersetze(err, cfg.model);
  }
}
