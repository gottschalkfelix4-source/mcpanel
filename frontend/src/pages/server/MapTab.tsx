import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDrive, Map as MapIcon, Maximize2, Puzzle, Users } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { Badge, Button, ErrorNote, InfoNote, LoadErrorBlock, LoadingBlock, Panel, useToast } from '../../components/ui';
import { TaskProgress } from '../../components/TaskProgress';
import { ChunkCanvas, type ChunkCanvasHandle } from '../../components/worldmap/ChunkCanvas';
import { PregenPanel, type PregenForm } from '../../components/worldmap/PregenPanel';
import { TrimPanel, type TrimForm } from '../../components/worldmap/TrimPanel';
import { formatBytes } from '../../lib/format';
import {
  DIMENSION_IDS, DIMENSION_LABELS, type Area, type ChunkMapData, type Dimension, type MapInfo, type PlayersResponse, type WorldSize,
} from '../../components/worldmap/types';
import { useServer } from './ServerLayout';

const ADDON_TASKS = ['map.addons'];

/**
 * Reiter „Karte“: Gelände über BlueMap (eingebettet), daneben eine eigene
 * Übersicht der generierten Chunks mit Spielern und Vorgenerierung über Chunky.
 */
export default function MapTab() {
  const { server, can, liveState } = useServer();
  const running = liveState === 'running';
  const canvasRef = useRef<ChunkCanvasHandle>(null);
  const queryClient = useQueryClient();

  const info = useQuery({
    queryKey: ['map', server.id],
    queryFn: () => api.get<MapInfo>(`/servers/${server.id}/map`),
    refetchInterval: (query) => (query.state.data?.job?.status === 'running' ? 3000 : 20_000),
  });
  const jobRunning = info.data?.job?.status === 'running';

  const [form, setForm] = useState<PregenForm>({
    dimension: 'overworld', shape: 'circle', centerX: 0, centerZ: 0, radius: 2500,
    onlyWhenEmpty: false, tpsGuard: true, pauseRender: true,
  });
  const [trimForm, setTrimForm] = useState<TrimForm>({
    dimension: 'overworld', shape: 'circle', centerX: 0, centerZ: 0, radius: 2500, mode: 'outside',
  });
  /** Welches Panel die Karte gerade zeigt – das zuletzt benutzte. */
  const [tool, setTool] = useState<'pregen' | 'trim'>('pregen');
  /** Klick auf die Karte setzt den Mittelpunkt dieses Panels. */
  const [picking, setPickingFor] = useState<'pregen' | 'trim' | null>(null);
  const [viewDim, setViewDim] = useState<Dimension>('overworld');
  const [layer, setLayer] = useState<'terrain' | 'chunks'>('chunks');
  const bluemapInstalled = Boolean(info.data?.addons.bluemap.installed);

  // Gelände ist die Vorgabe, sobald BlueMap da ist.
  const layerChosen = useRef(false);
  useEffect(() => {
    if (!layerChosen.current && bluemapInstalled) setLayer('terrain');
  }, [bluemapInstalled]);

  const job = info.data?.job;
  const activeJob = job && (job.status === 'running' || job.status === 'paused') ? job : null;
  // Während eines Laufs zeigt die Karte dessen Dimension.
  useEffect(() => { if (activeJob) setViewDim(activeJob.dimension); }, [activeJob?.dimension]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!activeJob) setViewDim(form.dimension); }, [form.dimension]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!activeJob) setViewDim(trimForm.dimension); }, [trimForm.dimension]); // eslint-disable-line react-hooks/exhaustive-deps

  const worldSize = useQuery({
    queryKey: ['map-size', server.id],
    queryFn: () => api.get<WorldSize>(`/servers/${server.id}/map/size`),
    refetchInterval: jobRunning ? 30_000 : 120_000,
  });

  const chunks = useQuery({
    queryKey: ['map-chunks', server.id, viewDim],
    queryFn: () => api.get<ChunkMapData>(`/servers/${server.id}/map/chunks?dimension=${viewDim}`),
    refetchInterval: jobRunning ? 10_000 : 60_000,
    enabled: layer === 'chunks',
  });
  const players = useQuery({
    queryKey: ['map-players', server.id],
    queryFn: () => api.get<PlayersResponse>(`/servers/${server.id}/map/players`),
    refetchInterval: 2000,
    enabled: running,
  });

  const area: Area | null = useMemo(() => {
    if (activeJob) return activeJob;
    if (tool === 'trim') return viewDim === trimForm.dimension ? { ...trimForm, trim: trimForm.mode } : null;
    if (!info.data?.canPregen || viewDim !== form.dimension) return null;
    return form;
  }, [activeJob, info.data?.canPregen, viewDim, form, tool, trimForm]);

  if (info.isLoading) return <LoadingBlock label="Karte wird geladen …" />;
  if (!info.data) return <LoadErrorBlock error={info.error} onRetry={() => void info.refetch()} />;
  const data = info.data;
  const playerList = players.data?.players ?? [];

  return (
    <div className="flex flex-wrap items-start gap-5 animate-fade-in">
      <Panel
        className="min-w-0 flex-[999_1_640px]"
        bodyClassName="!p-0"
        title="Karte"
        icon={<MapIcon size={16} />}
        actions={
          <div className="flex flex-wrap gap-2">
            {layer === 'chunks' && (
              <Toggle3 value={viewDim} onChange={(v) => setViewDim(v as Dimension)}
                options={(['overworld', 'nether', 'end'] as Dimension[]).map((d) => ({ value: d, label: DIMENSION_LABELS[d] }))} />
            )}
            <Toggle3 value={layer} onChange={(v) => { layerChosen.current = true; setLayer(v as 'terrain' | 'chunks'); }}
              options={[{ value: 'terrain', label: 'Gelände', disabled: !bluemapInstalled }, { value: 'chunks', label: 'Chunk-Status' }]} />
          </div>
        }
      >
        {layer === 'terrain' && bluemapInstalled ? (
          <BlueMapFrame serverId={server.id} running={running} accepted={data.bluemapAccepted} />
        ) : (
          <>
            <ChunkCanvas
              ref={canvasRef}
              data={chunks.data}
              players={playerList}
              dimensionId={DIMENSION_IDS[viewDim]}
              area={area}
              current={activeJob?.status === 'running' && !activeJob.autoPaused ? activeJob.current : null}
              onPick={picking ? (x, z) => {
                if (picking === 'trim') setTrimForm({ ...trimForm, centerX: x, centerZ: z });
                else setForm({ ...form, centerX: x, centerZ: z });
                setPickingFor(null);
              } : undefined}
            />
            {chunks.error && <div className="p-3"><ErrorNote>{(chunks.error as Error).message}</ErrorNote></div>}
          </>
        )}
        <p className="border-t border-stone-890 px-4 py-2.5 text-xs text-stone-400">
          {layer === 'terrain'
            ? 'Gelände und Spieler von BlueMap – neu generierte Gebiete erscheinen, sobald BlueMap sie gerendert hat.'
            : 'Aus den Regionsdateien der Welt – zeigt jeden gespeicherten Chunk, auch bei gestopptem Server. Spieler alle 2 s.'}
          {layer === 'chunks' && chunks.data && ` ${DIMENSION_LABELS[viewDim]}: ${chunks.data.chunks.toLocaleString('de-DE')} Chunks, ${formatBytes(chunks.data.bytes)} in Regionsdateien.`}
        </p>
      </Panel>

      <aside className="flex min-w-0 flex-[1_1_340px] flex-col gap-5">
        <AddonsPanel serverId={server.id} info={data} canInstall={data.canPregen} running={running}
          onDone={() => { void queryClient.invalidateQueries({ queryKey: ['map', server.id] }); }} />
        <WorldSizePanel size={worldSize.data} loading={worldSize.isLoading} />
        <div onPointerDownCapture={() => setTool('pregen')} onFocusCapture={() => setTool('pregen')}>
          <PregenPanel serverId={server.id} info={data} form={form} setForm={setForm} picking={picking === 'pregen'}
            setPicking={(value) => setPickingFor(value ? 'pregen' : null)} running={running} />
        </div>
        {(data.canTrim || data.canPregen) && !activeJob && (
          <div onPointerDownCapture={() => setTool('trim')} onFocusCapture={() => setTool('trim')}>
            <TrimPanel serverId={server.id} serverName={server.name} info={data} form={trimForm} setForm={setTrimForm}
              picking={picking === 'trim'} setPicking={(value) => setPickingFor(value ? 'trim' : null)} running={running || liveState === 'starting'}
              onDone={() => { void queryClient.invalidateQueries({ queryKey: ['map', server.id] }); }} />
          </div>
        )}
        <Panel title={`Spieler · ${players.data?.online ?? 0} online`} icon={<Users size={16} />} bodyClassName="!p-0">
          {!running ? (
            <p className="p-4 text-sm text-stone-400">Der Server ist aus.</p>
          ) : players.data?.unsupported ? (
            <p className="p-4 text-sm text-stone-400">Positionen gibt es erst ab Minecraft 1.13 (Befehl <code>data</code>).</p>
          ) : playerList.length === 0 ? (
            <p className="p-4 text-sm text-stone-400">Gerade ist niemand online.</p>
          ) : (
            <ul className="divide-y divide-stone-700">
              {playerList.map((player) => {
                const dim = (Object.keys(DIMENSION_IDS) as Dimension[]).find((d) => DIMENSION_IDS[d] === player.dimension);
                return (
                  <li key={player.name} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block font-bold">{player.name}</span>
                      <span className="block font-mono text-xs text-stone-400">
                        {dim ? DIMENSION_LABELS[dim] : player.dimension ?? '?'} · X {Math.round(player.x)} · Z {Math.round(player.z)}
                      </span>
                    </span>
                    {dim && can('console.read') && (
                      <Button variant="ghost" className="!px-2.5 !py-1.5 !text-xs" onClick={() => {
                        layerChosen.current = true;
                        setLayer('chunks');
                        setViewDim(dim);
                        setTimeout(() => canvasRef.current?.focus(player.x, player.z), 50);
                      }}>Zeigen</Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </aside>
    </div>
  );
}

function WorldSizePanel({ size, loading }: { size: WorldSize | undefined; loading: boolean }) {
  return (
    <Panel title="Weltgröße" icon={<HardDrive size={16} />}>
      {!size ? (
        <p className="text-sm text-stone-400">{loading ? 'Wird gezählt …' : 'Keine Welt gefunden.'}</p>
      ) : (
        <div className="space-y-2">
          <p className="font-pixel text-2xl text-stone-50">{size.partial ? '≥ ' : ''}{formatBytes(size.bytes, 2)}</p>
          <ul className="space-y-0.5 text-xs text-stone-400">
            {size.folders.map((folder) => (
              <li key={folder.name} className="flex justify-between gap-2"><span className="font-mono">{folder.name}/</span><span>{formatBytes(folder.bytes)}</span></li>
            ))}
            <li>{size.files.toLocaleString('de-DE')} Dateien</li>
          </ul>
        </div>
      )}
    </Panel>
  );
}

function Toggle3({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string; disabled?: boolean }[] }) {
  return (
    <div role="group" className="flex border border-stone-950">
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={value === option.value} disabled={option.disabled}
          title={option.disabled ? 'Braucht BlueMap' : undefined}
          onClick={() => onChange(option.value)}
          className={clsx('border-r border-stone-950 px-3 py-1.5 text-xs font-bold last:border-r-0 disabled:cursor-not-allowed disabled:opacity-40',
            value === option.value ? 'bg-grass text-white' : 'bg-stone-700 text-stone-300 hover:text-stone-50')}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * BlueMap im Panel. Die Seite läuft in einer Sandbox ohne Zugriff auf das
 * Panel (siehe Backend `bluemapProxy.ts`), der Link gilt einige Stunden.
 */
function BlueMapFrame({ serverId, running, accepted }: { serverId: string; running: boolean; accepted: boolean }) {
  const token = useQuery({
    queryKey: ['map-view-token', serverId],
    queryFn: () => api.post<{ url: string }>(`/servers/${serverId}/map/view-token`),
    staleTime: 6 * 3600_000,
  });
  if (!running) {
    return <div className="p-6"><InfoNote>BlueMap zeigt die Karte, solange der Server läuft. Die Chunk-Status-Ansicht funktioniert auch jetzt.</InfoNote></div>;
  }
  if (token.isLoading) return <LoadingBlock label="Karte wird verbunden …" />;
  if (!token.data) return <div className="p-6"><LoadErrorBlock error={token.error} onRetry={() => void token.refetch()} /></div>;
  return (
    <div className="relative">
      {!accepted && <div className="p-3"><InfoNote>BlueMap braucht die Zustimmung zum Download der Mojang-Grafiken – siehe „Erweiterungen“.</InfoNote></div>}
      <iframe
        title="BlueMap-Karte"
        src={token.data.url}
        sandbox="allow-scripts allow-popups allow-downloads"
        className="block h-[min(620px,70vh)] w-full border-0 bg-stone-well"
      />
      <a href={token.data.url} target="_blank" rel="noreferrer" aria-label="Karte im neuen Tab öffnen"
        className="absolute right-3 top-3 grid h-9 w-9 place-items-center border border-stone-950 bg-stone-700 text-stone-50 hover:bg-stone-600">
        <Maximize2 size={15} />
      </a>
    </div>
  );
}

function AddonsPanel({ serverId, info, canInstall, running, onDone }: { serverId: string; info: MapInfo; canInstall: boolean; running: boolean; onDone: () => void }) {
  const toast = useToast();
  const { chunky, bluemap } = info.addons;
  const missing = { chunky: !chunky.installed && Boolean(chunky.available), bluemap: !bluemap.installed && Boolean(bluemap.available) };
  const [want, setWant] = useState({ chunky: true, bluemap: true });
  const [accept, setAccept] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const install = useMutation({
    mutationFn: () => api.post<{ taskId: string }>(`/servers/${serverId}/map/addons`, {
      chunky: missing.chunky && want.chunky,
      bluemap: missing.bluemap && want.bluemap,
      acceptDownload: accept,
      restart: true,
    }),
    onSuccess: (res) => { setTaskId(res.taskId); toast.success('Einrichtung gestartet.'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const accept_ = useMutation({
    mutationFn: () => api.post<{ applied: boolean }>(`/servers/${serverId}/map/bluemap-accept`),
    onSuccess: (res) => {
      toast.success(res.applied ? 'Erlaubt – BlueMap beginnt mit dem Rendern.' : 'Erlaubt – wird beim nächsten Start von BlueMap übernommen.');
      onDone();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const anyMissing = missing.chunky || missing.bluemap;
  const needsAccept = missing.bluemap && want.bluemap;
  const lines = (['chunky', 'bluemap'] as const).map((key) => {
    const state = info.addons[key];
    const label = key === 'chunky' ? 'Chunky' : 'BlueMap';
    const status = state.installed
      ? <Badge tone="green">installiert</Badge>
      : state.lookupFailed ? <Badge tone="gold">Modrinth nicht erreichbar</Badge>
      : state.available ? <Badge tone="gold">fehlt · {state.available.version}</Badge>
      : <Badge tone="neutral">nicht für {info.loader} {info.mcVersion}</Badge>;
    return (
      <div key={key} className="flex items-center justify-between gap-2 text-sm">
        <span className="min-w-0">
          <span className="font-semibold">{label}</span>{' '}
          <span className="text-xs text-stone-400">{key === 'chunky' ? 'Vorgenerierung' : 'Gelände-Karte'}{state.file ? ` · ${state.file}` : ''}</span>
        </span>
        {status}
      </div>
    );
  });

  return (
    <Panel title="Erweiterungen" icon={<Puzzle size={16} />}>
      <div className="space-y-3">
        {lines}
        {info.loader === 'VANILLA' && (
          <InfoNote>Ein Vanilla-Server lädt keine Mods. Die Chunk-Status-Karte und die Spieler gehen trotzdem; für Vorgenerierung und Gelände den Servertyp auf Fabric, Forge, NeoForge oder Paper stellen.</InfoNote>
        )}
        <TaskProgress serverId={serverId} types={ADDON_TASKS} taskId={taskId ?? undefined} onRunningChange={setBusy} onFinished={onDone} />
        {bluemap.installed && !info.bluemapAccepted && canInstall && (
          <div className="space-y-2 border-t border-stone-700 pt-3">
            <p className="text-sm">BlueMap zeichnet erst, wenn sie Spielgrafiken von Mojang laden darf (<code className="font-mono text-xs">accept-download</code>).</p>
            <Button loading={accept_.isPending} onClick={() => accept_.mutate()}>Mojang-Download erlauben</Button>
          </div>
        )}
        {anyMissing && canInstall && (
          <div className="space-y-2.5 border-t border-stone-700 pt-3">
            {missing.chunky && missing.bluemap && (
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-grass-light" checked={want.chunky} onChange={(e) => setWant({ ...want, chunky: e.target.checked })} />Chunky</label>
                <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-grass-light" checked={want.bluemap} onChange={(e) => setWant({ ...want, bluemap: e.target.checked })} />BlueMap</label>
              </div>
            )}
            {needsAccept && (
              <label className="flex items-start gap-2 text-sm leading-snug">
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-grass-light" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
                <span>BlueMap darf Spielgrafiken von Mojang laden. <span className="text-stone-400">Ohne diese Zustimmung zeichnet BlueMap keine Karte.</span></span>
              </label>
            )}
            <p className="text-xs text-stone-400">
              Reine Server-Erweiterungen von Modrinth – Spieler müssen nichts installieren.{running ? ' Der Server startet dafür einmal neu.' : ''} Die Karte läuft nur über das Panel, ohne offenen Port.
            </p>
            <Button variant="primary" className="w-full" loading={install.isPending || busy}
              disabled={(needsAccept && !accept) || !((missing.chunky && want.chunky) || (missing.bluemap && want.bluemap))}
              onClick={() => install.mutate()}>
              {running ? 'Installieren und neu starten' : 'Installieren'}
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}
