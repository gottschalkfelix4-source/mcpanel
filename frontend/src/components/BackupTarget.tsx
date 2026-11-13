import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Ban, Check, Cloud, Globe, HardDrive, Plug, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import { Badge, Button, ErrorNote, Field, InfoNote, LoadingBlock, Panel, Toggle, useToast } from './ui';

type TargetKind = 'NONE' | 'SMB' | 'S3' | 'WEBDAV';

interface TargetView {
  kind: TargetKind;
  keepLocal: boolean;
  smb: {
    host: string;
    share: string;
    path: string;
    username: string;
    domain: string;
    version: string;
    passwordSet: boolean;
  };
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    accessKeyId: string;
    forcePathStyle: boolean;
    secretMasked: string;
    secretSet: boolean;
  };
  webdav: {
    url: string;
    username: string;
    passwordSet: boolean;
  };
}

interface TargetStatus {
  kind: TargetKind;
  ok: boolean;
  message: string;
  freeBytes: number | null;
}

const KINDS: { key: TargetKind; label: string; hint: string; Icon: typeof Cloud; tint: string }[] = [
  {
    key: 'NONE',
    label: 'Keine',
    hint: 'Sicherungen liegen nur neben den Serverdaten – auf derselben Platte.',
    Icon: Ban,
    tint: '#8a8a8a',
  },
  {
    key: 'SMB',
    label: 'Samba-Freigabe',
    hint: 'Ein NAS oder ein Windows-Rechner im Netz. Das Panel hängt die Freigabe selbst ein.',
    Icon: HardDrive,
    tint: '#FFAA00',
  },
  {
    key: 'S3',
    label: 'S3-Speicher',
    hint: 'AWS S3, MinIO, Backblaze B2, Wasabi – alles, was die S3-Schnittstelle spricht.',
    Icon: Cloud,
    tint: '#4AEDD9',
  },
  {
    key: 'WEBDAV',
    label: 'WebDAV',
    hint: 'Nextcloud, ownCloud, Synology, QNAP, Hetzner Storage Box – ein Ordner per Adresse.',
    Icon: Globe,
    tint: '#55AAFF',
  },
];

const KIND_LABEL: Record<TargetKind, string> = { NONE: 'Keine', SMB: 'Samba', S3: 'S3', WEBDAV: 'WebDAV' };

/** Gilt ein gespeichertes Kennwort noch? Nur für denselben Server (wie im Backend). */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a.trim()).origin === new URL(b.trim()).origin;
  } catch {
    return false;
  }
}

/** Speicherziel für Backups: Art wählen, Zugang eintragen, Verbindung prüfen. */
export default function BackupTarget() {
  const toast = useToast();

  const query = useQuery({
    queryKey: ['backup-target'],
    queryFn: () => api.get<{ target: TargetView; status: TargetStatus }>('/settings/backup-target'),
  });

  const [kind, setKind] = useState<TargetKind>('NONE');
  const [keepLocal, setKeepLocal] = useState(false);
  const [smb, setSmb] = useState({
    host: '', share: '', path: '', username: '', password: '', domain: '', version: '3.0',
  });
  const [s3, setS3] = useState({
    endpoint: '', region: 'us-east-1', bucket: '', prefix: '',
    accessKeyId: '', secretAccessKey: '', forcePathStyle: true,
  });
  const [webdav, setWebdav] = useState({ url: '', username: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<TargetStatus | null>(null);

  // Gespeicherten Stand übernehmen. Geheimnisse kommen nie mit – die Felder
  // bleiben leer und bedeuten beim Speichern „unverändert lassen".
  useEffect(() => {
    const t = query.data?.target;
    if (!t) return;
    setKind(t.kind);
    setKeepLocal(t.keepLocal);
    setSmb({ ...t.smb, password: '' });
    setS3({ ...t.s3, secretAccessKey: '' });
    setWebdav({ url: t.webdav.url, username: t.webdav.username, password: '' });
  }, [query.data]);

  const body = () => ({ kind, keepLocal, smb, s3, webdav });

  const test = useMutation({
    mutationFn: () => api.post<TargetStatus>('/settings/backup-target/test', body()),
    onSuccess: (status) => {
      setProbe(status);
      status.ok ? toast.success(status.message) : toast.error(status.message);
    },
    onError: (err: Error) => setError(err.message),
  });

  const save = useMutation({
    mutationFn: () =>
      api.put<{ ok: boolean; status: TargetStatus; target: TargetView }>(
        '/settings/backup-target',
        body(),
      ),
    onSuccess: (res) => {
      setProbe(res.status);
      if (res.ok) {
        toast.success('Speicherziel gesichert.');
        setError(null);
        void query.refetch();
      } else {
        setError(`Nicht gespeichert – die Verbindung schlug fehl: ${res.status.message}`);
      }
    },
    onError: (err: Error) => setError(err.message),
  });

  if (query.isLoading) {
    return (
      <Panel title="Backup-Speicherziel" icon={<HardDrive size={16} />}>
        <LoadingBlock />
      </Panel>
    );
  }

  const status = probe ?? query.data?.status ?? null;
  const saved = query.data?.target;
  const busy = test.isPending || save.isPending;

  return (
    <Panel
      title="Backup-Speicherziel"
      icon={<HardDrive size={16} />}
      subtitle="Wohin jede fertige Sicherung zusätzlich kopiert wird."
      actions={
        saved && (
          <Badge tone={saved.kind === 'NONE' ? 'neutral' : status?.ok ? 'green' : 'red'}>
            {saved.kind === 'NONE'
              ? 'nicht eingerichtet'
              : `${KIND_LABEL[saved.kind]}${status?.ok ? '' : ' – gestört'}`}
          </Badge>
        )
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote>{error}</ErrorNote>}

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {KINDS.map((option) => {
            const active = kind === option.key;
            return (
              <button
                key={option.key}
                type="button"
                onClick={() => {
                  setKind(option.key);
                  setProbe(null);
                }}
                className={clsx(
                  'flex items-start gap-3 border p-3 text-left transition',
                  active
                    ? 'border-grass-light bg-grass/[0.14]'
                    : 'border-stone-700 bg-stone-900/60 hover:border-stone-550',
                )}
              >
                <option.Icon size={18} style={{ color: option.tint }} className="mt-0.5 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-stone-100">{option.label}</span>
                  <span className="mt-1 block text-xs leading-snug text-stone-350">{option.hint}</span>
                </span>
              </button>
            );
          })}
        </div>

        {kind === 'SMB' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Server" hint="Name oder IP, z. B. nas.fritz.box">
              <input
                className="mc-input w-full"
                value={smb.host}
                onChange={(e) => setSmb((p) => ({ ...p, host: e.target.value }))}
                placeholder="192.168.1.20"
              />
            </Field>
            <Field label="Freigabe" hint="Der Name hinter dem Servernamen, ohne Schrägstriche.">
              <input
                className="mc-input w-full"
                value={smb.share}
                onChange={(e) => setSmb((p) => ({ ...p, share: e.target.value }))}
                placeholder="backups"
              />
            </Field>
            <Field label="Unterordner" hint="Optional, innerhalb der Freigabe.">
              <input
                className="mc-input w-full"
                value={smb.path}
                onChange={(e) => setSmb((p) => ({ ...p, path: e.target.value }))}
                placeholder="minecraft"
              />
            </Field>
            <Field label="Benutzer" hint="Leer lassen für eine Gastfreigabe.">
              <input
                className="mc-input w-full"
                value={smb.username}
                onChange={(e) => setSmb((p) => ({ ...p, username: e.target.value }))}
              />
            </Field>
            <Field
              label="Kennwort"
              hint={
                saved?.smb.passwordSet
                  ? 'Gespeichert – leer lassen, um es zu behalten.'
                  : 'Wird nur auf dem Server gespeichert und nie zurückgegeben.'
              }
            >
              <input
                type="password"
                className="mc-input w-full"
                value={smb.password}
                onChange={(e) => setSmb((p) => ({ ...p, password: e.target.value }))}
                placeholder={saved?.smb.passwordSet ? '••••••••' : ''}
              />
            </Field>
            <Field label="Domäne / Protokoll" hint="Domäne meist leer; Protokoll 3.0 passt fast immer.">
              <div className="flex gap-2">
                <input
                  className="mc-input w-full"
                  value={smb.domain}
                  onChange={(e) => setSmb((p) => ({ ...p, domain: e.target.value }))}
                  placeholder="WORKGROUP"
                />
                <select
                  className="mc-input w-24 shrink-0"
                  value={smb.version}
                  onChange={(e) => setSmb((p) => ({ ...p, version: e.target.value }))}
                >
                  <option value="3.0">3.0</option>
                  <option value="3.1.1">3.1.1</option>
                  <option value="2.1">2.1</option>
                  <option value="1.0">1.0</option>
                </select>
              </div>
            </Field>
          </div>
        )}

        {kind === 'S3' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Bucket">
              <input
                className="mc-input w-full"
                value={s3.bucket}
                onChange={(e) => setS3((p) => ({ ...p, bucket: e.target.value }))}
                placeholder="mcpanel-backups"
              />
            </Field>
            <Field label="Region">
              <input
                className="mc-input w-full"
                value={s3.region}
                onChange={(e) => setS3((p) => ({ ...p, region: e.target.value }))}
                placeholder="eu-central-1"
              />
            </Field>
            <Field label="Endpunkt" hint="Leer lassen für AWS. Sonst die URL des Anbieters.">
              <input
                className="mc-input w-full font-mono text-xs"
                value={s3.endpoint}
                onChange={(e) => setS3((p) => ({ ...p, endpoint: e.target.value }))}
                placeholder="https://s3.eu-central-003.backblazeb2.com"
              />
            </Field>
            <Field label="Präfix" hint="Optionaler Ordner im Bucket.">
              <input
                className="mc-input w-full"
                value={s3.prefix}
                onChange={(e) => setS3((p) => ({ ...p, prefix: e.target.value }))}
                placeholder="mcpanel/"
              />
            </Field>
            <Field label="Zugriffsschlüssel-ID">
              <input
                className="mc-input w-full font-mono text-xs"
                value={s3.accessKeyId}
                onChange={(e) => setS3((p) => ({ ...p, accessKeyId: e.target.value }))}
              />
            </Field>
            <Field
              label="Geheimer Schlüssel"
              hint={
                saved?.s3.secretSet
                  ? `Gespeichert (${saved.s3.secretMasked}) – leer lassen, um ihn zu behalten.`
                  : 'Wird nur auf dem Server gespeichert und nie zurückgegeben.'
              }
            >
              <input
                type="password"
                className="mc-input w-full font-mono text-xs"
                value={s3.secretAccessKey}
                onChange={(e) => setS3((p) => ({ ...p, secretAccessKey: e.target.value }))}
                placeholder={saved?.s3.secretSet ? '••••••••' : ''}
              />
            </Field>
            <div className="sm:col-span-2">
              <Toggle
                checked={s3.forcePathStyle}
                onChange={(v) => setS3((p) => ({ ...p, forcePathStyle: v }))}
                label="Pfad-Adressierung (für MinIO und die meisten Nicht-AWS-Anbieter nötig)"
              />
            </div>
          </div>
        )}

        {kind === 'WEBDAV' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field
                label="Adresse des Ordners"
                hint="Nextcloud: …/remote.php/dav/files/BENUTZER/Ordner · Synology: http://nas:5005/Freigabe/Ordner. Fehlt der letzte Ordner, legt das Panel ihn an."
              >
                <input
                  className="mc-input w-full font-mono text-xs"
                  value={webdav.url}
                  onChange={(e) => setWebdav((p) => ({ ...p, url: e.target.value }))}
                  placeholder="https://cloud.example.de/remote.php/dav/files/anna/MCPanel"
                />
              </Field>
            </div>
            <Field label="Benutzer">
              <input
                className="mc-input w-full"
                value={webdav.username}
                onChange={(e) => setWebdav((p) => ({ ...p, username: e.target.value }))}
                autoComplete="off"
              />
            </Field>
            <Field
              label="Kennwort"
              hint={
                saved?.webdav.passwordSet && sameOrigin(webdav.url, saved.webdav.url)
                  ? 'Gespeichert – leer lassen, um es zu behalten.'
                  : 'Bei Nextcloud mit Zwei-Faktor ein App-Passwort. Wird nie zurückgegeben.'
              }
            >
              <input
                type="password"
                className="mc-input w-full"
                value={webdav.password}
                onChange={(e) => setWebdav((p) => ({ ...p, password: e.target.value }))}
                placeholder={saved?.webdav.passwordSet && sameOrigin(webdav.url, saved.webdav.url) ? '••••••••' : ''}
                autoComplete="new-password"
              />
            </Field>
            {/^http:\/\//i.test(webdav.url.trim()) && (
              <div className="sm:col-span-2">
                <InfoNote>
                  Mit http:// gehen Kennwort und Sicherungen unverschlüsselt durchs Netz – nur im
                  eigenen Heimnetz verwenden, im Internet immer https://.
                </InfoNote>
              </div>
            )}
          </div>
        )}

        {status && kind !== 'NONE' && (
          <div
            className={clsx(
              'flex items-start gap-2 border px-3 py-2.5 text-xs',
              status.ok
                ? 'border-emerald/40 bg-emerald/[0.10] text-emerald'
                : 'border-red-500/40 bg-red-500/[0.10] text-red-300',
            )}
          >
            {status.ok ? (
              <Check size={14} className="mt-0.5 shrink-0" />
            ) : (
              <TriangleAlert size={14} className="mt-0.5 shrink-0" />
            )}
            <span className="min-w-0 break-words">
              {status.message}
              {status.freeBytes !== null && ` · ${(status.freeBytes / 1024 ** 3).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB frei`}
            </span>
          </div>
        )}

        {kind === 'NONE' && (
          <InfoNote>
            Ohne Zweitablage liegen die Sicherungen auf derselben Platte wie die Serverdaten. Das
            hilft gegen versehentliches Löschen, aber nicht gegen einen Plattenausfall.
          </InfoNote>
        )}

        {kind !== 'NONE' && (
          <div className="space-y-1.5 border border-stone-700 bg-stone-900/40 p-3">
            <Toggle checked={keepLocal} onChange={setKeepLocal} label="Zusätzlich eine lokale Kopie im Panel behalten" />
            <p className="text-xs leading-relaxed text-stone-400">
              {keepLocal
                ? 'Jede Sicherung wird lokal gepackt und danach ins Speicherziel kopiert – zwei Kopien, doppelter Platz, längere Laufzeit.'
                : 'Sicherungen entstehen direkt im Speicherziel, noch während gepackt wird – ohne lokale Kopie und ohne zweiten Durchgang. Ist das Ziel einmal nicht erreichbar, wird ausnahmsweise lokal gesichert.'}
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            icon={<Plug size={15} />}
            loading={test.isPending}
            disabled={busy || kind === 'NONE'}
            onClick={() => {
              setError(null);
              test.mutate();
            }}
          >
            Verbindung prüfen
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={busy}
            onClick={() => {
              setError(null);
              save.mutate();
            }}
          >
            Speichern
          </Button>
        </div>
      </div>
    </Panel>
  );
}
