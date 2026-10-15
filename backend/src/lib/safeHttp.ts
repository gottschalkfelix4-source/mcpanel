import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { isPublicAddress, normalizeAddress } from './network.js';

/**
 * Ausgehende Webhooks. Ziel und tatsächlich verbundene Adresse werden
 * gemeinsam geprüft: die Namensauflösung läuft über einen eigenen `lookup`,
 * der jede Antwort verwirft, die ins lokale Netz zeigt – so kann ein Name nicht
 * erst öffentlich und beim Verbinden privat auflösen (DNS-Rebinding).
 * Weiterleitungen werden nicht verfolgt.
 */

export interface PostOptions {
  /** Ziele im lokalen Netz zulassen (nur von Administratoren gesetzt). */
  allowPrivate?: boolean;
  timeoutMs?: number;
}

export class BlockedTargetError extends Error {}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

function guardedLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    const list = (addresses as dns.LookupAddress[]).filter((entry) => isPublicAddress(entry.address));
    if (!list.length) {
      return callback(new BlockedTargetError(`Ziel ${hostname} liegt im lokalen Netz und ist nicht freigegeben`), '');
    }
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

/** Wirft, wenn die URL nicht erlaubt ist. Prüft wörtliche IP-Adressen sofort. */
export function assertWebhookUrl(target: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new BlockedTargetError('Die Ziel-URL ist ungültig');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BlockedTargetError('Nur http- und https-Adressen sind erlaubt');
  }
  if (allowPrivate) return url;
  const host = normalizeAddress(url.hostname);
  if (net.isIP(host) && !isPublicAddress(host)) {
    throw new BlockedTargetError('Adressen im lokalen Netz sind nur für Administratoren erlaubt');
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new BlockedTargetError('Adressen im lokalen Netz sind nur für Administratoren erlaubt');
  }
  return url;
}

/** POST mit JSON-Körper. Antwortinhalt wird nie zurückgegeben, nur der Status. */
export function postJson(target: string, body: unknown, options: PostOptions = {}): Promise<number> {
  const allowPrivate = options.allowPrivate ?? false;
  const url = assertWebhookUrl(target, allowPrivate);
  const payload = Buffer.from(JSON.stringify(body));
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, 'User-Agent': 'MCPanel' },
      lookup: allowPrivate ? undefined : (guardedLookup as unknown as net.LookupFunction),
      timeout: options.timeoutMs ?? 8000,
    }, (res) => {
      res.resume();
      const status = res.statusCode ?? 0;
      res.on('end', () => {
        if (status >= 200 && status < 300) resolve(status);
        else if (status >= 300 && status < 400) reject(new Error(`HTTP ${status} – Weiterleitungen werden nicht verfolgt`));
        else reject(new Error(`HTTP ${status}`));
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung beim Zustellen')));
    req.on('error', (err) => reject(err instanceof BlockedTargetError ? err : new Error(`Zustellung fehlgeschlagen: ${(err as NodeJS.ErrnoException).code ?? err.message}`)));
    req.end(payload);
  });
}
