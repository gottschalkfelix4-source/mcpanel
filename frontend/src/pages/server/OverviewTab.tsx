import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, Clock, Cpu, HardDrive, MemoryStick, Package, Users, Wifi,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { formatBytes, formatDate, formatMemory, formatUptime } from '../../lib/format';
import type { TaskInfo } from '../../lib/types';
import { Badge, Panel } from '../../components/ui';
import { BarChart, PixelBar, PixelHead, useCountUp, useHistory } from '../../components/pixel';
import { useServer } from './ServerLayout';

export default function OverviewTab() {
  const { server, liveState, liveHealth, liveStats, players } = useServer();

  const tasks = useQuery({
    queryKey: ['server-tasks', server.id],
    queryFn: () => api.get<TaskInfo[]>(`/servers/${server.id}/tasks`),
    refetchInterval: 10_000,
  });

  const running = liveState === 'running';

  // Container-Limit als Bezugsgröße – der Java-Heap ist nur ein Teil davon.
  const memLimit = liveStats?.memoryLimit || server.memoryMb * 1024 * 1024;
  const memPercent = liveStats ? (liveStats.memoryUsed / Math.max(1, memLimit)) * 100 : 0;
  const cpuPercent = liveStats?.cpuPercent ?? 0;

  const cpuHistory = useHistory(running ? cpuPercent : 2, 40);
  const ramHistory = useHistory(running ? memPercent : 2, 40);

  // Beim Öffnen weich hochzählen
  const cpuCount = useCountUp(cpuPercent);
  const memCount = useCountUp(liveStats?.memoryUsed ?? 0);
  const diskCount = useCountUp(server.disk.total);

  const diskPending = server.disk.pending && server.disk.total === 0;
  const worldShare = server.disk.total > 0 ? (server.disk.data / server.disk.total) * 100 : 0;
  const quotaLimit = server.quota.diskLimitBytes;
  const quotaPercent = server.quota.diskPercent;
  const playerPercent = players && players.max > 0 ? (players.online / players.max) * 100 : 0;

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      {/* Kennzahlen */}
      <div className="grid gap-[18px] [grid-template-columns:repeat(auto-fit,minmax(230px,1fr))]">
        <Stat
          icon={<Activity size={13} />}
          tint="#17DD62"
          label="Status"
          value={liveState === 'running' ? 'Online' : liveState === 'starting' ? 'Startet' : 'Offline'}
          sub={
            !running
              ? 'Container gestoppt'
              : liveHealth === 'unhealthy'
                ? `seit ${formatUptime(server.startedAt)} · Status-Ping antwortet nicht`
                : `seit ${formatUptime(server.startedAt)} · Health-Ping OK`
          }
          percent={running ? 100 : 0}
          delay={0}
        />
        <Stat
          icon={<Cpu size={13} />}
          tint="#4AEDD9"
          label="CPU"
          value={running ? `${cpuCount.toFixed(1)} %` : '–'}
          sub="Anteil an allen Kernen"
          percent={cpuPercent}
          delay={0.06}
        />
        <Stat
          icon={<MemoryStick size={13} />}
          tint="#7FB238"
          label="Arbeitsspeicher"
          value={running ? formatBytes(memCount) : '–'}
          sub={`von ${formatBytes(memLimit)} Container-Limit · Java-Heap ${formatMemory(server.memoryMb)}`}
          percent={memPercent}
          delay={0.12}
        />
        <Stat
          icon={<HardDrive size={13} />}
          tint="#FFAA00"
          label="Speicherplatz"
          value={
            diskPending
              ? '…'
              : quotaLimit
                ? `${formatBytes(diskCount)} / ${formatBytes(quotaLimit)}`
                : formatBytes(diskCount)
          }
          sub={
            diskPending
              ? 'wird berechnet …'
              : quotaPercent !== null
                ? `${quotaPercent} % des Kontingents · Welt ${formatBytes(server.disk.data)} · Backups ${formatBytes(server.disk.backups)}`
                : `Welt ${formatBytes(server.disk.data)} · Backups ${formatBytes(server.disk.backups)}`
          }
          /* Mit Kontingent zeigt der Balken die Auslastung, ohne den Weltanteil. */
          percent={quotaPercent ?? worldShare}
          delay={0.18}
        />
      </div>

      {/* min-w-0: Grid-Kinder schrumpfen sonst nicht unter ihre Inhaltsbreite
          und schieben auf schmalen Screens die ganze Seite auf. */}
      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          {/* Live-Auslastung */}
          <Panel
            title="Auslastung · live"
            icon={<Activity size={16} />}
            actions={
              <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 font-mono text-[11px] text-stone-350">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-[9px] w-[9px] bg-diamond" />
                  CPU {running ? `${cpuPercent.toFixed(0)} %` : '–'}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-[9px] w-[9px] bg-grass-light" />
                  RAM {running && liveStats ? formatBytes(liveStats.memoryUsed, 1) : '–'}
                </span>
              </div>
            }
          >
            <div className="flex flex-col gap-4">
              <div>
                <BarChart values={cpuHistory} color="#4AEDD9" height={96} glow gridlines />
                <p className="mt-1.5 text-[10px] uppercase tracking-[0.12em] text-stone-450">
                  CPU · letzte 2 Minuten
                </p>
              </div>
              <div>
                <BarChart values={ramHistory} color="#7FB238" height={96} glow gridlines />
                <p className="mt-1.5 text-[10px] uppercase tracking-[0.12em] text-stone-450">
                  Arbeitsspeicher · Anteil am Container-Limit
                </p>
              </div>
            </div>
          </Panel>

          {/* Serverdetails */}
          <Panel title="Serverdetails" icon={<Wifi size={16} />}>
            <dl className="grid gap-x-6 gap-y-3.5 sm:grid-cols-2">
              <Detail label="Adresse" value={server.address} />
              <Detail label="Port" value={String(server.port)} />
              <Detail label="Typ" value={server.type} />
              <Detail label="Minecraft-Version" value={server.mcVersion} />
              <Detail label="Java-Heap" value={formatMemory(server.memoryMb)} />
              <Detail label="Besitzer" value={server.owner?.username ?? '–'} />
              <Detail label="Autostart" value={server.autoStart ? 'Aktiv' : 'Aus'} />
              <Detail label="Erstellt" value={formatDate(server.createdAt)} />
            </dl>

            {server.description && (
              <p className="mt-4 border-t border-stone-890 pt-3 text-sm text-stone-350">
                {server.description}
              </p>
            )}
          </Panel>

          {/* Modpack */}
          {server.modpack?.name && (
            <Panel
              title="Installiertes Modpack"
              icon={<Package size={16} />}
              actions={
                <Link to="../modpack">
                  <button className="mc-btn-ghost !px-3 !py-1.5 !text-xs">Verwalten</button>
                </Link>
              }
            >
              <div className="flex items-center gap-3.5">
                {server.modpack.iconUrl && (
                  <img
                    src={server.modpack.iconUrl}
                    alt=""
                    className="h-14 w-14 border border-stone-950 object-cover"
                    style={{ boxShadow: '0 4px 0 0 rgba(0,0,0,.5)' }}
                  />
                )}
                <div className="min-w-0">
                  <p className="truncate font-bold text-stone-50">{server.modpack.name}</p>
                  <p className="mt-0.5 text-sm text-stone-350">{server.modpack.versionName}</p>
                  <Badge
                    tone={server.modpack.provider === 'modrinth' ? 'green' : 'gold'}
                    className="mt-1.5"
                  >
                    {server.modpack.provider}
                  </Badge>
                </div>
              </div>
            </Panel>
          )}

          {/* Aktivität */}
          <Panel title="Letzte Aktionen" icon={<Clock size={16} />} bodyClassName="!p-0">
            {(tasks.data?.length ?? 0) === 0 ? (
              <p className="p-5 text-center text-sm text-stone-450">Noch keine Aktionen.</p>
            ) : (
              <ul className="m-0 list-none p-0">
                {tasks.data!.slice(0, 6).map((task, i) => (
                  <li
                    key={task.id}
                    className="flex animate-slide-in items-center gap-[13px] border-b border-stone-875 px-4 py-3 transition-colors last:border-b-0 hover:bg-stone-600/[0.28]"
                    style={{ animationDelay: `${i * 0.05}s` }}
                  >
                    <Badge
                      tone={task.status === 'DONE' ? 'green' : task.status === 'FAILED' ? 'red' : 'gold'}
                    >
                      {task.status === 'DONE' ? 'OK' : task.status === 'FAILED' ? 'Fehler' : 'Läuft'}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-xs text-stone-100">{task.type}</p>
                      <p className="mt-[3px] truncate text-xs text-stone-450">
                        {task.error ?? task.message}
                      </p>
                    </div>
                    <span className="shrink-0 font-mono text-[11px] text-stone-450">
                      {formatDate(task.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        {/* Spieler */}
        <Panel
          title="Spieler online"
          icon={<Users size={16} />}
          className="h-fit min-w-0"
          actions={
            <span className="font-mono text-[11px] text-stone-350">
              {players ? `${players.online}/${players.max}` : '–'}
            </span>
          }
        >
          <PixelBar percent={playerPercent} color="#7FE028" glow className="mb-3.5" />

          {!players ? (
            <p className="py-6 text-center text-sm text-stone-450">
              {running ? 'Warte auf Serverantwort …' : 'Server ist offline.'}
            </p>
          ) : players.players.length === 0 ? (
            <p className="py-6 text-center text-sm text-stone-450">
              Gerade ist niemand online ({players.online}/{players.max}).
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-[7px] p-0">
              {players.players.map((name, i) => (
                <li
                  key={name}
                  className="mc-well flex animate-slide-in items-center gap-[11px] px-[11px] py-[9px] transition-[border-color,transform] hover:translate-x-[3px] hover:border-grass-light"
                  style={{ animationDelay: `${i * 0.04}s` }}
                >
                  <PixelHead name={name} />
                  <span className="flex-1 truncate font-mono text-[13px] text-stone-100">{name}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

/** Kennzahlkarte mit getöntem Symbol und Anteilsbalken. */
function Stat({
  icon,
  tint,
  label,
  value,
  sub,
  percent,
  delay,
}: {
  icon: React.ReactNode;
  tint: string;
  label: string;
  value: React.ReactNode;
  sub: React.ReactNode;
  percent: number;
  delay: number;
}) {
  return (
    <div
      className={clsx(
        'mc-frame animate-fade-in transition-[transform,box-shadow] duration-200',
        'hover:-translate-y-1 hover:shadow-bevel-lift',
      )}
      style={{ animationDelay: `${delay}s`, animationFillMode: 'backwards' }}
    >
      <div className="mc-frame-inner overflow-hidden p-4">
        <div className="flex items-center gap-[9px] text-[10px] font-bold uppercase tracking-[0.12em] text-stone-400">
          <span style={{ color: tint }}>{icon}</span>
          {label}
        </div>
        <p className="mt-3 font-mono text-[26px] leading-none text-stone-50 text-shadow-pixel">
          {value}
        </p>
        <p className="mt-2 text-[11px] leading-[1.45] text-stone-450">{sub}</p>
        <PixelBar percent={percent} color={tint} height={6} className="mt-3" />
      </div>
    </div>
  );
}

/** Detailzeile mit Akzentkante links. */
function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-l-[3px] border-stone-700 pl-[11px] transition-colors hover:border-grass-light">
      <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-stone-450">{label}</dt>
      <dd className="mt-1 font-mono text-sm text-stone-100">{value}</dd>
    </div>
  );
}
