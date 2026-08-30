import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Boxes, Check, Package, Server as ServerIcon, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import type { ProjectSummary, ProjectVersion, ServerSummary, ServerType } from '../lib/types';
import { ModpackBrowser } from '../components/ModpackBrowser';
import { Button, ErrorNote, Field, InfoNote, Panel, useToast } from '../components/ui';

const SERVER_TYPES: { value: ServerType; label: string; hint: string }[] = [
  { value: 'PAPER', label: 'Paper', hint: 'Schnell, Plugin-fähig – die beste Wahl für Vanilla+' },
  { value: 'VANILLA', label: 'Vanilla', hint: 'Original von Mojang, ohne Erweiterungen' },
  { value: 'PURPUR', label: 'Purpur', hint: 'Paper-Fork mit vielen Extra-Optionen' },
  { value: 'FABRIC', label: 'Fabric', hint: 'Leichter Mod-Loader' },
  { value: 'FORGE', label: 'Forge', hint: 'Klassischer Mod-Loader' },
  { value: 'NEOFORGE', label: 'NeoForge', hint: 'Forge-Nachfolger für neue Versionen' },
  { value: 'QUILT', label: 'Quilt', hint: 'Fabric-Fork' },
];

const RAM_PRESETS = [2048, 4096, 6144, 8192, 12288, 16384];

export default function CreateServerPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<'plain' | 'modpack'>('plain');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<ServerType>('PAPER');
  const [mcVersion, setMcVersion] = useState('LATEST');
  const [memoryMb, setMemoryMb] = useState(4096);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pack, setPack] = useState<{ project: ProjectSummary; version: ProjectVersion } | null>(null);

  const versions = useQuery({
    queryKey: ['game-versions'],
    queryFn: () => api.get<{ release: string[] }>('/catalog/game-versions'),
    staleTime: 3_600_000,
  });

  async function create() {
    setError(null);
    if (name.trim().length < 2) {
      setError('Bitte gib dem Server einen Namen (mindestens 2 Zeichen).');
      return;
    }
    if (mode === 'modpack' && !pack) {
      setError('Bitte wähle zuerst ein Modpack aus.');
      return;
    }

    setBusy(true);
    try {
      const server = await api.post<ServerSummary>('/servers', {
        name: name.trim(),
        description: description.trim(),
        type: mode === 'modpack' ? 'MODPACK' : type,
        mcVersion:
          mode === 'modpack' ? (pack!.version.gameVersions[0] ?? 'LATEST') : mcVersion,
        memoryMb,
      });

      if (mode === 'modpack' && pack) {
        await api.post(`/servers/${server.id}/modpack/install`, {
          provider: pack.project.provider,
          projectId: pack.project.id,
          versionId: pack.version.id,
          backupFirst: false,
          startAfter: false,
        });
        toast.success('Server angelegt – Modpack wird installiert.');
        queryClient.invalidateQueries({ queryKey: ['servers'] });
        navigate(`/servers/${server.id}/modpack`);
        return;
      }

      toast.success('Server angelegt.');
      queryClient.invalidateQueries({ queryKey: ['servers'] });
      navigate(`/servers/${server.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Anlegen fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <div className="flex items-center gap-3.5">
        <Link
          to="/"
          className="grid h-[34px] w-[34px] place-items-center border border-stone-700 bg-stone-900/70 transition hover:border-grass-light hover:bg-grass/[0.18]"
          title="Zurück zur Übersicht"
        >
          <ArrowLeft size={18} className="text-stone-300" />
        </Link>
        <h1 className="heading-pixel text-base">Neuer Server</h1>
      </div>

      {/* Modus */}
      <div className="grid gap-3 sm:grid-cols-2">
        <ModeCard
          active={mode === 'plain'}
          onClick={() => setMode('plain')}
          icon={<ServerIcon size={22} />}
          title="Eigener Server"
          description="Vanilla, Paper oder ein Mod-Loader – du bestimmst Version und Ausstattung."
        />
        <ModeCard
          active={mode === 'modpack'}
          onClick={() => setMode('modpack')}
          icon={<Package size={22} />}
          title="Modpack-Server"
          description="Modpack von Modrinth oder CurseForge aussuchen – wird automatisch eingerichtet."
        />
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* Auswahlbereich */}
        <div className="space-y-5">
          {mode === 'modpack' ? (
            <Panel
              title="Modpack auswählen"
              icon={<Sparkles size={16} />}
              subtitle={
                pack
                  ? `Ausgewählt: ${pack.project.name} · ${pack.version.name}`
                  : 'Suche ein Modpack und wähle die gewünschte Version.'
              }
            >
              {pack && (
                <div className="mb-4 flex items-center gap-3 border border-grass-dark bg-grass/10 p-3">
                  {pack.project.iconUrl && (
                    <img
                      src={pack.project.iconUrl}
                      alt=""
                      className="h-12 w-12 border border-stone-950 object-cover"
                      style={{ boxShadow: '0 3px 0 0 rgba(0,0,0,.5)' }}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-white">{pack.project.name}</p>
                    <p className="truncate text-xs text-stone-400">
                      {pack.version.name} · MC {pack.version.gameVersions[0] ?? '?'}
                    </p>
                  </div>
                  <Button variant="ghost" className="!px-2.5 !py-1.5 !text-xs" onClick={() => setPack(null)}>
                    Ändern
                  </Button>
                </div>
              )}

              {!pack && (
                <ModpackBrowser
                  actionLabel="Auswählen"
                  onPick={(project, version) => {
                    setPack({ project, version });
                    if (!name.trim()) setName(project.name);
                  }}
                />
              )}
            </Panel>
          ) : (
            <Panel title="Servertyp" icon={<Boxes size={16} />}>
              <div className="grid gap-2 sm:grid-cols-2">
                {SERVER_TYPES.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => setType(option.value)}
                    className={clsx(
                      'flex items-start gap-2.5 border p-3 text-left transition',
                      type === option.value
                        ? 'border-grass-dark bg-grass/15'
                        : 'border-stone-700 bg-stone-800/50 hover:border-stone-600',
                    )}
                  >
                    <span
                      className={clsx(
                        'mt-0.5 grid h-4 w-4 shrink-0 place-items-center border',
                        type === option.value ? 'border-grass-light bg-grass' : 'border-stone-600',
                      )}
                    >
                      {type === option.value && <Check size={11} className="text-white" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-bold text-stone-100">{option.label}</span>
                      <span className="mt-0.5 block text-xs leading-snug text-stone-400">
                        {option.hint}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </Panel>
          )}
        </div>

        {/* Einstellungen */}
        <Panel title="Einstellungen" className="h-fit lg:sticky lg:top-24">
          <div className="space-y-4">
            <Field label="Name">
              <input
                className="mc-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="z. B. Freunde-Survival"
              />
            </Field>

            <Field label="Beschreibung" hint="Optional – nur im Panel sichtbar.">
              <input
                className="mc-input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Worum geht es auf dem Server?"
              />
            </Field>

            {mode === 'plain' && (
              <Field label="Minecraft-Version">
                <select
                  className="mc-select"
                  value={mcVersion}
                  onChange={(e) => setMcVersion(e.target.value)}
                >
                  <option value="LATEST">Neueste Version</option>
                  {(versions.data?.release ?? []).slice(0, 60).map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <Field label="Java-Heap" hint="Modpacks brauchen meist 6–8 GB. Der Container bekommt zusätzlich Reserve für die JVM.">
              <div className="grid grid-cols-3 gap-1.5">
                {RAM_PRESETS.map((mb) => (
                  <button
                    key={mb}
                    onClick={() => setMemoryMb(mb)}
                    className={clsx(
                      'border px-2 py-1.5 text-xs font-bold transition',
                      memoryMb === mb
                        ? 'border-grass-dark bg-grass/25 text-white'
                        : 'border-stone-700 bg-stone-800/60 text-stone-400 hover:text-stone-100',
                    )}
                  >
                    {mb / 1024} GB
                  </button>
                ))}
              </div>
            </Field>

            {mode === 'modpack' && (
              <InfoNote>
                Die Installation läuft im Hintergrund. Du kannst den Fortschritt danach im
                Modpack-Tab verfolgen.
              </InfoNote>
            )}

            <Button variant="primary" className="w-full" loading={busy} onClick={create}>
              Server erstellen
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  icon,
  title,
  description,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'mc-frame text-left transition-[transform,box-shadow,border-color] duration-200',
        active ? '!border-grass-dark shadow-glow' : 'hover:-translate-y-0.5 hover:!border-stone-500',
      )}
    >
      <div className="mc-frame-inner flex items-start gap-3 p-4">
        <span
          className={clsx(
            'grid h-11 w-11 shrink-0 place-items-center border border-stone-950 transition-colors',
            active ? 'bg-grass text-white' : 'bg-stone-700 text-stone-300',
          )}
          style={{ boxShadow: 'inset 1px 1px 0 rgba(255,255,255,.18), 0 3px 0 0 rgba(0,0,0,.5)' }}
        >
          {icon}
        </span>
        <span>
          <span className="heading block text-sm">{title}</span>
          <span className="mt-1 block text-xs leading-snug text-stone-350">{description}</span>
        </span>
      </div>
    </button>
  );
}
