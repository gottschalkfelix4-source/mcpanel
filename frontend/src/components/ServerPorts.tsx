import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cable, Plus, ScanSearch, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { Badge, Button, ErrorNote, Field, InfoNote, LoadErrorBlock, LoadingBlock, Panel, Toggle, useToast } from './ui';

type RouterState = 'off' | 'disabled' | 'forwarded' | 'conflict' | 'skipped' | 'pending' | 'error';

interface ServerPortInfo {
  id: string;
  label: string;
  source: string;
  manual: boolean;
  protocol: 'tcp' | 'udp' | 'tcp_udp';
  hostPort: number;
  containerPort: number;
  forward: boolean;
  address: string;
  router: RouterState;
  routerNote: string | null;
}

interface PortsResponse {
  unifi: { enabled: boolean; lastSync: string | null; error: string | null };
  ports: ServerPortInfo[];
  notes?: string[];
  restartNeeded?: boolean;
}

const PROTO: Record<string, string> = { tcp: 'TCP', udp: 'UDP', tcp_udp: 'TCP+UDP' };

const ROUTER: Record<RouterState, { label: string; tone: 'green' | 'red' | 'gold' | 'neutral' }> = {
  forwarded: { label: 'im Router frei', tone: 'green' },
  pending: { label: 'wird freigegeben …', tone: 'gold' },
  conflict: { label: 'Router-Konflikt', tone: 'red' },
  error: { label: 'Router-Fehler', tone: 'red' },
  skipped: { label: 'nicht freigegeben', tone: 'gold' },
  off: { label: 'Freigabe aus', tone: 'neutral' },
  disabled: { label: '', tone: 'neutral' },
};

/**
 * Zusatzports eines Servers: erkannte Erweiterungen (Sprachchat, Geyser,
 * Web-Karten) und von Administratoren ergänzte Ports. Freigegeben werden sie
 * im Container automatisch, im Router über die UniFi-Anbindung.
 */
export default function ServerPorts({ serverId, isAdmin, canEdit }: { serverId: string; isAdmin: boolean; canEdit: boolean }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = ['server-ports', serverId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => api.get<PortsResponse>(`/servers/${serverId}/ports`),
    refetchInterval: 15_000,
  });
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [protocol, setProtocol] = useState<'tcp' | 'udp' | 'tcp_udp'>('tcp');
  const [hostPort, setHostPort] = useState('');
  const [containerPort, setContainerPort] = useState('');

  const refresh = () => void queryClient.invalidateQueries({ queryKey: key });

  const detect = useMutation({
    mutationFn: () => api.post<PortsResponse>(`/servers/${serverId}/ports/detect`),
    onSuccess: (res) => {
      queryClient.setQueryData(key, res);
      if (res.notes?.length) toast.success(res.notes.join(' '));
      else toast.success('Keine Änderungen – alle Erweiterungen sind bereits berücksichtigt.');
      if (res.restartNeeded) toast.info('Neue Ports gelten ab dem nächsten Neustart des Servers.');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const add = useMutation({
    mutationFn: () => api.post(`/servers/${serverId}/ports`, {
      label: label.trim(), protocol, hostPort: Number(hostPort),
      ...(containerPort.trim() ? { containerPort: Number(containerPort) } : {}),
    }),
    onSuccess: () => {
      toast.success('Port ergänzt – er gilt ab dem nächsten Start des Servers.');
      setAdding(false); setLabel(''); setHostPort(''); setContainerPort('');
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const toggle = useMutation({
    mutationFn: ({ id, forward }: { id: string; forward: boolean }) => api.patch(`/servers/${serverId}/ports/${id}`, { forward }),
    onSuccess: refresh,
    onError: (err: Error) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/servers/${serverId}/ports/${id}`),
    onSuccess: () => { toast.success('Port entfernt.'); refresh(); },
    onError: (err: Error) => toast.error(err.message),
  });

  const data = query.data;

  return (
    <Panel
      title="Zusätzliche Ports"
      icon={<Cable size={16} />}
      subtitle="Für Erweiterungen mit eigenem Port – Simple Voice Chat, Geyser, BlueMap, Dynmap, squaremap, Votifier. Das Panel erkennt sie vor jedem Start selbst."
      actions={canEdit ? (
        <Button icon={<ScanSearch size={14} />} loading={detect.isPending} onClick={() => detect.mutate()}>Jetzt erkennen</Button>
      ) : undefined}
    >
      {query.isLoading ? <LoadingBlock /> : !data ? <LoadErrorBlock error={query.error} onRetry={() => void query.refetch()} /> : (
        <div className="space-y-3">
          {data.ports.length === 0 ? (
            <p className="text-sm text-stone-400">Keine Erweiterung mit eigenem Port installiert.</p>
          ) : (
            <ul className="divide-y divide-stone-800 border border-stone-800">
              {data.ports.map((port) => {
                const router = ROUTER[port.router];
                return (
                  <li key={port.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-stone-100">
                        {port.label} {port.manual && <span className="text-xs font-normal text-stone-450">· eigener Port</span>}
                      </p>
                      <p className="font-mono text-xs text-stone-400">
                        <span className="select-all text-stone-200">{port.address}</span> · {PROTO[port.protocol]}
                        {port.containerPort !== port.hostPort && ` · im Container ${port.containerPort}`}
                      </p>
                      {port.routerNote && <p className="mt-0.5 text-xs text-redstone">{port.routerNote}</p>}
                    </div>
                    {data.unifi.enabled && router.label && <Badge tone={router.tone}>{router.label}</Badge>}
                    {isAdmin && data.unifi.enabled && (
                      <Toggle checked={port.forward} onChange={(forward) => toggle.mutate({ id: port.id, forward })} label="Router" />
                    )}
                    {isAdmin && port.manual && (
                      <Button variant="ghost" className="!px-2" aria-label="Port entfernen" icon={<Trash2 size={14} />} loading={remove.isPending && remove.variables === port.id} onClick={() => remove.mutate(port.id)} />
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {!data.unifi.enabled && data.ports.length > 0 && (
            <InfoNote>
              Im Container sind die Ports freigegeben. Damit Spieler von außen drankommen, müssen sie noch im Router
              weitergeleitet werden{isAdmin ? ' – oder du bindest unter Panel-Einstellungen eine UniFi-Konsole an, dann passiert das automatisch.' : '.'}
            </InfoNote>
          )}
          {data.unifi.enabled && data.unifi.error && <ErrorNote>UniFi: {data.unifi.error}</ErrorNote>}

          {isAdmin && (adding ? (
            <div className="space-y-3 border border-stone-800 bg-stone-900/40 p-3">
              <div className="grid gap-3 sm:grid-cols-4">
                <Field label="Bezeichnung"><input className="mc-input" placeholder="z. B. Web-Shop" value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
                <Field label="Protokoll">
                  <select className="mc-select" value={protocol} onChange={(e) => setProtocol(e.target.value as typeof protocol)}>
                    <option value="tcp">TCP</option><option value="udp">UDP</option><option value="tcp_udp">TCP+UDP</option>
                  </select>
                </Field>
                <Field label="Port (Host)"><input className="mc-input font-mono" inputMode="numeric" value={hostPort} onChange={(e) => setHostPort(e.target.value.replace(/\D/g, ''))} /></Field>
                <Field label="Port im Container" hint="Leer = gleich"><input className="mc-input font-mono" inputMode="numeric" value={containerPort} onChange={(e) => setContainerPort(e.target.value.replace(/\D/g, ''))} /></Field>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setAdding(false)}>Abbrechen</Button>
                <Button variant="primary" loading={add.isPending} disabled={!label.trim() || !hostPort} onClick={() => add.mutate()}>Hinzufügen</Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" icon={<Plus size={14} />} onClick={() => setAdding(true)}>Eigenen Port hinzufügen</Button>
          ))}
        </div>
      )}
    </Panel>
  );
}
