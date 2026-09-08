import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../lib/errors.js';

/**
 * Sicherung, Wiederherstellung und Modpack-Installation schreiben in dasselbe
 * Verzeichnis. `runTask` laesst deshalb je Server nur eine davon gleichzeitig
 * zu – hier wird geprueft, dass die Sperre greift und sich auch nach einem
 * Fehlschlag wieder loest.
 */
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../db.js', () => ({
  prisma: {
    task: {
      create: mocks.create,
      update: mocks.update,
    },
  },
}));

vi.mock('../ws/io.js', () => ({ emitToServer: vi.fn() }));

const { runTask } = await import('./tasks.js');

/** Ein Versprechen, das der Test von aussen aufloest. */
function steuerbar() {
  let fertig!: () => void;
  let scheitert!: (err: Error) => void;
  const versprechen = new Promise<void>((res, rej) => {
    fertig = () => res();
    scheitert = rej;
  });
  return { versprechen, fertig, scheitert };
}

describe('runTask – Sperre je Server', () => {
  let zaehler = 0;

  beforeEach(() => {
    zaehler = 0;
    mocks.create.mockReset();
    mocks.update.mockReset();
    mocks.create.mockImplementation(async () => ({ id: `task-${++zaehler}` }));
    mocks.update.mockResolvedValue({});
  });

  it('lässt die erste Aufgabe zu', async () => {
    const id = await runTask('server-a', 'backup.create', async () => {});
    expect(id).toBe('task-1');
  });

  it('weist eine zweite Aufgabe am selben Server ab und nennt die laufende', async () => {
    const laufend = steuerbar();
    await runTask('server-a', 'backup.create', () => laufend.versprechen);

    const zweite = runTask('server-a', 'modpack.update', async () => {});
    await expect(zweite).rejects.toThrow(/Eine Sicherung läuft für diesen Server bereits/);
    await expect(zweite).rejects.toBeInstanceOf(HttpError);
    await zweite.catch((err: HttpError) => expect(err.statusCode).toBe(409));

    laufend.fertig();
  });

  it('sperrt andere Server nicht mit', async () => {
    const laufend = steuerbar();
    await runTask('server-a', 'backup.create', () => laufend.versprechen);

    await expect(runTask('server-b', 'backup.create', async () => {})).resolves.toBe('task-2');

    laufend.fertig();
  });

  it('gibt den Server nach dem Ende wieder frei', async () => {
    const laufend = steuerbar();
    await runTask('server-a', 'backup.create', () => laufend.versprechen);
    laufend.fertig();
    // Ein Durchlauf der Microtask-Queue, damit das finally in runTask greift.
    await new Promise((res) => setImmediate(res));

    await expect(runTask('server-a', 'modpack.update', async () => {})).resolves.toBe('task-2');
  });

  it('gibt den Server auch nach einem Fehlschlag wieder frei', async () => {
    const laufend = steuerbar();
    await runTask('server-a', 'backup.create', () => laufend.versprechen);
    laufend.scheitert(new Error('Archiv beschädigt'));
    await new Promise((res) => setImmediate(res));

    await expect(runTask('server-a', 'backup.create', async () => {})).resolves.toBe('task-2');
  });

  it('sperrt panelweite Aufgaben ohne Server nicht', async () => {
    const laufend = steuerbar();
    await runTask(null, 'wartung', () => laufend.versprechen);

    await expect(runTask(null, 'wartung', async () => {})).resolves.toBe('task-2');

    laufend.fertig();
  });
});

it('BUG-17: completion mode waits and propagates a late failure', async () => {
  const gate = steuerbar();
  let settled = false;
  const result = runTask('completion', 'modpack.update', () => gate.versprechen, true);
  const checked = expect(result).rejects.toThrow('late install failure');
  void result.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  expect(settled).toBe(false);
  gate.scheitert(new Error('late install failure'));
  await checked;
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }));
});
