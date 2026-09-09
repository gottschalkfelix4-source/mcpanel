import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, Copy, Globe, Network, RefreshCw, Save, Search, Server, Settings2, ShieldCheck } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { minecraftAddress, runtimeLabel, type ProxyOverview, type ProxyServer } from '../../lib/proxy';
import ProxySettings from '../../components/ProxySettings';
import { Badge, Button, EmptyState, ErrorNote, Field, InfoNote, LoadErrorBlock, LoadingBlock, Panel, useToast } from '../../components/ui';

export default function ProxyPage() {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const overview = useQuery({ queryKey: ['proxy-overview'], queryFn: () => api.get<ProxyOverview>('/settings/proxy/overview'), refetchInterval: 15000 });
  if (overview.isLoading) return <LoadingBlock label="Proxy-Verbindungen werden geladen …" />;
  if (!overview.data) return <LoadErrorBlock error={overview.error} onRetry={() => void overview.refetch()} />;
  const data = overview.data;
  const filtered = data.servers.filter(server => `${server.name} ${server.hostnames.join(' ')} ${server.port}`.toLowerCase().includes(search.toLowerCase()));
  const selected = filtered.find(server => server.id === selectedId) ?? filtered[0] ?? null;
  const requiredPorts = new Set(data.ports.filter(port => port.required).map(port => `${port.port}/${port.protocol}`));
  const domains = data.servers.reduce((count, server) => count + server.hostnames.length, 0);
  const proxyHealthy = data.proxy.enabled && data.proxy.running && data.proxy.reachable;
  const dnsTarget = data.publicHost && !['localhost', '127.0.0.1', '::1'].includes(data.publicHost) ? data.publicHost : 'deine öffentliche IP oder DynDNS-Adresse';

  return <div className="flex min-w-0 flex-col gap-5 animate-fade-in">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="heading-pixel text-base">Proxy & Verbindungen</h1><p className="mt-2.5 text-sm text-stone-350">Ein Eingang für deine Minecraft-Welten. Alle Subdomains und Portfreigaben an einem Ort.</p></div>
      <Button icon={<RefreshCw size={15} />} loading={overview.isFetching} onClick={() => void overview.refetch()}>Aktualisieren</Button>
    </div>
    {overview.isError && <ErrorNote>Die Aktualisierung ist fehlgeschlagen. Angezeigt wird der letzte Stand.</ErrorNote>}
    {(data.proxy.error || data.proxy.runtime.error) && <ErrorNote>{data.proxy.error || data.proxy.runtime.error}</ErrorNote>}
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Summary icon={<Network size={16} />} label="Proxy intern" value={!data.proxy.enabled ? 'Deaktiviert' : proxyHealthy ? 'Erreichbar' : 'Nicht bereit'} green={proxyHealthy} />
      <Summary icon={<Globe size={16} />} label="Gemeinsamer Eingang" value={`TCP ${data.proxy.port}`} />
      <Summary icon={<Server size={16} />} label="Subdomains / Server" value={`${domains} / ${data.servers.length}`} />
      <Summary icon={<ShieldCheck size={16} />} label="Benötigte TCP-Freigaben" value={String(requiredPorts.size)} />
    </div>

    <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Panel title="Wohin geht welche Verbindung?" icon={<Network size={16} />} subtitle="Klicke auf eine Subdomain oder einen Server, um die Zuordnung zu bearbeiten." className="min-w-0">
        <label className="mb-4 flex items-center gap-2 border border-stone-700 bg-stone-950/50 px-3"><Search size={15} className="shrink-0 text-stone-400" /><input aria-label="Subdomain oder Server suchen" className="min-w-0 flex-1 bg-transparent py-2.5 text-sm text-stone-100 outline-none" placeholder="Subdomain, Server oder Port suchen …" value={search} onChange={event => setSearch(event.target.value)} /></label>
        {filtered.length === 0 ? <EmptyState icon={<Network size={32} />} title={data.servers.length ? 'Keine passende Verbindung' : 'Noch keine Server'} description="Lege einen Server an oder passe die Suche an." /> : <Topology servers={filtered} proxy={data.proxy} selectedId={selected?.id ?? null} onSelect={setSelectedId} />}
        <p className="mt-3 text-xs text-stone-450">Grün: Proxy intern erreichbar und Ziel läuft. Gestrichelt: Route fehlt oder ist derzeit nicht bereit. DNS und Router-Freigaben sind nicht von außen geprüft.</p>
      </Panel>
      {selected ? <RouteDetails key={selected.id} server={selected} proxy={data.proxy} dnsTarget={dnsTarget} /> : <Panel title="Verbindung auswählen"><p className="text-sm text-stone-400">Hier erscheinen die Subdomains und Ports des ausgewählten Servers.</p><Link className="mt-3 inline-block text-grass-light" to="/servers/new">Server anlegen →</Link></Panel>}
    </div>

    <Panel title="Welche Ports müssen im Router frei sein?" icon={<ShieldCheck size={16} />} subtitle="Eingehende Verbindungen aus dem Internet → LAN-IP deines Unraid-Hosts. Externe und interne Portnummer gleich setzen.">
      <InfoNote>Die Spalte „Am Unraid-Host“ stammt aus Docker. Ob Router, Firewall und Internetanschluss eingehende Verbindungen erlauben, ist nicht geprüft. Für Minecraft Java über den Proxy genügt dessen TCP-Port.</InfoNote>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[620px] text-left text-sm">
          <thead className="border-b border-stone-700 text-xs uppercase text-stone-400"><tr><th className="p-3">Ziel</th><th className="p-3">Port</th><th className="p-3">Am Unraid-Host</th><th className="p-3">Router-Freigabe</th></tr></thead>
          <tbody>{data.ports.map((port, index) => {
            const active = port.bindings.filter(binding => binding.active);
            const remote = active.some(binding => !/^127\./.test(binding.hostIp) && !['::1', '::ffff:127.0.0.1'].includes(binding.hostIp));
            const conflict = port.required && data.ports.some(other => other !== port && other.required && other.port === port.port && other.protocol === port.protocol);
            return <tr key={`${port.ownerId}-${port.port}-${port.protocol}-${index}`} className="border-b border-stone-800 align-top">
              <td className="p-3 text-stone-100">{port.ownerName}<p className="mt-1 text-xs text-stone-450">{port.ownerId === 'proxy' ? 'Alle zugeordneten Subdomains' : 'Direkte Verbindung zum Server'}</p></td>
              <td className="p-3 font-mono text-diamond">{port.port} / {port.protocol.toUpperCase()}</td>
              <td className="p-3"><Badge tone={remote ? 'green' : 'gold'}>{port.state === 'unknown' ? 'Unbekannt' : remote ? 'Veröffentlicht' : active.length ? 'Nur lokal gebunden' : port.state === 'stopped' ? 'Container gestoppt' : 'Nicht veröffentlicht'}</Badge>{active.length > 0 && <p className="mt-1 break-all font-mono text-[11px] text-stone-450">{active.map(binding => `${binding.hostIp}:${binding.hostPort}`).join(', ')}</p>}</td>
              <td className="p-3"><span className={port.required ? 'text-stone-100' : 'text-stone-450'}>{port.required ? `TCP ${port.port} → Unraid-LAN-IP:${port.port}` : 'Für den normalen Spielzugang nicht nötig'}</span>{conflict && <p className="mt-1 text-xs text-redstone">Portkonflikt: mehrfach als Eingang konfiguriert.</p>}{port.protocol === 'udp' && <p className="mt-1 text-xs text-stone-450">Nur für passende Zusatzfunktionen separat freigeben.</p>}</td>
            </tr>;
          })}</tbody>
        </table>
        {data.ports.length === 0 && <p className="py-5 text-sm text-stone-400">Aktuell sind weder Proxy- noch Direktports konfiguriert oder von Docker gemeldet.</p>}
      </div>
      <p className="mt-4 text-xs leading-relaxed text-stone-400">Server ohne Direktzugriff brauchen keine eigene Router-Freigabe. Der interne Minecraft-Port 25565 und RCON-Port 25575 bleiben im Docker-Netzwerk. UDP-Funktionen wie Sprachchat werden vom Minecraft-Proxy nicht weitergeleitet.</p>
      <p className="mt-2 text-xs text-stone-450">Letzte Host-Prüfung: {new Date(data.checkedAt).toLocaleTimeString('de-DE')} · Internet-Erreichbarkeit: nicht geprüft</p>
    </Panel>

    <details className="mc-frame" open={!data.proxy.enabled || undefined}><summary className="flex cursor-pointer items-center gap-2 p-4 text-sm font-semibold text-stone-100"><Settings2 size={16} /> Proxy und öffentliche Adresse einstellen</summary><div className="p-3 pt-0"><ProxySettings publicHost={data.publicHost} /></div></details>
  </div>;
}

function Summary({ icon, label, value, green = false }: { icon: React.ReactNode; label: string; value: string; green?: boolean }) {
  return <div className="mc-frame"><div className="mc-frame-inner p-4"><p className="flex items-center gap-2 text-[11px] text-stone-400">{icon}{label}</p><p className={clsx('mt-3 font-mono text-xl', green ? 'text-emerald' : 'text-stone-100')}>{value}</p></div></div>;
}

function Topology({ servers, proxy, selectedId, onSelect }: { servers: ProxyServer[]; proxy: ProxyOverview['proxy']; selectedId: string | null; onSelect: (id: string) => void }) {
  const height = Math.max(280, servers.length * 112);
  const mid = height / 2;
  return <div className="overflow-x-auto rounded border border-stone-800 bg-stone-950/40 p-3" aria-label="Interaktive Subdomain-Zuordnung">
    <div className="mb-2 grid min-w-[650px] grid-cols-[30%_40%_30%] text-center text-[10px] uppercase tracking-widest text-stone-450"><span>Subdomain im Internet</span><span>Gemeinsamer Eingang</span><span>Minecraft-Server</span></div>
    <div className="relative min-w-[650px]" style={{ height }}>
      <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 1000 ${height}`} preserveAspectRatio="none" aria-hidden="true">
        {servers.map((server, i) => {
          const y = (i + 0.5) * height / servers.length;
          const ready = server.hostnames.length > 0 && proxy.enabled && proxy.reachable && server.runtime.state === 'running';
          return <g key={server.id} fill="none" stroke={selectedId === server.id ? '#4AEDD9' : ready ? '#7FB238' : '#55545c'} strokeWidth={selectedId === server.id ? 3 : 1.5} strokeDasharray={ready ? undefined : '6 5'} opacity={selectedId === server.id ? 1 : 0.7}>
            <path d={`M 300 ${y} C 365 ${y}, 365 ${mid}, 430 ${mid}`} /><path d={`M 570 ${mid} C 635 ${mid}, 635 ${y}, 700 ${y}`} />
          </g>;
        })}
      </svg>
      <div className="absolute left-[43%] flex w-[14%] flex-col items-center gap-2 border-2 border-grass-dark bg-stone-900 px-1 py-4 text-center shadow-lg" style={{ top: mid - 62 }}><Network size={24} className="text-grass-light" /><strong className="text-xs text-stone-100">Proxy</strong><span className="font-mono text-xs text-diamond">:{proxy.port}</span><span className="text-[10px] text-stone-450">{proxy.enabled ? proxy.reachable ? 'intern bereit' : 'nicht bereit' : 'deaktiviert'}</span></div>
      {servers.map((server, i) => {
        const top = (i + 0.5) * height / servers.length - 44;
        const selected = selectedId === server.id;
        const node = clsx('absolute flex h-[88px] w-[30%] flex-col justify-center overflow-hidden border px-3 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-diamond', selected ? 'border-diamond bg-stone-800 shadow-lg' : 'border-stone-600 bg-stone-900 hover:border-stone-400');
        return <div key={server.id}>
          <button className={clsx(node, 'left-0')} style={{ top }} aria-pressed={selected} aria-label={`Subdomains für ${server.name} auswählen`} onClick={() => onSelect(server.id)}>
            <span className="mb-1 flex items-center gap-1.5 text-[10px] text-stone-450"><Globe size={12} /> DNS</span>
            {server.hostnames.length ? server.hostnames.slice(0, 2).map(host => <span key={host} className="truncate font-mono text-xs text-stone-100" title={host}>{host}</span>) : <span className="text-xs text-stone-400">Keine Subdomain</span>}
            {server.hostnames.length > 2 && <span className="text-[10px] text-stone-450">+ {server.hostnames.length - 2} weitere</span>}
          </button>
          <button className={clsx(node, 'right-0')} style={{ top }} aria-pressed={selected} aria-label={`Server ${server.name} auswählen`} onClick={() => onSelect(server.id)}>
            <span className="truncate text-sm font-semibold text-stone-100">{server.name}</span><span className="mt-1 flex items-center gap-1.5 text-[11px] text-stone-400"><span className={clsx('h-1.5 w-1.5', server.runtime.state === 'running' ? 'bg-emerald' : 'bg-stone-500')} />{runtimeLabel[server.runtime.state]}</span><span className="mt-1 text-[10px] text-stone-450">{server.directConnect ? `Direktport ${server.port} zusätzlich aktiv` : 'Kein eigener öffentlicher Port'}</span>
          </button>
        </div>;
      })}
    </div>
  </div>;
}

function RouteDetails({ server, proxy, dnsTarget }: { server: ProxyServer; proxy: ProxyOverview['proxy']; dnsTarget: string }) {
  const [names, setNames] = useState(server.hostnames.join('\n'));
  const [dirty, setDirty] = useState(false);
  const toast = useToast();
  const queries = useQueryClient();
  const signature = server.hostnames.join('\n');
  useEffect(() => { if (!dirty) setNames(signature); }, [signature, dirty]);
  const save = useMutation({
    mutationFn: () => api.put(`/servers/${server.id}/proxy`, { hostnames: names.split(/[\n,]/).map(name => name.trim()).filter(Boolean), directConnect: server.directConnect }),
    onSuccess: async () => { await queries.invalidateQueries({ queryKey: ['proxy-overview'] }); setDirty(false); void queries.invalidateQueries({ queryKey: ['servers'] }); void queries.invalidateQueries({ queryKey: ['server', server.id] }); toast.success('Subdomains gespeichert.'); },
    onError: (error: Error) => toast.error(error.message),
  });
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); toast.success('Adresse kopiert.'); } catch { toast.error('Kopieren nicht möglich. Bitte die Adresse manuell auswählen.'); } };
  return <Panel title={server.name} icon={<Server size={16} />} subtitle="Ausgewählte Verbindung" className="min-w-0">
    <div className="space-y-4">
      <Badge tone={server.runtime.state === 'running' ? 'green' : 'gold'}>{runtimeLabel[server.runtime.state]}</Badge>
      {server.runtime.error && <ErrorNote>{server.runtime.error}</ErrorNote>}
      {!proxy.enabled && server.hostnames.length > 0 && <InfoNote>Die Subdomains sind gespeichert. Aktiviere den Proxy, damit sie zu diesem Server führen.</InfoNote>}
      <Field label="Subdomains" hint="Eine pro Zeile. Die erste ist die Hauptadresse. Speichern ändert die Zuordnung ohne Server-Neustart."><textarea aria-label={`Subdomains für ${server.name}`} className="mc-input font-mono text-sm" rows={3} value={names} placeholder="atm.deine-domain.de" onChange={event => { setNames(event.target.value); setDirty(true); }} /></Field>
      <Button variant="primary" icon={<Save size={14} />} loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>Zuordnung speichern</Button>
      {server.hostnames.map(hostname => <div className="flex min-w-0 items-center gap-2" key={hostname}><code className="min-w-0 flex-1 break-all text-xs text-diamond">{minecraftAddress(hostname, proxy.port)}</code><Button variant="ghost" className="!p-2" title={`${hostname} kopieren`} icon={<Copy size={13} />} onClick={() => void copy(minecraftAddress(hostname, proxy.port))} /></div>)}
      <div className="border-t border-stone-750 pt-3 text-xs leading-relaxed text-stone-350"><p className="flex items-center gap-1.5 font-semibold text-stone-100"><Check size={13} /> DNS & Router</p><p className="mt-2 break-words">Subdomains per A/AAAA-Eintrag auf deine öffentliche IP oder per CNAME auf deine DynDNS-Adresse richten. Eingestellter öffentlicher Host: <strong>{dnsTarget}</strong>.</p><p className="mt-2">Router: TCP <strong>{proxy.port}</strong> an die LAN-IP von Unraid, Port <strong>{proxy.port}</strong>.{proxy.port !== 25565 && ' Ohne DNS-SRV-Eintrag geben Spieler die oben angezeigte Adresse mit Port ein.'}</p></div>
      <div className="border-t border-stone-750 pt-3 text-xs text-stone-350"><p>Direktzugriff: <strong>{server.directConnect ? `aktiv · TCP ${server.port}` : 'deaktiviert'}</strong></p><p className="mt-1 break-all">Internes Ziel: {server.internalAddress}</p></div>
      <Link to={`/servers/${server.id}/settings`} className="inline-flex items-center gap-2 text-sm text-grass-light hover:underline">Direktzugriff und Server einstellen <ArrowRight size={14} /></Link>
    </div>
  </Panel>;
}
