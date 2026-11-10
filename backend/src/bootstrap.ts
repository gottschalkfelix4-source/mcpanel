import { hasInterruptedRestore, recoverInterruptedRestore } from './services/restoreRecovery.js';
import { reconcileProxy } from './services/proxy.js';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { config, setHostDataRoot } from './config.js';
import { prisma } from './db.js';
import { ensureDataDirs, runAutostart } from './services/serverManager.js';
import { detectHostDataRoot, ensureNetwork, getState, onServerStart, stop, recreateContainer } from './services/docker.js';
import { rconCommand } from './services/rcon.js';
import { cleanupPartialBackups } from './services/backups.js';
import { loadServerPorts, reassignBusyPort, syncServerPorts } from './services/serverPorts.js';
import { scheduleUnifiSync, setUnifiLogger } from './services/unifi.js';
import { startPregenMonitor } from './services/pregen.js';
import { startWatcher } from './services/notify.js';
import { startPanelBackupScheduler } from './services/panelBackups.js';
import { applyTarget, getTarget } from './services/backupTarget.js';
import { startScheduler } from './services/automation.js';
import { prepareSetupCode } from './routes/setup.js';
import { runDataMigrations } from './services/migrations.js';
import { pruneExpiredSessions } from './auth/sessions.js';
import { startPlayerStats } from './services/playerStats.js';
import { loadNodes, startNodeMonitor } from './services/nodes.js';

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

  // Standorte vor allem anderen laden: ab hier zeigen serverDir() und die
  // Docker-Aufrufe für Server auf Nodes an die richtige Stelle.
  await loadNodes();
  await startNodeMonitor(log).catch((err) => log(`Nodes nicht gestartet: ${err instanceof Error ? err.message : err}`));

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
      await prepareSetupCode(log);
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
      await prepareSetupCode(log);
    }
  }

  // Lief beim letzten Ende noch etwas, kann der Minecraft-Server im Zustand
  // „save-off“ hängen (Sicherung, Welt-Export, Kopie). Nach dem Start wieder
  // einschalten – der Befehl schadet nicht, wenn Speichern ohnehin an ist.
  const interrupted = await prisma.task.findMany({
    where: { status: { in: ['PENDING', 'RUNNING'] }, serverId: { not: null } },
    select: { serverId: true },
  });
  const interruptedServers = [...new Set(interrupted.map((task) => task.serverId!))];
  setTimeout(() => {
    void (async () => {
      for (const id of interruptedServers) {
        const server = await prisma.server.findUnique({ where: { id } });
        if (!server) continue;
        const state = await getState(server).catch(() => null);
        if (state?.state !== 'running') continue;
        await rconCommand(server, 'save-on').then(
          () => log(`${server.name}: automatisches Speichern nach abgebrochenem Vorgang wieder eingeschaltet`),
          (err) => log(`${server.name}: „save-on“ nach abgebrochenem Vorgang fehlgeschlagen – ${err instanceof Error ? err.message : err}`),
        );
      }
    })().catch(() => {});
  }, 20_000).unref();

  // Verwaiste Tasks aus einem vorherigen Lauf abschließen
  await prisma.task.updateMany({
    where: { status: { in: ['PENDING', 'RUNNING'] } },
    data: { status: 'FAILED', error: 'Panel wurde neu gestartet' },
  });

  // Ein einzelner kaputter Server (Docker weg, Rechte, volle Platte) darf
  // den Start des Panels nicht verhindern – sonst ist niemand mehr drin.
  for (const server of await prisma.server.findMany()) {
    try {
      await cleanupPartialBackups(server.id).then((count) => {
        if (count > 0) log(`${server.name}: ${count} unvollständige Sicherung(en) eines abgebrochenen Laufs entfernt`);
      }).catch(() => {});
      const interrupted = await hasInterruptedRestore(server.id);
      if (interrupted) await stop(server);
      await recoverInterruptedRestore(server.id);
      if (interrupted) await recreateContainer(await prisma.server.findUniqueOrThrow({ where: { id: server.id } }));
    } catch (err) {
      log(`Wiederherstellung für ${server.name} konnte nicht aufgeräumt werden: ${err instanceof Error ? err.message : err}`);
    }
  }
  await runDataMigrations(log);

  // Zusatzports (Sprachchat, Geyser, Web-Karten) vor jedem Start erkennen und
  // danach die Router-Freigaben abgleichen.
  await loadServerPorts().catch((err) => log(`Zusatzports nicht geladen: ${err instanceof Error ? err.message : err}`));
  setUnifiLogger(log);
  onServerStart({
    before: async (server) => {
      const result = await syncServerPorts(server);
      for (const note of result.notes) log(`${server.name}: ${note}`);
    },
    after: () => scheduleUnifiSync(),
    portBusy: (server, hostPort) => reassignBusyPort(server, hostPort),
  });
  scheduleUnifiSync(10_000);

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
  // Vorgenerierungen fortsetzen, automatisch pausieren und BlueMap freischalten.
  startPregenMonitor(log);
  startPanelBackupScheduler(log);

  await startPlayerStats(log).catch((err) => log(`Spielerstatistik nicht gestartet: ${err instanceof Error ? err.message : err}`));

  // Abgelaufene Gerätesitzungen stündlich wegräumen.
  const prune = () => pruneExpiredSessions().catch((err) => log(`Sitzungen aufräumen: ${err instanceof Error ? err.message : err}`));
  void prune();
  setInterval(prune, 3600_000).unref();
}
