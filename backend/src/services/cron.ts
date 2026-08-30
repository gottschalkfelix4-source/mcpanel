/**
 * Minimaler Cron-Auswerter für 5-Feld-Ausdrücke:
 *
 *   Minute Stunde Tag-im-Monat Monat Wochentag
 *   *      *      *            *     *
 *
 * Unterstützt `*`, `5`, `1,15`, `1-5`, `*\/10` und Kombinationen davon.
 * Wochentag: 0 = Sonntag … 6 = Samstag (7 wird als Sonntag gelesen).
 *
 * Bewusst ohne Fremdbibliothek: der Funktionsumfang ist überschaubar und
 * vollständig testbar, das spart eine Abhängigkeit im Serverpfad.
 */

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

const RANGES: [number, number][] = [
  [0, 59], // Minute
  [0, 23], // Stunde
  [1, 31], // Tag
  [1, 12], // Monat
  [0, 6], // Wochentag
];

/** Ein einzelnes Feld auflösen, z. B. "*\/15" oder "1-5". */
function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const chunk = part.trim();
    if (!chunk) throw new Error('Leeres Feld im Cron-Ausdruck');

    const [spec, stepRaw] = chunk.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Ungültige Schrittweite "${stepRaw}"`);
    }

    let from: number;
    let to: number;

    if (spec === '*') {
      from = min;
      to = max;
    } else if (spec.includes('-')) {
      const [a, b] = spec.split('-').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        throw new Error(`Ungültiger Bereich "${spec}"`);
      }
      from = a;
      to = b;
    } else {
      const value = Number(spec);
      if (!Number.isInteger(value)) throw new Error(`Ungültiger Wert "${spec}"`);
      from = value;
      to = value;
    }

    // Wochentag 7 ist ebenfalls Sonntag
    if (max === 6) {
      if (from === 7) from = 0;
      if (to === 7) to = 0;
    }

    if (from < min || to > max || from > to) {
      throw new Error(`Wert außerhalb des gültigen Bereichs (${min}–${max}): "${chunk}"`);
    }

    for (let v = from; v <= to; v += step) values.add(v);
  }

  return values;
}

export function parseCron(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('Ein Cron-Ausdruck braucht genau 5 Felder: Minute Stunde Tag Monat Wochentag');
  }

  const [minutes, hours, daysOfMonth, months, daysOfWeek] = fields.map((field, i) =>
    parseField(field, RANGES[i][0], RANGES[i][1]),
  );

  return { minutes, hours, daysOfMonth, months, daysOfWeek };
}

/** Prüft, ob der Ausdruck gültig ist – für die Eingabevalidierung. */
export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * Trifft der Ausdruck auf diesen Zeitpunkt zu?
 *
 * Wie bei Vixie-Cron gilt: Sind *beide* Tagesfelder eingeschränkt, reicht es,
 * wenn eines passt (ODER). Ist nur eines eingeschränkt, muss dieses passen.
 */
export function matchesCron(fields: CronFields, date: Date): boolean {
  if (!fields.minutes.has(date.getMinutes())) return false;
  if (!fields.hours.has(date.getHours())) return false;
  if (!fields.months.has(date.getMonth() + 1)) return false;

  const domRestricted = fields.daysOfMonth.size < 31;
  const dowRestricted = fields.daysOfWeek.size < 7;
  const domMatch = fields.daysOfMonth.has(date.getDate());
  const dowMatch = fields.daysOfWeek.has(date.getDay());

  if (domRestricted && dowRestricted) return domMatch || dowMatch;
  if (domRestricted) return domMatch;
  if (dowRestricted) return dowMatch;
  return true;
}

/** Nächster Zeitpunkt nach `from`, an dem der Ausdruck zutrifft. */
export function nextRun(expression: string, from: Date = new Date()): Date | null {
  const fields = parseCron(expression);

  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  // Ein Jahr voraus reicht – alles andere ist praktisch nie erreichbar.
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (matchesCron(fields, cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Beschreibung für die Oberfläche
// ---------------------------------------------------------------------------

const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

const pad = (n: number) => String(n).padStart(2, '0');

/** Erzeugt einen lesbaren deutschen Satz zu einem Cron-Ausdruck. */
export function describeCron(expression: string): string {
  let fields: CronFields;
  try {
    fields = parseCron(expression);
  } catch {
    return 'Ungültiger Zeitplan';
  }

  const [minuteField, hourField, domField, monthField, dowField] = expression.trim().split(/\s+/);

  // Jede Minute – sonst würde unten eine sinnlose Liste aus 1440 Uhrzeiten entstehen
  if (minuteField === '*') {
    if (hourField === '*' && domField === '*' && monthField === '*' && dowField === '*') {
      return 'Jede Minute';
    }
    const hours = [...fields.hours].sort((a, b) => a - b).map((h) => `${pad(h)} Uhr`);
    return `Jede Minute (${hours.length <= 4 ? hours.join(', ') : `${hours.length} Stunden`})`;
  }

  // Alle N Minuten
  const everyMinutes = minuteField.match(/^\*\/(\d+)$/);
  if (everyMinutes && hourField === '*' && domField === '*' && monthField === '*' && dowField === '*') {
    return `Alle ${everyMinutes[1]} Minuten`;
  }

  // Alle N Stunden zur Minute M
  const everyHours = hourField.match(/^\*\/(\d+)$/);
  if (everyHours && /^\d+$/.test(minuteField) && domField === '*' && monthField === '*' && dowField === '*') {
    return `Alle ${everyHours[1]} Stunden (zur Minute ${minuteField})`;
  }

  // Stündlich zur Minute M
  if (/^\d+$/.test(minuteField) && hourField === '*' && domField === '*' && monthField === '*' && dowField === '*') {
    return `Stündlich um :${pad(Number(minuteField))}`;
  }

  const times = [...fields.hours]
    .sort((a, b) => a - b)
    .flatMap((h) => [...fields.minutes].sort((a, b) => a - b).map((m) => `${pad(h)}:${pad(m)}`));
  const timeText = times.length <= 4 ? times.join(', ') : `${times.length}× täglich`;

  // Wöchentlich an bestimmten Tagen
  if (dowField !== '*' && domField === '*') {
    const days = [...fields.daysOfWeek].sort((a, b) => a - b).map((d) => WEEKDAYS[d]);
    const dayText =
      days.length === 1
        ? days[0] + 's'
        : days.length === 7
          ? 'täglich'
          : days.join(', ');
    return `${dayText} um ${timeText}`;
  }

  // Monatlich an bestimmten Tagen
  if (domField !== '*') {
    const days = [...fields.daysOfMonth].sort((a, b) => a - b).join('., ');
    return `Am ${days}. des Monats um ${timeText}`;
  }

  return `Täglich um ${timeText}`;
}
