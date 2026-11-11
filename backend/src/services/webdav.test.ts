import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { deleteFile, getFile, parseQuota, probe, putFile, putStream, webdavBase, type WebdavConfig } from './webdav.js';

/** Kleiner WebDAV-Server im Arbeitsspeicher – genug für die genutzten Methoden. */
const dav = {
  files: new Map<string, Buffer>(),
  dirs: new Set<string>(['/dav/']),
  log: [] as string[],
  auth: '',
  failPutWith: 0,
  quota: '1234567' as string | null,
};
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const p = decodeURIComponent(new URL(req.url!, 'http://x').pathname);
      dav.log.push(`${req.method} ${p}`);
      if (req.headers.authorization !== dav.auth) { res.writeHead(401).end(); return; }
      const parent = p.replace(/[^/]+\/?$/, '');
      switch (req.method) {
        case 'MKCOL':
          if (dav.dirs.has(p)) { res.writeHead(405).end(); return; }
          if (!dav.dirs.has(parent)) { res.writeHead(409).end(); return; }
          dav.dirs.add(p.endsWith('/') ? p : `${p}/`);
          res.writeHead(201).end();
          return;
        case 'PUT':
          if (dav.failPutWith) { res.writeHead(dav.failPutWith).end(); return; }
          if (!dav.dirs.has(parent)) { res.writeHead(409).end(); return; }
          dav.files.set(p, Buffer.concat(chunks));
          res.writeHead(201).end();
          return;
        case 'MOVE': {
          const to = decodeURIComponent(new URL(String(req.headers.destination)).pathname);
          const data = dav.files.get(p);
          if (!data) { res.writeHead(404).end(); return; }
          dav.files.delete(p);
          dav.files.set(to, data);
          res.writeHead(201).end();
          return;
        }
        case 'GET': {
          const data = dav.files.get(p);
          if (!data) { res.writeHead(404).end(); return; }
          res.writeHead(200).end(data);
          return;
        }
        case 'DELETE':
          res.writeHead(dav.files.delete(p) ? 204 : 404).end();
          return;
        case 'PROPFIND':
          if (!dav.dirs.has(p.endsWith('/') ? p : `${p}/`)) { res.writeHead(404).end(); return; }
          res.writeHead(207, { 'Content-Type': 'application/xml' }).end(
            `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop>${dav.quota === null ? '' : `<d:quota-available-bytes>${dav.quota}</d:quota-available-bytes>`}</d:prop></d:propstat></d:response></d:multistatus>`,
          );
          return;
        default:
          res.writeHead(405).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  dav.files.clear();
  dav.dirs = new Set(['/dav/']);
  dav.log = [];
  dav.auth = `Basic ${Buffer.from('anna:geheim').toString('base64')}`;
  dav.failPutWith = 0;
  dav.quota = '1234567';
});

const config = (over: Partial<WebdavConfig> = {}): WebdavConfig => ({ url: `${base}/dav/Sicherungen`, username: 'anna', password: 'geheim', ...over });

async function tempFile(content: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-webdav-'));
  const file = path.join(dir, 'archiv.zip');
  await fs.writeFile(file, content);
  return { dir, file };
}

it('lädt hoch, holt zurück und löscht – mit Zwischenname und MOVE', async () => {
  const { dir, file } = await tempFile('weltdaten');
  const progress: number[] = [];
  await fs.mkdir(dir, { recursive: true });
  dav.dirs.add('/dav/Sicherungen/');
  await putFile(config(), ['srv1'], 'backup 1.zip', file, (p) => progress.push(p));

  expect([...dav.files.keys()]).toEqual(['/dav/Sicherungen/srv1/backup 1.zip']);
  expect(dav.log.find((l) => l.startsWith('PUT'))).toMatch(/^PUT \/dav\/Sicherungen\/srv1\/mcpanel-upload-.+\.tmp$/);
  expect(progress.at(-1)).toBe(100);

  const back = path.join(dir, 'zurueck');
  expect(await getFile(config(), ['srv1', 'backup 1.zip'], back)).toBe(true);
  expect(await fs.readFile(back, 'utf8')).toBe('weltdaten');
  expect(await getFile(config(), ['srv1', 'fehlt.zip'], back)).toBe(false);

  await deleteFile(config(), ['srv1', 'backup 1.zip']);
  await deleteFile(config(), ['srv1', 'backup 1.zip']);
  expect(dav.files.size).toBe(0);
  await fs.rm(dir, { recursive: true, force: true });
});

it('räumt den Zwischennamen weg, wenn der Upload scheitert', async () => {
  const { dir, file } = await tempFile('x');
  dav.dirs.add('/dav/Sicherungen/');
  dav.failPutWith = 507;
  await expect(putFile(config(), ['srv1'], 'a.zip', file)).rejects.toThrow('Kein Platz mehr');
  expect(dav.log.some((l) => /^DELETE .*mcpanel-upload-/.test(l))).toBe(true);
  expect(dav.files.size).toBe(0);
  await fs.rm(dir, { recursive: true, force: true });
});

it('Verbindungstest legt den Ordner an, schreibt probeweise und liest den freien Platz', async () => {
  expect(await probe(config())).toEqual({ freeBytes: 1234567 });
  expect(dav.dirs.has('/dav/Sicherungen/')).toBe(true);
  expect(dav.files.size).toBe(0);
  dav.quota = '-3';
  expect(await probe(config())).toEqual({ freeBytes: null });
});

it('übersetzt abgelehnte Zugangsdaten und nicht erreichbare Server', async () => {
  await expect(probe(config({ password: 'falsch' }))).rejects.toThrow('Zugangsdaten abgelehnt (401)');
  await expect(probe(config({ url: 'http://127.0.0.1:1/dav' }))).rejects.toThrow('Verbindung abgelehnt');
});

it('prüft die Adresse und lässt keine Ausbrüche aus dem Ordner zu', async () => {
  expect(webdavBase({ url: 'https://cloud.example.de/remote.php/dav/files/anna' }).href).toBe('https://cloud.example.de/remote.php/dav/files/anna/');
  expect(() => webdavBase({ url: 'ftp://nas/x' })).toThrow('http:// oder https://');
  expect(() => webdavBase({ url: 'https://anna:geheim@nas/x' })).toThrow('eigenen Felder');
  expect(() => webdavBase({ url: 'kein link' })).toThrow('keine gültige URL');
  await expect(deleteFile(config(), ['..', 'fremd.zip'])).rejects.toThrow('Ungültiger Pfad');
  await expect(deleteFile(config(), ['a/b'])).rejects.toThrow('Ungültiger Pfad');
});

it('liest den freien Platz mit beliebigem Namensraum-Präfix', () => {
  expect(parseQuota('<D:quota-available-bytes>42</D:quota-available-bytes>')).toBe(42);
  expect(parseQuota('<quota-available-bytes xmlns="DAV:">7</quota-available-bytes>')).toBe(7);
  expect(parseQuota('<d:prop/>')).toBeNull();
});

it('lädt einen Datenstrom unbekannter Länge hoch und räumt bei Abbruch auf', async () => {
  const { PassThrough } = await import('node:stream');
  dav.dirs.add('/dav/Sicherungen/');
  const body = new PassThrough();
  const upload = putStream(config(), ['srv2'], 'direkt.zip', body);
  body.write('Teil 1 ');
  await new Promise((resolve) => setTimeout(resolve, 20));
  body.end('Teil 2');
  await upload;
  const target = path.join(os.tmpdir(), `mcpanel-webdav-strom-${Date.now()}`);
  try {
    expect(await getFile(config(), ['srv2', 'direkt.zip'], target)).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('Teil 1 Teil 2');
  } finally {
    await fs.rm(target, { force: true });
  }

  dav.failPutWith = 411;
  const second = new PassThrough();
  second.end('x');
  await expect(putStream(config(), ['srv2'], 'b.zip', second)).rejects.toThrow();
  dav.failPutWith = 0;
  expect([...dav.files.keys()].filter((name) => name.includes('mcpanel-upload-'))).toEqual([]);
});
