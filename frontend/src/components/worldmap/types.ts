export type Dimension = 'overworld' | 'nether' | 'end';
export type Shape = 'circle' | 'square';

export const DIMENSION_IDS: Record<Dimension, string> = {
  overworld: 'minecraft:overworld',
  nether: 'minecraft:the_nether',
  end: 'minecraft:the_end',
};

export const DIMENSION_LABELS: Record<Dimension, string> = {
  overworld: 'Oberwelt',
  nether: 'Nether',
  end: 'End',
};

export interface AddonState {
  installed: boolean;
  file: string | null;
  available: { version: string; filename: string } | null;
  lookupFailed?: boolean;
}

export interface PregenJob {
  dimension: Dimension;
  shape: Shape;
  centerX: number;
  centerZ: number;
  radius: number;
  onlyWhenEmpty: boolean;
  tpsGuard: boolean;
  pauseRender: boolean;
  status: 'running' | 'paused' | 'done' | 'cancelled' | 'failed';
  autoPaused: 'players' | 'tps' | 'stopped' | null;
  world: string;
  processed: number;
  percent: number;
  total: number;
  rate: number | null;
  etaSeconds: number | null;
  /** Chunk-Koordinaten */
  current: { x: number; z: number } | null;
  startedAt: string;
  finishedAt: string | null;
  message: string | null;
}

export interface MapInfo {
  loader: string;
  mcVersion: string;
  addons: { chunky: AddonState; bluemap: AddonState };
  bluemapAccepted: boolean;
  job: PregenJob | null;
  canPregen: boolean;
  canTrim: boolean;
  canBackup: boolean;
  remainingDiskBytes: number | null;
  bytesPerChunk: number;
}

export interface RegionBits {
  x: number;
  z: number;
  bits: string;
  count: number;
}

export interface ChunkMapData {
  dimension: Dimension;
  regions: RegionBits[];
  chunks: number;
  /** Größe der Regionsdateien dieser Dimension */
  bytes: number;
  truncated: boolean;
}

export interface PlayerPosition {
  name: string;
  x: number;
  y: number;
  z: number;
  dimension: string | null;
}

export interface PlayersResponse {
  online: number;
  players: PlayerPosition[];
  unsupported: boolean;
  offline: boolean;
}

/** Geplanter oder laufender Bereich, wie ihn die Karte zeichnet. */
export interface Area {
  shape: Shape;
  centerX: number;
  centerZ: number;
  radius: number;
  /** Gesetzt: Bereich zum Zurücksetzen – rot, mit Markierung dessen, was wegfällt. */
  trim?: TrimMode;
}

export type TrimMode = 'outside' | 'inside';

export interface TrimSummary {
  chunks: number;
  removed: number;
  bytes: number;
  filesDeleted: number;
  filesRewritten: number;
  skipped: string[];
}

export interface WorldSize {
  level: string;
  bytes: number;
  files: number;
  partial: boolean;
  folders: { name: string; bytes: number }[];
}
