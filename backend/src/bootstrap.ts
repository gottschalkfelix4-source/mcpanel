import { hasInterruptedRestore, recoverInterruptedRestore } from './services/restoreRecovery.js';
import { reconcileProxy } from './services/proxy.js';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { config, setHostDataRoot } from './config.js';
import { prisma } from './db.js';
import { ensureDataDirs, runAutostart } from './services/serverManager.js';
import { detectHostDataRoot, ensureNetwork, stop, recreateContainer } from './services/docker.js';
import { startWatcher } from './services/notify.js';
import { applyTarget, getTarget } from './services/backupTarget.js';
import { startScheduler } from './services/automation.js';

/** Beispielwert, der frueher in .env.example stand und im Repository nachlesbar ist. */
const BEISPIEL_JWT_SECRET = 'bitte-hier-ein-langes-zufaelliges-secret-eintragen';

/** Passwoerter, die in Anleitungen und Beispieldateien kursieren. */
const PLATZHALTER_PASSWOERTER = new Set([
  'changeme123',
  'changeme',
  'change-me',
  'password',
  'passwort',
  'admin',
  'admin123',
  'mcpanel',
  'geheim',
]);

/**
 * Prueft die Admin-Vorgaben aus der Umgebung und nennt den Grund, falls sie
 * nicht taugen. Die Mindestlaenge entspricht der des Einrichtungsassistenten.
 */
function pruefeAdminVorgaben(): string | null {
  const { email, username, password } = config.admin;
  if (!email.trim() || !username.trim()) return 'ADMIN_EMAIL oder ADMIN_USERNAME ist leer';
  if (password.length < 8) return 'ADMIN_PASSWORD ist kuerzer als 8 Zeichen';
  if (PLATZHALTER_PASSWOERTER.has(password.toLowerCase())) {
    return 'ADMIN_PASSWORD ist ein bekannter Platzhalter';
  }
  return null;
}

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
  if (!path.isAbsolute(config.hostDataRoot) && !path.win32.isAbsolute(config.hostDataRoot)) throw new Error('HOST_DATA_ROOT muss ein absoluter Pfad auf dem Docker-Host sein (oder leer für automatische Erkennung).');
  log(`Datenverzeichnis: ${config.dataRoot} (Host: ${config.hostDataRoot})`);

  try {
    await ensureNetwork();
    log(`Docker-Netzwerk "${config.dockerNetwork}" bereit`);
  } catch (err) {
    log(`WARNUNG: Docker nicht erreichbar – ${err instanceof Error ? err.message : err}`);
  }

  if (config.jwtSecret === BEISPIEL_JWT_SECRET) {
    log(
      'WARNUNG: JWT_SECRET steht auf dem Beispielwert aus .env.example. Damit sind ' +
        'alle Sitzungstoken faelschbar – Wert leeren (das Panel erzeugt dann selbst ' +
        'eines) oder durch einen langen Zufallswert ersetzen.',
    );
  }

  const userCount = await prisma.user.count();
  if (userCount === 0) {
    const problem = config.admin.password ? pruefeAdminVorgaben() : null;
    if (problem) {
      // Ueberspringen statt abbrechen: der Assistent ist ein vollwertiger Weg
      // zum ersten Konto, ein Startabbruch waere nur ein toter Container.
      log(`WARNUNG: Kein Administrator aus der Umgebung angelegt – ${problem}.`);
      log('Das Panel fuehrt beim Aufruf stattdessen durch die Ersteinrichtung.');
    } else if (config.admin.password) {
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

  for (const server of await prisma.server.findMany()) {
    const interrupted = await hasInterruptedRestore(server.id);
    if (interrupted) await stop(server);
    await recoverInterruptedRestore(server.id);
    if (interrupted) await recreateContainer(await prisma.server.findUniqueOrThrow({ where: { id: server.id } }));
  }
  void runAutostart();
  await reconcileProxy().catch(err => log(`Proxy: ${err.message}`));

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
