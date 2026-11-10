import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Crosshair, Grid3x3, Pause, Play, X } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { Badge, Button, ConfirmDialog, ErrorNote, InfoNote, Panel, ProgressBar, Toggle, useToast } from '../ui';
import { DIMENSION_LABELS, type Dimension, type MapInfo, type PregenJob, type Shape } from './types';

export interface PregenForm {
  dimension: Dimension;
  shape: Shape;
  centerX: number;
  centerZ: number;
  radius: number;
  onlyWhenEmpty: boolean;
  tpsGuard: boolean;
  pauseRender: boolean;
}

/** Durchschnittliches Tempo für die Zeitschätzung – echte Werte liefert Chunky beim Lauf. */
const ASSUMED_RATE = 40;
const PRESETS = [1000, 2500, 5000, 10000];

export function estimate(form: Pick<PregenForm, 'shape' | 'radius'>) {
  const r = form.radius / 16;
  return Math.round(form.shape === 'circle' ? Math.PI * r * r : 4 * r * r);
}

export function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${m} min`;
  return `${h}:${String(m).padStart(2, '0')} h`;
}

const de = (value: number) => Math.round(value).toLocaleString('de-DE');

interface Props {
  serverId: string;
  info: MapInfo;
  form: PregenForm;
  setForm: (next: PregenForm) => void;
  picking: boolean;
  setPicking: (value: boolean) => void;
  running: boolean;
}

export function PregenPanel({ serverId, info, form, setForm, picking, setPicking, running }: Props) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const job = info.job;
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['map', serverId] });

  const action = useMutation({
    mutationFn: ({ path, body, method = 'post' }: { path: string; body?: unknown; method?: 'post' | 'del' }) =>
      method === 'del' ? api.del(`/servers/${serverId}/map/${path}`) : api.post(`/servers/${serverId}/map/${path}`, body),
    onSuccess: refresh,
    onError: (err: Error) => toast.error(err.message),
  });

  const set = <K extends keyof PregenForm>(key: K, value: PregenForm[K]) => setForm({ ...form, [key]: value });
  const chunks = estimate(form);
  const bytes = chunks * info.bytesPerChunk;
  const tooBig = info.remainingDiskBytes !== null && bytes > info.remainingDiskBytes;
  const chunkyReady = info.addons.chunky.installed;

  if (job && (job.status === 'running' || job.status === 'paused')) {
    return (
      <Panel title="Vorgenerierung" icon={<Grid3x3 size={16} />} subtitle={`${DIMENSION_LABELS[job.dimension]} · ${job.shape === 'circle' ? 'Kreis' : 'Quadrat'} · Radius ${de(job.radius)} um ${job.centerX} / ${job.centerZ}`}>
        <div className="space-y-3">
          <JobBadge job={job} />
          <div>
            <div className="mb-1.5 flex items-end justify-between gap-2">
              <span className="font-pixel text-base">{job.percent.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %</span>
              <span className="text-xs text-stone-400">{de(job.processed)} / {de(job.total)} Chunks</span>
            </div>
            <ProgressBar value={job.percent} tone={job.status === 'paused' || job.autoPaused ? 'gold' : 'green'} />
          </div>
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <Stat label="Tempo" value={job.rate !== null ? `${job.rate.toLocaleString('de-DE')} Chunks/s` : '–'} />
            <Stat label="Restzeit" value={job.etaSeconds !== null ? duration(job.etaSeconds) : '–'} />
            <Stat label="Seit" value={new Date(job.startedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} />
          </dl>
          {info.canPregen && (
            <div className="flex gap-2">
              {job.status === 'running' ? (
                <Button className="flex-1" icon={<Pause size={15} />} loading={action.isPending} onClick={() => action.mutate({ path: 'pregen/pause' })}>Pausieren</Button>
              ) : (
                <Button className="flex-1" icon={<Play size={15} />} loading={action.isPending} disabled={!running} onClick={() => action.mutate({ path: 'pregen/resume' })}>Fortsetzen</Button>
              )}
              <Button variant="ghost" className="flex-1" icon={<X size={15} />} onClick={() => setConfirmCancel(true)}>Abbrechen</Button>
            </div>
          )}
          <p className="text-xs text-stone-400">
            {[job.onlyWhenEmpty && 'pausiert, solange Spieler online sind', job.tpsGuard && 'bremst unter 15 TPS', job.pauseRender && 'BlueMap rendert danach'].filter(Boolean).join(' · ') || 'ohne automatische Pausen'}
            . Nach einem Neustart des Servers macht das Panel selbst weiter.
          </p>
        </div>
        <ConfirmDialog
          open={confirmCancel}
          onClose={() => setConfirmCancel(false)}
          danger
          title="Vorgenerierung abbrechen?"
          confirmLabel="Abbrechen"
          message="Bereits erzeugte Chunks bleiben in der Welt. Der Fortschritt dieses Auftrags geht verloren – ein neuer Auftrag beginnt von vorn, überspringt aber vorhandene Chunks schnell."
          onConfirm={() => action.mutateAsync({ path: 'pregen/cancel' })}
        />
      </Panel>
    );
  }

  return (
    <Panel title="Vorgenerierung" icon={<Grid3x3 size={16} />} subtitle={chunkyReady ? `mit Chunky · ${info.addons.chunky.file}` : 'braucht Chunky'}>
      <div className="space-y-4">
        {job && <FinishedJob job={job} canClear={info.canPregen} onClear={() => action.mutate({ path: 'pregen', method: 'del' })} />}

        <div>
          <p className="mc-label">Dimension</p>
          <Segmented
            value={form.dimension}
            onChange={(value) => set('dimension', value as Dimension)}
            options={(['overworld', 'nether', 'end'] as Dimension[]).map((d) => ({ value: d, label: DIMENSION_LABELS[d] }))}
          />
        </div>
        <div>
          <p className="mc-label">Form</p>
          <Segmented value={form.shape} onChange={(value) => set('shape', value as Shape)} options={[{ value: 'circle', label: 'Kreis' }, { value: 'square', label: 'Quadrat' }]} />
        </div>
        <div>
          <label htmlFor="pregen-radius" className="mc-label flex justify-between">
            <span>Radius</span><span className="normal-case tracking-normal text-stone-100">{de(form.radius)} Blöcke</span>
          </label>
          <input id="pregen-radius" type="range" min={250} max={20000} step={250} value={form.radius}
            onChange={(e) => set('radius', Number(e.target.value))} className="w-full accent-grass-light" />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {PRESETS.map((value) => (
              <button key={value} type="button" onClick={() => set('radius', value)}
                className={clsx('border px-2 py-1 text-xs font-semibold', form.radius === value ? 'border-grass-dark bg-grass/25 text-white' : 'border-stone-600 bg-stone-700/60 text-stone-300 hover:text-stone-50')}>
                {de(value)}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="mc-label">Mittelpunkt</p>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-stone-400">X
              <CoordInput value={form.centerX} onChange={(v) => set('centerX', v)} />
            </label>
            <label className="text-xs text-stone-400">Z
              <CoordInput value={form.centerZ} onChange={(v) => set('centerZ', v)} />
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

        <div className="space-y-2.5">
          <Toggle checked={form.onlyWhenEmpty} onChange={(v) => set('onlyWhenEmpty', v)} label={<Option title="Nur ohne Spieler" hint="Pausiert, sobald jemand online ist." />} />
          <Toggle checked={form.tpsGuard} onChange={(v) => set('tpsGuard', v)} label={<Option title="Bei Last bremsen" hint="Pausiert unter 15 TPS, macht ab 18 weiter." />} />
          {info.addons.bluemap.installed && (
            <Toggle checked={form.pauseRender} onChange={(v) => set('pauseRender', v)} label={<Option title="Karte erst danach rendern" hint="BlueMap rendert die neuen Chunks im Anschluss." />} />
          )}
        </div>

        <div className="grid grid-cols-3 gap-2 border border-stone-700 bg-stone-well p-2.5 text-xs text-stone-400">
          <div>Chunks<br /><strong className="text-sm text-stone-100">{de(chunks)}</strong></div>
          <div>Speicher ca.<br /><strong className="text-sm text-stone-100">{formatBytes(bytes)}</strong></div>
          <div>Dauer ca.<br /><strong className="text-sm text-stone-100">{duration(chunks / ASSUMED_RATE)}</strong></div>
        </div>
        {tooBig && <ErrorNote>Passt nicht ins Speicherkontingent des Servers – noch {formatBytes(info.remainingDiskBytes!)} frei.</ErrorNote>}
        {!chunkyReady && <InfoNote>Chunky ist noch nicht installiert – siehe „Erweiterungen“.</InfoNote>}
        {chunkyReady && !running && <InfoNote>Der Server muss laufen, damit Chunky arbeiten kann.</InfoNote>}

        {info.canPregen ? (
          <Button variant="primary" className="w-full" loading={action.isPending} disabled={!chunkyReady || !running || tooBig}
            onClick={() => action.mutate({ path: 'pregen', body: form }, { onSuccess: () => { setPicking(false); toast.success('Vorgenerierung gestartet.'); } })}>
            Vorgenerierung starten
          </Button>
        ) : (
          <p className="text-xs text-stone-400">Dir fehlt das Recht „Welt vorgenerieren“.</p>
        )}
      </div>
    </Panel>
  );
}

function JobBadge({ job }: { job: PregenJob }) {
  if (job.status === 'paused') return <Badge tone="gold">angehalten</Badge>;
  if (job.autoPaused === 'players') return <Badge tone="gold">wartet – Spieler online</Badge>;
  if (job.autoPaused === 'tps') return <Badge tone="gold">gebremst – Server unter Last</Badge>;
  if (job.autoPaused === 'stopped') return <Badge tone="neutral">Server gestoppt – geht beim Start weiter</Badge>;
  return <Badge tone="green">läuft</Badge>;
}

function FinishedJob({ job, canClear, onClear }: { job: PregenJob; canClear: boolean; onClear: () => void }) {
  const text = job.status === 'done'
    ? `Fertig: ${de(job.processed)} Chunks in ${DIMENSION_LABELS[job.dimension]} (Radius ${de(job.radius)}).`
    : job.status === 'cancelled'
      ? `Abgebrochen bei ${job.percent.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %.`
      : job.message ?? 'Fehlgeschlagen.';
  return (
    <div className={clsx('flex items-start justify-between gap-2 border p-2.5 text-sm', job.status === 'done' ? 'border-grass-dark bg-grass/10' : job.status === 'failed' ? 'border-redstone/50 bg-redstone/10' : 'border-stone-600 bg-stone-900/50')}>
      <span>{text}</span>
      {canClear && <button type="button" aria-label="Hinweis entfernen" onClick={onClear} className="text-stone-400 hover:text-stone-100"><X size={14} /></button>}
    </div>
  );
}

function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div role="group" className="grid border border-stone-950" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}
          className={clsx('px-2 py-2 text-xs font-bold', value === option.value ? 'bg-grass text-white' : 'bg-stone-700 text-stone-300 hover:text-stone-50')}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Option({ title, hint }: { title: string; hint: string }) {
  return (
    <span>
      <span className="block text-sm font-semibold text-stone-100">{title}</span>
      <span className="block text-xs text-stone-400">{hint}</span>
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-stone-700 bg-stone-well p-2">
      <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-stone-400">{label}</dt>
      <dd className="mt-1 font-bold text-stone-100">{value}</dd>
    </div>
  );
}

/**
 * Koordinatenfeld. Hält den getippten Text selbst, damit ein einzelnes „-“
 * stehen bleibt – sonst ließe sich keine negative Koordinate eingeben.
 */
function CoordInput({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  // Von außen geändert (Klick auf die Karte, „Weltmitte“)?
  useEffect(() => {
    setText((current) => (toInt(current) === value ? current : String(value)));
  }, [value]);
  return (
    <input
      className="mc-input mt-1 font-mono"
      inputMode="text"
      value={text}
      onChange={(e) => {
        const next = e.target.value.replace(/[^\d-]/g, '').replace(/(?!^)-/g, '');
        setText(next);
        onChange(toInt(next));
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

export function toInt(value: string): number {
  const n = parseInt(value.replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? Math.max(-29_999_000, Math.min(29_999_000, n)) : 0;
}
