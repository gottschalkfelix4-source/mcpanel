import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { Server } from '@prisma/client';
import { prisma } from '../db.js';
import { serverDir } from '../config.js';
import { safePath } from '../lib/safePath.js';
import { badRequest } from '../lib/errors.js';
import { parseProperties, mergeProperties } from './properties.js';
import { createServer, deleteServer } from './serverManager.js';
import { getState, recreateContainer } from './docker.js';
import { dirSize } from './files.js';
import { rconCommand } from './rcon.js';
import { withServerOperation } from './operations.js';
import type { TaskHandle } from './tasks.js';

const EXCLUDED = new Set(['logs', 'crash-reports', 'cache', '.cache', 'session.lock', '.restore-old', '.restore-stage', '.rcon-cli.env', '.mc-health.env']);
export function cloneEnvironment(extra: Record<string, string>) {
  const result = { ...extra };
  for (const key of ['RCON_PASSWORD', 'RCON_PORT', 'SERVER_PORT', 'SERVER_IP', 'SERVER_HOST', 'COPY_CONFIG_DEST', 'SYNC_DESTINATION']) delete result[key];
  // Eine Testkopie darf beim ersten Start keine externe Originalwelt nachladen.
  for (const key of ['WORLD', 'WORLD_URL']) delete result[key];
  return result;
}

/** Ohne Links kopieren; jede Dateikomponente vor dem Schreiben erneut prüfen. */
async function copyTree(source: string, target: string, skip: Set<string>, budget: { remaining: number }, relative = ''): Promise<void> {
  for (const entry of await fs.readdir(safePath(source, relative), { withFileTypes: true })) {
    const rel = path.join(relative, entry.name);
    if (EXCLUDED.has(entry.name) || skip.has(rel.split(path.sep)[0])) continue;
    const info = await fs.lstat(safePath(source, rel));
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw badRequest('Die Testkopie enthält einen Link oder eine besondere Datei. Kopieren wurde abgebrochen.');
    if (info.isDirectory()) {
      await fs.mkdir(safePath(target, rel), { recursive: true });
      await copyTree(source, target, skip, budget, rel);
    } else {
      if (info.size > budget.remaining) throw badRequest('Die Testkopie überschreitet das Speicherkontingent.');
      await fs.copyFile(safePath(source, rel), safePath(target, rel), constants.COPYFILE_FICLONE);
      budget.remaining -= info.size;
    }
  }
}

export async function cloneServer(source: Server, options: { name: string; includeWorld: boolean }, task: TaskHandle): Promise<Server> {
  return withServerOperation(source.id, 'Testserver kopieren', async () => {
    source = await prisma.server.findUniqueOrThrow({ where: { id: source.id } });
    const state = await getState(source);
    if (state.state === 'starting' && options.includeWorld) throw badRequest('Bitte warten, bis der Quellserver vollständig gestartet ist, oder ohne Welt kopieren.');
    const raw = await fs.readFile(safePath(serverDir(source.id), 'server.properties'), 'utf8').catch(() => '');
    const properties = parseProperties(raw);
    const world = properties['level-name'] || 'world';
    if (/[\/\\]|^\.\.?$/.test(world)) throw badRequest('Der Weltname eignet sich nicht für eine sichere Testkopie.');
    const skip = options.includeWorld ? new Set<string>() : new Set([world, `${world}_nether`, `${world}_the_end`, 'world', 'world_nether', 'world_the_end']);
    let savingDisabled = false;
    let target: Server | null = null;
    try {
      if (options.includeWorld && state.state === 'running') {
        await task.update(5, 'Welt wird konsistent gespeichert …');
        savingDisabled = true;
        await rconCommand(source, 'save-off');
        await rconCommand(source, 'save-all flush');
      }
      await task.update(15, 'Eigenständiger Testserver wird angelegt …');
      target = await createServer({ name: options.name, description: `Testkopie von ${source.name}`, ownerId: source.ownerId,
        type: source.type, mcVersion: source.mcVersion, memoryMb: source.memoryMb,
        extraEnv: cloneEnvironment(source.extraEnv as Record<string, string>),
        quota: { quotaDiskMb: source.quotaDiskMb, quotaBackups: source.quotaBackups, quotaMemoryMb: source.quotaMemoryMb } });
      return await withServerOperation(target.id, 'Testserver kopieren', async () => {
        await task.update(30, 'Dateien werden in die Testkopie übertragen …');
        await copyTree(serverDir(source.id), serverDir(target!.id), skip,
          { remaining: target!.quotaDiskMb > 0 ? target!.quotaDiskMb * 1024 * 1024 : Infinity });
        const next = { ...properties, 'server-port': '25565', 'server-ip': '', 'rcon.port': String(target!.rconPort),
          'rcon.password': target!.rconPassword, 'enable-rcon': 'true' };
        if (target!.quotaDiskMb > 0 && await dirSize(serverDir(target!.id)) > target!.quotaDiskMb * 1024 * 1024) throw badRequest('Die Testkopie überschreitet das Speicherkontingent.');
        await fs.writeFile(safePath(serverDir(target!.id), 'server.properties'), mergeProperties(raw, next));
        target = await prisma.server.update({ where: { id: target!.id }, data: {
          modpackProvider: source.modpackProvider, modpackProjectId: source.modpackProjectId,
          modpackVersionId: source.modpackVersionId, modpackName: source.modpackName,
          modpackVersionName: source.modpackVersionName, modpackIconUrl: source.modpackIconUrl,
        } });
        await recreateContainer(target);
        await task.log(`Testserver ${target.name} erstellt · Port ${target.port} · bleibt gestoppt.`);
        await task.update(100, `Testserver „${target.name}“ erstellt`);
        return target;
      });
    } catch (err) {
      if (target) await deleteServer(target, true);
      throw err;
    } finally {
      if (savingDisabled) await rconCommand(source, 'save-on');
    }
  });
}
