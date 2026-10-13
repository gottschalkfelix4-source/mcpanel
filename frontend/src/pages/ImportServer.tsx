import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Upload } from 'lucide-react';
import { uploadFiles } from '../lib/api';
import { Button, ErrorNote, Field, InfoNote, Panel, ProgressBar, Toggle } from '../components/ui';
import { TaskProgress } from '../components/TaskProgress';

import type { ServerDetail } from '../lib/types';

const TYPES = ['VANILLA', 'PAPER', 'PURPUR', 'SPIGOT', 'FABRIC', 'FORGE', 'NEOFORGE', 'QUILT'];
const TASKS = ['server.import'];

export default function ImportServerPage({ existingServer }: { existingServer?: ServerDetail }) {
  const queries = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState(existingServer?.name ?? '');
  const [type, setType] = useState('PAPER');
  const [mcVersion, setMcVersion] = useState('');
  const [loaderVersion, setLoaderVersion] = useState('');
  const [memoryMb, setMemoryMb] = useState(existingServer?.memoryMb ?? 4096);
  const [startAfter, setStartAfter] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; taskId: string } | null>(null);
  const modded = ['FORGE', 'NEOFORGE', 'FABRIC', 'QUILT'].includes(type);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(null);
    if (!file || !/\.zip$/i.test(file.name)) { setError('Bitte eine ZIP-Datei auswählen.'); return; }
    if (file.size > 4 * 1024 ** 3) { setError('Das ZIP darf höchstens 4 GiB groß sein.'); return; }
    setBusy(true); setProgress(0);
    try {
      const params = new URLSearchParams({ name: name.trim(), type, mcVersion: mcVersion.trim(), memoryMb: String(memoryMb), startAfter: String(startAfter) });
      if (modded) params.set('loaderVersion', loaderVersion.trim());
      const response = await uploadFiles<{ id: string; taskId: string }>(`/servers/${existingServer ? existingServer.id + "/" : ""}import?${params}`, [file], setProgress);
      setCreated(response);
      void queries.invalidateQueries({ queryKey: ['servers'] });
    } catch (error) { setError(error instanceof Error ? error.message : 'Serverimport fehlgeschlagen'); }
    finally { setBusy(false); }
  }

  return <div className="flex max-w-3xl flex-col gap-5">
    <Link to="/" className="inline-flex items-center gap-2 text-sm text-stone-300"><ArrowLeft size={16} />Zur Serverübersicht</Link>
    <h1 className="heading-pixel text-base">Server aus ZIP importieren</h1>
    <InfoNote>{existingServer ? "Ersetzt die Serverdateien durch das ZIP. Vorher wird ein Sicherheitsbackup des bisherigen Servers erstellt. Besitzer, Zugriffsrechte und Kontingente bleiben erhalten." : "Erstellt einen neuen Server."} Das ZIP muss den vollständigen Serverordner mit server.properties enthalten – direkt oder in einem übergeordneten Ordner. Welten, Mods, Plugins und Spielerlisten werden übernommen. Andere Panel-Server bleiben erhalten.</InfoNote>
    {error && <ErrorNote>{error}</ErrorNote>}
    {created ? <>
      <TaskProgress serverId={created.id} taskId={created.taskId} types={TASKS} onFinished={() => { void queries.invalidateQueries({ queryKey: ['servers'] }); }} />
      <Link to={`/servers/${created.id}`}><Button>Zum importierten Server</Button></Link>
    </> : <Panel title="ZIP und Servereinstellungen">
      <form onSubmit={submit}>
        <fieldset disabled={busy} className="space-y-4">
          <Field label="Server-ZIP" hint="Bis zu 4 GiB komprimiert, 64 GiB entpackt. Den Quellserver vor dem Erstellen des ZIPs stoppen.">
            <input type="file" accept=".zip,application/zip" required className="mc-input" onChange={e => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          <Field label="Name im Panel"><input required minLength={2} maxLength={48} className="mc-input" value={name} onChange={e => setName(e.target.value)} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Bisheriger Servertyp"><select className="mc-select" value={type} onChange={e => setType(e.target.value)}>{TYPES.map(t => <option key={t}>{t}</option>)}</select></Field>
            <Field label="Bisherige Minecraft-Version" hint="Genau dieselbe Version wie beim Quellserver verwenden."><input required placeholder="z. B. 1.20.1" className="mc-input" value={mcVersion} onChange={e => setMcVersion(e.target.value)} /></Field>
          </div>
          {modded && <Field label="Bisherige Loader-Version" hint="Steht üblicherweise im Startskript oder im Startprotokoll."><input required className="mc-input" placeholder={type === 'FORGE' ? 'z. B. 47.4.0' : 'Genaue Loader-Version'} value={loaderVersion} onChange={e => setLoaderVersion(e.target.value)} /></Field>}
          <Field label="Maximaler Java-Heap"><select className="mc-select" value={memoryMb} onChange={e => setMemoryMb(Number(e.target.value))}>{[2048, 4096, 6144, 8192, 12288, 16384].map(m => <option key={m} value={m}>{m / 1024} GB</option>)}</select></Field>
          <Toggle checked={startAfter} onChange={setStartAfter} label="Nach dem Import starten und Start prüfen" />
          <p className="text-sm text-stone-400">Port und RCON-Zugang werden für das Panel angepasst. Startskripte und JVM-Argumente aus dem ZIP werden nicht automatisch ausgeführt.</p>
          {existingServer && <label className="flex items-start gap-2 text-sm"><input type="checkbox" required />Ich möchte die Dateien dieses Servers durch den ZIP-Inhalt ersetzen. Der bisherige Stand bleibt im Sicherheitsbackup erhalten.</label>}
          <Button type="submit" variant="primary" loading={busy} icon={<Upload size={16} />}>Server importieren</Button>
        </fieldset>
        {busy && <div className="mt-4 space-y-2" aria-live="polite"><ProgressBar value={progress} /><p className="text-sm text-stone-300">{progress < 100 ? `ZIP wird hochgeladen … ${Math.round(progress)} %` : 'ZIP wird geprüft und neuer Server vorbereitet …'}</p></div>}
      </form>
    </Panel>}
  </div>;
}
