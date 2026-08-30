import path from 'node:path';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Umgebungsvariable ${name} fehlt`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  jwtSecret: req('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',

  /** Pfad der Serverdaten *innerhalb* des Backend-Containers. */
  dataRoot: process.env.DATA_ROOT ?? path.resolve(process.cwd(), 'data'),
  /** Derselbe Ordner aus Sicht des Docker-Hosts (für Bind-Mounts). */
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


  admin: {
    email: process.env.ADMIN_EMAIL ?? 'admin@example.com',
    username: process.env.ADMIN_USERNAME ?? 'admin',
    password: process.env.ADMIN_PASSWORD ?? 'changeme123',
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

