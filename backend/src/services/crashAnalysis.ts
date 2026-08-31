/**
 * Ermittelt aus dem Protokoll eines abgestürzten Servers, welche Mod bzw.
 * welches Plugin den Start verhindert hat.
 *
 * Der verlässlichste Hinweis steht im Stacktrace: Java hängt hinter jede Zeile
 * die Herkunft der Klasse an – `at toni.missingmodschecker.MissingModsWindow
 * .<init>(…) ~[missingmodschecker.jar:?]`. Die oberste Zeile, die nicht zum
 * Loader oder zum Spiel selbst gehört, ist der Verursacher.
 */

/** Jars, die immer im Stacktrace stehen und nie die Ursache sind. */
const INFRASTRUKTUR = [
  /^fabric-loader/i,
  /^fabric-server/i,
  /^quilt-loader/i,
  /^minecraft/i,
  /^forge-/i,
  /^neoforge-/i,
  /^client-extra/i,
  /^server-\d/i,
  /^mixin/i,
  /^sponge-mixin/i,
  /^bootstraplauncher/i,
  /^securejarhandler/i,
  /^modlauncher/i,
];

export interface CrashSuspect {
  /** Dateiname im Mods-/Plugins-Ordner, falls zuzuordnen. */
  filename: string | null;
  /** Name aus dem Protokoll – auch dann gesetzt, wenn keine Datei passt. */
  reference: string;
  enabled: boolean;
}

export interface CrashDiagnosis {
  /** Kurze Einordnung des Fehlers auf Deutsch. */
  headline: string;
  /** Warum diese Mod verdächtig ist. */
  reason: string;
  suspect: CrashSuspect | null;
  /** Die Zeilen, auf denen die Einschätzung beruht. */
  excerpt: string[];
}

/** Erkannte Fehlerbilder, von der aussagekräftigsten Regel abwärts. */
const MUSTER: { test: RegExp; headline: string; reason: string }[] = [
  {
    test: /java\.awt\.HeadlessException|No X11 DISPLAY variable was set/,
    headline: 'Eine Mod wollte ein Fenster öffnen.',
    reason:
      'Auf einem Server gibt es keine Anzeige. Die Mod ist für den Client gedacht und bricht deshalb schon beim Start ab.',
  },
  {
    test: /org[./]lwjgl|ClassNotFoundException:\s*org\.lwjgl/i,
    headline: 'Eine Mod hat auf die Grafikausgabe zugegriffen.',
    reason:
      'LWJGL und OpenGL gibt es nur im Spiel selbst, nicht auf einem Server. Solche Renderer-Mods laufen serverseitig nie.',
  },
  {
    test: /in environment type SERVER|environment type SERVER/,
    headline: 'Eine Mod ist ausdrücklich nur für den Client gebaut.',
    reason:
      'Der Loader hat die Klasse abgelehnt, weil sie als clientseitig ausgewiesen ist.',
  },
  {
    test: /Mixin apply.*failed|Critical injection failure/i,
    headline: 'Ein Mixin einer Mod ließ sich nicht anwenden.',
    reason:
      'Meist passt die Mod nicht zur Minecraft- oder Loader-Version, oder sie kollidiert mit einer anderen Mod.',
  },
  {
    test: /Incompatible mod set|requires .* which is missing|unmet dependency/i,
    headline: 'Eine Mod fordert etwas, das nicht vorhanden ist.',
    reason: 'Eine Abhängigkeit fehlt oder liegt in der falschen Version vor.',
  },
];

const stem = (name: string) =>
  name
    .replace(/\.jar(\.disabled)?$/i, '')
    .toLowerCase()
    .replace(/[_\s]+/g, '-');

/**
 * Ordnet den Namen aus dem Protokoll einer echten Datei zu. Zuerst exakt,
 * dann über den normalisierten Stamm, zuletzt über einen Präfix an einer
 * Trennstelle – „missingmodschecker" darf nicht auf „MoogsMissingVillages"
 * passen, deshalb wird nur am Anfang und nur an einer Grenze verglichen.
 */
function findeDatei(referenz: string, dateien: string[]): string | null {
  const gesucht = stem(referenz);

  const exakt = dateien.find((f) => f.toLowerCase() === referenz.toLowerCase());
  if (exakt) return exakt;

  const gleich = dateien.find((f) => stem(f) === gesucht);
  if (gleich) return gleich;

  if (gesucht.length < 4) return null;
  return (
    dateien.find((f) => {
      const s = stem(f);
      return s.startsWith(gesucht) && /^[-.]/.test(s.slice(gesucht.length));
    }) ?? null
  );
}

/** Alle Jar-Herkünfte einer Stacktrace-Zeile, von oben nach unten. */
function jarsAusStacktrace(zeilen: string[]): string[] {
  const treffer: string[] = [];
  for (const zeile of zeilen) {
    const m = zeile.match(/~?\[([^\]]+\.jar)[:\]]/i);
    if (!m) continue;
    const jar = m[1].split(/[\/]/).pop()!;
    if (INFRASTRUKTUR.some((re) => re.test(jar))) continue;
    if (!treffer.includes(jar)) treffer.push(jar);
  }
  return treffer;
}

/**
 * @param log      Rohprotokoll des Containers (die letzten Zeilen genügen)
 * @param dateien  Dateinamen im Mods-/Plugins-Ordner, inkl. `.disabled`
 */
export function analyseCrash(log: string, dateien: string[]): CrashDiagnosis | null {
  if (!log.trim()) return null;
  const zeilen = log.split(/\r?\n/);

  const muster = MUSTER.find((m) => m.test.test(log));

  // Ab der Fehlerzeile nach unten suchen: davor steht bei Fabric die komplette
  // Modliste, in der beliebige Jars vorkommen.
  const fehlerIndex = zeilen.findIndex(
    (z) => /Exception|Error/.test(z) && !/^\s*at\s/.test(z),
  );
  const stack = fehlerIndex >= 0 ? zeilen.slice(fehlerIndex) : zeilen;

  const jars = jarsAusStacktrace(stack);
  if (jars.length === 0) return null;

  const referenz = jars[0];
  const datei = findeDatei(referenz, dateien);

  const auszug = stack
    .slice(0, 12)
    .filter((z) => z.trim().length > 0)
    .map((z) => z.replace(/\s+$/, ''));

  return {
    headline: muster?.headline ?? 'Der Server hat sich beim Start beendet.',
    reason:
      muster?.reason ??
      'Der Fehler stammt aus dieser Datei – sie steht im Stacktrace ganz oben.',
    suspect: {
      filename: datei,
      reference: referenz,
      enabled: datei ? !datei.endsWith('.disabled') : false,
    },
    excerpt: auszug,
  };
}
