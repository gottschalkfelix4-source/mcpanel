/**
 * Kleiner Leser für SNBT, wie es die FTB-Mods schreiben: Einträge stehen
 * zeilenweise ohne Komma, Schlüssel teils in Anführungszeichen, Zahlen mit
 * Typ-Suffix (`1b`, `3L`, `0.5d`), dazu typisierte Felder (`[I; 1, 2]`).
 * Gelesen wird in schlichte JSON-Werte; geschrieben wird nie – Änderungen
 * laufen über Befehle des Mods, damit der laufende Server sie mitbekommt.
 */
export type SnbtValue = string | number | boolean | SnbtValue[] | { [key: string]: SnbtValue };

const MAX_DEPTH = 64;

export function parseSnbt(text: string): SnbtValue {
  let i = 0;
  const fail = (what: string): never => { throw new Error(`SNBT ungültig: ${what} an Position ${i}`); };
  const skip = () => {
    for (;;) {
      while (i < text.length && /[\s,]/.test(text[i])) i++;
      // Zeilenkommentare, wie sie FTB-Konfigurationen enthalten
      if (text[i] === '#' || (text[i] === '/' && text[i + 1] === '/')) {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      return;
    }
  };
  const quoted = (): string => {
    const quote = text[i++];
    let out = '';
    while (i < text.length && text[i] !== quote) {
      if (text[i] === '\\' && i + 1 < text.length) i++;
      out += text[i++];
    }
    if (text[i] !== quote) fail('Zeichenkette nicht geschlossen');
    i++;
    return out;
  };
  const bare = (): string => {
    const start = i;
    while (i < text.length && /[A-Za-z0-9_.+\-]/.test(text[i])) i++;
    if (i === start) fail('Wert erwartet');
    return text.slice(start, i);
  };
  const scalar = (raw: string): SnbtValue => {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    const number = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)[bBsSlLfFdD]?$/.exec(raw);
    return number ? Number(number[1]) : raw;
  };
  const value = (depth: number): SnbtValue => {
    if (depth > MAX_DEPTH) fail('zu tief verschachtelt');
    skip();
    const c = text[i];
    if (c === '{') {
      i++;
      const out: { [key: string]: SnbtValue } = {};
      for (;;) {
        skip();
        if (text[i] === '}') { i++; return out; }
        if (i >= text.length) fail('Block nicht geschlossen');
        const key = text[i] === '"' || text[i] === "'" ? quoted() : bare();
        skip();
        if (text[i] !== ':') fail('Doppelpunkt erwartet');
        i++;
        out[key] = value(depth + 1);
      }
    }
    if (c === '[') {
      i++;
      // Typisierte Felder: [B; …], [I; …], [L; …]
      if (/[BIL]/.test(text[i] ?? '') && /^\s*;/.test(text.slice(i + 1, i + 4))) i = text.indexOf(';', i) + 1;
      const out: SnbtValue[] = [];
      for (;;) {
        skip();
        if (text[i] === ']') { i++; return out; }
        if (i >= text.length) fail('Liste nicht geschlossen');
        out.push(value(depth + 1));
      }
    }
    if (c === '"' || c === "'") return quoted();
    return scalar(bare());
  };
  const result = value(0);
  skip();
  if (i < text.length) fail('unerwarteter Rest');
  return result;
}
