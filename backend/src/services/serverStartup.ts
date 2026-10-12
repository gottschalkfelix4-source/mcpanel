import type { Server } from '@prisma/client';
import fs from 'node:fs/promises';
import { badRequest } from '../lib/errors.js';
import * as dockerSvc from './docker.js';
import { listPlayers } from './rcon.js';
import { analyseCrash } from './crashAnalysis.js';
import { contentDir } from './content.js';

export interface StartupOptions {
  timeoutMs?: number;
  pollMs?: number;
  onWaiting?: (message: string) => Promise<void>;
}

/** Docker-Start allein genügt nicht: Status-Ping oder RCON müssen antworten. */
export async function waitForServerReady(server: Server, options: StartupOptions = {}): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
  let lastProgress = 0;
  for (;;) {
    const { state, health } = await dockerSvc.getState(server);
    if (state === 'error' || state === 'stopped' || state === 'missing') {
      const log = await dockerSvc.tailLogs(server, 1500);
      const dir = contentDir(server);
      const diagnosis = analyseCrash(log, dir ? await fs.readdir(dir).catch(() => []) : [], dir ?? undefined);
      throw badRequest('Minecraft-Start fehlgeschlagen. ' + (diagnosis?.reason ?? 'Der Container hat sich vor dem erfolgreichen Start beendet. Details stehen in der Konsole.'));
    }
    if (health === 'healthy') return;
    // Auch bei fehlendem oder unzuverlässigem Docker-Healthcheck zählt eine
    // echte Antwort des Minecraft-Servers als erfolgreicher Start.
    if (await listPlayers(server).then(() => true, () => false)) return;
    if (Date.now() >= deadline) {
      throw badRequest('Minecraft antwortet nach der Startwartezeit noch nicht. Details stehen in der Konsole.');
    }
    if (Date.now() - lastProgress >= 30_000) {
      await options.onWaiting?.('Warte auf den Minecraft-Start …');
      lastProgress = Date.now();
    }
    await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 2000));
  }
}
