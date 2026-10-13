import CreateServerPage from '../CreateServer';
import { InfoNote } from '../../components/ui';
import { useServer } from './ServerLayout';

export default function ReinstallTab() {
  const { server, can } = useServer();
  if (!can('server.reinstall')) return <InfoNote>Dir fehlt das Recht „Server neu installieren“.</InfoNote>;
  return <CreateServerPage key={server.id} existingServer={server} />;
}
