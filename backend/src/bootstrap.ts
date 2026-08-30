import bcrypt from 'bcryptjs';
import { config, setHostDataRoot } from './config.js';
import { prisma } from './db.js';
import { ensureDataDirs, runAutostart } from './services/serverManager.js';
import { detectHostDataRoot, ensureNetwork } from './services/docker.js';
import { startWatcher } from './services/notify.js';
import { applyTarget, getTarget } from './services/backupTarget.js';
import { startScheduler } from './services/automation.js';

/** Legt beim ersten Start Verzeichnisse, Netzwerk und den Admin-Account an. */
export async function bootstrap(log: (msg: string) => void): Promise<void> {
  await ensureDataDirs();

  // Host-Pfad moeglichst selbst ermitteln; nur wenn er ausdruecklich gesetzt
  // wurde, hat die Umgebung Vorrang.
  if (!process.env.HOST_DATA_ROOT) {
    const detected = await detectHostDataRoot(config.dataRoot);
    if (detected && detected !== config.hostDataRoot) {
      setHostDataRoot(detected);
      log(`Host-Datenpfad automatisch erkannt: ${detected}`);
    }
  }
  log(`Datenverzeichnis: ${config.dataRoot} (Host: ${config.hostDataRoot})`);

  try {
    await ensureNetwork();
    log(`Docker-Netzwerk "${config.dockerNetwork}" bereit`);
  } catch (err) {
    log(`WARNUNG: Docker nicht erreichbar – ${err instanceof Error ? err.message : err}`);
  }

  const userCount = await prisma.user.count();
  if (userCount === 0) {
    if (config.admin.password) {
      // Unbeaufsichtigter Start: Zugangsdaten kamen ueber die Umgebung.
      await prisma.user.create({
        data: {
          email: config.admin.email.toLowerCase(),
          username: config.admin.username,
          role: 'ADMIN',
          passwordHash: await bcrypt.hash(config.admin.password, 10),
        },
      });
      log(`Administrator "${config.admin.username}" aus der Umgebung angelegt.`);
    } else {
      log('Noch kein Konto vorhanden – das Panel fuehrt beim Aufruf durch die Ersteinrichtung.');
    }
  }

  // Verwaiste Tasks aus einem vorherigen Lauf abschließen
  await prisma.task.updateMany({
    where: { status: { in: ['PENDING', 'RUNNING'] } },
    data: { status: 'FAILED', error: 'Panel wurde neu gestartet' },
  });

  void runAutostart();

  // Eine eingerichtete Samba-Freigabe muss nach jedem Neustart wieder
  // eingehaengt werden – der Mount lebt nur im Container.
  const target = await getTarget();
  if (target.kind !== 'NONE') {
    try {
      await applyTarget();
      log(`Backup-Zweitablage aktiv (${target.kind})`);
    } catch (err) {
      log(`Backup-Zweitablage nicht verfuegbar: ${err instanceof Error ? err.message : err}`);
    }
  }

  startScheduler(log);
  startWatcher(log);
}
