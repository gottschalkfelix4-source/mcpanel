import net from 'node:net';

/**
 * Adressprüfungen an einer Stelle: Proxy-Vertrauen (X-Forwarded-For),
 * Sperre für das Minecraft-Netz und der SSRF-Schutz für ausgehende Webhooks.
 */

/** `::ffff:10.0.0.1` → `10.0.0.1`, Zonen-Index und Klammern entfernen. */
export function normalizeAddress(address: string | undefined | null): string {
  let value = (address ?? '').trim();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  value = value.replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
  return mapped ? mapped[1] : value.toLowerCase();
}

function family(address: string): 'ipv4' | 'ipv6' | null {
  const kind = net.isIP(address);
  return kind === 4 ? 'ipv4' : kind === 6 ? 'ipv6' : null;
}

export class AddressList {
  private list = new net.BlockList();
  private empty = true;

  /** Nimmt `10.0.0.0/8`, `fd00::/8` oder eine einzelne Adresse. Ungültiges wird verworfen. */
  add(cidr: string): boolean {
    const [rawAddress, rawPrefix] = cidr.trim().split('/');
    const address = normalizeAddress(rawAddress);
    const type = family(address);
    if (!type) return false;
    const max = type === 'ipv4' ? 32 : 128;
    const prefix = rawPrefix === undefined ? max : Number(rawPrefix);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return false;
    this.list.addSubnet(address, prefix, type);
    this.empty = false;
    return true;
  }

  has(address: string | undefined | null): boolean {
    if (this.empty) return false;
    const value = normalizeAddress(address);
    const type = family(value);
    return Boolean(type && this.list.check(value, type));
  }
}

const LOOPBACK = new AddressList();
for (const cidr of ['127.0.0.0/8', '::1/128']) LOOPBACK.add(cidr);

/** Private und interne Bereiche, wie Docker-Netze und Heimnetze sie nutzen. */
const PRIVATE = new AddressList();
for (const cidr of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7']) PRIVATE.add(cidr);

/**
 * Alles, was ein ausgehender Webhook nie erreichen darf, sofern es nicht
 * ausdrücklich erlaubt wurde: Schleife, privat, Link-local (Cloud-Metadaten),
 * CGNAT, Multicast, „dieses Netz“ und die Dokumentations-/Testbereiche.
 */
const NON_PUBLIC = new AddressList();
for (const cidr of [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24',
  '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
  '::/128', '::1/128', '64:ff9b::/96', '100::/64', '2001:db8::/32', 'fc00::/7', 'fe80::/10', 'ff00::/8',
]) NON_PUBLIC.add(cidr);

export const isLoopbackAddress = (address: string | undefined | null) => LOOPBACK.has(address);
export const isPrivateAddress = (address: string | undefined | null) => PRIVATE.has(address);
export const isPublicAddress = (address: string | undefined | null) =>
  family(normalizeAddress(address)) !== null && !NON_PUBLIC.has(address);

/** Kommagetrennte CIDR-Liste aus der Umgebung, z. B. `TRUSTED_PROXIES=192.168.1.5,10.0.0.0/24`. */
export function parseAddressList(value: string | undefined): AddressList {
  const list = new AddressList();
  for (const entry of (value ?? '').split(',').map((part) => part.trim()).filter(Boolean)) list.add(entry);
  return list;
}

// ---------------------------------------------------------------------------
// Minecraft-Netz: Server-Container dürfen das Panel nicht ansprechen.
// ---------------------------------------------------------------------------

let serverNetwork = new AddressList();
let serverGateways = new Set<string>();

/**
 * Wird nach dem Anlegen des Docker-Netzes gesetzt. Das Gateway ist der
 * Docker-Host selbst und bleibt erlaubt – ein Container kann dessen Adresse
 * nicht für eine vollständige TCP-Verbindung vortäuschen.
 */
export function setServerNetwork(subnets: string[], gateways: string[]): void {
  const list = new AddressList();
  for (const subnet of subnets) list.add(subnet);
  serverNetwork = list;
  serverGateways = new Set(gateways.map(normalizeAddress).filter(Boolean));
}

export function isServerNetworkAddress(address: string | undefined | null): boolean {
  const value = normalizeAddress(address);
  return Boolean(value) && !serverGateways.has(value) && serverNetwork.has(value);
}

// ---------------------------------------------------------------------------
// Proxy-Vertrauen
// ---------------------------------------------------------------------------

let trustedProxies = parseAddressList(process.env.TRUSTED_PROXIES);

/** Nur für Tests. */
export function setTrustedProxies(value: string): void {
  trustedProxies = parseAddressList(value);
}

/**
 * Für Fastifys `trustProxy` und den Socket.IO-Handschlag: Vertraut wird genau
 * dem nginx des Panels (Schleife bzw. interner Compose-Dienst, nie einem
 * Minecraft-Container). Weiter zurückliegende Glieder der X-Forwarded-For-Kette
 * zählen nur, wenn sie in TRUSTED_PROXIES stehen – sonst könnte jeder Client im
 * LAN seine Adresse frei wählen und die Anmeldebremse umgehen.
 */
export function trustProxy(address: string, hop: number): boolean {
  if (hop === 0) {
    return isLoopbackAddress(address) || (isPrivateAddress(address) && !isServerNetworkAddress(address));
  }
  return trustedProxies.has(address);
}

/** Dieselbe Auswertung wie Fastifys `req.ip`, für Verbindungen außerhalb von Fastify. */
export function clientAddress(remote: string | undefined, forwardedFor: string | string[] | undefined): string {
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor ?? '';
  const chain = [remote ?? '', ...header.split(',').map((part) => part.trim()).filter(Boolean).reverse()];
  let address = chain[0];
  for (let hop = 0; hop < chain.length - 1; hop++) {
    if (!trustProxy(chain[hop], hop)) break;
    address = chain[hop + 1];
  }
  return normalizeAddress(address);
}
