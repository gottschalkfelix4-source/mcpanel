import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Network, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { Badge, Button, ErrorNote, Field, InfoNote, LoadErrorBlock, LoadingBlock, Panel, Toggle, useToast } from './ui';

type WanInterface = 'wan' | 'wan2' | 'both';

interface UnifiConfig {
  enabled: boolean;
  url: string;
  site: string;
  auth: 'apikey' | 'login';
  username: string;
  verifyTls: boolean;
  fingerprint: string;
  forwardIp: string;
  wanInterface: WanInterface;
  forwardGamePorts: boolean;
  autoForwardDetected: boolean;
  hasApiKey: boolean;
  hasPassword: boolean;
}

interface SyncStatus {
  at: string;
  ok: boolean;
  error: string | null;
  created: number;
  updated: number;
  removed: number;
  rules: { name: string; port: number; protocol: string; ip: string }[];
  conflicts: { name: string; port: number; existing: string }[];
  skipped: { name: string; reason: string }[];
}

interface TestResult {
  ok: boolean;
  fingerprint: string;
  message: string;
}

const PROTO: Record<string, string> = { tcp: 'TCP', udp: 'UDP', tcp_udp: 'TCP+UDP' };

/**
 * UniFi-Anbindung: Portweiterleitungen für Sprachchat, Geyser & Co. legt das
 * Panel selbst auf der Konsole an. Der API-Schlüssel und das Passwort kommen
 * nie zurück – leere Felder behalten den gespeicherten Wert.
 */
export default function UnifiSettings() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['settings', 'unifi'],
    queryFn: () => api.get<{ config: UnifiConfig; status: SyncStatus | null }>('/settings/unifi'),
  });

  const [form, setForm] = useState<UnifiConfig | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [password, setPassword] = useState('');
  const [test, setTest] = useState<TestResult | null>(null);

  useEffect(() => {
    if (query.data && !form) setForm(query.data.config);
  }, [query.data, form]);

  const body = (extra: Partial<UnifiConfig> = {}) => {
    const next = { ...form!, ...extra };
    return {
      enabled: next.enabled, url: next.url, site: next.site, auth: next.auth,
      apiKey: apiKey || undefined, username: next.username, password: password || undefined,
      verifyTls: next.verifyTls, fingerprint: next.fingerprint, forwardIp: next.forwardIp,
      wanInterface: next.wanInterface, forwardGamePorts: next.forwardGamePorts,
      autoForwardDetected: next.autoForwardDetected,
    };
  };

  const runTest = useMutation({
    mutationFn: () => api.post<TestResult>('/settings/unifi/test', body()),
    onSuccess: (res) => setTest(res),
    onError: (err: Error) => toast.error(err.message),
  });

  const save = useMutation({
    mutationFn: (extra: Partial<UnifiConfig>) =>
      api.put<{ ok: boolean; test?: TestResult; removed?: number; removeError?: string | null; config: UnifiConfig; status: SyncStatus | null }>(
        '/settings/unifi', body(extra)),
    onSuccess: (res) => {
      if (!res.ok) {
        if (res.test) setTest(res.test);
        toast.error(`Nicht gespeichert – ${res.test?.message ?? 'Verbindung fehlgeschlagen'}`);
        return;
      }
      setForm(res.config);
      setApiKey('');
      setPassword('');
      if (!res.config.enabled) {
        toast.success(res.removeError
          ? `Anbindung aus. Die Weiterleitungen konnten nicht entfernt werden: ${res.removeError}`
          : `Anbindung aus – ${res.removed ?? 0} Weiterleitung(en) des Panels entfernt.`);
      } else if (res.status?.ok) {
        toast.success('UniFi angebunden – Weiterleitungen abgeglichen.');
      } else {
        toast.error(`Gespeichert, aber der Abgleich schlug fehl: ${res.status?.error ?? 'unbekannt'}`);
      }
      void queryClient.invalidateQueries({ queryKey: ['settings', 'unifi'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const sync = useMutation({
    mutationFn: () => api.post<{ ok: boolean; status: SyncStatus | null }>('/settings/unifi/sync'),
    onSuccess: (res) => {
      if (res.ok) toast.success('Weiterleitungen abgeglichen.');
      else toast.error(res.status?.error ?? 'Abgleich fehlgeschlagen');
      void queryClient.invalidateQueries({ queryKey: ['settings', 'unifi'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (query.isLoading || (query.data && !form)) {
    return <Panel title="UniFi-Portfreigaben" icon={<Network size={16} />}><LoadingBlock /></Panel>;
  }
  if (!query.data || !form) {
    return <Panel title="UniFi-Portfreigaben" icon={<Network size={16} />}><LoadErrorBlock error={query.error} onRetry={() => void query.refetch()} /></Panel>;
  }

  const saved = query.data.config;
  const status = query.data.status;
  const set = <K extends keyof UnifiConfig>(key: K, value: UnifiConfig[K]) => {
    setForm({ ...form, [key]: value });
    if (key === 'url' || key === 'verifyTls') setTest(null);
  };
  const fingerprintPending = !form.verifyTls && test?.fingerprint && test.fingerprint !== form.fingerprint;

  return (
    <Panel
      title="UniFi-Portfreigaben"
      icon={<Network size={16} />}
      subtitle="Öffnet die Ports von Simple Voice Chat, Geyser, BlueMap & Co. automatisch auf einer UniFi-Konsole (UDM Pro, UDR, UCG, Cloud Key)."
      actions={saved.enabled ? (
        <Button icon={<RefreshCw size={14} />} loading={sync.isPending} onClick={() => sync.mutate()}>Jetzt abgleichen</Button>
      ) : undefined}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-stone-400">Status:</span>
          {!saved.enabled ? <Badge tone="neutral">aus</Badge>
            : !status ? <Badge tone="gold">noch nicht abgeglichen</Badge>
            : status.ok ? <Badge tone="green">aktiv · {status.rules.length} Weiterleitung(en)</Badge>
            : <Badge tone="red">Fehler</Badge>}
          {status && <span className="text-xs text-stone-450">zuletzt {formatDate(status.at)}</span>}
        </div>
        {saved.enabled && status?.error && <ErrorNote>{status.error}</ErrorNote>}

        <Toggle checked={form.enabled} onChange={(v) => set('enabled', v)} label="Portfreigaben automatisch auf der UniFi-Konsole pflegen" />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Adresse der Konsole" hint="Die interne Adresse, unter der du die UniFi-Oberfläche öffnest.">
            <input className="mc-input font-mono" placeholder="https://192.168.1.1" value={form.url} onChange={(e) => set('url', e.target.value)} />
          </Field>
          <Field label="Site" hint="Fast immer „default“.">
            <input className="mc-input font-mono" value={form.site} onChange={(e) => set('site', e.target.value)} />
          </Field>
        </div>

        <Field label="Anmeldung">
          <select className="mc-select" value={form.auth} onChange={(e) => set('auth', e.target.value as UnifiConfig['auth'])}>
            <option value="apikey">API-Schlüssel</option>
            <option value="login">Lokaler Benutzer (Benutzername + Passwort)</option>
          </select>
        </Field>

        {form.auth === 'apikey' ? (
          <Field
            label="API-Schlüssel"
            hint={<>In der Konsole unter <strong>Einstellungen → Steuerebene → Integrationen</strong> erzeugen. {saved.hasApiKey ? 'Leer lassen behält den gespeicherten Schlüssel.' : ''} Lehnt deine Netzwerk-Version Portweiterleitungen per Schlüssel ab, nimm einen lokalen Benutzer.</>}
          >
            <input className="mc-input font-mono" type="password" autoComplete="off" placeholder={saved.hasApiKey ? '•••••••• (gespeichert)' : ''} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </Field>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Benutzername" hint="Eigenes lokales Konto mit Netzwerk-Administratorrechten, ohne Zwei-Faktor-Anmeldung.">
              <input className="mc-input" autoComplete="off" value={form.username} onChange={(e) => set('username', e.target.value)} />
            </Field>
            <Field label="Passwort" hint={saved.hasPassword ? 'Leer lassen behält das gespeicherte Passwort.' : undefined}>
              <input className="mc-input" type="password" autoComplete="new-password" placeholder={saved.hasPassword ? '•••••••• (gespeichert)' : ''} value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Weiterleiten an (LAN-IP des Docker-Hosts)" hint="Die feste IP des Rechners, auf dem das Panel bzw. Docker läuft – z. B. dein Unraid-Server. Server auf Nodes im Heimnetz nutzen deren Adresse.">
            <input className="mc-input font-mono" placeholder="192.168.1.10" value={form.forwardIp} onChange={(e) => set('forwardIp', e.target.value)} />
          </Field>
          <Field label="WAN-Schnittstelle">
            <select className="mc-select" value={form.wanInterface} onChange={(e) => set('wanInterface', e.target.value as WanInterface)}>
              <option value="wan">WAN 1</option>
              <option value="wan2">WAN 2</option>
              <option value="both">Beide</option>
            </select>
          </Field>
        </div>

        <Toggle checked={form.forwardGamePorts} onChange={(v) => set('forwardGamePorts', v)}
          label="Auch die Spielports freigeben (bzw. den Port des Subdomain-Proxys)" />

        <div>
          <Toggle checked={form.autoForwardDetected} onChange={(v) => set('autoForwardDetected', v)}
            label="Erkannte Mod-Ports ohne Rückfrage freigeben" />
          <p className="mt-1 text-xs leading-relaxed text-stone-400">
            Aus (empfohlen): Neue Ports erscheinen am Server unter „Zusätzliche Ports“ und ein Administrator schaltet die
            Router-Freigabe einmal ein. An: Jeder erkannte Port wird sofort geöffnet – die Portnummer steht aber in Dateien
            des Servers, die jedes Mitglied mit Dateirechten ändern kann.
          </p>
        </div>

        <div className="space-y-2 border border-stone-800 bg-stone-900/40 p-3">
          <Toggle checked={form.verifyTls} onChange={(v) => set('verifyTls', v)} label="Gültiges Zertifikat erzwingen (nur mit eigenem Zertifikat auf der Konsole)" />
          {!form.verifyTls && (
            <p className="text-xs leading-relaxed text-stone-400">
              UniFi-Konsolen haben meist ein selbstsigniertes Zertifikat. Das Panel merkt sich deshalb dessen Fingerabdruck und
              verbindet sich nur mit genau dieser Konsole – sonst könnte ein Gerät im Netz den API-Schlüssel abgreifen.
            </p>
          )}
          {!form.verifyTls && form.fingerprint && (
            <p className="flex items-start gap-2 text-xs text-stone-300">
              <ShieldCheck size={14} className="mt-0.5 shrink-0 text-grass-light" />
              <span>Bestätigt: <code className="break-all text-stone-200">{form.fingerprint}</code></span>
            </p>
          )}
        </div>

        {test && (
          test.ok
            ? <InfoNote>{test.message}</InfoNote>
            : fingerprintPending
              ? (
                <div className="space-y-2 border border-gold/40 bg-gold/[0.08] p-3 text-sm text-stone-200">
                  <p>Die Konsole meldet diesen Zertifikats-Fingerabdruck (SHA-256):</p>
                  <code className="block select-all break-all font-mono text-xs text-gold">{test.fingerprint}</code>
                  <p className="text-xs text-stone-400">
                    Vergleiche ihn mit dem Zertifikat, das dein Browser beim Öffnen der Konsole anzeigt (Schloss-Symbol → Zertifikat).
                    Stimmt er, bestätige ihn.
                  </p>
                  <Button variant="gold" icon={<ShieldCheck size={14} />} onClick={() => { set('fingerprint', test.fingerprint); setTest(null); }}>
                    Fingerabdruck bestätigen
                  </Button>
                </div>
              )
              : <ErrorNote>{test.message}</ErrorNote>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button loading={runTest.isPending} disabled={!form.url} onClick={() => runTest.mutate()}>Verbindung testen</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate({})}>Speichern</Button>
        </div>

        {saved.enabled && status?.ok && (
          <div className="space-y-2">
            {status.conflicts.length > 0 && (
              <ErrorNote>
                Nicht angelegt, weil der Port im Router schon vergeben ist:{' '}
                {status.conflicts.map((c) => `${c.name} (Port ${c.port}, belegt durch „${c.existing}“)`).join('; ')}
              </ErrorNote>
            )}
            {status.skipped.length > 0 && (
              <InfoNote>
                Übersprungen: {status.skipped.map((s) => `${s.name} – ${s.reason}`).join('; ')}
              </InfoNote>
            )}
            {status.rules.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-stone-450">
                    <tr><th className="py-1 pr-3 font-normal">Regel</th><th className="py-1 pr-3 font-normal">Port</th><th className="py-1 font-normal">Ziel</th></tr>
                  </thead>
                  <tbody className="text-stone-300">
                    {status.rules.map((rule) => (
                      <tr key={rule.port} className="border-t border-stone-800">
                        <td className="py-1 pr-3">{rule.name}</td>
                        <td className="py-1 pr-3 font-mono">{rule.port} {PROTO[rule.protocol] ?? rule.protocol}</td>
                        <td className="py-1 font-mono">{rule.ip}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
