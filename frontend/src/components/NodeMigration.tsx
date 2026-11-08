import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, HardDrive } from 'lucide-react';
import { api } from '../lib/api';
import { formatMemory } from '../lib/format';
import type { NodesResponse, ServerDetail } from '../lib/types';
import { TaskProgress } from './TaskProgress';
import { Button, ConfirmDialog, Field, InfoNote, Panel, useToast } from './ui';

const MIGRATE_TASKS = ['server.migrate'];

/**
 * Umzug eines Servers auf eine andere Node. Nur für Administratoren – ein
 * Umzug kostet Plattenplatz und RAM auf einem anderen Rechner.
 */
export default function NodeMigration({ server, onDone }: { server: ServerDetail; onDone: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const current = server.node?.id ?? 'local';
  const [target, setTarget] = useState<string>('');
  const [confirm, setConfirm] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const nodes = useQuery({
    queryKey: ['nodes'],
    queryFn: () => api.get<NodesResponse>('/nodes'),
    staleTime: 15_000,
  });
  const list = nodes.data?.nodes ?? [];
  // Nur der Hauptserver und keine weitere Node: nichts zum Umziehen.
  if (nodes.isSuccess && list.length < 2) return null;

  const options = list.filter((node) => (node.id ?? 'local') !== current);
  const chosen = list.find((node) => (node.id ?? 'local') === target);
  const here = list.find((node) => (node.id ?? 'local') === current);
  const running_ = server.state === 'running' || server.state === 'starting';

  return (
    <Panel
      title="Node"
      icon={<HardDrive size={16} />}
      subtitle={<>Läuft auf <strong className="text-stone-200">{server.node?.name ?? 'Hauptserver'}</strong>{here?.status === 'offline' ? ' (getrennt)' : ''}</>}
    >
      <div className="space-y-4">
        <Field label="Umziehen nach" hint="Die Dateien werden kopiert und geprüft; erst wenn der Server am Ziel steht, verschwinden sie an der alten Stelle.">
          <select className="mc-select" value={target} onChange={(e) => setTarget(e.target.value)} disabled={running}>
            <option value="">Ziel wählen …</option>
            {options.map((node) => {
              const free = node.metrics ? node.metrics.memTotalMb - node.allocatedMemoryMb : null;
              return (
                <option key={node.id ?? 'local'} value={node.id ?? 'local'} disabled={node.status !== 'online'}>
                  {node.name}
                  {node.status !== 'online'
                    ? ' – getrennt'
                    : node.metrics ? ` – ${formatMemory(Math.max(0, free ?? 0))} RAM frei, ${formatMemory(node.metrics.diskFreeMb)} Platte frei` : ''}
                </option>
              );
            })}
          </select>
        </Field>

        {chosen && running_ && (
          <InfoNote>Der Server läuft gerade. Er wird für den Umzug gestoppt und am Ziel wieder gestartet.</InfoNote>
        )}
        {chosen && (
          <InfoNote>
            Spieler verbinden sich danach mit <span className="font-mono">{chosen.publicHost}:{server.port}</span>
            {server.proxy.hostnames.length > 0 ? ' – die Subdomains leitet der Proxy automatisch weiter.' : '.'}
            {chosen.connection === 'wireguard' && ` Auf der Node muss der Port ${server.port} (TCP/UDP) von außen erreichbar sein.`}
          </InfoNote>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" icon={<ArrowRightLeft size={15} />} disabled={!chosen || running}
            onClick={() => setConfirm(true)}>
            Server umziehen
          </Button>
          <Link to="/admin/nodes" className="text-xs text-stone-400 hover:text-stone-200">Nodes verwalten →</Link>
        </div>

        <TaskProgress
          serverId={server.id}
          types={MIGRATE_TASKS}
          taskId={taskId ?? undefined}
          onRunningChange={setRunning}
          onFinished={(task) => {
            setTaskId(null);
            setTarget('');
            if (task.status === 'DONE') toast.success(task.message || 'Umzug abgeschlossen');
            void queryClient.invalidateQueries({ queryKey: ['nodes'] });
            void queryClient.invalidateQueries({ queryKey: ['servers'] });
            onDone();
          }}
        />
      </div>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Server umziehen?"
        confirmLabel="Umziehen"
        message={
          <p>
            <strong className="text-stone-100">{server.name}</strong> zieht von „{server.node?.name ?? 'Hauptserver'}“ nach
            „{chosen?.name}“. Je nach Größe der Welt und Leitung dauert das einige Minuten; der Server ist so lange offline.
          </p>
        }
        onConfirm={async () => {
          try {
            const result = await api.post<{ taskId: string }>(`/servers/${server.id}/migrate`, {
              nodeId: target === 'local' ? null : target,
            });
            setTaskId(result.taskId);
            setRunning(true);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Umzug konnte nicht starten');
          }
        }}
      />
    </Panel>
  );
}
