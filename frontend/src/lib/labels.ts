import type { ServerType } from './types';

/** Lesbare Namen der Servertypen – überall gleich statt „NEOFORGE“. */
export const SERVER_TYPE_LABELS: Record<ServerType, string> = {
  VANILLA: 'Vanilla',
  PAPER: 'Paper',
  PURPUR: 'Purpur',
  SPIGOT: 'Spigot',
  FABRIC: 'Fabric',
  FORGE: 'Forge',
  NEOFORGE: 'NeoForge',
  QUILT: 'Quilt',
  MODPACK: 'Modpack',
};

export const serverTypeLabel = (type: string) => SERVER_TYPE_LABELS[type as ServerType] ?? type;

export const PROVIDER_LABELS: Record<string, string> = {
  modrinth: 'Modrinth',
  curseforge: 'CurseForge',
  ftb: 'FTB',
};

export const providerLabel = (provider: string | null) => (provider ? PROVIDER_LABELS[provider] ?? provider : '');

/** Aufgaben: was gerade passiert und wie es hinterher heißt. */
export const TASK_LABELS: Record<string, { running: string; done: string }> = {
  'server.import': { running: 'Server wird aus ZIP importiert', done: 'Server aus ZIP importiert' },
  'modpack.install': { running: 'Modpack wird installiert', done: 'Modpack installiert' },
  'modpack.update': { running: 'Modpack wird aktualisiert', done: 'Modpack aktualisiert' },
  'modpack.preview': { running: 'Paketvergleich läuft', done: 'Paketvergleich' },
  'backup.create': { running: 'Backup wird erstellt', done: 'Backup erstellt' },
  'backup.restore': { running: 'Backup wird eingespielt', done: 'Backup eingespielt' },
  'backup.verify': { running: 'Backup wird geprüft', done: 'Backup geprüft' },
  'server.reinstall': { running: 'Server wird neu installiert', done: 'Server neu installiert' },
  'server.clone': { running: 'Testkopie wird erstellt', done: 'Testkopie erstellt' },
  'server.migrate': { running: 'Server zieht auf eine andere Node um', done: 'Umzug auf andere Node' },
  'world.export': { running: 'Welt wird zum Herunterladen gepackt', done: 'Welt zum Herunterladen gepackt' },
  'world.import': { running: 'Welt wird importiert', done: 'Welt importiert' },
  'world.reset': { running: 'Welt wird zurückgesetzt', done: 'Welt zurückgesetzt' },
  'assistant.action': { running: 'KI-Reparatur wird ausgeführt', done: 'KI-Reparatur' },
  'map.addons': { running: 'Karten-Erweiterungen werden eingerichtet', done: 'Karten-Erweiterungen eingerichtet' },
  'map.trim': { running: 'Chunks werden zurückgesetzt', done: 'Chunks zurückgesetzt' },
  'panel.backup': { running: 'Panel-Sicherung läuft', done: 'Panel-Sicherung' },
};

export function taskLabel(type: string, running: boolean): string {
  const label = TASK_LABELS[type];
  return label ? (running ? label.running : label.done) : type;
}
