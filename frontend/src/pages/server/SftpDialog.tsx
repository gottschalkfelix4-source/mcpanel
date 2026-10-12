import { useQuery } from '@tanstack/react-query';
import { Copy, ExternalLink } from 'lucide-react';
import { api } from '../../lib/api';
import { Button, ErrorNote, LoadingBlock, Modal, useToast } from '../../components/ui';

interface ConnectionInfo {
  enabled: boolean; host: string; port: number; username: string;
  path: string; fingerprint: string; writable: boolean;
}

export default function SftpDialog({ serverId, path, open, onClose }: {
  serverId: string; path: string; open: boolean; onClose: () => void;
}) {
  const toast = useToast();
  const info = useQuery({
    queryKey: ['sftp', serverId],
    queryFn: () => api.get<ConnectionInfo>(`/servers/${serverId}/files/sftp`),
    enabled: open,
    staleTime: 0,
  });
  const connection = info.data;
  const host = connection?.host || window.location.hostname;
  const remotePath = connection ? connection.path + path.replace(/^\/+/, '') : '';
  const encodedPath = remotePath.split('/').map(encodeURIComponent).join('/');
  const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  // Das Passwort gehört weder in eine URL noch in den Browser-Speicher.
  const url = connection ? `sftp://${encodeURIComponent(connection.username)}@${address}:${connection.port}${encodedPath}` : '';
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); toast.success('Kopiert.'); }
    catch { toast.error('Kopieren ist nicht verfügbar. Bitte den Wert markieren und kopieren.'); }
  }
  function row(label: string, value: string) {
    return <div key={label} className="grid grid-cols-[100px_minmax(0,1fr)_28px] items-start gap-3 border-b border-stone-890 py-2.5 last:border-0">
      <dt className="text-sm text-stone-400">{label}</dt>
      <dd className="break-all font-mono text-sm text-stone-100">{value}</dd>
      <button type="button" onClick={() => copy(value)} title={`${label} kopieren`} aria-label={`${label} kopieren`} className="p-1 text-stone-400 hover:text-grass-light"><Copy size={15} /></button>
    </div>;
  }
  return <Modal open={open} onClose={onClose} title="SFTP-Verbindung" size="md" footer={
    <div className="flex w-full flex-wrap justify-end gap-2">
      <Button variant="ghost" onClick={onClose}>Schließen</Button>
      <Button variant="ghost" disabled={!connection?.enabled} icon={<Copy size={15} />} onClick={() => copy(url)}>Verbindung kopieren</Button>
      <Button variant="primary" disabled={!connection?.enabled} icon={<ExternalLink size={15} />} onClick={() => { window.location.href = url; }}>SFTP-Client öffnen</Button>
    </div>
  }>
    {info.isLoading ? <LoadingBlock /> : info.error ? <ErrorNote>{(info.error as Error).message}</ErrorNote> : connection && <div className="flex flex-col gap-4">
      {!connection.enabled && <ErrorNote>Der SFTP-Dienst ist deaktiviert oder nicht erreichbar.</ErrorNote>}
      <dl>
        {row('Protokoll', 'SFTP')}
        {row('Adresse', host)}
        {row('Port', String(connection.port))}
        {row('Benutzer', connection.username)}
        <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-3 border-b border-stone-890 py-2.5"><dt className="text-sm text-stone-400">Passwort</dt><dd className="text-sm text-stone-100">Dein Panel-Passwort</dd></div>
        {row('Verzeichnis', remotePath)}
        {row('Hostschlüssel', connection.fingerprint)}
      </dl>
      <p className="text-sm text-stone-400">{connection.writable ? 'Du kannst Dateien hochladen, herunterladen und bearbeiten.' : 'Du hast für diesen Server nur Leserechte.'} Für Uploads im Client eine gleichzeitige Übertragung je Server einstellen.</p>
      <p className="text-xs text-stone-450">Der Button öffnet das Programm, das für sftp:// registriert ist. Falls nichts passiert, die Verbindungsdaten in FileZilla oder WinSCP eintragen. Beim ersten Verbinden den angezeigten Hostschlüssel vergleichen.</p>
    </div>}
  </Modal>;
}
