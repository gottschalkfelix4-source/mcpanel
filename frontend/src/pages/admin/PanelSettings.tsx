import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Boxes, Container, ExternalLink, Key, ScrollText, Server } from 'lucide-react';
import { api } from '../../lib/api';
import NotificationChannels from '../../components/NotificationChannels';
import BackupTarget from '../../components/BackupTarget';
import { formatDate } from '../../lib/format';
import {
  Badge, Button, ErrorNote, Field, InfoNote, LoadingBlock, Panel, useToast,
} from '../../components/ui';

interface PanelInfo {
  publicHost: string;
  portRange: { min: number; max: number };
  dataRoot: string;
  hostDataRoot: string;
  mcImage: string;
  dockerNetwork: string;
  curseforge: { configured: boolean; masked: string | null };
  counts: { users: number; servers: number; backups: number };
  docker: { version: string; containers: number } | null;
}

interface AuditEntry {
  id: string;
  action: string;
  detail: string;
  createdAt: string;
  user: { id: string; username: string } | null;
  server: { id: string; name: string } | null;
}

export default function PanelSettingsPage() {
  const toast = useToast();
  const [apiKey, setApiKey] = useState('');

  const info = useQuery({
    queryKey: ['panel-settings'],
    queryFn: () => api.get<PanelInfo>('/settings'),
  });

  const audit = useQuery({
    queryKey: ['audit'],
    queryFn: () => api.get<AuditEntry[]>('/settings/audit?limit=60'),
  });

  const saveKey = useMutation({
    mutationFn: () => api.put<{ verified?: boolean; error?: string }>('/settings/curseforge', { apiKey }),
    onSuccess: (res) => {
      if (res.error) toast.error(`Gespeichert, aber der Test schlug fehl: ${res.error}`);
      else if (res.verified) toast.success('CurseForge-Key gespeichert und geprüft.');
      else toast.success('CurseForge-Key entfernt.');
      setApiKey('');
      void info.refetch();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (info.isLoading) return <LoadingBlock />;
  const data = info.data!;

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <div>
        <h1 className="heading-pixel text-base">Panel-Einstellungen</h1>
        <p className="mt-2.5 text-sm text-stone-350">
          Systemzustand, Integrationen und Aktivitätsprotokoll.
        </p>
      </div>

      {/* Überblick */}
      <div className="grid gap-[18px] [grid-template-columns:repeat(auto-fit,minmax(230px,1fr))]">
        <Metric icon={<Server size={13} />} tint="#7FB238" label="Server" value={data.counts.servers} delay={0} />
        <Metric icon={<Boxes size={13} />} tint="#4AEDD9" label="Benutzer" value={data.counts.users} delay={0.06} />
        <Metric icon={<ScrollText size={13} />} tint="#FFAA00" label="Backups" value={data.counts.backups} delay={0.12} />
        <Metric
          icon={<Container size={13} />}
          tint={data.docker ? '#17DD62' : '#E8453C'}
          label="Docker"
          value={data.docker ? `v${data.docker.version}` : 'nicht erreichbar'}
          sub={data.docker ? `${data.docker.containers} verwaltete Container` : 'Socket prüfen'}
          delay={0.18}
        />
      </div>

      {/* CurseForge */}
      <Panel
        title="CurseForge-Integration"
        icon={<Key size={16} />}
        subtitle="Ohne API-Key ist nur Modrinth durchsuchbar."
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-stone-400">Status:</span>
            {data.curseforge.configured ? (
              <Badge tone="green">aktiv · {data.curseforge.masked}</Badge>
            ) : (
              <Badge tone="red">kein Key hinterlegt</Badge>
            )}
          </div>

          <Field
            label="API-Key"
            hint={
              <span>
                Kostenlos unter{' '}
                <a
                  href="https://console.curseforge.com/"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-gold hover:underline"
                >
                  console.curseforge.com <ExternalLink size={11} />
                </a>{' '}
                erstellen. Leer lassen und speichern entfernt den Key.
              </span>
            }
          >
            <div className="flex flex-wrap gap-2">
              <input
                className="mc-input flex-1 font-mono"
                placeholder="$2a$10$…"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <Button variant="primary" loading={saveKey.isPending} onClick={() => saveKey.mutate()}>
                Speichern & testen
              </Button>
            </div>
          </Field>
        </div>
      </Panel>

      <BackupTarget />

      {/* Benachrichtigungen fuer alle Server */}
      <NotificationChannels
        basePath="/settings/notifications"
        queryKey={['notify', 'global']}
        scope="global"
      />

      {/* System */}
      <Panel title="Systemkonfiguration" icon={<Container size={16} />}>
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Row label="Öffentlicher Hostname" value={data.publicHost} />
          <Row label="Port-Bereich" value={`${data.portRange.min} – ${data.portRange.max}`} />
          <Row label="Datenpfad (Container)" value={data.dataRoot} mono />
          <Row label="Datenpfad (Host)" value={data.hostDataRoot} mono />
          <Row label="Server-Image" value={data.mcImage} mono />
          <Row label="Docker-Netzwerk" value={data.dockerNetwork} mono />
        </dl>

        {!data.docker && (
          <div className="mt-4">
            <ErrorNote>
              Der Docker-Socket ist nicht erreichbar. Ohne ihn kann das Panel keine Server starten –
              prüfe das Volume <code>/var/run/docker.sock</code> im Compose-Stack.
            </ErrorNote>
          </div>
        )}

        <div className="mt-4">
          <InfoNote>
            Diese Werte kommen aus der <code>.env</code> bzw. dem Compose-Stack. Nach einer Änderung
            ist ein Neustart des Backends nötig.
          </InfoNote>
        </div>
      </Panel>

      {/* Protokoll */}
      <Panel title="Aktivitätsprotokoll" icon={<ScrollText size={16} />} bodyClassName="!p-0">
        {audit.isLoading ? (
          <LoadingBlock />
        ) : (audit.data?.length ?? 0) === 0 ? (
          <p className="p-6 text-center text-sm text-stone-450">Noch keine Einträge.</p>
        ) : (
          <ul className="max-h-[26rem] divide-y divide-stone-875 overflow-y-auto">
            {audit.data!.map((entry, i) => (
              <li
                key={entry.id}
                className="flex animate-slide-in flex-wrap items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-stone-600/[0.28]"
                style={{ animationDelay: `${Math.min(i, 12) * 0.03}s` }}
              >
                <code className="shrink-0 font-mono text-xs text-diamond">{entry.action}</code>
                <span className="min-w-0 flex-1 truncate text-stone-350">{entry.detail}</span>
                {entry.server && <Badge>{entry.server.name}</Badge>}
                <span className="shrink-0 text-xs text-stone-450">
                  {entry.user?.username ?? 'System'}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-stone-550">
                  {formatDate(entry.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

/** Kennzahlkarte im Look der Server-Übersicht. */
function Metric({
  icon,
  tint,
  label,
  value,
  sub,
  delay,
}: {
  icon: React.ReactNode;
  tint: string;
  label: string;
  value: React.ReactNode;
  sub?: string;
  delay: number;
}) {
  return (
    <div
      className="mc-frame animate-fade-in transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-bevel-lift"
      style={{ animationDelay: `${delay}s`, animationFillMode: 'backwards' }}
    >
      <div className="mc-frame-inner p-4">
        <div className="flex items-center gap-[9px] text-[10px] font-bold uppercase tracking-[0.12em] text-stone-400">
          <span style={{ color: tint }}>{icon}</span>
          {label}
        </div>
        <p className="mt-3 font-mono text-[26px] leading-none text-stone-50 text-shadow-pixel">{value}</p>
        {sub && <p className="mt-2 text-[11px] text-stone-450">{sub}</p>}
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="border-l-[3px] border-stone-700 pl-[11px] transition-colors hover:border-grass-light">
      <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-stone-450">{label}</dt>
      <dd className={`mt-1 break-all text-sm text-stone-100 ${mono ? 'font-mono text-xs' : 'font-mono'}`}>
        {value}
      </dd>
    </div>
  );
}
