import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Ban, Crown, ListChecks, LogOut, Plus, ShieldCheck, UserMinus, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { Badge, Button, EmptyState, LoadingBlock, Panel, useToast } from '../../components/ui';
import { PixelHead } from '../../components/pixel';
import { useServer } from './ServerLayout';

interface PlayerLists {
  ops: { uuid: string; name: string; level: number }[];
  whitelist: { uuid: string; name: string }[];
  banned: { uuid: string; name: string; reason?: string }[];
}

type Action =
  | 'op' | 'deop' | 'whitelistAdd' | 'whitelistRemove'
  | 'ban' | 'pardon' | 'kick';

/** Pixelkopf im Design-Look – keine Anfrage an fremde Bilddienste. */
const Avatar = PixelHead;

export default function PlayersTab() {
  const { server, can, liveState, players } = useServer();
  const toast = useToast();
  const [newName, setNewName] = useState('');

  const lists = useQuery({
    queryKey: ['player-lists', server.id],
    queryFn: () => api.get<PlayerLists>(`/servers/${server.id}/config/players`),
    refetchInterval: 20_000,
  });

  const act = useMutation({
    mutationFn: (payload: { action: Action; player: string; reason?: string }) =>
      api.post<{ response: string }>(`/servers/${server.id}/config/players/${payload.action}`, {
        player: payload.player,
        reason: payload.reason,
      }),
    onSuccess: (res) => {
      toast.success(res.response?.trim() || 'Erledigt.');
      setTimeout(() => void lists.refetch(), 600);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const canEdit = can('config.edit');
  const offline = liveState !== 'running';

  function run(action: Action, player: string) {
    if (!player.trim()) return;
    act.mutate({ action, player: player.trim() });
  }

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      {offline && (
        <div className="mc-frame animate-pop-in !border-gold/40">
          <div className="mc-frame-inner flex items-center gap-2.5 p-3 text-sm text-gold">
            Der Server ist offline. Spieleraktionen brauchen einen laufenden Server – die Listen
            unten zeigen den gespeicherten Stand.
          </div>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Online */}
        <Panel
          title="Gerade online"
          icon={<Users size={16} />}
          subtitle={players ? `${players.online} von ${players.max}` : undefined}
          bodyClassName="!p-0"
        >
          {!players || players.players.length === 0 ? (
            <EmptyState
              icon={<Users size={36} />}
              title="Niemand online"
              description={offline ? 'Starte den Server, damit Spieler beitreten können.' : undefined}
            />
          ) : (
            <ul className="divide-y divide-stone-875">
              {players.players.map((name, i) => (
                <li
                  key={name}
                  className="flex animate-slide-in items-center gap-3 px-4 py-2.5 transition-colors hover:bg-stone-600/[0.28]"
                  style={{ animationDelay: `${Math.min(i, 10) * 0.04}s` }}
                >
                  <Avatar name={name} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-stone-100">{name}</span>
                  {canEdit && (
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        className="!px-2 !py-1 !text-[11px]"
                        icon={<Crown size={12} />}
                        onClick={() => run('op', name)}
                        title="Zum Operator machen"
                      />
                      <Button
                        variant="ghost"
                        className="!px-2 !py-1 !text-[11px]"
                        icon={<LogOut size={12} />}
                        onClick={() => run('kick', name)}
                        title="Kicken"
                      />
                      <Button
                        variant="danger"
                        className="!px-2 !py-1 !text-[11px]"
                        icon={<Ban size={12} />}
                        onClick={() => run('ban', name)}
                        title="Bannen"
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* Whitelist */}
        <Panel
          title="Whitelist"
          icon={<ListChecks size={16} />}
          subtitle="Nur diese Spieler dürfen beitreten, wenn die Whitelist aktiv ist."
          bodyClassName="!p-0"
        >
          {canEdit && (
            <div className="flex gap-2 border-b border-stone-890 bg-stone-well/40 p-3">
              <input
                className="mc-input"
                placeholder="Minecraft-Name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    run('whitelistAdd', newName);
                    setNewName('');
                  }
                }}
              />
              <Button
                variant="primary"
                icon={<Plus size={15} />}
                disabled={offline || !newName.trim()}
                onClick={() => {
                  run('whitelistAdd', newName);
                  setNewName('');
                }}
              >
                Hinzufügen
              </Button>
            </div>
          )}

          {lists.isLoading ? (
            <LoadingBlock />
          ) : (lists.data?.whitelist.length ?? 0) === 0 ? (
            <EmptyState icon={<ListChecks size={34} />} title="Whitelist ist leer" />
          ) : (
            <ul className="max-h-72 divide-y divide-stone-875 overflow-y-auto">
              {lists.data!.whitelist.map((entry, i) => (
                <li
                  key={entry.uuid}
                  className="flex animate-slide-in items-center gap-3 px-4 py-2 transition-colors hover:bg-stone-600/[0.28]"
                  style={{ animationDelay: `${Math.min(i, 10) * 0.04}s` }}
                >
                  <Avatar name={entry.name} size={24} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-stone-100">{entry.name}</span>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      className="!px-2 !py-1 !text-[11px]"
                      icon={<UserMinus size={12} />}
                      disabled={offline}
                      onClick={() => run('whitelistRemove', entry.name)}
                      title="Entfernen"
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* Operatoren */}
        <Panel title="Operatoren" icon={<ShieldCheck size={16} />} bodyClassName="!p-0">
          {(lists.data?.ops.length ?? 0) === 0 ? (
            <EmptyState icon={<ShieldCheck size={34} />} title="Keine Operatoren" />
          ) : (
            <ul className="divide-y divide-stone-875">
              {lists.data!.ops.map((op, i) => (
                <li
                  key={op.uuid}
                  className="flex animate-slide-in items-center gap-3 px-4 py-2 transition-colors hover:bg-stone-600/[0.28]"
                  style={{ animationDelay: `${Math.min(i, 10) * 0.04}s` }}
                >
                  <Avatar name={op.name} size={24} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-stone-100">{op.name}</span>
                  <Badge tone="gold">Level {op.level}</Badge>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      className="!px-2 !py-1 !text-[11px]"
                      disabled={offline}
                      onClick={() => run('deop', op.name)}
                    >
                      Entziehen
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* Bans */}
        <Panel title="Gesperrte Spieler" icon={<Ban size={16} />} bodyClassName="!p-0">
          {(lists.data?.banned.length ?? 0) === 0 ? (
            <EmptyState icon={<Ban size={34} />} title="Keine Sperren" />
          ) : (
            <ul className="divide-y divide-stone-875">
              {lists.data!.banned.map((entry, i) => (
                <li
                  key={entry.uuid}
                  className="flex animate-slide-in items-center gap-3 px-4 py-2 transition-colors hover:bg-stone-600/[0.28]"
                  style={{ animationDelay: `${Math.min(i, 10) * 0.04}s` }}
                >
                  <Avatar name={entry.name} size={24} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-[13px] text-stone-100">{entry.name}</p>
                    {entry.reason && <p className="truncate text-xs text-stone-450">{entry.reason}</p>}
                  </div>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      className="!px-2 !py-1 !text-[11px]"
                      disabled={offline}
                      onClick={() => run('pardon', entry.name)}
                    >
                      Entsperren
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
