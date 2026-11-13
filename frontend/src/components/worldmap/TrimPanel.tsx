import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Crosshair, Eraser } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { Button, ConfirmDialog, ErrorNote, InfoNote, Panel, Toggle, useToast } from '../ui';
import { TaskProgress } from '../TaskProgress';
import { DIMENSION_LABELS, type Dimension, type MapInfo, type Shape, type TrimMode, type TrimSummary } from './types';
import { toInt } from './PregenPanel';

export interface TrimForm {
  dimension: Dimension;
  shape: Shape;
  centerX: number;
  centerZ: number;
  radius: number;
  mode: TrimMode;
}

const TRIM_TASKS = ['map.trim'];
const PRESETS = [500, 1000, 2500, 5000];
const de = (value: number) => Math.round(value).toLocaleString('de-DE');

interface Props {
  serverId: string;
  serverName: string;
  info: MapInfo;
  form: TrimForm;
  setForm: (next: TrimForm) => void;
  picking: boolean;
  setPicking: (value: boolean) => void;
  running: boolean;
  onDone: () => void;
}

/**
 * Chunks zurücksetzen: alles außerhalb eines Umkreises entfernen (Welt
 * verkleinern) oder genau einen Bereich neu generieren lassen. Läuft nur bei
 * gestopptem Server, standardmäßig mit Backup vorab.
 */
export function TrimPanel({ serverId, serverName, info, form, setForm, picking, setPicking, running, onDone }: Props) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [backupFirst, setBackupFirst] = useState(info.canBackup);
  const [confirm, setConfirm] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof TrimForm>(key: K, value: TrimForm[K]) => setForm({ ...form, [key]: value });

  // Die Vorschau liest nur die Tabellen der Regionsdateien – kurz warten,
  // bis der Regler ruht, damit nicht jede Zwischenstellung eine Anfrage wird.
  const [debounced, setDebounced] = useState(form);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(form), 400);
    return () => clearTimeout(timer);
  }, [form]);
  const preview = useQuery({
    queryKey: ['map-trim-estimate', serverId, debounced],
    queryFn: () => api.post<TrimSummary>(`/servers/${serverId}/map/trim/estimate`, debounced),
    staleTime: 10_000,
  });

  const start = useMutation({
    mutationFn: () => api.post<{ taskId: string }>(`/servers/${serverId}/map/trim`, { ...form, backupFirst }),
    onSuccess: (res) => { setTaskId(res.taskId); setPicking(false); toast.success('Zurücksetzen gestartet.'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const finished = () => {
    void queryClient.invalidateQueries({ queryKey: ['map-chunks', serverId] });
    void queryClient.invalidateQueries({ queryKey: ['map-size', serverId] });
    void queryClient.invalidateQueries({ queryKey: ['map-trim-estimate', serverId] });
    onDone();
  };

  const summary = preview.data;
  const nothing = summary && summary.removed === 0;

  return (
    <Panel title="Chunks zurücksetzen" icon={<Eraser size={16} />} subtitle="Welt verkleinern oder Gebiet neu generieren">
      <div className="space-y-4">
        <div>
          <p className="mc-label">Was soll weg?</p>
          <Segmented value={form.mode} onChange={(value) => set('mode', value as TrimMode)}
            options={[{ value: 'outside', label: 'Alles außerhalb' }, { value: 'inside', label: 'Nur den Bereich' }]} />
          <p className="mt-1.5 text-xs text-stone-400">
            {form.mode === 'outside'
              ? 'Der Bereich bleibt, alles drumherum erzeugt Minecraft beim nächsten Besuch neu.'
              : 'Der Bereich wird beim nächsten Besuch neu erzeugt – etwa für neue Biome oder Erze nach einem Mod-Update.'}
          </p>
        </div>
        <div>
          <p className="mc-label">Dimension</p>
          <Segmented value={form.dimension} onChange={(value) => set('dimension', value as Dimension)}
            options={(['overworld', 'nether', 'end'] as Dimension[]).map((d) => ({ value: d, label: DIMENSION_LABELS[d] }))} />
        </div>
        <div>
          <p className="mc-label">Form</p>
          <Segmented value={form.shape} onChange={(value) => set('shape', value as Shape)} options={[{ value: 'circle', label: 'Kreis' }, { value: 'square', label: 'Quadrat' }]} />
        </div>
        <div>
          <label htmlFor="trim-radius" className="mc-label flex justify-between">
            <span>Radius</span><span className="normal-case tracking-normal text-stone-100">{de(form.radius)} Blöcke</span>
          </label>
          <input id="trim-radius" type="range" min={100} max={20000} step={100} value={form.radius}
            onChange={(e) => set('radius', Number(e.target.value))} className="w-full accent-redstone" />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {PRESETS.map((value) => (
              <button key={value} type="button" onClick={() => set('radius', value)}
                className={clsx('border px-2 py-1 text-xs font-semibold', form.radius === value ? 'border-redstone bg-redstone/20 text-white' : 'border-stone-600 bg-stone-700/60 text-stone-300 hover:text-stone-50')}>
                {de(value)}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="mc-label">Mittelpunkt</p>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-stone-400">X
              <input className="mc-input mt-1 font-mono" inputMode="text" defaultValue={form.centerX} key={`x${form.centerX}`}
                onBlur={(e) => set('centerX', toInt(e.target.value))} />
            </label>
            <label className="text-xs text-stone-400">Z
              <input className="mc-input mt-1 font-mono" inputMode="text" defaultValue={form.centerZ} key={`z${form.centerZ}`}
                onBlur={(e) => set('centerZ', toInt(e.target.value))} />
            </label>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" className="border border-stone-600 bg-stone-700/60 px-2 py-1 text-xs font-semibold text-stone-300 hover:text-stone-50" onClick={() => setForm({ ...form, centerX: 0, centerZ: 0 })}>Weltmitte</button>
            <button type="button" aria-pressed={picking}
              className={clsx('inline-flex items-center gap-1 border px-2 py-1 text-xs font-semibold', picking ? 'border-gold bg-gold/15 text-gold' : 'border-stone-600 bg-stone-700/60 text-stone-300 hover:text-stone-50')}
              onClick={() => setPicking(!picking)}>
              <Crosshair size={12} /> Auf Karte wählen
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 border border-stone-700 bg-stone-well p-2.5 text-xs text-stone-400">
          <div>Entfernt<br /><strong className="text-sm text-stone-100">{summary ? de(summary.removed) : '…'}</strong></div>
          <div>von<br /><strong className="text-sm text-stone-100">{summary ? de(summary.chunks) : '…'}</strong></div>
          <div>Frei ca.<br /><strong className="text-sm text-stone-100">{summary ? formatBytes(summary.bytes) : '…'}</strong></div>
        </div>
        {preview.error && <ErrorNote>{(preview.error as Error).message}</ErrorNote>}
        {summary && summary.skipped.length > 0 && (
          <InfoNote>{summary.skipped.length} Regionsdatei(en) sind beschädigt und würden unverändert bleiben.</InfoNote>
        )}

        <TaskProgress serverId={serverId} types={TRIM_TASKS} taskId={taskId ?? undefined} onRunningChange={setBusy} onFinished={finished} />

        {!info.canTrim ? (
          <p className="text-xs text-stone-400">Dafür braucht es die Rechte „Welt vorgenerieren“ und „Dateien bearbeiten“.</p>
        ) : (
          <>
            {info.canBackup
              ? <Toggle checked={backupFirst} onChange={setBackupFirst} label={<span className="text-sm font-semibold text-stone-100">Vorher ein Backup anlegen</span>} />
              : <p className="text-xs text-stone-400">Ohne das Recht „Backups erstellen“ geht es nur ohne Backup vorab.</p>}
            {running && <InfoNote>Der Server muss dafür gestoppt sein – er hält die Regionsdateien offen.</InfoNote>}
            <Button variant="danger" className="w-full" loading={start.isPending || busy}
              disabled={running || !summary || Boolean(nothing)}
              onClick={() => setConfirm(true)}>
              {nothing ? 'Nichts zu entfernen' : `${summary ? de(summary.removed) : ''} Chunks zurücksetzen`}
            </Button>
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        danger
        title="Chunks zurücksetzen?"
        confirmLabel="Zurücksetzen"
        requireText={serverName}
        message={
          <>
            {de(summary?.removed ?? 0)} Chunks in {DIMENSION_LABELS[form.dimension]} werden aus der Welt entfernt – mit allem, was dort gebaut wurde,
            samt Truhen, Tieren und Dorfbewohnern. Minecraft erzeugt das Gelände beim nächsten Besuch neu.
            {backupFirst ? ' Vorher wird ein Backup angelegt.' : ' Es wird kein Backup angelegt – das lässt sich nicht rückgängig machen.'}
          </>
        }
        onConfirm={() => start.mutateAsync()}
      />
    </Panel>
  );
}

function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div role="group" className="grid border border-stone-950" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}
          className={clsx('px-2 py-2 text-xs font-bold', value === option.value ? 'bg-redstone text-white' : 'bg-stone-700 text-stone-300 hover:text-stone-50')}>
          {option.label}
        </button>
      ))}
    </div>
  );
}
