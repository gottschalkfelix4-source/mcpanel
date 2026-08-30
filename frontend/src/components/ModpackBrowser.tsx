import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Download, ExternalLink, Package, Search, Server as ServerIcon, User } from 'lucide-react';
import { api } from '../lib/api';
import { formatCompact, formatDate } from '../lib/format';
import type { ProjectSummary, ProjectVersion } from '../lib/types';
import { Badge, Button, EmptyState, ErrorNote, InfoNote, LoadingBlock, Modal, Spinner } from './ui';

type Provider = 'all' | 'modrinth' | 'curseforge';
type CatalogType = 'modpack' | 'mod' | 'plugin';

const SEARCH_PLACEHOLDER: Record<CatalogType, string> = {
  modpack: 'Modpacks durchsuchen …',
  mod: 'Mods durchsuchen …',
  plugin: 'Plugins durchsuchen …',
};

const PROVIDER_STYLES: Record<string, string> = {
  modrinth: 'border-emerald/40 bg-emerald/15 text-emerald',
  curseforge: 'border-gold/40 bg-gold/15 text-gold',
};

/** Zeigt an, wie gut ein Projekt serverseitig belegt ist. */
function ServerSupportBadge({ project }: { project: ProjectSummary }) {
  if (project.serverSupport === 'unsupported') {
    return (
      <Badge tone="red" className="!text-[9px]">
        kein Server
      </Badge>
    );
  }
  if (project.serverSupport === 'supported') {
    return (
      <Badge tone="green" className="!text-[9px]">
        {project.hasServerPack ? 'Serverpaket' : 'servertauglich'}
      </Badge>
    );
  }
  return (
    <Badge className="!text-[9px]" >
      ungeprüft
    </Badge>
  );
}

function useDebounced<T>(value: T, delay = 400): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function ModpackBrowser({
  type = 'modpack',
  onPick,
  actionLabel = 'Installieren',
}: {
  type?: CatalogType;
  onPick: (project: ProjectSummary, version: ProjectVersion) => unknown;
  actionLabel?: string;
}) {
  // Plugins laufen per Definition auf dem Server – der Servertauglichkeits-
  // filter und seine Abzeichen sagen dort nichts aus.
  const isPlugin = type === 'plugin';
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<Provider>('all');
  const [gameVersion, setGameVersion] = useState('');
  const [sort, setSort] = useState<'relevance' | 'downloads' | 'updated'>('relevance');
  const [serverOnly, setServerOnly] = useState(true);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ProjectSummary | null>(null);

  const debouncedQuery = useDebounced(query);

  // Ohne diesen Parameter filtert die Schnittstelle von sich aus auf
  // servertaugliche Projekte – bei Plugins waere das eine leere Aussage.
  const effectiveServerOnly = isPlugin ? false : serverOnly;

  useEffect(() => setPage(1), [debouncedQuery, provider, gameVersion, sort, effectiveServerOnly]);

  const providers = useQuery({
    queryKey: ['catalog-providers'],
    queryFn: () =>
      api.get<{ modrinth: { available: boolean }; curseforge: { available: boolean } }>(
        '/catalog/providers',
      ),
    staleTime: 300_000,
  });

  const versions = useQuery({
    queryKey: ['game-versions'],
    queryFn: () => api.get<{ release: string[] }>('/catalog/game-versions'),
    staleTime: 3_600_000,
  });

  const search = useQuery({
    queryKey: [
      'catalog-search', type, debouncedQuery, provider, gameVersion, sort, page, effectiveServerOnly,
    ],
    queryFn: () => {
      const params = new URLSearchParams({
        type,
        provider,
        sort,
        page: String(page),
        pageSize: '24',
        serverOnly: String(effectiveServerOnly),
      });
      if (debouncedQuery) params.set('q', debouncedQuery);
      if (gameVersion) params.set('gameVersion', gameVersion);
      return api.get<{
        hits: ProjectSummary[];
        total: number;
        sources: { provider: string; total: number; error: string | null }[];
      }>(`/catalog/search?${params}`);
    },
  });

  const cfAvailable = providers.data?.curseforge.available ?? false;
  const sourceErrors = useMemo(
    () => (search.data?.sources ?? []).filter((s) => s.error),
    [search.data],
  );

  return (
    <div className="space-y-4">
      {/* Filterleiste */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-450" />
          <input
            className="mc-input pl-8"
            placeholder={SEARCH_PLACEHOLDER[type]}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <select
          className="mc-select w-auto"
          value={gameVersion}
          onChange={(e) => setGameVersion(e.target.value)}
        >
          <option value="">Alle MC-Versionen</option>
          {(versions.data?.release ?? []).slice(0, 60).map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>

        <select
          className="mc-select w-auto"
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
        >
          <option value="relevance">Relevanz</option>
          <option value="downloads">Downloads</option>
          <option value="updated">Zuletzt aktualisiert</option>
        </select>
      </div>

      {/* Quellen */}
      <div className="flex flex-wrap items-center gap-1.5">
        {(['all', 'modrinth', 'curseforge'] as Provider[]).map((p) => {
          const disabled = p === 'curseforge' && !cfAvailable;
          return (
            <button
              key={p}
              disabled={disabled}
              onClick={() => setProvider(p)}
              className={clsx(
                'border px-3 py-1 text-xs font-bold uppercase tracking-wider transition',
                provider === p
                  ? 'border-grass-dark bg-grass/25 text-white'
                  : 'border-stone-700 bg-stone-800/60 text-stone-400 hover:text-stone-100',
                disabled && 'cursor-not-allowed opacity-40',
              )}
              title={disabled ? 'CurseForge-API-Key fehlt (Panel-Einstellungen)' : undefined}
            >
              {p === 'all' ? 'Alle Quellen' : p}
            </button>
          );
        })}

        {!isPlugin && (
          <button
            onClick={() => setServerOnly((v) => !v)}
            className={clsx(
              'ml-auto flex items-center gap-1.5 border px-3 py-1 text-xs font-bold uppercase tracking-wider transition',
              serverOnly
                ? 'border-grass-dark bg-grass/25 text-white'
                : 'border-stone-700 bg-stone-800/60 text-stone-400 hover:text-stone-100',
            )}
            title={
              serverOnly
                ? 'Es werden nur Packs gezeigt, die serverseitig laufen. Klicken für alle.'
                : 'Es werden alle Packs gezeigt – auch reine Client-Packs.'
            }
          >
            <ServerIcon size={12} />
            {serverOnly ? 'nur servertauglich' : 'alle Packs'}
          </button>
        )}
      </div>

      {!effectiveServerOnly && !isPlugin && (
        <InfoNote>
          Reine Client-Packs sind eingeblendet. Die laufen auf einem Server oft nicht oder
          nur nach Handarbeit – siehe das Abzeichen an den Treffern.
        </InfoNote>
      )}

      {sourceErrors.map((s) => (
        <ErrorNote key={s.provider}>
          {s.provider}: {s.error}
        </ErrorNote>
      ))}

      {/* Ergebnisse */}
      {search.isLoading ? (
        <LoadingBlock label="Suche läuft …" />
      ) : search.error ? (
        <ErrorNote>{(search.error as Error).message}</ErrorNote>
      ) : (search.data?.hits.length ?? 0) === 0 ? (
        <EmptyState
          icon={<Package size={40} />}
          title="Nichts gefunden"
          description="Versuche einen anderen Suchbegriff oder eine andere Version."
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {search.data!.hits.map((project, i) => (
              <button
                key={`${project.provider}-${project.id}`}
                onClick={() => setSelected(project)}
                className="mc-frame group animate-fade-in text-left transition-[transform,box-shadow,background-color] duration-200 hover:-translate-y-1 hover:!bg-[#4a4a53] hover:shadow-bevel-lift"
                style={{ animationDelay: `${Math.min(i, 8) * 0.04}s`, animationFillMode: 'backwards' }}
              >
                <div className="mc-frame-inner flex gap-3 p-3">
                  <div className="mc-well h-14 w-14 shrink-0 overflow-hidden !border-stone-950">
                    {project.iconUrl ? (
                      <img src={project.iconUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <div className="grid h-full w-full place-items-center text-stone-500">
                        <Package size={22} />
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <h4 className="truncate text-sm font-bold text-stone-50 group-hover:text-white">
                        {project.name}
                      </h4>
                      <span
                        className={clsx(
                          'mc-badge shrink-0 !text-[9px]',
                          PROVIDER_STYLES[project.provider],
                        )}
                      >
                        {project.provider === 'modrinth' ? 'MR' : 'CF'}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs leading-snug text-stone-350">
                      {project.summary}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-stone-450">
                      <span className="flex items-center gap-1 font-mono">
                        <Download size={11} /> {formatCompact(project.downloads)}
                      </span>
                      {project.author && (
                        <span className="flex items-center gap-1 truncate">
                          <User size={11} /> {project.author}
                        </span>
                      )}
                      {!isPlugin && <ServerSupportBadge project={project} />}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>

          <div className="flex items-center justify-center gap-2 pt-2">
            <Button variant="ghost" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              Zurück
            </Button>
            <span className="px-2 font-mono text-sm text-stone-350">Seite {page}</span>
            <Button
              variant="ghost"
              disabled={(search.data?.hits.length ?? 0) < 12}
              onClick={() => setPage((p) => p + 1)}
            >
              Weiter
            </Button>
          </div>
        </>
      )}

      <VersionPicker
        project={selected}
        onClose={() => setSelected(null)}
        actionLabel={actionLabel}
        showServerPack={!isPlugin}
        onPick={async (project, version) => {
          await onPick(project, version);
          setSelected(null);
        }}
      />
    </div>
  );
}

function VersionPicker({
  project,
  onClose,
  onPick,
  actionLabel,
  showServerPack,
}: {
  project: ProjectSummary | null;
  onClose: () => void;
  onPick: (project: ProjectSummary, version: ProjectVersion) => unknown;
  actionLabel: string;
  /** Bei Plugins gibt es keine Client-/Server-Pakete, die man unterscheiden muesste. */
  showServerPack: boolean;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const versions = useQuery({
    queryKey: ['catalog-versions', project?.provider, project?.id],
    queryFn: () =>
      api.get<{ versions: ProjectVersion[] }>(`/catalog/${project!.provider}/${project!.id}/versions`),
    enabled: Boolean(project),
  });

  const list = useMemo(() => {
    const all = versions.data?.versions ?? [];
    if (!filter) return all;
    return all.filter(
      (v) =>
        v.name.toLowerCase().includes(filter.toLowerCase()) ||
        v.gameVersions.some((g) => g.includes(filter)),
    );
  }, [versions.data, filter]);

  if (!project) return null;

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          {project.name}
          {project.websiteUrl && (
            <a
              href={project.websiteUrl}
              target="_blank"
              rel="noreferrer"
              className="text-stone-450 transition hover:text-grass-light"
              title="Auf der Website ansehen"
            >
              <ExternalLink size={14} />
            </a>
          )}
        </span>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-stone-350">{project.summary}</p>

        <input
          className="mc-input"
          placeholder="Version filtern (z. B. 1.20.1) …"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />

        {versions.isLoading ? (
          <LoadingBlock label="Versionen werden geladen …" />
        ) : versions.error ? (
          <ErrorNote>{(versions.error as Error).message}</ErrorNote>
        ) : (
          <div className="mc-well max-h-[46vh] divide-y divide-stone-875 overflow-y-auto">
            {list.slice(0, 120).map((version, i) => (
              <div
                key={version.id}
                className="flex animate-slide-in items-center gap-3 p-2.5 transition-colors hover:bg-stone-600/[0.28]"
                style={{ animationDelay: `${Math.min(i, 10) * 0.03}s` }}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-stone-50">{version.name}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {version.gameVersions.slice(0, 4).map((g) => (
                      <Badge key={g} tone="blue" className="!text-[9px]">
                        {g}
                      </Badge>
                    ))}
                    {version.loaders.slice(0, 2).map((l) => (
                      <Badge key={l} tone="purple" className="!text-[9px]">
                        {l}
                      </Badge>
                    ))}
                    {showServerPack && version.provider === 'curseforge' && (
                      <Badge
                        tone={version.serverPackFileId ? 'green' : 'neutral'}
                        className="!text-[9px]"
                      >
                        {version.serverPackFileId ? 'Serverpaket' : 'nur Client-Paket'}
                      </Badge>
                    )}
                    <span className="font-mono text-[10px] text-stone-450">
                      {formatDate(version.datePublished)}
                    </span>
                  </div>
                </div>

                <Button
                  variant="primary"
                  className="!px-3 !py-1.5 !text-xs"
                  loading={busyId === version.id}
                  onClick={async () => {
                    setBusyId(version.id);
                    try {
                      await onPick(project, version);
                    } finally {
                      setBusyId(null);
                    }
                  }}
                >
                  {actionLabel}
                </Button>
              </div>
            ))}
            {list.length === 0 && (
              <p className="p-6 text-center text-sm text-stone-450">Keine passende Version.</p>
            )}
          </div>
        )}

        {versions.isFetching && !versions.isLoading && (
          <div className="flex justify-center">
            <Spinner />
          </div>
        )}
      </div>
    </Modal>
  );
}
