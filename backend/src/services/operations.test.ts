import { describe, expect, it } from 'vitest';
import { withQueuedOperation, withServerOperation } from './operations.js';

describe('server mutations', () => {
  it('excludes independent work while allowing nested backup/power steps', async () => {
    let finish!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const task = withServerOperation('one', 'Restore', async () => {
      await withServerOperation('one', 'Internal stop', async () => {});
      entered();
      await blocked;
    });
    await ready;
    await expect(withServerOperation('one', 'Upload', async () => {})).rejects.toMatchObject({ statusCode: 409 });
    await expect(withServerOperation('two', 'Upload', async () => 'ok')).resolves.toBe('ok');
    finish();
    await task;
    await expect(withServerOperation('one', 'Upload', async () => 'ok')).resolves.toBe('ok');
  });

  it('serializes shared backup targets without rejecting another server', async () => {
    const events: number[] = [];
    await Promise.all([1, 2, 3].map(n => withQueuedOperation('target', 'Copy', async () => {
      events.push(n);
      await new Promise(resolve => setTimeout(resolve, 2));
      await withQueuedOperation('target', 'Nested mount', async () => { events.push(-n); });
    })));
    expect(events).toEqual([1, -1, 2, -2, 3, -3]);
  });
});
