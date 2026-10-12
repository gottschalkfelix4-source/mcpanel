import type { PowerState } from './types';

export function serverStatus(state: PowerState, health?: string | null) {
  if (state === 'starting' || (state === 'running' && health === 'starting')) return { label: 'Startet', tone: 'gold' as const };
  if (state === 'running') {
    if (health === 'healthy') return { label: 'Bereit', tone: 'green' as const };
    if (health === 'unhealthy') return { label: 'Prüfung fehlgeschlagen', tone: 'red' as const };
    return { label: 'Läuft · ungeprüft', tone: 'neutral' as const };
  }
  if (state === 'error') return { label: 'Fehler', tone: 'red' as const };
  return { label: state === 'missing' ? 'Kein Container' : 'Offline', tone: 'neutral' as const };
}
