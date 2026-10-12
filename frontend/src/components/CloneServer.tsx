import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Button, Field, Panel, Toggle, useToast } from './ui';
import { TaskProgress } from './TaskProgress';

export default function CloneServer({ id, name }: { id: string; name: string }) {
  const [copyName, setCopyName] = useState(`${name.slice(0, 43)} Test`);
  const [includeWorld, setIncludeWorld] = useState(false);
  const [running, setRunning] = useState(false);
  const toast = useToast();
  const queries = useQueryClient();
  const clone = useMutation({
    mutationFn: () => api.post(`/servers/${id}/clone`, { name: copyName, includeWorld }),
    onSuccess: () => { toast.info('Testkopie wird erstellt.'); void queries.invalidateQueries({ queryKey: ['server-tasks', id] }); },
    onError: (err: Error) => toast.error(err.message),
  });
  return <Panel title="Als Testserver kopieren">
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); clone.mutate(); }}>
      <Field label="Name der Testkopie"><input aria-label="Name der Testkopie" className="mc-input" value={copyName} minLength={2} maxLength={48} onChange={event => setCopyName(event.target.value)} /></Field>
      <Toggle checked={includeWorld} onChange={setIncludeWorld} label="Bestehende Welt mitkopieren" />
      <p className="text-sm text-stone-400">Die Kopie erhält einen eigenen Port und bleibt zunächst gestoppt. Ohne Welt wird beim Start eine neue Welt erzeugt. Mitglieder, Subdomains und Automationen werden nicht übernommen.</p>
      <Button type="submit" variant="primary" loading={clone.isPending || running}>Testkopie erstellen</Button>
    </form>
    <TaskProgress serverId={id} types={['server.clone']} onRunningChange={setRunning} onFinished={() => { void queries.invalidateQueries({ queryKey: ['servers'] }); }} />
  </Panel>;
}
