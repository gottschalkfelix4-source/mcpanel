export interface ProxyPort { hostIp: string; hostPort: number; containerPort: number; protocol: string; active: boolean }
export interface ProxyRuntime { state: 'running' | 'stopped' | 'missing' | 'unknown'; ports: ProxyPort[]; error: string | null }
export interface ProxyServer {
  id: string; name: string; type: string; hostnames: string[]; directConnect: boolean; port: number;
  internalAddress: string; runtime: ProxyRuntime;
}
export interface ProxyOverview {
  proxy: { enabled: boolean; port: number; running: boolean; reachable: boolean; error: string | null; runtime: ProxyRuntime };
  publicHost: string; network: string; checkedAt: string; externalReachability: 'not_checked'; servers: ProxyServer[];
  ports: { ownerId: string; ownerName: string; port: number; protocol: string; required: boolean; bindings: ProxyPort[]; state: ProxyRuntime['state'] }[];
}
export const runtimeLabel = { running: 'Läuft', stopped: 'Gestoppt', missing: 'Nicht angelegt', unknown: 'Status unbekannt' };
export function minecraftAddress(hostname: string, port: number): string {
  return port === 25565 ? hostname : `${hostname}:${port}`;
}
