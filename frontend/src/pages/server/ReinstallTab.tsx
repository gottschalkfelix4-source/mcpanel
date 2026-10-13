import { useState } from 'react';
import ImportServerPage from '../ImportServer';
import CreateServerPage from '../CreateServer';
import { Button, InfoNote } from '../../components/ui';
import { useServer } from './ServerLayout';

export default function ReinstallTab() {
  const [zip, setZip] = useState(false);
  const { server, can } = useServer();
  if (!can('server.reinstall')) return <InfoNote>Dir fehlt das Recht „Server neu installieren“.</InfoNote>;
  return <div className="space-y-4">
    <div className="flex gap-2"><Button onClick={() => setZip(false)} variant={zip ? 'default' : 'primary'}>Neu installieren</Button><Button onClick={() => setZip(true)} variant={zip ? 'primary' : 'default'}>ZIP importieren</Button></div>
    {zip ? <ImportServerPage key={server.id} existingServer={server} /> : <CreateServerPage key={server.id} existingServer={server} />}
  </div>;
}
