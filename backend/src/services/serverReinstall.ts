import { prisma } from '../db.js';
import { serverBackupDir } from '../config.js';
import { badRequest } from '../lib/errors.js';
import * as docker from './docker.js';
import { createBackup } from './backups.js';
import { installModpack } from './modpack.js';
import { withServerOperation } from './operations.js';
import { assertMemoryAllowed } from './quota.js';
import { dirSize } from './files.js';
import { invalidateDiskUsage } from './diskUsage.js';
import { waitForServerReady } from './serverStartup.js';
import { commitRestore, finishRestore, recoverInterruptedRestore, restorePaths, saveRestoreMetadata } from './restoreRecovery.js';
import { prepareReinstallData, reinstallEnvironment, reinstallMetadata, type ReinstallRequest } from './reinstallationData.js';
import type { TaskHandle } from './tasks.js';

export async function reinstallServer(id: string, request: ReinstallRequest, task: TaskHandle, actor: { id: string; isAdmin: boolean }): Promise<void> {
  return withServerOperation(id, 'Eine Neuinstallation', async () => {
    await recoverInterruptedRestore(id);
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    assertMemoryAllowed(server, request.memoryMb, actor.isAdmin);
    if (request.modpack) {
      await installModpack(id, { ...request.modpack, backupFirst: true, startAfter: request.startAfter,
        reinstall: request, createdById: actor.id }, task);
      return;
    }
    const next = { ...server, name: request.name, description: request.description, memoryMb: request.memoryMb,
      type: request.type, mcVersion: request.mcVersion, extraEnv: reinstallEnvironment(server),
      modpackProvider: null, modpackProjectId: null, modpackVersionId: null, modpackName: null, modpackVersionName: null, modpackIconUrl: null };
    await task.update(5, 'Passendes Java-Abbild wird vorbereitet …');
    await docker.ensureImage(docker.imageForServer(next));
    const state = await docker.getState(server);
    const wasRunning = state.state === 'running' || state.state === 'starting';
    const { stage } = restorePaths(id);
    let stopped = false, changing = false;
    try {
      if (wasRunning) { await docker.stop(server); stopped = true; }
      await task.update(15, 'Sicherheitsbackup vor der Neuinstallation …');
      const backup = await createBackup(server, { name: `Vor Neuinstallation ${new Date().toISOString().slice(0, 16)}`, note: 'Automatisch vor Server-Neuinstallation', createdById: actor.id, origin: 'SAFETY' });
      await task.log(`Sicherheitsbackup erstellt: ${backup.name}`);
      await task.update(35, 'Frische Installation wird vorbereitet …');
      changing = true;
      await prepareReinstallData(server, stage, request.keepWorld);
      if (server.quotaDiskMb > 0 && await dirSize(stage) + await dirSize(serverBackupDir(id)) > server.quotaDiskMb * 1024 * 1024) throw badRequest('Speicherkontingent reicht für die Neuinstallation nicht aus.');
      await saveRestoreMetadata(id, reinstallMetadata(server));
      const updated = await prisma.server.update({ where: { id }, data: { ...reinstallMetadata(next) } });
      await commitRestore(id);
      await task.update(75, 'Container wird mit der gewählten Version neu erstellt …');
      await docker.recreateContainer(updated);
      invalidateDiskUsage(id);
      if (request.startAfter) {
        await docker.start(updated);
        await waitForServerReady(updated, { onWaiting: message => task.update(90, message) });
      }
      await finishRestore(id);
      await task.update(100, request.startAfter ? 'Neuinstallation abgeschlossen – Minecraft antwortet.' : 'Neuinstallation abgeschlossen – der Server kann gestartet werden.');
    } catch (error) {
      // Erst den möglicherweise neuen Prozess stoppen, dann Dateien/Metadaten zurückholen.
      if (stopped || changing) {
        await docker.stop(await prisma.server.findUniqueOrThrow({ where: { id } }));
        await recoverInterruptedRestore(id);
        const recovered = await prisma.server.findUniqueOrThrow({ where: { id } });
        await docker.recreateContainer(recovered);
        if (wasRunning) await docker.start(recovered);
      }
      invalidateDiskUsage(id);
      throw error;
    }
  });
}
