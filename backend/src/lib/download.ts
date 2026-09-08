import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { byteLimit } from './byteLimit.js';

export interface DownloadOptions {
  headers?: Record<string, string>;
  onProgress?: (received: number, total: number | null) => void;
  retries?: number;
  maxBytes?: number;
}

/** Lädt eine URL in eine Datei. Legt fehlende Ordner an, räumt bei Fehlern auf. */
export async function downloadToFile(
  url: string,
  destination: string,
  options: DownloadOptions = {},
): Promise<number> {
  const { headers, onProgress, retries = 3 } = options;
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const tempDir = await fsp.mkdtemp(path.join(path.dirname(destination), '.download-'));
  const temporary = path.join(tempDir, 'content');
  let lastError: unknown;
  try {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(120_000) });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} bei ${url}`);
      }
      const total = Number(res.headers.get('content-length')) || null;
      let received = 0;

      const source = Readable.fromWeb(res.body as never);
      source.on('data', (chunk: Buffer) => {
        received += chunk.length;
        onProgress?.(received, total);
      });

      await pipeline(source, byteLimit(options.maxBytes), fs.createWriteStream(temporary));
      await fsp.rename(temporary, destination);
      return received;
    } catch (err) {
      lastError = err;
      await fsp.rm(temporary, { force: true }).catch(() => {});
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

/** JSON-Request mit klarer Fehlermeldung. */
export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  label = 'API',
): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label}: HTTP ${res.status}${body ? ' – ' + body.slice(0, 200) : ''}`);
  }
  return (await res.json()) as T;
}
