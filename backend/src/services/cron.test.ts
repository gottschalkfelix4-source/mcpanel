import { describe, expect, it } from 'vitest';
import { describeCron, isValidCron, nextRun, parseCron, parseField } from './cron.js';

/** Feld als aufsteigende Liste – Mengen vergleichen sich schlecht. */
const sorted = (values: Set<number>) => [...values].sort((a, b) => a - b);

/**
 * Zeitpunkt in der Zeitzone des Rechners. `nextRun` rechnet mit Ortszeit
 * (`getHours()` und Co.), also werden die Erwartungen genauso gebaut – damit
 * bestehen die Tests unabhaengig von TZ. Alle Zeitpunkte liegen im Januar und
 * Februar, wo keine Zeitzone auf Sommerzeit umstellt.
 */
const local = (year: number, month: number, day: number, hour = 0, minute = 0) =>
  new Date(year, month - 1, day, hour, minute, 0, 0);

describe('parseField – Grundformen', () => {
  it('löst "*" auf das ganze Feld auf', () => {
    expect(parseField('*', 0, 59).size).toBe(60);
    expect(sorted(parseField('*', 1, 12))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('liest einen Einzelwert', () => {
    expect(sorted(parseField('5', 0, 59))).toEqual([5]);
  });

  it('liest eine Liste', () => {
    expect(sorted(parseField('1,15', 0, 59))).toEqual([1, 15]);
  });

  it('liest einen Bereich', () => {
    expect(sorted(parseField('1-5', 0, 59))).toEqual([1, 2, 3, 4, 5]);
  });

  it('liest eine Schrittweite über das ganze Feld', () => {
    expect(sorted(parseField('*/15', 0, 59))).toEqual([0, 15, 30, 45]);
  });

  it('liest eine Schrittweite innerhalb eines Bereichs', () => {
    expect(sorted(parseField('10-50/10', 0, 59))).toEqual([10, 20, 30, 40, 50]);
  });

  it('liest "5/10" nach Vixie-Art als "5-59/10"', () => {
    expect(sorted(parseField('5/10', 0, 59))).toEqual([5, 15, 25, 35, 45, 55]);
  });

  it('mischt Liste, Bereich und Schrittweite in einem Feld', () => {
    expect(sorted(parseField('0,30,45-47,50/4', 0, 59))).toEqual([0, 30, 45, 46, 47, 50, 54, 58]);
  });
});

describe('parseField – Wochentage', () => {
  it('liest "1-7" als alle sieben Tage', () => {
    expect(sorted(parseField('1-7', 0, 6))).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('liest "0-7" als alle sieben Tage', () => {
    expect(sorted(parseField('0-7', 0, 6))).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('liest "7" als Sonntag', () => {
    expect(sorted(parseField('7', 0, 6))).toEqual([0]);
  });

  it('liest "0" als Sonntag', () => {
    expect(sorted(parseField('0', 0, 6))).toEqual([0]);
  });

  it('liest "6-7" als Samstag und Sonntag', () => {
    expect(sorted(parseField('6-7', 0, 6))).toEqual([0, 6]);
  });

  it('liest "1-5" als Montag bis Freitag', () => {
    expect(sorted(parseField('1-5', 0, 6))).toEqual([1, 2, 3, 4, 5]);
  });

  it('lässt 7 nur im Wochentagsfeld zu', () => {
    expect(() => parseField('7', 1, 6)).toThrow(/Bereich/);
  });
});

describe('parseCron', () => {
  it('zerlegt einen vollständigen Ausdruck in fünf Felder', () => {
    const fields = parseCron('30 4 1,15 */6 1-5');
    expect(sorted(fields.minutes)).toEqual([30]);
    expect(sorted(fields.hours)).toEqual([4]);
    expect(sorted(fields.daysOfMonth)).toEqual([1, 15]);
    expect(sorted(fields.months)).toEqual([1, 7]);
    expect(sorted(fields.daysOfWeek)).toEqual([1, 2, 3, 4, 5]);
  });

  it('verträgt mehrfache Leerzeichen und Rand-Leerzeichen', () => {
    expect(sorted(parseCron('  0   4  *  *  *  ').hours)).toEqual([4]);
  });

  it('ergibt bei "0 4 * * 0-7" ein tägliches Backup', () => {
    expect(parseCron('0 4 * * 0-7').daysOfWeek.size).toBe(7);
  });

  it('ergibt bei "0 4 * * 7" nur den Sonntag', () => {
    expect(sorted(parseCron('0 4 * * 7').daysOfWeek)).toEqual([0]);
  });
});

describe('parseCron – ungültige Ausdrücke', () => {
  it('lehnt zu wenige Felder ab', () => {
    expect(() => parseCron('0 4 * *')).toThrow(/genau 5 Felder/);
  });

  it('lehnt zu viele Felder ab', () => {
    expect(() => parseCron('0 4 * * * *')).toThrow(/genau 5 Felder/);
  });

  it('lehnt einen leeren Ausdruck ab', () => {
    expect(() => parseCron('   ')).toThrow(/genau 5 Felder/);
  });

  it('lehnt eine Minute über 59 ab', () => {
    expect(() => parseCron('60 4 * * *')).toThrow(/außerhalb des gültigen Bereichs \(0–59\)/);
  });

  it('lehnt eine Stunde über 23 ab', () => {
    expect(() => parseCron('0 24 * * *')).toThrow(/außerhalb des gültigen Bereichs \(0–23\)/);
  });

  it('lehnt den Tag 0 ab', () => {
    expect(() => parseCron('0 4 0 * *')).toThrow(/außerhalb des gültigen Bereichs \(1–31\)/);
  });

  it('lehnt den Monat 13 ab', () => {
    expect(() => parseCron('0 4 * 13 *')).toThrow(/außerhalb des gültigen Bereichs \(1–12\)/);
  });

  it('lehnt den Wochentag 8 ab', () => {
    expect(() => parseCron('0 4 * * 8')).toThrow(/außerhalb des gültigen Bereichs \(0–6\)/);
  });

  it('lehnt einen rückwärts laufenden Bereich ab', () => {
    expect(() => parseCron('30-10 4 * * *')).toThrow(/außerhalb des gültigen Bereichs/);
  });

  it('lehnt Buchstabensalat ab', () => {
    expect(() => parseCron('abc 4 * * *')).toThrow(/Ungültiger Wert "abc"/);
    expect(() => parseCron('MON-FRI 4 * * *')).toThrow(/Ungültiger Bereich "MON-FRI"/);
  });

  it('lehnt die Schrittweite 0 ab', () => {
    expect(() => parseCron('*/0 4 * * *')).toThrow(/Ungültige Schrittweite "0"/);
  });

  it('lehnt eine nicht-numerische Schrittweite ab', () => {
    expect(() => parseCron('*/x 4 * * *')).toThrow(/Ungültige Schrittweite "x"/);
  });

  it('lehnt einen leeren Listeneintrag ab', () => {
    expect(() => parseCron('1,,2 4 * * *')).toThrow(/Leeres Feld/);
  });
});

describe('isValidCron', () => {
  it('bejaht gültige Ausdrücke', () => {
    expect(isValidCron('0 4 * * *')).toBe(true);
    expect(isValidCron('*/15 * * * 0-7')).toBe(true);
  });

  it('verneint ungültige Ausdrücke, ohne zu werfen', () => {
    expect(isValidCron('0 4 * *')).toBe(false);
    expect(isValidCron('0 99 * * *')).toBe(false);
    expect(isValidCron('unfug')).toBe(false);
  });
});

describe('nextRun', () => {
  it('findet den nächsten Tag, wenn die Uhrzeit heute vorbei ist', () => {
    // Donnerstag, 15. Januar 2026
    expect(nextRun('30 3 * * *', local(2026, 1, 15, 4, 0))).toEqual(local(2026, 1, 16, 3, 30));
  });

  it('findet die Uhrzeit noch am selben Tag, wenn sie bevorsteht', () => {
    expect(nextRun('30 3 * * *', local(2026, 1, 15, 3, 29))).toEqual(local(2026, 1, 15, 3, 30));
  });

  it('überspringt den Startzeitpunkt selbst', () => {
    expect(nextRun('30 3 * * *', local(2026, 1, 15, 3, 30))).toEqual(local(2026, 1, 16, 3, 30));
  });

  it('läuft bei "0 4 * * 0-7" täglich', () => {
    expect(nextRun('0 4 * * 0-7', local(2026, 1, 15, 5, 0))).toEqual(local(2026, 1, 16, 4, 0));
  });

  it('läuft bei "0 4 * * 7" nur sonntags', () => {
    // Vom Donnerstag aus zum Sonntag, dem 18. Januar 2026
    expect(nextRun('0 4 * * 7', local(2026, 1, 15, 5, 0))).toEqual(local(2026, 1, 18, 4, 0));
  });

  it('verknüpft Tag und Wochentag mit ODER, wenn beide eingeschränkt sind', () => {
    // Der 13. ist ein Dienstag – er zählt trotzdem, obwohl Freitag gefordert ist
    expect(nextRun('0 12 13 * 5', local(2026, 1, 10, 0, 0))).toEqual(local(2026, 1, 13, 12, 0));
    // Und nach dem 13. greift wieder der Freitag
    expect(nextRun('0 12 13 * 5', local(2026, 1, 13, 13, 0))).toEqual(local(2026, 1, 16, 12, 0));
  });

  it('nutzt allein den Wochentag, wenn der Tag frei ist', () => {
    expect(nextRun('0 12 * * 5', local(2026, 1, 13, 13, 0))).toEqual(local(2026, 1, 16, 12, 0));
  });

  it('nutzt allein den Tag im Monat, wenn der Wochentag frei ist', () => {
    expect(nextRun('0 12 13 * *', local(2026, 1, 14, 0, 0))).toEqual(local(2026, 2, 13, 12, 0));
  });

  it('liefert null für einen Zeitpunkt, den es nie gibt', () => {
    expect(nextRun('0 0 30 2 *', local(2026, 1, 1, 0, 0))).toBeNull();
  });

  it('meldet ungültige Ausdrücke, statt null zu liefern', () => {
    expect(() => nextRun('0 4 * *', local(2026, 1, 1, 0, 0))).toThrow(/genau 5 Felder/);
  });
});

describe('describeCron', () => {
  it('beschreibt "0 4 * * 0-7" als täglich', () => {
    expect(describeCron('0 4 * * 0-7')).toBe('Täglich um 04:00');
  });

  it('beschreibt einen einzelnen Wochentag', () => {
    expect(describeCron('0 4 * * 7')).toBe('Sonntags um 04:00');
  });

  it('meldet ungültige Ausdrücke im Klartext', () => {
    expect(describeCron('0 4 * *')).toBe('Ungültiger Zeitplan');
  });
});
