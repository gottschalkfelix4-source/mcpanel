export type ProviderId = 'modrinth' | 'curseforge';

/**
 * `plugin` meint Bukkit-Abkoemmlinge (Paper/Spigot/Purpur). Beide Anbieter
 * fuehren sie getrennt von den Mods: Modrinth ueber die Facette
 * `project_type:plugin`, CurseForge ueber die Klasse "Bukkit Plugins".
 */
export type ProjectType = 'modpack' | 'mod' | 'plugin';

export interface SearchQuery {
  query?: string;
  gameVersion?: string;
  loader?: string;
  type?: ProjectType;
  page?: number;
  pageSize?: number;
  sort?: 'relevance' | 'downloads' | 'updated' | 'newest';
  /** Nur Projekte liefern, die sich auf einem Server betreiben lassen. */
  serverOnly?: boolean;
}

/**
 * Servertauglichkeit laut Anbieter.
 *   supported   – Modrinth meldet server_side, oder es gibt ein CF-Serverpaket
 *   unsupported – Modrinth meldet ausdrücklich "unsupported"
 *   unknown     – CurseForge ohne Serverpaket: kann laufen, ist aber ungeprüft
 */
export type ServerSupport = 'supported' | 'unsupported' | 'unknown';

export interface ProjectSummary {
  provider: ProviderId;
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
  serverSupport: ServerSupport;
  /** Nur CurseForge: der Autor stellt ein fertiges Serverpaket bereit. */
  hasServerPack?: boolean;
}

export interface SearchResponse {
  hits: ProjectSummary[];
  total: number;
}

export interface ProjectVersion {
  provider: ProviderId;
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
  /** Nur bei CurseForge: manche Autoren verbieten API-Downloads. */
  downloadBlocked?: boolean;
  /** Nur bei CurseForge: ID des vom Autor bereitgestellten Serverpakets. */
  serverPackFileId?: number | null;
  /** Nur bei CurseForge: diese Datei *ist* bereits ein Serverpaket. */
  isServerPack?: boolean;
}

/** Ergebnis der Analyse eines Modpack-Archivs. */
export interface ResolvedModpack {
  name: string;
  version: string;
  minecraftVersion: string;
  /** itzg-TYPE: FORGE | NEOFORGE | FABRIC | QUILT | VANILLA */
  loader: string;
  loaderVersion: string | null;
}
