import { z, ZodIssueCode, type ZodErrorMap } from 'zod';

/**
 * Deutsche Standardmeldungen für zod. Rund 150 Prüfungen haben keine eigene
 * Meldung – ohne diese Übersetzung sähe man „String must contain at least 8
 * character(s)“. Eigene Meldungen (`.min(8, '…')`) gehen weiterhin vor.
 */
const TYPEN: Record<string, string> = {
  string: 'Text', number: 'Zahl', integer: 'ganze Zahl', boolean: 'Ja/Nein-Wert', object: 'Objekt',
  array: 'Liste', date: 'Datum', bigint: 'Zahl', null: 'leer', undefined: 'nichts',
};
const typ = (name: string) => TYPEN[name] ?? name;
const zahl = (value: number | bigint) => Number(value).toLocaleString('de-DE');

export const deutscheMeldungen: ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === 'undefined') return { message: 'Pflichtfeld fehlt' };
      if (issue.expected === 'integer') return { message: 'Muss eine ganze Zahl sein' };
      return { message: `Erwartet: ${typ(issue.expected)}, erhalten: ${typ(issue.received)}` };
    case ZodIssueCode.too_small:
      if (issue.type === 'string') return { message: Number(issue.minimum) === 1 ? 'Darf nicht leer sein' : `Mindestens ${zahl(issue.minimum)} Zeichen` };
      if (issue.type === 'array' || issue.type === 'set') return { message: `Mindestens ${zahl(issue.minimum)} Einträge` };
      if (issue.type === 'number' || issue.type === 'bigint') return { message: issue.inclusive ? `Mindestens ${zahl(issue.minimum)}` : `Größer als ${zahl(issue.minimum)}` };
      return { message: 'Zu klein' };
    case ZodIssueCode.too_big:
      if (issue.type === 'string') return { message: `Höchstens ${zahl(issue.maximum)} Zeichen` };
      if (issue.type === 'array' || issue.type === 'set') return { message: `Höchstens ${zahl(issue.maximum)} Einträge` };
      if (issue.type === 'number' || issue.type === 'bigint') return { message: issue.inclusive ? `Höchstens ${zahl(issue.maximum)}` : `Kleiner als ${zahl(issue.maximum)}` };
      return { message: 'Zu groß' };
    case ZodIssueCode.invalid_string:
      if (issue.validation === 'email') return { message: 'Keine gültige E-Mail-Adresse' };
      if (issue.validation === 'url') return { message: 'Keine gültige Adresse' };
      if (issue.validation === 'uuid' || issue.validation === 'cuid') return { message: 'Ungültige Kennung' };
      return { message: 'Ungültiges Format' };
    case ZodIssueCode.invalid_enum_value:
      return { message: `Erlaubt: ${issue.options.join(', ')}` };
    case ZodIssueCode.invalid_literal:
      return { message: 'Ungültiger Wert' };
    case ZodIssueCode.unrecognized_keys:
      return { message: `Unbekannte Felder: ${issue.keys.join(', ')}` };
    case ZodIssueCode.not_multiple_of:
      return { message: `Muss ein Vielfaches von ${zahl(issue.multipleOf)} sein` };
    case ZodIssueCode.not_finite:
      return { message: 'Muss eine endliche Zahl sein' };
    case ZodIssueCode.invalid_date:
      return { message: 'Ungültiges Datum' };
    case ZodIssueCode.invalid_union:
    case ZodIssueCode.invalid_union_discriminator:
      return { message: 'Ungültiger Wert' };
    default:
      return { message: ctx.defaultError };
  }
};

z.setErrorMap(deutscheMeldungen);
