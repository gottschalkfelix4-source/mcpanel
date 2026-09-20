/**
 * Ermittelt aus dem Protokoll eines abgestürzten Servers, welche Mod bzw.
 * welches Plugin den Start verhindert hat.
 *
 * Der verlässlichste Hinweis steht im Stacktrace: Java hängt hinter jede Zeile
 * die Herkunft der Klasse an – `at toni.missingmodschecker.MissingModsWindow
 * .<init>(…) ~[missingmodschecker.jar:?]`. Die oberste Zeile, die nicht zum
 * Loader oder zum Spiel selbst gehört, ist der Verursacher.
 *
 * Wo der Loader die schuldige Mod von sich aus benennt – bei einer fehlenden
 * Abhängigkeit und bei einem Fehler im Einstiegspunkt – zählt das mehr als der
 * Stacktrace: darunter stehen dann nur noch Loader- und Spielklassen, aus
 * denen sonst die falsche Mod herausgelesen wird.
 */

import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

/** Jars, die immer im Stacktrace stehen und nie die Ursache sind. */
const INFRASTRUKTUR = [
  /^fabric-loader/i,
  /^fabric-server/i,
  /^quilt-loader/i,
  /^minecraft/i,
  /^forge-/i,
  /^neoforge-/i,
  /^client-extra/i,
  // Das Spiel selbst – als `server-1.20.1.jar` und, von Fabric umbenannt,
  // als `server-intermediary.jar`. Eng gefasst: `server-translations-api`
  // ist eine ganz normale Mod und darf verdaechtig bleiben.
  /^server-(\d|intermediary)/i,
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

/**
 * Fabrics Abhaengigkeitsfehler nennt die Mod im Klartext:
 *   - Mod 'Missing Mods Checker' (missingmodschecker) 1.0.1 requires any
 *     version of txnilib, which is missing!
 * Das ist der haeufigste Startfehler ueberhaupt und praeziser als jeder
 * Stacktrace - dort stehen bei diesem Fall nur Loader-Klassen.
 */
function fabricAbhaengigkeit(log: string): { modId: string; name: string; fehlt: string[] } | null {
  const re = /Mod '([^']+)' \(([A-Za-z0-9_.-]+)\).*? requires .*?(?:version of |version )([A-Za-z0-9_.-]+), which is missing/g;
  const treffer = [...log.matchAll(re)];
  if (treffer.length === 0) return null;

  // Mehrere Zeilen betreffen meist dieselbe Mod mit mehreren Luecken.
  const erste = treffer[0];
  const fehlt = [
    ...new Set(treffer.filter((t) => t[2] === erste[2]).map((t) => t[3])),
  ];
  return { modId: erste[2], name: erste[1], fehlt };
}

/**
 * Bricht eine Mod in ihrem Einstiegspunkt ab, nennt Fabric sie im Klartext:
 *   Could not execute entrypoint stage 'main' due to errors, provided by
 *   'certain_questing_additions' at 'ru.hollowhorizon…'!
 * Darunter folgen nur noch Loader- und Spielklassen – wer dort den Stacktrace
 * liest, beschuldigt irgendeine Mod, die zufaellig weiter oben steht.
 */
function fabricEinstiegspunkt(log: string): string | null {
  const treffer = log.match(
    /Could not execute entrypoint stage '[^']*' due to errors,? provided by '([^']+)'/,
  );
  return treffer?.[1] ?? null;
}

/**
 * Eine leere `lang/*.json` in einem Mod-Jar reisst den Server beim Start mit
 * einer NullPointerException aus der Sprachdatei-Verarbeitung ab, noch bevor
 * die Welt geladen wird. Im Stacktrace steht dann ausschliesslich Minecraft
 * selbst – die schuldige Mod findet man nur, indem man die Jars aufmacht.
 *
 * Geprueft wird nur auf *leer*: Minecraft liest die Dateien nachsichtig und
 * verkraftet etwa Kommentare, aber aus einer leeren Datei wird `null`, und
 * genau daran stirbt der Start.
 */
function modMitLeererSprachdatei(modsDir: string): { file: string; eintrag: string } | null {
  let dateien: string[];
  try {
    dateien = fs.readdirSync(modsDir);
  } catch {
    return null;
  }

  for (const file of dateien) {
    if (!/\.jar$/i.test(file)) continue;
    try {
      for (const eintrag of new AdmZip(path.join(modsDir, file)).getEntries()) {
        if (!/^assets\/[^/]+\/lang\/[^/]+\.json$/i.test(eintrag.entryName)) continue;
        if (eintrag.getData().toString('utf8').trim() === '') {
          return { file, eintrag: eintrag.entryName };
        }
      }
    } catch {
      /* unlesbares Jar ist hier nicht die Frage */
    }
  }
  return null;
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

/** Aus einer Mod-ID bzw. einem Jar-Namen den Verdächtigen bauen. */
function verdacht(referenz: string, dateien: string[]): CrashSuspect {
  const datei = findeDatei(referenz, dateien);
  return {
    filename: datei,
    reference: datei ?? referenz,
    enabled: datei ? !datei.endsWith('.disabled') : false,
  };
}

/**
 * @param log      Rohprotokoll des Containers (die letzten Zeilen genügen)
 * @param dateien  Dateinamen im Mods-/Plugins-Ordner, inkl. `.disabled`
 * @param modsDir  Ordner derselben Dateien. Nur noetig, um in die Jars zu
 *                 schauen, wenn das Protokoll keine Mod nennt.
 */
export function analyseCrash(
  log: string,
  dateien: string[],
  modsDir?: string,
): CrashDiagnosis | null {
  if (!log.trim()) return null;
  const zeilen = log.split(/\r?\n/);

  const dep = fabricAbhaengigkeit(log);
  if (dep) {
    const datei = findeDatei(dep.modId, dateien);
    return {
      headline: `"${dep.name}" fehlt eine Abhängigkeit.`,
      reason:
        `Die Mod verlangt ${dep.fehlt.join(' und ')} – das liegt nicht im Ordner. ` +
        'Entweder die fehlende Mod nachinstallieren oder diese hier abschalten.',
      suspect: {
        filename: datei,
        reference: datei ?? dep.modId,
        enabled: datei ? !datei.endsWith('.disabled') : false,
      },
      excerpt: zeilen
        .filter((z) => /requires|Incompatible mods|Install /.test(z))
        .slice(0, 8)
        .map((z) => z.replace(/\s+$/, '')),
    };
  }

  const muster = MUSTER.find((m) => m.test.test(log));

  const einstieg = fabricEinstiegspunkt(log);
  if (einstieg) {
    const ab = zeilen.findIndex((z) => /Could not execute entrypoint stage/.test(z));
    return {
      headline: muster?.headline ?? 'Eine Mod ist beim Start abgebrochen.',
      reason:
        muster?.reason ??
        `Der Loader konnte den Einstiegspunkt von "${einstieg}" nicht ausführen – ` +
          'die Mod passt nicht zu diesem Server.',
      suspect: verdacht(einstieg, dateien),
      excerpt: zeilen
        .slice(Math.max(0, ab))
        .filter((z) => z.trim().length > 0)
        .slice(0, 12)
        .map((z) => z.replace(/\s+$/, '')),
    };
  }

  // Ab der Fehlerzeile nach unten suchen: davor steht bei Fabric die komplette
  // Modliste, in der beliebige Jars vorkommen. Warnungen zaehlen nicht – von
  // „Error loading class“ stehen bei Modpacks Hunderte im Protokoll.
  const fehlerIndex = zeilen.findIndex(
    (z) => /Exception|Error/.test(z) && !/^\s*at\s/.test(z) && !/\bWARN\b/.test(z),
  );
  const stack = fehlerIndex >= 0 ? zeilen.slice(fehlerIndex) : zeilen;

  const auszug = stack
    .slice(0, 12)
    .filter((z) => z.trim().length > 0)
    .map((z) => z.replace(/\s+$/, ''));

  const jars = jarsAusStacktrace(stack);
  if (jars.length === 0) {
    // Keine Mod im Stacktrace: bei der Sprachdatei-Ausnahme lohnt der Blick
    // in die Jars, sonst bleibt der Absturz unerklaert.
    const gson = /Cannot invoke "com\.google\.gson\.JsonObject\.entrySet\(\)"/.test(log);
    const leer = gson && modsDir ? modMitLeererSprachdatei(modsDir) : null;
    if (!leer) return null;
    return {
      headline: 'Eine Mod liefert eine leere Sprachdatei.',
      reason:
        `In \`${leer.file}\` ist \`${leer.eintrag}\` leer. Minecraft liest die Sprachdateien ` +
        'aller Mods, bevor die Welt lädt, und bricht an einer leeren Datei ab.',
      suspect: verdacht(leer.file, dateien),
      excerpt: auszug,
    };
  }

  const referenz = jars[0];
  const datei = findeDatei(referenz, dateien);

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
