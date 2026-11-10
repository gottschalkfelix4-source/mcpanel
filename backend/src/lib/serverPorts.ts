/**
 * Zusatzports je Server, synchron abfragbar.
 *
 * `portBindings()` in docker.ts ist synchron und wird auch in Tests ohne
 * Datenbank aufgerufen. Quelle ist die Tabelle `ServerPort`; beim Start lädt
 * `loadServerPorts()` den Stand, jeder Abgleich schreibt ihn hier nach. Ein
 * Server ohne Eintrag hat keine Zusatzports – so war es vor dieser Funktion.
 *
 * Bewusst ohne Laufzeit-Importe, damit docker.ts nichts Neues nachlädt.
 */

export type PortProtocol = 'tcp' | 'udp' | 'tcp_udp';

export interface ExtraPort {
  hostPort: number;
  containerPort: number;
  protocol: PortProtocol;
}

const ports = new Map<string, ExtraPort[]>();

export function extraPortsOf(serverId: string): ExtraPort[] {
  return ports.get(serverId) ?? [];
}

export function setExtraPorts(serverId: string, list: ExtraPort[]): void {
  if (list.length === 0) ports.delete(serverId);
  else {
    ports.set(serverId, list
      .map(({ hostPort, containerPort, protocol }) => ({ hostPort, containerPort, protocol }))
      .sort((a, b) => a.hostPort - b.hostPort));
  }
}

export function replaceAllExtraPorts(rows: ({ serverId: string } & ExtraPort)[]): void {
  ports.clear();
  const grouped = new Map<string, ExtraPort[]>();
  for (const row of rows) {
    const list = grouped.get(row.serverId) ?? [];
    list.push({ hostPort: row.hostPort, containerPort: row.containerPort, protocol: row.protocol });
    grouped.set(row.serverId, list);
  }
  for (const [serverId, list] of grouped) setExtraPorts(serverId, list);
}

/** Docker-Schlüssel wie "24454/udp" je Containerport und Protokoll. */
export function dockerPortKeys(port: Pick<ExtraPort, 'containerPort' | 'protocol'>): string[] {
  const protocols = port.protocol === 'tcp_udp' ? ['tcp', 'udp'] : [port.protocol];
  return protocols.map((protocol) => `${port.containerPort}/${protocol}`);
}
