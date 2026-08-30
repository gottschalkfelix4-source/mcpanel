import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Gauge, Plus, Save, Settings2, Terminal, Trash2, X } from 'lucide-react';
import { api } from '../../lib/api';
import type { ServerType } from '../../lib/types';
import {
  Button, ConfirmDialog, Field, InfoNote, Panel, Toggle, useToast,
} from '../../components/ui';
import { useServer } from './ServerLayout';

const SERVER_TYPES: ServerType[] = [
  'VANILLA', 'PAPER', 'PURPUR', 'SPIGOT', 'FABRIC', 'FORGE', 'NEOFORGE', 'QUILT', 'MODPACK',
];

const RAM_PRESETS = [1024, 2048, 4096, 6144, 8192, 12288, 16384, 24576];

export default function SettingsTab() {
  const { server, refresh } = useServer();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [name, setName] = useState(server.name);
  const [description, setDescription] = useState(server.description);
  const [type, setType] = useState<ServerType>(server.type);
  const [mcVersion, setMcVersion] = useState(server.mcVersion);
  const [memoryMb, setMemoryMb] = useState(server.memoryMb);
  const [autoStart, setAutoStart] = useState(server.autoStart);
  const [env, setEnv] = useState<[string, string][]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [keepFiles, setKeepFiles] = useState(false);

  // Kontingente: nur Administratoren duerfen sie setzen.
  const [quotaDiskGb, setQuotaDiskGb] = useState(
    server.quota.diskLimitBytes ? String(Math.round(server.quota.diskLimitBytes / 1024 ** 3)) : '',
  );
  const [quotaBackups, setQuotaBackups] = useState(
    server.quota.backupLimit ? String(server.quota.backupLimit) : '',
  );
  const [quotaMemoryMb, setQuotaMemoryMb] = useState(
    server.quota.memoryLimitMb ? String(server.quota.memoryLimitMb) : '',
  );

  const environment = useQuery({
    queryKey: ['environment', server.id],
    queryFn: () =>
      api.get<{ extraEnv: Record<string, string>; effective: string[]; image: string }>(
        `/servers/${server.id}/config/environment`,
      ),
  });

  useEffect(() => {
    if (environment.data) setEnv(Object.entries(environment.data.extraEnv));
  }, [environment.data]);

  const versions = useQuery({
    queryKey: ['game-versions'],
    queryFn: () => api.get<{ release: string[] }>('/catalog/game-versions'),
    staleTime: 3_600_000,
  });

  const save = useMutation({
    mutationFn: () =>
      api.patch<{ recreated: boolean }>(`/servers/${server.id}`, {
        name,
        description,
        type,
        mcVersion,
        memoryMb,
        autoStart,
        extraEnv: Object.fromEntries(env.filter(([k]) => k.trim())),
        ...(server.isAdmin
          ? {
              quotaDiskMb: quotaDiskGb.trim() ? Math.round(Number(quotaDiskGb) * 1024) : 0,
              quotaBackups: quotaBackups.trim() ? Number(quotaBackups) : 0,
              quotaMemoryMb: quotaMemoryMb.trim() ? Number(quotaMemoryMb) : 0,
            }
          : {}),
      }),
    onSuccess: (res) => {
      toast.success(
        res.recreated
          ? 'Gespeichert – der Container wurde mit den neuen Werten neu aufgesetzt.'
          : 'Gespeichert.',
      );
      refresh();
      void environment.refetch();
      queryClient.invalidateQueries({ queryKey: ['servers'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/servers/${server.id}?files=${keepFiles ? 'keep' : 'delete'}`),
    onSuccess: () => {
      toast.success('Server gelöscht.');
      queryClient.invalidateQueries({ queryKey: ['servers'] });
      navigate('/');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <Panel title="Servereinstellungen" icon={<Settings2 size={16} />}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <input className="mc-input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <Field label="Beschreibung">
            <input
              className="mc-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          <Field label="Servertyp" hint="Bei installiertem Modpack besser nicht ändern.">
            <select
              className="mc-select"
              value={type}
              onChange={(e) => setType(e.target.value as ServerType)}
            >
              {SERVER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Minecraft-Version">
            <input
              className="mc-input"
              list="mc-versions"
              value={mcVersion}
              onChange={(e) => setMcVersion(e.target.value)}
            />
            <datalist id="mc-versions">
              <option value="LATEST" />
              {(versions.data?.release ?? []).map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </Field>

          <Field label="Java-Heap" hint={`Aktuell ${memoryMb} MB. Das Container-Limit liegt darüber (Reserve für die JVM).`}>
            <select
              className="mc-select"
              value={memoryMb}
              onChange={(e) => setMemoryMb(Number(e.target.value))}
            >
              {[...new Set([...RAM_PRESETS, memoryMb])]
                .sort((a, b) => a - b)
                .map((mb) => (
                  <option key={mb} value={mb}>
                    {mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB` : `${mb} MB`}
                  </option>
                ))}
            </select>
          </Field>

          <Field label="Autostart" hint="Server startet automatisch mit dem Panel.">
            <Toggle checked={autoStart} onChange={setAutoStart} label={autoStart ? 'Aktiv' : 'Aus'} />
          </Field>
        </div>

        <InfoNote>
          Änderungen an RAM, Version, Typ oder Umgebung setzen den Container neu auf. Deine
          Serverdateien und die Welt bleiben dabei unangetastet.
        </InfoNote>

        <div className="mt-4 flex justify-end">
          <Button variant="primary" icon={<Save size={15} />} loading={save.isPending} onClick={() => save.mutate()}>
            Speichern
          </Button>
        </div>
      </Panel>

      {/* Kontingent */}
      <Panel
        title="Kontingent"
        icon={<Gauge size={16} />}
        subtitle="Grenzen dieses Servers. Sie gelten für alle, die Zugriff darauf haben."
      >
        {server.isAdmin ? (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Speicherplatz (GB)" hint="Serverdaten und Sicherungen zusammen. Leer = unbegrenzt.">
                <input
                  type="number"
                  min={0}
                  className="mc-input w-full"
                  value={quotaDiskGb}
                  onChange={(e) => setQuotaDiskGb(e.target.value)}
                  placeholder="unbegrenzt"
                />
              </Field>
              <Field label="Sicherungen" hint="Ältere werden nach einem Backup automatisch entfernt.">
                <input
                  type="number"
                  min={0}
                  className="mc-input w-full"
                  value={quotaBackups}
                  onChange={(e) => setQuotaBackups(e.target.value)}
                  placeholder="unbegrenzt"
                />
              </Field>
              <Field label="Max. Java-Heap (MB)" hint="Obergrenze für Mitglieder ohne Adminrechte.">
                <input
                  type="number"
                  min={0}
                  step={512}
                  className="mc-input w-full"
                  value={quotaMemoryMb}
                  onChange={(e) => setQuotaMemoryMb(e.target.value)}
                  placeholder="unbegrenzt"
                />
              </Field>
            </div>

            <div className="mt-4">
              <InfoNote>
                Ist der Platz aufgebraucht, lehnt das Panel neue Sicherungen und Uploads ab und meldet
                das über die eingerichteten Benachrichtigungen. Gespeichert wird zusammen mit den
                Grundeinstellungen oben.
              </InfoNote>
            </div>
          </>
        ) : (
          <InfoNote>
            Die Grenzen dieses Servers setzt ein Administrator. Aktuell:{' '}
            {server.quota.diskLimitBytes
              ? `${(server.quota.diskLimitBytes / 1024 ** 3).toFixed(0)} GB Speicher`
              : 'unbegrenzter Speicher'}
            ,{' '}
            {server.quota.backupLimit ? `${server.quota.backupLimit} Sicherungen` : 'beliebig viele Sicherungen'}
            {server.quota.memoryLimitMb ? `, höchstens ${server.quota.memoryLimitMb} MB Java-Heap` : ''}.
          </InfoNote>
        )}
      </Panel>

      {/* Umgebungsvariablen */}
      <Panel
        title="Erweiterte Umgebung"
        icon={<Terminal size={16} />}
        subtitle="Zusätzliche Variablen für das itzg/minecraft-server Image (z. B. JVM_OPTS, INIT_MEMORY)."
      >
        {environment.data?.image && (
          <p className="mb-3 text-xs text-stone-400">
            Verwendetes Image:{' '}
            <code className="text-stone-200">{environment.data.image}</code>{' '}
            <span className="text-stone-450">
              – automatisch passend zu Minecraft {mcVersion} gewählt. Mit der Variable{' '}
              <code>MC_IMAGE</code> überschreibbar.
            </span>
          </p>
        )}

        <div className="space-y-2">
          {env.map(([key, value], index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <input
                className="mc-input font-mono sm:w-64"
                placeholder="SCHLUESSEL"
                value={key}
                onChange={(e) =>
                  setEnv((prev) => prev.map((row, i) => (i === index ? [e.target.value, row[1]] : row)))
                }
              />
              <input
                className="mc-input flex-1 font-mono"
                placeholder="Wert"
                value={value}
                onChange={(e) =>
                  setEnv((prev) => prev.map((row, i) => (i === index ? [row[0], e.target.value] : row)))
                }
              />
              <button
                onClick={() => setEnv((prev) => prev.filter((_, i) => i !== index))}
                className="p-2 text-stone-450 transition hover:text-redstone"
                title="Entfernen"
              >
                <X size={16} />
              </button>
            </div>
          ))}

          <Button variant="ghost" icon={<Plus size={15} />} onClick={() => setEnv((p) => [...p, ['', '']])}>
            Variable hinzufügen
          </Button>
        </div>

        {environment.data?.effective && (
          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-stone-450 hover:text-stone-300">
              Effektive Umgebung des Containers anzeigen
            </summary>
            <pre className="console-view mc-well mt-2 max-h-52 overflow-auto p-3 text-[11px]">
              {environment.data.effective.join('\n')}
            </pre>
          </details>
        )}
      </Panel>

      {/* Gefahrenzone */}
      {(server.isOwner || server.isAdmin) && (
        <Panel title="Gefahrenzone" icon={<AlertTriangle size={16} />} className="!border-redstone/50">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-sm font-bold text-stone-100">Server löschen</p>
              <p className="mt-1 text-xs text-stone-400">
                Entfernt den Container und – auf Wunsch – alle Dateien inklusive Welt und Backups.
              </p>
            </div>
            <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setConfirmDelete(true)}>
              Server löschen
            </Button>
          </div>
        </Panel>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutateAsync()}
        title="Server endgültig löschen?"
        message={
          <div className="space-y-3">
            <p>
              <strong className="text-stone-100">{server.name}</strong> wird gestoppt und der
              Container entfernt.
            </p>
            <Toggle
              checked={keepFiles}
              onChange={setKeepFiles}
              label="Dateien und Backups auf der Festplatte behalten"
            />
            {!keepFiles && (
              <p className="text-redstone">
                Welt, Mods, Konfiguration und alle Backups werden unwiderruflich gelöscht.
              </p>
            )}
          </div>
        }
        confirmLabel="Löschen"
        danger
        requireText={server.name}
      />
    </div>
  );
}
