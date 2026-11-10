import { useEffect, useState } from 'react';
import { copyText } from '../../lib/clipboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ArrowUpCircle, Check, CheckCircle2, ChevronDown, ChevronUp, Copy, Cpu, HardDrive, Home, KeyRound, Loader2, MemoryStick,
  Monitor, Network, Plus, RefreshCw, Server, ShieldCheck, Terminal, Trash2, Wifi,
} from 'lucide-react';
import { api } from '../../lib/api';
import { formatMemory, formatRelative } from '../../lib/format';
import type { NodeInstall, NodeOverview, NodesResponse, NodeUpdate } from '../../lib/types';
import {
  Badge, Button, ConfirmDialog, EmptyState, ErrorNote, Field, InfoNote, LoadErrorBlock, LoadingBlock, Modal, Panel,
  ProgressBar, Toggle, useToast,
} from '../../components/ui';

// ---------------------------------------------------------------- Hilfen ---

function percent(used: number, total: number): number {
  return total > 0 ? Math.round((used / total) * 100) : 0;
}

function tone(value: number): 'green' | 'gold' | 'red' {
  return value >= 90 ? 'red' : value >= 70 ? 'gold' : 'green';
}

function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mc-well relative">
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all p-3 pr-12 font-mono text-[11px] leading-relaxed text-stone-200">{text}</pre>
      <button
        type="button"
        aria-label={label}
        className="absolute right-2 top-2 border border-stone-600 bg-stone-800 p-1.5 text-stone-300 transition hover:text-white"
        onClick={async () => {
          if (await copyText(text)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }
        }}
      >
        {copied ? <Check size={14} className="text-emerald" /> : <Copy size={14} />}
      </button>
    </div>
  );
}

function StatusBadge({ node }: { node: NodeOverview }) {
  if (node.status === 'online') return <Badge tone="green"><span className="h-[7px] w-[7px] bg-emerald" />Verbunden</Badge>;
  if (node.status === 'pending') return <Badge tone="gold"><Loader2 size={11} className="animate-spin" />Wartet auf Installation</Badge>;
  return <Badge tone="red"><span className="h-[7px] w-[7px] bg-redstone" />Getrennt</Badge>;
}

function ConnectionBadge({ node }: { node: NodeOverview }) {
  if (node.local) return <Badge tone="neutral"><Home size={11} />Hauptserver</Badge>;
  return (
    <>
      {node.connection === 'direct'
        ? <Badge tone="blue"><Wifi size={11} />LAN, ohne VPN</Badge>
        : <Badge tone="purple"><ShieldCheck size={11} />WireGuard</Badge>}
      {node.platform === 'windows' && <Badge tone="neutral"><Monitor size={11} />Windows</Badge>}
    </>
  );
}

type Platform = 'linux' | 'windows';

const PLATFORMS: { value: Platform; label: string; hint: string }[] = [
  { value: 'linux', label: 'Linux', hint: 'VPS, Root-Server oder Linux-PC – Befehl per SSH im Terminal' },
  { value: 'windows', label: 'Windows', hint: 'PC mit Docker Desktop – Befehl in der PowerShell' },
];

function Meter({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: number; detail: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-stone-400">
        <span className="flex items-center gap-1.5">{icon}{label}</span>
        <span className="font-mono text-stone-300">{detail}</span>
      </div>
      <ProgressBar value={value} tone={tone(value)} />
    </div>
  );
}

// ------------------------------------------------------------- Node-Karte ---

function UpdateNote({ update }: { update: NodeUpdate }) {
  if (update.state === 'running') {
    return (
      <InfoNote>
        <span className="flex items-center gap-2"><Loader2 size={14} className="shrink-0 animate-spin" />{update.message}</span>
      </InfoNote>
    );
  }
  // Ergebnis nur kurz zeigen; ein Fehler bleibt stehen, bis man es erneut versucht.
  if (update.state === 'done') {
    const age = update.finishedAt ? Date.now() - new Date(update.finishedAt).getTime() : 0;
    if (age > 10 * 60_000) return null;
    return <p className="flex items-center gap-2 text-sm text-emerald"><CheckCircle2 size={15} />{update.message}</p>;
  }
  return <ErrorNote><strong>Agent-Update:</strong> {update.message}</ErrorNote>;
}

function NodeCard({ node, panelVersion, onInstall, onDelete, onUpdate }: {
  node: NodeOverview;
  panelVersion: string;
  onInstall: () => void;
  onDelete: () => void;
  onUpdate: () => void;
}) {
  const m = node.metrics;
  const updating = node.update?.state === 'running';
  const outdated = !node.local && Boolean(panelVersion) && Boolean(node.agentVersion) && node.agentVersion !== panelVersion;
  const memAllocated = m ? percent(node.allocatedMemoryMb, m.memTotalMb) : 0;
  const memUsed = m ? percent(m.memTotalMb - m.memAvailableMb, m.memTotalMb) : 0;
  const disk = m ? percent(m.diskTotalMb - m.diskFreeMb, m.diskTotalMb) : 0;
  const load = m ? Math.round((m.load[0] / Math.max(1, m.cpus)) * 100) : 0;

  return (
    <Panel
      title={node.name}
      icon={node.local ? <Home size={16} /> : <HardDrive size={16} />}
      subtitle={<span className="font-mono">{node.publicHost}{node.tunnelIp && node.connection === 'wireguard' ? ` · Tunnel ${node.tunnelIp}` : ''}</span>}
      actions={<StatusBadge node={node} />}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ConnectionBadge node={node} />
        <Badge tone="neutral"><Server size={11} />{node.servers} {node.servers === 1 ? 'Server' : 'Server'}</Badge>
        {m?.dockerVersion && <Badge tone="neutral">Docker {m.dockerVersion}</Badge>}
        {!node.local && node.agentVersion && <Badge tone="neutral">Agent {node.agentVersion}</Badge>}
        {outdated && !updating && <Badge tone="gold"><ArrowUpCircle size={11} />Update auf {panelVersion}</Badge>}
      </div>

      {node.update && <div className="mt-3"><UpdateNote update={node.update} /></div>}
      {node.error && !updating && <div className="mt-3"><ErrorNote>{node.error}</ErrorNote></div>}

      {m ? (
        <div className="mt-4 space-y-3">
          <Meter icon={<MemoryStick size={12} />} label="RAM zugewiesen (Server-Grenzen)" value={memAllocated}
            detail={`${formatMemory(node.allocatedMemoryMb)} / ${formatMemory(m.memTotalMb)}`} />
          <Meter icon={<MemoryStick size={12} />} label="RAM belegt" value={memUsed}
            detail={`${formatMemory(m.memTotalMb - m.memAvailableMb)} / ${formatMemory(m.memTotalMb)}`} />
          <Meter icon={<Cpu size={12} />} label={`CPU-Last (${m.cpus} Kerne)`} value={load}
            detail={`${m.load[0].toFixed(2)} · ${m.load[1].toFixed(2)} · ${m.load[2].toFixed(2)}`} />
          <Meter icon={<HardDrive size={12} />} label="Speicherplatz" value={disk}
            detail={`${formatMemory(m.diskFreeMb)} frei`} />
        </div>
      ) : (
        !node.error && <p className="mt-4 text-sm text-stone-400">Noch keine Messwerte.</p>
      )}

      {!node.local && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-stone-800 pt-3">
          <span className="text-xs text-stone-450">
            {node.lastSeenAt ? `Zuletzt gesehen ${formatRelative(node.lastSeenAt)}` : 'Noch nie verbunden'}
          </span>
          <div className="flex flex-wrap gap-2">
            <Button variant={outdated ? 'primary' : 'ghost'} icon={<ArrowUpCircle size={14} />} onClick={onUpdate}
              loading={updating} disabled={updating || node.status !== 'online'}
              title={node.status !== 'online' ? 'Nur bei verbundener Node möglich – sonst den Installationsbefehl erneut ausführen' : undefined}>
              Agent aktualisieren
            </Button>
            <Button variant="ghost" icon={<Terminal size={14} />} onClick={onInstall}>Installationsbefehl</Button>
            <Button variant="ghost" icon={<Trash2 size={14} />} onClick={onDelete} disabled={node.servers > 0}
              title={node.servers > 0 ? 'Erst alle Server umziehen oder löschen' : undefined}>Entfernen</Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- Wizard ---

function InstallInstructions({ install, direct, platform }: { install: NodeInstall; direct: boolean; platform: Platform }) {
  const [showScript, setShowScript] = useState(false);
  return (
    <div className="space-y-3">
      {platform === 'windows' ? (
        <p className="text-sm text-stone-300">
          Starte auf dem Windows-PC <strong>Docker Desktop</strong>, öffne dann <strong>PowerShell als Administrator</strong>{' '}
          (Rechtsklick auf Start → „Terminal (Administrator)“) und füge diesen <strong>einen</strong> Befehl ein. Er legt
          Datenvolume und Firewall-Regeln an und startet den Node-Agenten.
        </p>
      ) : (
        <p className="text-sm text-stone-300">
          Melde dich per SSH auf {direct ? 'dem Rechner' : 'dem VPS'} an und füge diesen <strong>einen</strong> Befehl ein.
          Er installiert bei Bedarf Docker, legt das Profil ab und startet den Node-Agenten.
        </p>
      )}
      <CopyBlock text={install.command} label="Befehl kopieren" />
      <button type="button" className="flex items-center gap-1.5 text-xs text-stone-400 hover:text-stone-200" onClick={() => setShowScript(!showScript)}>
        {showScript ? <ChevronUp size={14} /> : <ChevronDown size={14} />} Skript im Klartext ansehen
      </button>
      {showScript && <CopyBlock text={install.script} label="Skript kopieren" />}
      <InfoNote>
        Der Befehl enthält die Zugangsdaten der Node ({direct ? 'Token und Samba-Kennwort' : 'WireGuard-Schlüssel, Token und Samba-Kennwort'}).
        Nicht weitergeben – bei Bedarf lässt er sich hier jederzeit erneut anzeigen.
      </InfoNote>
    </div>
  );
}

function AddNodeWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [direct, setDirect] = useState(false);
  const [platform, setPlatform] = useState<Platform>('linux');
  const [listenPort, setListenPort] = useState(51820);
  const [dataRoot, setDataRoot] = useState('/opt/mcpanel-node');
  const [advanced, setAdvanced] = useState(false);
  const [install, setInstall] = useState<NodeInstall | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(1); setName(''); setHost(''); setDirect(false); setPlatform('linux'); setListenPort(51820);
    setDataRoot('/opt/mcpanel-node'); setAdvanced(false); setInstall(null);
  }, [open]);

  const create = useMutation({
    mutationFn: () => api.post<NodeInstall>('/nodes', {
      name, publicHost: host, connection: direct ? 'direct' : 'wireguard', platform, listenPort,
      ...(platform === 'linux' ? { dataRoot } : {}),
    }),
    onSuccess: (data) => {
      setInstall(data);
      setStep(2);
      void queryClient.invalidateQueries({ queryKey: ['nodes'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Node konnte nicht angelegt werden'),
  });

  // Schritt 2: so lange nachfragen, bis die Node sich meldet.
  const status = useQuery({
    queryKey: ['nodes', 'wizard', install?.id],
    queryFn: () => api.post<{ nodes: NodeOverview[] }>('/nodes/check'),
    enabled: open && step === 2 && Boolean(install?.id),
    refetchInterval: 4000,
  });
  const node = status.data?.nodes.find((entry) => entry.id === install?.id);
  useEffect(() => {
    if (step === 2 && node?.status === 'online') {
      setStep(3);
      void queryClient.invalidateQueries({ queryKey: ['nodes'] });
    }
  }, [step, node?.status, queryClient]);

  const footer = step === 1 ? (
    <>
      <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
      <Button variant="primary" loading={create.isPending} disabled={!name.trim() || !host.trim()} onClick={() => create.mutate()}>
        Weiter: Installationsbefehl
      </Button>
    </>
  ) : step === 2 ? (
    <Button variant="ghost" onClick={onClose}>Später fertigstellen</Button>
  ) : (
    <Button variant="primary" onClick={onClose}>Fertig</Button>
  );

  return (
    <Modal open={open} onClose={onClose} title="Node hinzufügen" size="lg" footer={footer}>
      <ol className="mb-5 grid grid-cols-3 gap-2 text-[11px] uppercase tracking-wider">
        {['Verbindung', 'Installieren', 'Verbunden'].map((label, index) => (
          <li key={label} className={clsx('border-b-2 pb-1.5', step > index ? 'border-grass text-grass-light' : 'border-stone-700 text-stone-500')}>
            {index + 1}. {label}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <div className="space-y-4">
          <Field label="Name" hint="Zum Wiedererkennen, z. B. „VPS Hetzner“ oder „Keller-PC“.">
            <input className="mc-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>

          <Field label="Betriebssystem der Node">
            <div className="grid grid-cols-2 gap-2">
              {PLATFORMS.map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  onClick={() => setPlatform(entry.value)}
                  className={clsx(
                    'border p-3 text-left transition',
                    platform === entry.value
                      ? 'border-grass-dark bg-grass/20 text-white'
                      : 'border-stone-700 bg-stone-800/60 text-stone-400 hover:text-stone-100',
                  )}
                >
                  <span className="flex items-center gap-2 text-sm font-bold">
                    {entry.value === 'windows' ? <Monitor size={15} /> : <Terminal size={15} />}{entry.label}
                  </span>
                  <span className="mt-1 block text-xs text-stone-400">{entry.hint}</span>
                </button>
              ))}
            </div>
          </Field>

          <div className="mc-well p-3">
            <Toggle checked={direct} onChange={setDirect} label={<span className="text-sm text-stone-200">Im selben Netzwerk wie der Hauptserver (ohne VPN)</span>} />
            <p className="mt-2 text-xs text-stone-400">
              {direct
                ? 'Das Panel spricht die Node direkt über ihre LAN-Adresse an. Kein WireGuard, kein offener UDP-Port. Docker-Zugriff und Statusabfrage sind über ein Token gesichert, Dateien gehen per SMB3 verschlüsselt. Nur für vertrauenswürdige Heimnetze.'
                : 'Das Panel baut einen WireGuard-Tunnel zur Node auf. Der Hauptserver braucht keine Portfreigabe – nur auf der Node muss ein UDP-Port offen sein. Richtig für gemietete Server im Internet.'}
            </p>
          </div>

          <Field
            label={direct ? (platform === 'windows' ? 'LAN-IP des Windows-PCs' : 'LAN-IP der Node') : 'Öffentliche Adresse der Node'}
            hint={direct
              ? platform === 'windows'
                ? 'Feste private IPv4-Adresse des PCs (ipconfig → IPv4-Adresse), z. B. 192.168.1.50. Am besten im Router fest vergeben.'
                : 'Feste private IPv4-Adresse, z. B. 192.168.1.50. Am besten im Router fest vergeben.'
              : platform === 'windows'
                ? 'Öffentliche IP oder DynDNS-Name des Anschlusses, an dem der PC hängt. Im Router UDP-Port und Spielports auf den PC weiterleiten.'
                : 'IP-Adresse oder DNS-Name des VPS. Spieler verbinden sich ebenfalls mit dieser Adresse.'}
          >
            <input className="mc-input font-mono" value={host} onChange={(e) => setHost(e.target.value.trim())}
              placeholder={direct ? '192.168.1.50' : 'vps.example.com'} />
          </Field>

          <button type="button" className="flex items-center gap-1.5 text-xs text-stone-400 hover:text-stone-200" onClick={() => setAdvanced(!advanced)}>
            {advanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />} Erweitert
          </button>
          {advanced && (
            <div className="grid gap-4 sm:grid-cols-2">
              {!direct && (
                <Field label="WireGuard-Port (UDP)" hint="Muss auf der Node erreichbar sein.">
                  <input className="mc-input font-mono" type="number" min={1} max={65535} value={listenPort}
                    onChange={(e) => setListenPort(Number(e.target.value) || 51820)} />
                </Field>
              )}
              {platform === 'linux' && (
                <Field label="Datenverzeichnis auf der Node" hint="Hier liegen die Serverdaten.">
                  <input className="mc-input font-mono" value={dataRoot} onChange={(e) => setDataRoot(e.target.value.trim())} />
                </Field>
              )}
            </div>
          )}

          {platform === 'windows' ? (
            <InfoNote>
              Voraussetzung: Windows 10/11 mit <strong>Docker Desktop</strong> (Linux-Container, WSL 2) – installierbar mit{' '}
              <span className="font-mono">winget install -e --id Docker.DockerDesktop</span>. Die Serverdaten liegen in einem
              Docker-Volume; Docker Desktop muss laufen, damit die Node erreichbar ist.
            </InfoNote>
          ) : (
            <InfoNote>
              Voraussetzung: Linux mit root-Zugang (Debian, Ubuntu, Fedora, Alpine …). Docker wird bei Bedarf automatisch installiert.
            </InfoNote>
          )}
        </div>
      )}

      {step === 2 && install && (
        <div className="space-y-4">
          <InstallInstructions install={install} direct={direct} platform={platform} />
          <div className="flex items-start gap-3 border border-stone-700 bg-stone-900/60 p-3 text-sm">
            <Loader2 size={18} className="mt-0.5 shrink-0 animate-spin text-gold" />
            <div>
              <p className="text-stone-200">Warte darauf, dass sich die Node meldet …</p>
              {node?.error && <p className="mt-1 text-xs text-stone-400">{node.error}</p>}
            </div>
          </div>
        </div>
      )}

      {step === 3 && node && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 text-emerald">
            <CheckCircle2 size={22} />
            <p className="heading text-base">„{node.name}“ ist verbunden</p>
          </div>
          {node.metrics && (
            <p className="text-sm text-stone-300">
              {node.metrics.hostname}: {node.metrics.cpus} Kerne, {formatMemory(node.metrics.memTotalMb)} RAM,{' '}
              {formatMemory(node.metrics.diskFreeMb)} Platte frei, Docker {node.metrics.dockerVersion}.
            </p>
          )}
          <InfoNote>
            Neue Server lassen sich jetzt beim Anlegen auf diese Node legen. Bestehende Server ziehst du in deren
            Einstellungen unter „Node“ um.
          </InfoNote>
        </div>
      )}
    </Modal>
  );
}

// ----------------------------------------------------------------- Seite ---

export default function NodesPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [wizard, setWizard] = useState(false);
  const [installFor, setInstallFor] = useState<NodeOverview | null>(null);
  const [deleteFor, setDeleteFor] = useState<NodeOverview | null>(null);
  const [uninstall, setUninstall] = useState<string | null>(null);
  const [updateFor, setUpdateFor] = useState<NodeOverview | null>(null);

  const overview = useQuery({
    queryKey: ['nodes'],
    queryFn: () => api.get<NodesResponse>('/nodes'),
    // Während eines Agent-Updates den Fortschritt dichter abfragen.
    refetchInterval: (query) => (query.state.data?.nodes.some((node) => node.update?.state === 'running') ? 2000 : 10_000),
  });
  const install = useQuery({
    queryKey: ['nodes', 'install', installFor?.id],
    queryFn: () => api.get<NodeInstall>(`/nodes/${installFor!.id}/install`),
    enabled: Boolean(installFor?.id),
    staleTime: Infinity,
  });

  if (overview.isLoading) return <LoadingBlock label="Nodes werden geladen …" />;
  if (!overview.data) return <LoadErrorBlock error={overview.error} onRetry={() => void overview.refetch()} />;
  const { nodes, tunnel } = overview.data;
  const remote = nodes.filter((node) => !node.local);
  const needsTunnel = remote.some((node) => node.connection === 'wireguard');

  return (
    <div className="flex min-w-0 flex-col gap-5 animate-fade-in">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="heading-pixel text-base">Nodes</h1>
          <p className="mt-2.5 text-sm text-stone-350">
            Weitere Rechner für deine Minecraft-Server – ein gemieteter VPS oder ein zweiter PC im Heimnetz.
          </p>
        </div>
        <div className="flex gap-2">
          <Button icon={<RefreshCw size={15} />} loading={overview.isFetching} onClick={() => void overview.refetch()}>Aktualisieren</Button>
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => setWizard(true)}>Node hinzufügen</Button>
        </div>
      </div>

      {needsTunnel && !tunnel.up && tunnel.error && (
        <ErrorNote><strong>WireGuard-Tunnel nicht verfügbar:</strong> {tunnel.error}</ErrorNote>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-2">
        {nodes.map((node) => (
          <NodeCard
            key={node.id ?? 'local'}
            node={node}
            panelVersion={overview.data.panelVersion ?? ''}
            onInstall={() => setInstallFor(node)}
            onDelete={() => setDeleteFor(node)}
            onUpdate={() => setUpdateFor(node)}
          />
        ))}
      </div>

      {remote.length === 0 && (
        <Panel>
          <EmptyState
            icon={<Network size={32} />}
            title="Noch keine weiteren Nodes"
            description="Füge einen VPS oder einen zweiten Rechner hinzu. Ein Befehl auf der Node genügt – danach kannst du Server per Klick dorthin umziehen."
            action={<Button variant="primary" icon={<Plus size={15} />} onClick={() => setWizard(true)}>Node hinzufügen</Button>}
          />
        </Panel>
      )}

      <AddNodeWizard open={wizard} onClose={() => { setWizard(false); void queryClient.invalidateQueries({ queryKey: ['nodes'] }); }} />

      <Modal open={Boolean(installFor)} onClose={() => setInstallFor(null)} title={`Installationsbefehl – ${installFor?.name ?? ''}`} size="lg"
        footer={<Button variant="primary" onClick={() => setInstallFor(null)}>Schließen</Button>}>
        {install.isLoading ? <LoadingBlock /> : install.data ? (
          <div className="space-y-4">
            <InstallInstructions install={install.data} direct={installFor?.connection === 'direct'} platform={installFor?.platform === 'windows' ? 'windows' : 'linux'} />
            <Field label="Node später wieder entfernen" hint={installFor?.platform === 'windows'
              ? 'In der PowerShell auf dem PC ausführen. Die Serverdaten im Volume „mcpanel-node-data“ bleiben liegen.'
              : 'Auf der Node ausführen. Die Serverdaten im Datenverzeichnis bleiben liegen.'}>
              <CopyBlock text={install.data.uninstall} label="Befehl kopieren" />
            </Field>
          </div>
        ) : <LoadErrorBlock error={install.error} />}
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteFor)}
        onClose={() => setDeleteFor(null)}
        danger
        title="Node entfernen?"
        confirmLabel="Entfernen"
        requireText={deleteFor?.name}
        message={<>Das Panel trennt sich von <strong>{deleteFor?.name}</strong> und vergisst ihre Zugangsdaten. Auf der Node selbst läuft der Agent weiter, bis du ihn dort entfernst.</>}
        onConfirm={async () => {
          if (!deleteFor?.id) return;
          try {
            const result = await api.del<{ uninstall: string }>(`/nodes/${deleteFor.id}`);
            setUninstall(result.uninstall);
            toast.success('Node entfernt');
            void queryClient.invalidateQueries({ queryKey: ['nodes'] });
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Entfernen fehlgeschlagen');
          }
        }}
      />

      <ConfirmDialog
        open={Boolean(updateFor)}
        onClose={() => setUpdateFor(null)}
        title="Agent aktualisieren?"
        confirmLabel="Aktualisieren"
        message={<>
          Die Node <strong>{updateFor?.name}</strong> lädt das Abbild <span className="font-mono">{overview.data.image}</span> und
          startet ihren Agenten damit neu. Minecraft-Server laufen weiter; Konsole, Dateien und Spielerlisten sind für etwa
          eine halbe Minute nicht erreichbar. Startet der neue Agent nicht, läuft automatisch wieder der bisherige.
        </>}
        onConfirm={async () => {
          if (!updateFor?.id) return;
          try {
            await api.post(`/nodes/${updateFor.id}/update-agent`);
            toast.success('Agent-Update gestartet');
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Update konnte nicht gestartet werden');
          }
          void queryClient.invalidateQueries({ queryKey: ['nodes'] });
        }}
      />

      <Modal open={Boolean(uninstall)} onClose={() => setUninstall(null)} title="Agent auf der Node entfernen" size="md"
        footer={<Button variant="primary" onClick={() => setUninstall(null)}>Schließen</Button>}>
        <div className="space-y-3">
          <p className="flex items-center gap-2 text-sm text-stone-300"><KeyRound size={15} />Zum Aufräumen auf der Node ausführen:</p>
          {uninstall && <CopyBlock text={uninstall} label="Befehl kopieren" />}
        </div>
      </Modal>
    </div>
  );
}
