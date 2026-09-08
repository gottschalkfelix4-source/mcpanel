import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { byteLimit } from './byteLimit.js';

export interface DownloadOptions {
  headers?: Record<string, string>;
  onProgress?: (received: number, total: number | null) => void;
  retries?: number;
  maxBytes?: number;
  /** Timeout for response headers, independent of the size of the download. */
  headersTimeoutMs?: number;
  /** Maximum time without pipeline progress; active transfers have no total deadline. */
  stallTimeoutMs?: number;
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
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = (ms: number, message: string) => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new Error(message)), ms);
        timer.unref();
      };
      try {
        arm(options.headersTimeoutMs ?? 30_000, 'Download-Server antwortet nicht rechtzeitig');
        const res = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
        if (!res.ok || !res.body) {
          await res.body?.cancel();
          throw new Error(`HTTP ${res.status} bei ${url}`);
        }
        const total = Number(res.headers.get('content-length')) || null;
        let received = 0;
        const progress = () => arm(options.stallTimeoutMs ?? 300_000, 'Download ohne Fortschritt: Netzwerk oder Datenträger antwortet nicht');
        progress();
        const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          progress();
          onProgress?.(received, total);
          callback(null, chunk);
        } });
        await pipeline(
          Readable.fromWeb(res.body as never), byteLimit(options.maxBytes), meter,
          fs.createWriteStream(temporary, { highWaterMark: 1024 * 1024 }),
          { signal: controller.signal },
        );
        clearTimeout(timer);
        await fsp.rename(temporary, destination);
        return received;
      } catch (err) {
        lastError = controller.signal.aborted ? controller.signal.reason : err;
        await fsp.rm(temporary, { force: true }).catch(() => {});
        if ((err as { statusCode?: number }).statusCode === 400) throw err;
        if (attempt < retries) await new Promise(r => setTimeout(r, 500 * attempt));
      } finally {
        clearTimeout(timer);
        controller.abort();
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
