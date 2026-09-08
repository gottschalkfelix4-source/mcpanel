export type Role = 'ADMIN' | 'USER';

export type PowerState = 'running' | 'starting' | 'stopped' | 'missing' | 'error';

export type ServerType =
  | 'VANILLA' | 'PAPER' | 'PURPUR' | 'SPIGOT'
  | 'FABRIC' | 'FORGE' | 'NEOFORGE' | 'QUILT' | 'MODPACK';

export interface Me {
  id: string;
  email: string;
  username: string;
  role: Role;
  createdAt: string;
  serverCount: number;
}

export interface ContainerStats {
  cpuPercent: number;
  memoryUsed: number;
  memoryLimit: number;
}

export interface ModpackRef {
  provider: 'modrinth' | 'curseforge' | null;
  projectId: string | null;
  versionId: string | null;
  name: string | null;
  versionName: string | null;
  iconUrl: string | null;
}

export interface ServerSummary {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  type: ServerType;
  mcVersion: string;
  memoryMb: number;
  port: number;
  address: string;
  directAddress: string;
  directConnect: boolean;
  proxy: { enabled: boolean; port: number; hostnames: string[] };
  autoStart: boolean;
  state: PowerState;
  /** Docker-Healthcheck: healthy | starting | unhealthy | null */
  health?: string | null;
  startedAt: string | null;
  stats: ContainerStats | null;
  /** Gecachte Spielerzahl – null, solange noch keine Antwort vorliegt. */
  players: { online: number; max: number } | null;
  modpack: ModpackRef | null;
  createdAt: string;
}

export interface ServerDetail extends ServerSummary {
  owner: { id: string; username: string } | null;
  memberCount: number;
  disk: {
    data: number;
    backups: number;
    total: number;
    /** Wird gerade (neu) berechnet – die Zahlen können noch fehlen. */
    pending?: boolean;
    computedAt?: string | null;
  };
  quota: {
    /** 0 = unbegrenzt */
    diskLimitBytes: number;
    diskUsedBytes: number;
    /** null = unbegrenzt oder noch nicht berechnet */
    diskPercent: number | null;
    diskPending: boolean;
    backupLimit: number;
    backupCount: number;
    memoryLimitMb: number;
  };
  permissions: string[];
  isOwner: boolean;
  isAdmin: boolean;
  publicHost: string;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: string;
  editable: boolean;
}

export interface PropertyField {
  key: string;
  label: string;
  type: 'string' | 'boolean' | 'number' | 'select';
  group: string;
  options?: string[];
  min?: number;
  max?: number;
  hint?: string;
}

export interface Backup {
  id: string;
  name: string;
  filename: string;
  sizeBytes: number;
  /** Liegt zusaetzlich in der Zweitablage. */
  mirrored: boolean;
  note: string;
  createdAt: string;
  createdBy: { id: string; username: string } | null;
}

export interface ProjectSummary {
  provider: 'modrinth' | 'curseforge';
  id: string;
  slug: string;
  name: string;
  summary: string;
  iconUrl: string | null;
  downloads: number;
  author: string;
  categories: string[];
  gameVersions: string[];
  websiteUrl: string | null;
  updatedAt: string | null;
  /** Servertauglichkeit laut Anbieter. */
  serverSupport: 'supported' | 'unsupported' | 'unknown';
  /** Nur CurseForge: fertiges Serverpaket vorhanden. */
  hasServerPack?: boolean;
}

export interface ProjectVersion {
  provider: 'modrinth' | 'curseforge';
  id: string;
  projectId: string;
  name: string;
  versionNumber: string;
  gameVersions: string[];
  loaders: string[];
  datePublished: string;
  downloadUrl: string | null;
  filename: string;
  fileSize: number;
  downloadBlocked?: boolean;
  /** Nur CurseForge: zugehöriges Serverpaket, das der Installer bevorzugt. */
  serverPackFileId?: number | null;
  isServerPack?: boolean;
}

export interface TaskInfo {
  id: string;
  serverId: string | null;
  type: string;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
  progress: number;
  message: string;
  log: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Member {
  id: string;
  user: { id: string; username: string; email: string };
  permissions: string[];
  createdAt?: string;
}

/** Art des verwaltbaren Zusatzinhalts – null bei Servern, die keinen kennen. */
export type ContentKind = 'mod' | 'plugin';

/**
 * Bukkit-Abkoemmlinge laden aus plugins/, die Loader aus mods/, Vanilla aus
 * keinem von beiden. Dient nur der Beschriftung, bis die Liste geladen ist –
 * massgeblich bleibt das `kind` aus der Antwort.
 */
export const CONTENT_KIND_BY_TYPE: Record<ServerType, ContentKind | null> = {
  VANILLA: null,
  PAPER: 'plugin',
  PURPUR: 'plugin',
  SPIGOT: 'plugin',
  FABRIC: 'mod',
  FORGE: 'mod',
  NEOFORGE: 'mod',
  QUILT: 'mod',
  MODPACK: 'mod',
};

export interface ContentFile {
  filename: string;
  displayName: string;
  enabled: boolean;
  size: number;
  modified: string;
}

export interface ContentListing {
  /** null: Der Servertyp unterstuetzt weder Mods noch Plugins. */
  kind: ContentKind | null;
  dirName: string | null;
  items: ContentFile[];
}

export interface PlayerInfo {
  online: number;
  max: number;
  players: string[];
  available: boolean;
}

export interface PanelUser {
  id: string;
  email: string;
  username: string;
  role: Role;
  active: boolean;
  createdAt: string;
  _count?: { ownedServers: number; memberships: number };
}

export type AutomationTrigger = 'SCHEDULE' | 'ON_CRASH';
export type AutomationAction =
  | 'COMMAND' | 'BACKUP' | 'RESTART' | 'START' | 'STOP' | 'MODPACK_UPDATE';

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  cron: string | null;
  action: AutomationAction;
  config: {
    command?: string;
    backupName?: string;
    note?: string;
    keepBackups?: number;
  };
  onlyWhenRunning: boolean;
  lastRunAt: string | null;
  lastStatus: 'OK' | 'FEHLER' | 'UEBERSPRUNGEN' | null;
  lastMessage: string | null;
  runCount: number;
  createdAt: string;
  /** Vom Server erzeugter Klartext des Zeitplans. */
  scheduleText: string;
  nextRunAt: string | null;
}

export type NotifyChannelType = 'DISCORD' | 'WEBHOOK';

export interface NotifyChannel {
  id: string;
  name: string;
  enabled: boolean;
  type: NotifyChannelType;
  /** Gekuerzte Ziel-URL – das Token bleibt auf dem Server. */
  targetMasked: string;
  events: string[];
  global: boolean;
  lastSentAt: string | null;
  lastStatus: 'OK' | 'FEHLER' | null;
  lastMessage: string | null;
  sentCount: number;
}

export interface NotifyEventInfo {
  key: string;
  label: string;
  standard: boolean;
}

export interface NotifyListResponse {
  channels: NotifyChannel[];
  globalChannels?: NotifyChannel[];
  catalog: NotifyEventInfo[];
  defaults: string[];
  canManage: boolean;
}

/** Auswertung des Protokolls nach einem Absturz – siehe CrashDialog. */
export interface CrashSuspect {
  filename: string | null;
  reference: string;
  enabled: boolean;
}

export interface CrashDiagnosis {
  headline: string;
  reason: string;
  suspect: CrashSuspect | null;
  excerpt: string[];
}
