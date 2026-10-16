import { useMutation, useQueryClient } from '@tanstack/react-query';
import { HardDrive, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatBytes } from '../lib/format';
import { Badge, ErrorNote, Field, InfoNote, Panel, ProgressBar, useToast } from './ui';

export type TotpPolicy = 'off' | 'admins' | 'all';

export interface SecurityInfo {
  requireTotp: TotpPolicy;
  usersWithoutTotp: number;
  adminsWithoutTotp: number;
}

export interface DiskInfo {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
  warnBytes: number;
  low: boolean;
}

const POLICY_LABEL: Record<TotpPolicy, string> = {
  off: 'Freiwillig – jedes Konto entscheidet selbst',
  admins: 'Pflicht für Administratoren',
  all: 'Pflicht für alle Konten',
};

/** Zwei-Faktor-Pflicht für das ganze Panel. */
export function SecuritySettings({ data }: { data: SecurityInfo }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const save = useMutation({
    mutationFn: (requireTotp: TotpPolicy) => api.put<{ requireTotp: TotpPolicy }>('/settings/security', { requireTotp }),
    onSuccess: (res) => {
      toast.success(`Zwei-Faktor-Anmeldung: ${POLICY_LABEL[res.requireTotp]}.`);
      void queryClient.invalidateQueries({ queryKey: ['panel-settings'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const affected =
    data.requireTotp === 'all' ? data.usersWithoutTotp : data.requireTotp === 'admins' ? data.adminsWithoutTotp : 0;

  return (
    <Panel title="Anmeldesicherheit" icon={<ShieldCheck size={16} />}>
      <div className="space-y-4">
        <Field
          label="Zwei-Faktor-Anmeldung"
          hint="Betroffene Konten ohne zweiten Faktor landen nach der Anmeldung direkt in der Einrichtung und kommen erst danach ins Panel."
        >
          <select
            className="mc-input max-w-md"
            value={data.requireTotp}
            disabled={save.isPending}
            onChange={(e) => save.mutate(e.target.value as TotpPolicy)}
          >
            {(Object.keys(POLICY_LABEL) as TotpPolicy[]).map((key) => (
              <option key={key} value={key}>{POLICY_LABEL[key]}</option>
            ))}
          </select>
        </Field>
        <div className="flex flex-wrap gap-2 text-sm">
          <Badge tone={data.usersWithoutTotp ? 'gold' : 'green'}>{data.usersWithoutTotp} Konten ohne zweiten Faktor</Badge>
          <Badge tone={data.adminsWithoutTotp ? 'gold' : 'green'}>davon {data.adminsWithoutTotp} Administratoren</Badge>
        </div>
        {affected > 0 && (
          <InfoNote>
            {affected === 1 ? 'Ein Konto muss' : `${affected} Konten müssen`} den zweiten Faktor bei der nächsten
            Anmeldung einrichten. Bestehende Sitzungen werden bis dahin auf die Einrichtung beschränkt.
          </InfoNote>
        )}
        {!user?.totpEnabled && data.requireTotp === 'off' && (
          <p className="text-xs text-stone-450">
            Um eine Pflicht einzuschalten, die auch dich betrifft, richte zuerst im Profil deinen eigenen zweiten
            Faktor ein – sonst sperrst du dich selbst aus.
          </p>
        )}
      </div>
    </Panel>
  );
}

/**
 * Belegung des Datenträgers unter dem Datenverzeichnis. Die Benachrichtigung
 * bei knappem Platz verschickt das Backend unabhängig davon.
 */
export function DiskSpace({ disk }: { disk: DiskInfo | null }) {
  return (
    <Panel title="Speicherplatz" icon={<HardDrive size={16} />} subtitle="Datenträger mit Servern, Backups und Datenbank">
      {!disk ? (
        <p className="text-sm text-stone-400">Der Speicherplatz lässt sich auf diesem System nicht ermitteln.</p>
      ) : (
        <div className="space-y-3">
          <ProgressBar value={disk.usedPercent} tone={disk.low ? 'red' : disk.usedPercent >= 80 ? 'gold' : 'green'} />
          <p className="text-sm text-stone-300">
            {formatBytes(disk.usedBytes)} von {formatBytes(disk.totalBytes)} belegt ({disk.usedPercent} %) ·{' '}
            <span className={disk.low ? 'text-redstone' : 'text-stone-100'}>{formatBytes(disk.freeBytes)} frei</span>
          </p>
          {disk.low && (
            <ErrorNote>
              Der Platz wird knapp (weniger als {formatBytes(disk.warnBytes)} frei). Backups, Modpack-Installationen
              und Uploads können fehlschlagen – alte Backups löschen oder den Datenträger vergrößern.
            </ErrorNote>
          )}
        </div>
      )}
    </Panel>
  );
}
