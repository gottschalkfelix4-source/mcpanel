import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dataRoot = process.env.DATA_ROOT ?? path.resolve(process.cwd(), 'data');

/**
 * Sitzungs-Geheimnis. Reihenfolge: Umgebung, dann eine Datei im
 * Datenverzeichnis, sonst wird eines erzeugt und dort abgelegt.
 *
 * So laeuft `docker compose up` ohne jede Vorbereitung, und die Sitzungen
 * ueberleben trotzdem einen Neustart - ein bei jedem Start neu gewuerfeltes
 * Geheimnis wuerde alle Anmeldungen ungueltig machen.
 */
function resolveJwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET?.trim();
  if (fromEnv) return fromEnv;

  const file = path.join(dataRoot, '.jwt-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* noch nicht vorhanden */
  }

  const generated = crypto.randomBytes(48).toString('hex');
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(file, generated, { mode: 0o600 });
  } catch (err) {
    // Nicht schreibbar: das Panel laeuft trotzdem, aber Anmeldungen halten
    // dann nur bis zum naechsten Neustart.
    console.warn(`Konnte ${file} nicht schreiben: ${err instanceof Error ? err.message : err}`);
  }
  return generated;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  jwtSecret: resolveJwtSecret(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',

  /** Pfad der Serverdaten *innerhalb* des Backend-Containers. */
  dataRoot,
  /**
   * Derselbe Ordner aus Sicht des Docker-Hosts (fuer Bind-Mounts der
   * Minecraft-Container). Wird beim Start ueberschrieben, wenn er sich aus
   * den eigenen Mounts ablesen laesst - siehe detectHostDataRoot().
   */
  hostDataRoot: process.env.HOST_DATA_ROOT ?? process.env.DATA_ROOT ?? path.resolve(process.cwd(), 'data'),

  portRange: {
    min: Number(process.env.MC_PORT_MIN ?? 25565),
    max: Number(process.env.MC_PORT_MAX ?? 25700),
  },

  publicHost: process.env.PUBLIC_HOST ?? 'localhost',
  dockerNetwork: process.env.DOCKER_NETWORK ?? 'mcpanel_mcpanel',
  containerPrefix: process.env.CONTAINER_PREFIX ?? 'mc',
  /** Fest vorgegebenes Image. Leer = passend zur Minecraft-Version wählen. */
  mcImage: process.env.MC_IMAGE ?? '',
  mcImageRepo: process.env.MC_IMAGE_REPO ?? 'itzg/minecraft-server',

  curseforgeApiKey: process.env.CURSEFORGE_API_KEY ?? '',

  /**
   * Bauinformationen aus dem Abbild. Beim Bauen von Hand leer - dann laeuft
   * das Panel aus dem Quellcode und es gibt keine Fassung zu melden.
   */
  build: {
    version: process.env.MCPANEL_VERSION ?? '',
    revision: process.env.MCPANEL_REVISION ?? '',
    date: process.env.MCPANEL_BUILD_DATE ?? '',
  },


  /**
   * Vorgaben fuer einen unbeaufsichtigten ersten Start. Ist kein Passwort
   * gesetzt, bleibt die Benutzertabelle leer und das Panel fuehrt stattdessen
   * durch die Ersteinrichtung im Browser.
   */
  admin: {
    email: process.env.ADMIN_EMAIL ?? 'admin@example.com',
    username: process.env.ADMIN_USERNAME ?? 'admin',
    password: process.env.ADMIN_PASSWORD ?? '',
  },
};

export const serversDir = () => path.join(config.dataRoot, 'servers');
export const backupsDir = () => path.join(config.dataRoot, 'backups');
export const cacheDir = () => path.join(config.dataRoot, 'cache');

/** Datenverzeichnis eines Servers – im Backend-Container. */
export const serverDir = (id: string) => path.join(serversDir(), id);
/** Datenverzeichnis eines Servers – aus Host-Sicht (Bind-Mount-Quelle). */
export const serverHostDir = (id: string) =>
  `${config.hostDataRoot.replace(/[/\\]+$/, '')}/servers/${id}`;
export const serverBackupDir = (id: string) => path.join(backupsDir(), id);

/**
 * Setzt den Host-Pfad nachtraeglich. Nur beim Start aufzurufen: die
 * Minecraft-Container haengen ihre Verzeichnisse anhand dieses Wertes ein.
 */
export function setHostDataRoot(value: string): void {
  config.hostDataRoot = value;
}
