import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useServer } from '../pages/server/ServerLayout';
import { Button, Field, InfoNote, Panel, Toggle, useToast } from './ui';

export default function ServerRouting() {
  const { server, refresh } = useServer();
  const toast = useToast();
  const queries = useQueryClient();
  const [names, setNames] = useState(server.proxy.hostnames.join('\n'));
  const [directConnect, setDirect] = useState(server.directConnect);
  const [port, setPort] = useState(server.port);
  const done = () => { refresh(); void queries.invalidateQueries({ queryKey: ['servers'] }); toast.success('Serveradresse gespeichert.'); };
  const save = useMutation({
    mutationFn: () => api.put(`/servers/${server.id}/proxy`, { hostnames: names.split(/[\n,]/).map(s => s.trim()).filter(Boolean), directConnect }),
    onSuccess: done, onError: (err: Error) => toast.error(err.message),
  });
  const savePort = useMutation({
    mutationFn: () => api.patch(`/servers/${server.id}`, { port }),
    onSuccess: done, onError: (err: Error) => toast.error(err.message),
  });
  return <Panel title="Subdomains und Direktzugriff">
    <div className="space-y-4">
      <p className="text-sm text-stone-300">{server.proxy.enabled ? `Gemeinsamer Proxy-Port: ${server.proxy.port}` : 'Proxy noch nicht aktiviert.'} {server.isAdmin && <Link to="/admin/proxy" className="text-grass-light hover:underline">Proxy-Übersicht öffnen →</Link>}</p>
      <Field label="Subdomains – eine pro Zeile" hint="Die erste ist die primäre Adresse. Beispiel: survival.example.de. Aliase dürfen keinem anderen Server zugeordnet sein.">
        <textarea className="mc-input" rows={3} value={names} onChange={e => setNames(e.target.value)} />
      </Field>
      <Toggle checked={directConnect} onChange={setDirect} label="Zusätzlich über eigenen Direktport erreichbar" />
      <InfoNote>Eine Änderung am Direktzugriff oder Direktport setzt den Container neu auf und unterbricht einen laufenden Server. Subdomain-Änderungen allein erfordern keinen Neustart.</InfoNote>
      <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Subdomains und Zugriff speichern</Button>
      <Field label="Reservierter Direktport" hint={`Direktzugriff ${server.directConnect ? 'aktiv' : 'deaktiviert'}: ${server.directAddress}. Zum Freigeben von 25565 für den Proxy zuerst einen anderen Port speichern oder den Direktzugriff ausschalten.`}>
        <input className="mc-input" type="number" min={1024} max={65535} value={port} onChange={e => setPort(Number(e.target.value))} />
      </Field>
      <Button loading={savePort.isPending} onClick={() => savePort.mutate()}>Direktport ändern</Button>
    </div>
  </Panel>;
}
