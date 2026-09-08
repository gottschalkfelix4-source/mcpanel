import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { downloadToFile } from './download.js';

let root: string;
let server: http.Server;
let base: string;
const timers = new Set<ReturnType<typeof setInterval>>();
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-download-'));
  server = http.createServer((req, res) => {
    if (req.url === '/no-headers') return;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.write('first');
    if (req.url === '/stalled') return;
    let count = 0;
    const timer = setInterval(() => {
      res.write('chunk');
      if (++count === 10) { clearInterval(timer); timers.delete(timer); res.end(); }
    }, 30);
    timers.add(timer);
    res.on('close', () => { clearInterval(timer); timers.delete(timer); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  for (const timer of timers) clearInterval(timer);
  timers.clear();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true });
});
it('allows a progressing transfer to outlive both timeout durations', async () => {
  const dest = path.join(root, 'pack.zip');
  const bytes = await downloadToFile(base + '/active', dest, { retries: 1, headersTimeoutMs: 150, stallTimeoutMs: 150 });
  expect(bytes).toBe(55);
  expect(await fs.readFile(dest, 'utf8')).toBe('first' + 'chunk'.repeat(10));
});
it('aborts a stalled body and preserves the previous file', async () => {
  const dest = path.join(root, 'pack.zip');
  await fs.writeFile(dest, 'previous');
  await expect(downloadToFile(base + '/stalled', dest, { retries: 1, stallTimeoutMs: 60 })).rejects.toThrow('ohne Fortschritt');
  expect(await fs.readFile(dest, 'utf8')).toBe('previous');
  expect(await fs.readdir(root)).toEqual(['pack.zip']);
});
it('still times out when the server never sends headers', async () => {
  await expect(downloadToFile(base + '/no-headers', path.join(root, 'pack.zip'), { retries: 1, headersTimeoutMs: 60 })).rejects.toThrow('antwortet nicht');
  expect(await fs.readdir(root)).toEqual([]);
});
