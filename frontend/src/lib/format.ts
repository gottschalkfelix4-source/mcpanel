/*
 * Zahlen, Größen und Zeiten einheitlich auf Deutsch. Die Intl-Formatierer
 * werden einmal angelegt: `toLocaleString` mit Optionen baut sie sonst bei
 * jedem Aufruf neu – bei einer Dateiliste mit Tausenden Zeilen spürbar.
 */

const numberFormats = new Map<string, Intl.NumberFormat>();
function numberFormat(min: number, max: number): Intl.NumberFormat {
  const key = `${min}:${max}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat('de-DE', { minimumFractionDigits: min, maximumFractionDigits: max });
    numberFormats.set(key, format);
  }
  return format;
}

/** Zahl mit festen Nachkommastellen und deutschem Komma. */
export function formatDecimal(value: number, digits = 1): string {
  return numberFormat(digits, digits).format(value);
}

export function formatBytes(bytes: number, digits = 1): string {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${formatDecimal(value, i === 0 ? 0 : digits)} ${units[i]}`;
}

const integer = new Intl.NumberFormat('de-DE');
export function formatNumber(value: number): string {
  return integer.format(value);
}

const compact = new Intl.NumberFormat('de-DE', { notation: 'compact', maximumFractionDigits: 1 });
export function formatCompact(value: number): string {
  return compact.format(value);
}

const dateTime = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '–';
  return dateTime.format(new Date(iso));
}

const relative = new Intl.RelativeTimeFormat('de-DE', { numeric: 'auto' });
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000000],
  ['month', 2592000000],
  ['day', 86400000],
  ['hour', 3600000],
  ['minute', 60000],
  ['second', 1000],
];
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '–';
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (abs >= ms || unit === 'second') {
      return relative.format(Math.round(-diff / ms), unit);
    }
  }
  return '–';
}

/** Laufzeit wie „2 Tg. 3 Std.“ oder „14 Min.“. */
export function formatUptime(startedAt: string | null): string {
  if (!startedAt) return '–';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} Tg. ${h} Std.`;
  if (h > 0) return `${h} Std. ${m} Min.`;
  if (m > 0) return `${m} Min.`;
  return `${seconds % 60} Sek.`;
}

export function formatMemory(mb: number): string {
  return mb >= 1024 ? `${formatDecimal(mb / 1024, mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
}
