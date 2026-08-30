import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { FileCode2, Plus, RotateCw, Save, SlidersHorizontal } from 'lucide-react';
import { api } from '../../lib/api';
import type { PropertyField } from '../../lib/types';
import {
  Button, EmptyState, InfoNote, LoadingBlock, Panel, Toggle, useToast,
} from '../../components/ui';
import { useServer } from './ServerLayout';

interface PropertiesResponse {
  fields: PropertyField[];
  exists: boolean;
  values: Record<string, string>;
  extra: Record<string, string>;
}

export default function ConfigTab() {
  const { server, can, liveState } = useServer();
  const toast = useToast();

  const [values, setValues] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [newKey, setNewKey] = useState('');

  const config = useQuery({
    queryKey: ['properties', server.id],
    queryFn: () => api.get<PropertiesResponse>(`/servers/${server.id}/config/properties`),
  });

  useEffect(() => {
    if (!config.data) return;
    setValues(config.data.values);
    setExtra(config.data.extra);
    setDirty(false);
  }, [config.data]);

  const save = useMutation({
    mutationFn: () =>
      api.put<{ restartRequired: boolean }>(`/servers/${server.id}/config/properties`, {
        values: { ...values, ...extra },
      }),
    onSuccess: (res) => {
      setDirty(false);
      toast.success(
        res.restartRequired
          ? 'Gespeichert – ein Neustart übernimmt die Änderungen.'
          : 'Gespeichert.',
      );
      void config.refetch();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const groups = useMemo(() => {
    const fields = config.data?.fields ?? [];
    const map = new Map<string, PropertyField[]>();
    for (const field of fields) {
      if (!map.has(field.group)) map.set(field.group, []);
      map.get(field.group)!.push(field);
    }
    return [...map.entries()];
  }, [config.data]);

  function setValue(key: string, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  const readOnly = !can('config.edit');

  if (config.isLoading) return <LoadingBlock />;

  if (!config.data?.exists) {
    return (
      <Panel title="Konfiguration" icon={<FileCode2 size={16} />}>
        <EmptyState
          icon={<FileCode2 size={40} />}
          title="Noch keine server.properties"
          description="Die Datei entsteht beim ersten Start des Servers. Starte den Server einmal, dann kannst du hier alles einstellen."
        />
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      {dirty && (
        <div className="mc-frame sticky top-24 z-20 animate-pop-in !border-gold/50">
          <div className="mc-frame-inner flex flex-wrap items-center justify-between gap-3 p-3">
            <p className="flex items-center gap-2 text-sm font-bold text-gold">
              <span className="h-2 w-2 animate-pulse-soft bg-gold" />
              Ungespeicherte Änderungen
            </p>
            <div className="flex gap-2">
            <Button
              variant="ghost"
              icon={<RotateCw size={15} />}
              onClick={() => {
                setValues(config.data!.values);
                setExtra(config.data!.extra);
                setDirty(false);
              }}
            >
              Verwerfen
            </Button>
            <Button variant="primary" icon={<Save size={15} />} loading={save.isPending} onClick={() => save.mutate()}>
              Speichern
            </Button>
            </div>
          </div>
        </div>
      )}

      {liveState === 'running' && (
        <InfoNote>
          Der Server läuft. Änderungen an <code>server.properties</code> greifen erst nach einem
          Neustart.
        </InfoNote>
      )}

      {groups.map(([group, fields]) => (
        <Panel key={group} title={group} icon={<SlidersHorizontal size={16} />}>
          <div className="grid gap-4 sm:grid-cols-2">
            {fields.map((field) => {
              const value = values[field.key] ?? '';
              return (
                <div key={field.key}>
                  <label className="mc-label">{field.label}</label>

                  {field.type === 'boolean' ? (
                    <Toggle
                      checked={value === 'true'}
                      disabled={readOnly}
                      onChange={(v) => setValue(field.key, String(v))}
                      label={value === 'true' ? 'An' : 'Aus'}
                    />
                  ) : field.type === 'select' ? (
                    <select
                      className="mc-select"
                      value={value}
                      disabled={readOnly}
                      onChange={(e) => setValue(field.key, e.target.value)}
                    >
                      {!field.options?.includes(value) && <option value={value}>{value || '–'}</option>}
                      {field.options?.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="mc-input"
                      type={field.type === 'number' ? 'number' : 'text'}
                      min={field.min}
                      max={field.max}
                      value={value}
                      disabled={readOnly}
                      onChange={(e) => setValue(field.key, e.target.value)}
                    />
                  )}

                  <p className="mt-1 font-mono text-[10px] text-stone-450">{field.key}</p>
                  {field.hint && <p className="mt-0.5 text-xs text-stone-450">{field.hint}</p>}
                </div>
              );
            })}
          </div>
        </Panel>
      ))}

      {/* Alles Übrige */}
      <Panel
        title="Weitere Einträge"
        subtitle="Alle übrigen Schlüssel aus server.properties"
        icon={<FileCode2 size={16} />}
      >
        <div className="space-y-2">
          {Object.entries(extra).map(([key, value]) => (
            <div key={key} className="flex flex-wrap items-center gap-2">
              <code className="w-full shrink-0 text-xs text-stone-400 sm:w-64">{key}</code>
              <input
                className="mc-input flex-1"
                value={value}
                disabled={readOnly}
                onChange={(e) => {
                  setExtra((prev) => ({ ...prev, [key]: e.target.value }));
                  setDirty(true);
                }}
              />
            </div>
          ))}

          {!readOnly && (
            <div className="flex flex-wrap items-center gap-2 border-t border-stone-875 pt-3">
              <input
                className="mc-input sm:w-64"
                placeholder="neuer.schluessel"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
              />
              <Button
                variant="ghost"
                icon={<Plus size={15} />}
                disabled={!newKey.trim()}
                onClick={() => {
                  setExtra((prev) => ({ ...prev, [newKey.trim()]: '' }));
                  setNewKey('');
                  setDirty(true);
                }}
              >
                Hinzufügen
              </Button>
            </div>
          )}
        </div>
      </Panel>

      {!readOnly && (
        <div className="flex justify-end">
          <Button variant="primary" icon={<Save size={15} />} loading={save.isPending} onClick={() => save.mutate()}>
            Konfiguration speichern
          </Button>
        </div>
      )}
    </div>
  );
}
