import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Crown, Pencil, Plus, Trash2, UserMinus, UserPlus, UsersRound } from 'lucide-react';
import { api } from '../lib/api';
import { Badge, Button, ConfirmDialog, Field, InfoNote, Modal, Panel, useToast } from './ui';

interface Member { uuid: string; name: string; rank: 'owner' | 'officer' | 'member' | 'invited' | 'ally' }
interface Party {
  id: string;
  name: string;
  shortName: string;
  description: string;
  color: string | null;
  owner: string | null;
  members: Member[];
  invited: Member[];
  allies: Member[];
}
interface TeamPlayer { uuid: string; name: string; partyId: string | null }
interface TeamsResponse { available: boolean; parties: Party[]; players: TeamPlayer[]; canManage: boolean }

type Action =
  | { type: 'disband' }
  | { type: 'add' | 'remove' | 'transfer'; player: string }
  | { type: 'rename'; name: string };

const RANK: Record<string, string> = { owner: 'Besitzer', officer: 'Offizier', member: 'Mitglied' };

/**
 * FTB-Teams-Partys eines Servers. Erscheint nur, wenn der Mod in der Welt
 * Daten angelegt hat. Änderungen schickt das Panel als Befehle des Mods an
 * den laufenden Server.
 */
export default function FtbTeams({ serverId, running, online }: { serverId: string; running: boolean; online: string[] }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = ['ftb-teams', serverId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => api.get<TeamsResponse>(`/servers/${serverId}/teams`),
    refetchInterval: 20_000,
  });
  const [disband, setDisband] = useState<Party | null>(null);
  const [rename, setRename] = useState<{ party: Party; name: string } | null>(null);
  const [creating, setCreating] = useState<{ player: string; name: string } | null>(null);
  const [addTo, setAddTo] = useState<Record<string, string>>({});

  // Der Mod schreibt seine Dateien beim Speichern der Welt – kurz danach neu lesen.
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: key });
    setTimeout(() => void queryClient.invalidateQueries({ queryKey: key }), 2500);
  };

  const act = useMutation({
    mutationFn: ({ party, action }: { party: Party; action: Action }) =>
      api.post<{ response: string }>(`/servers/${serverId}/teams/${party.id}/action`, action),
    onSuccess: (res) => { toast.success(res.response || 'Erledigt.'); refresh(); },
    onError: (err: Error) => toast.error(err.message),
  });
  const create = useMutation({
    mutationFn: (body: { player: string; name: string }) => api.post<{ response: string }>(`/servers/${serverId}/teams`, body),
    onSuccess: (res) => { toast.success(res.response || 'Party angelegt.'); setCreating(null); refresh(); },
    onError: (err: Error) => toast.error(err.message),
  });

  const data = query.data;
  if (!data?.available) return null;
  const canManage = data.canManage;
  const free = data.players.filter((player) => !player.partyId);
  const freeOnline = free.filter((player) => online.some((name) => name.toLowerCase() === player.name.toLowerCase()));

  return (
    <Panel
      title={`FTB-Partys · ${data.parties.length}`}
      icon={<UsersRound size={16} />}
      subtitle="Teams aus FTB Teams – Mitglieder, Besitzer und Namen verwalten, ohne ins Spiel zu müssen."
      actions={canManage ? (
        <Button icon={<Plus size={14} />} disabled={!running || freeOnline.length === 0}
          title={!running ? 'Der Server muss laufen' : freeOnline.length === 0 ? 'Braucht einen Spieler, der online und in keiner Party ist' : undefined}
          onClick={() => setCreating({ player: freeOnline[0].name, name: `${freeOnline[0].name}s Party` })}>
          Neue Party
        </Button>
      ) : undefined}
    >
      <div className="space-y-3">
        {canManage && !running && <InfoNote>Ändern geht nur bei laufendem Server – FTB Teams nimmt die Änderungen als Befehle entgegen.</InfoNote>}
        {data.parties.length === 0 && <p className="text-sm text-stone-400">Auf diesem Server gibt es noch keine Party.</p>}

        {data.parties.map((party) => (
          <div key={party.id} className="border border-stone-700 bg-stone-900/40">
            <div className="flex flex-wrap items-center gap-2 border-b border-stone-700 px-3 py-2.5">
              <span aria-hidden="true" className="block h-3.5 w-3.5 border border-stone-950" style={{ background: party.color ?? '#5B8731' }} />
              <span className="min-w-0 flex-1 truncate font-bold text-stone-50">{party.name}</span>
              <Badge tone="neutral">{party.members.length} Mitglied{party.members.length === 1 ? '' : 'er'}</Badge>
              {canManage && (
                <>
                  <Button variant="ghost" className="!px-2 !py-1" aria-label={`${party.name} umbenennen`} title="Umbenennen" icon={<Pencil size={13} />}
                    disabled={!running} onClick={() => setRename({ party, name: party.name })} />
                  <Button variant="danger" className="!px-2 !py-1" aria-label={`${party.name} auflösen`} title="Auflösen" icon={<Trash2 size={13} />}
                    disabled={!running} onClick={() => setDisband(party)} />
                </>
              )}
            </div>
            <ul className="divide-y divide-stone-800">
              {party.members.map((member) => (
                <li key={member.uuid} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-stone-100">{member.name}</span>
                  <Badge tone={member.rank === 'owner' ? 'gold' : 'neutral'}>{RANK[member.rank] ?? member.rank}</Badge>
                  {canManage && member.rank !== 'owner' && (
                    <>
                      <Button variant="ghost" className="!px-2 !py-1 !text-[11px]" icon={<Crown size={12} />} disabled={!running || act.isPending}
                        aria-label={`${member.name} zum Besitzer machen`} title="Zum Besitzer machen"
                        onClick={() => {
                          if (window.confirm(`Die Party „${party.name}“ an ${member.name} übertragen?`)) act.mutate({ party, action: { type: 'transfer', player: member.name } });
                        }} />
                      <Button variant="ghost" className="!px-2 !py-1 !text-[11px]" icon={<UserMinus size={12} />} disabled={!running || act.isPending}
                        aria-label={`${member.name} entfernen`} title="Aus der Party entfernen"
                        onClick={() => {
                          if (window.confirm(`${member.name} aus „${party.name}“ entfernen?`)) act.mutate({ party, action: { type: 'remove', player: member.name } });
                        }} />
                    </>
                  )}
                </li>
              ))}
            </ul>
            {(party.invited.length > 0 || party.allies.length > 0) && (
              <p className="border-t border-stone-800 px-3 py-2 text-xs text-stone-400">
                {party.invited.length > 0 && <>Eingeladen: {party.invited.map((m) => m.name).join(', ')}. </>}
                {party.allies.length > 0 && <>Verbündete: {party.allies.map((m) => m.name).join(', ')}.</>}
              </p>
            )}
            {canManage && free.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-t border-stone-800 px-3 py-2">
                <label className="sr-only" htmlFor={`add-${party.id}`}>Spieler hinzufügen</label>
                <select id={`add-${party.id}`} className="mc-select !w-auto min-w-[10rem] flex-1 !py-1.5 text-sm"
                  value={addTo[party.id] ?? ''} onChange={(e) => setAddTo({ ...addTo, [party.id]: e.target.value })}>
                  <option value="">Spieler ohne Party …</option>
                  {free.map((player) => <option key={player.uuid} value={player.name}>{player.name}</option>)}
                </select>
                <Button icon={<UserPlus size={13} />} className="!py-1.5" disabled={!running || !addTo[party.id] || act.isPending}
                  onClick={() => act.mutate({ party, action: { type: 'add', player: addTo[party.id] } }, { onSuccess: () => setAddTo({ ...addTo, [party.id]: '' }) })}>
                  Hinzufügen
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={Boolean(disband)}
        onClose={() => setDisband(null)}
        danger
        title="Party auflösen?"
        confirmLabel="Auflösen"
        requireText={disband?.name}
        message={<>Alle {disband?.members.length} Mitglieder verlieren die Party <strong>{disband?.name}</strong>. Was daran hängt – etwa beanspruchte Chunks und gemeinsame Quest-Fortschritte – geht nach den Regeln der jeweiligen Mods verloren oder an die einzelnen Spieler zurück. Das lässt sich nicht rückgängig machen.</>}
        onConfirm={async () => { if (disband) await act.mutateAsync({ party: disband, action: { type: 'disband' } }).catch(() => {}); }}
      />

      <Modal open={Boolean(rename)} onClose={() => setRename(null)} size="sm" title="Party umbenennen"
        footer={<>
          <Button variant="ghost" onClick={() => setRename(null)}>Abbrechen</Button>
          <Button variant="primary" loading={act.isPending} disabled={!rename?.name.trim()}
            onClick={() => rename && act.mutate({ party: rename.party, action: { type: 'rename', name: rename.name.trim() } }, { onSuccess: () => setRename(null) })}>
            Umbenennen
          </Button>
        </>}>
        <Field label="Neuer Name">
          <input className="mc-input" maxLength={50} autoFocus value={rename?.name ?? ''} onChange={(e) => rename && setRename({ ...rename, name: e.target.value })} />
        </Field>
      </Modal>

      <Modal open={Boolean(creating)} onClose={() => setCreating(null)} size="sm" title="Neue Party"
        footer={<>
          <Button variant="ghost" onClick={() => setCreating(null)}>Abbrechen</Button>
          <Button variant="primary" loading={create.isPending} disabled={!creating?.name.trim()} onClick={() => creating && create.mutate({ player: creating.player, name: creating.name.trim() })}>
            Anlegen
          </Button>
        </>}>
        <div className="space-y-3">
          <Field label="Besitzer" hint="FTB Teams legt eine Party nur für einen Spieler an, der gerade online und in keiner Party ist.">
            <select className="mc-select" value={creating?.player ?? ''} onChange={(e) => creating && setCreating({ ...creating, player: e.target.value })}>
              {freeOnline.map((player) => <option key={player.uuid} value={player.name}>{player.name}</option>)}
            </select>
          </Field>
          <Field label="Name">
            <input className="mc-input" maxLength={50} value={creating?.name ?? ''} onChange={(e) => creating && setCreating({ ...creating, name: e.target.value })} />
          </Field>
        </div>
      </Modal>
    </Panel>
  );
}
