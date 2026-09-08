import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Button, ErrorNote, Field, InfoNote, Panel, Toggle, useToast } from './ui';

interface Status { enabled: boolean; port: number; running: boolean; reachable: boolean; error: string | null }

export default function ProxySettings({ publicHost }: { publicHost: string }) {
  const toast = useToast();
  const queries = useQueryClient();
  const status = useQuery({ queryKey: ['proxy-status'], queryFn: () => api.get<Status>('/settings/proxy'), refetchInterval: 15000 });
  const [enabled, setEnabled] = useState(false);
  const [port, setPort] = useState(25565);
  const [host, setHost] = useState(publicHost);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!loaded && status.data) { setEnabled(status.data.enabled); setPort(status.data.port); setLoaded(true); }
  }, [status.data, loaded]);
  const save = useMutation({
    mutationFn: () => api.put<Status>('/settings/proxy', { enabled, port }),
    onSuccess: () => { void queries.invalidateQueries(); toast.success('Minecraft-Proxy gespeichert.'); },
    onError: (err: Error) => toast.error(err.message),
  });
  const saveHost = useMutation({
    mutationFn: () => api.put('/settings/public-host', { host }),
    onSuccess: () => { void queries.invalidateQueries(); toast.success('Öffentlicher Host gespeichert.'); },
    onError: (err: Error) => toast.error(err.message),
  });
  return <Panel title="Minecraft-Subdomains">
    <div className="space-y-4">
      <InfoNote>Verbinde mehrere Minecraft-Server über eigene Subdomains und einen gemeinsamen Port. Die Namen vergibst du in den Einstellungen des jeweiligen Servers.</InfoNote>
      {status.error && <ErrorNote>{(status.error as Error).message}</ErrorNote>}
      {status.data?.error && <ErrorNote>{status.data.error}</ErrorNote>}
      <p className="text-sm text-stone-300">{status.data?.enabled ? (status.data.reachable ? 'Proxy erreichbar' : 'Proxy nicht erreichbar') : 'Proxy deaktiviert'}</p>
      <Toggle checked={enabled} onChange={setEnabled} label="Minecraft-Proxy aktivieren" />
      <Field label="Gemeinsamer Minecraft-Port" hint="Standard: 25565. Ein bestehender Server darf diesen Direktport nicht mehr belegen.">
        <input type="number" min={1024} max={65535} className="mc-input" value={port} onChange={e => setPort(Number(e.target.value))} />
      </Field>
      <Button variant="primary" disabled={!loaded} loading={save.isPending} onClick={() => save.mutate()}>Proxy speichern</Button>
      <InfoNote>Die DNS-Einträge der Subdomains müssen auf deinen Host zeigen. Gib den gemeinsamen TCP-Port im Router frei. Eine konfigurierte Subdomain bestätigt noch keine funktionierende DNS-Auflösung.</InfoNote>
      <Field label="Öffentlicher Host für Direktverbindungen" hint="Gilt für Serveradressen ohne aktive Subdomain. Ein hier gespeicherter Wert hat Vorrang vor PUBLIC_HOST.">
        <input className="mc-input" value={host} onChange={e => setHost(e.target.value)} />
      </Field>
      <Button loading={saveHost.isPending} onClick={() => saveHost.mutate()}>Öffentlichen Host speichern</Button>
    </div>
  </Panel>;
}
