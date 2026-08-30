import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search, Server as ServerIcon } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { ServerSummary } from '../lib/types';
import { ServerCard } from '../components/ServerCard';
import { SkeletonServerCard } from '../components/pixel';
import { Button, EmptyState, ErrorNote, Panel } from '../components/ui';

export default function ServersPage() {
  const { user } = useAuth();
  // Server anlegen ist Administratorensache – Mitglieder bekommen Zugriff
  // auf einen bestehenden Server statt einen eigenen.
  const canCreate = user?.role === 'ADMIN';
  const [search, setSearch] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['servers'],
    queryFn: () => api.get<ServerSummary[]>('/servers'),
    refetchInterval: 5000,
  });

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    if (!q) return data;
    return data.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        (s.modpack?.name ?? '').toLowerCase().includes(q),
    );
  }, [data, search]);

  const online = data?.filter((s) => s.state === 'running').length ?? 0;
  const totalPlayers = (data ?? []).reduce((sum, s) => sum + (s.players?.online ?? 0), 0);

  return (
    <div className="flex flex-col gap-[22px] animate-fade-in">
      <div className="flex flex-wrap items-end justify-between gap-[18px]">
        <div>
          <h1 className="heading-pixel text-[17px]">Deine Server</h1>

          <p className="mt-[11px] flex flex-wrap items-center gap-2.5 text-[13px] text-stone-300">
            <span className="font-mono">{data?.length ?? '–'} Server</span>
            <Divider />
            <span className="inline-flex items-center gap-[7px] font-semibold text-emerald">
              <span className="h-2 w-2 animate-ring bg-emerald" />
              {online} online
            </span>
            <Divider />
            <span className="font-mono">{totalPlayers} Spieler</span>
          </p>
        </div>

        <div className="flex w-full flex-wrap items-center gap-2.5 sm:w-auto">
          <div className="relative min-w-0 flex-1 sm:flex-none">
            <Search
              size={15}
              className="pointer-events-none absolute left-[11px] top-1/2 -translate-y-1/2 text-stone-450"
            />
            <input
              className="mc-input !py-2.5 pl-[34px] sm:w-[230px]"
              placeholder="Suchen …"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {canCreate && (
            <Link to="/servers/new">
              <Button variant="primary" icon={<Plus size={16} />}>
                Neuer Server
              </Button>
            </Link>
          )}
        </div>
      </div>

      {error && <ErrorNote>{(error as Error).message}</ErrorNote>}

      {isLoading ? (
        <div className="grid gap-[18px] [grid-template-columns:repeat(auto-fill,minmax(min(100%,360px),1fr))]">
          {[0, 1, 2].map((i) => (
            <SkeletonServerCard key={i} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<ServerIcon size={44} />}
            title={data?.length ? 'Nichts gefunden' : 'Noch kein Server'}
            description={
              data?.length
                ? 'Keine Server passen zu deiner Suche.'
                : canCreate
                  ? 'Lege deinen ersten Minecraft-Server an – Vanilla, Paper oder direkt ein komplettes Modpack.'
                  : 'Sobald dich jemand zu einem Server einlädt, steht er hier.'
            }
            action={
              !data?.length && canCreate && (
                <Link to="/servers/new">
                  <Button variant="primary" icon={<Plus size={16} />}>
                    Server erstellen
                  </Button>
                </Link>
              )
            }
          />
        </Panel>
      ) : (
        <div className="grid gap-[18px] [grid-template-columns:repeat(auto-fill,minmax(min(100%,360px),1fr))]">
          {filtered.map((server) => (
            <ServerCard key={server.id} server={server} />
          ))}
        </div>
      )}
    </div>
  );
}

function Divider() {
  return <span className="h-3 w-px bg-stone-600" />;
}
