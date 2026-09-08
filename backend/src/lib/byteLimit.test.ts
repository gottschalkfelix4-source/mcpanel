import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { expect, it } from 'vitest';
import { byteLimit } from './byteLimit.js';

it('stops before writing a chunk that crosses the quota', async () => {
  const output: Buffer[] = [];
  await expect(pipeline(Readable.from([Buffer.alloc(3), Buffer.alloc(3)]), byteLimit(5), new Writable({ write(data, _enc, cb) { output.push(data); cb(); } }))).rejects.toThrow('Speicherkontingent');
  expect(Buffer.concat(output).length).toBe(3);
});

it('permits exactly the available bytes and rejects growth at zero remaining', async () => {
  await pipeline(Readable.from([Buffer.alloc(5)]), byteLimit(5), new Writable({ write(_data, _enc, cb) { cb(); } }));
  await expect(pipeline(Readable.from([Buffer.alloc(1)]), byteLimit(0), new Writable({ write(_data, _enc, cb) { cb(); } }))).rejects.toThrow('Speicherkontingent');
});
