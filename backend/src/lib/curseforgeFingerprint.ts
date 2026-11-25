/**
 * CurseForge-Datei-Fingerprint.
 *
 * CurseForge erkennt installierte Moddateien nicht über SHA-1, sondern über
 * einen eigenen Fingerprint: MurmurHash2 (32 Bit, Seed 1) über die Datei,
 * aus der zuvor alle Whitespace-Zeichen (Tabulator, Zeilenumbruch, Wagen-
 * rücklauf, Leerzeichen) entfernt wurden – so bleibt der Hash auch dann
 * stabil, wenn ein Download die Zeilenenden verändert hat. Die gleiche
 * Berechnung verwenden packwiz (Go) und die offiziellen Curse-Clients.
 *
 * Referenzimplementierungen:
 *   - <https://github.com/packwiz/packwiz/blob/main/curseforge/detect.go>
 *   - @meza/curseforge-fingerprint (C++-Binding, mit Test-Fixtures)
 *
 * Der Fingerprint ist ein vorzeichenloser 32-Bit-Wert; die CurseForge-API
 * nimmt ihn als JSON-Zahl entgegen. Werte bis 2^53 – also alle hier – sind
 * in JavaScript exakt darstellbar.
 */

/** MurmurHash2 (32 Bit) mit Seed – Standardvariante von Austin Appleby. */
export function murmurHash2(data: Uint8Array, seed: number): number {
  const m = 0x5bd1e995;
  const r = 24;
  let h = (seed ^ data.length) >>> 0;
  let i = 0;
  const len = data.length;
  while (len - i >= 4) {
    let k = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
    k = Math.imul(k, m) >>> 0;
    k ^= k >>> r;
    k = Math.imul(k, m) >>> 0;
    h = Math.imul(h, m) >>> 0;
    h ^= k;
    i += 4;
  }
  switch (len - i) {
    case 3:
      h ^= data[i + 2] << 16;
    // fallthrough
    case 2:
      h ^= data[i + 1] << 8;
    // fallthrough
    case 1:
      h ^= data[i];
      h = Math.imul(h, m) >>> 0;
  }
  h ^= h >>> 13;
  h = Math.imul(h, m) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

/** Whitespace im Sinne von CurseForge: TAB, LF, CR, Leerzeichen. */
function isWhitespace(b: number): boolean {
  return b === 9 || b === 10 || b === 13 || b === 32;
}

/**
 * Fingerprint einer Datei: Whitespace entfernen, dann MurmurHash2 mit Seed 1.
 * Großzügig dimensioniert, weil die Datei dafür vollständig gelesen wird – die
 * Aufrufer begrenzen die Dateigröße.
 */
export function computeCurseforgeFingerprint(data: Uint8Array): number {
  // Gängige Jars sind weit unter 4 KiB Whitespace-Anteil – der seltene Fall
  // wächst den Puffer einfach nach.
  let out = new Uint8Array(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (!isWhitespace(b)) out[n++] = b;
  }
  return murmurHash2(out.subarray(0, n), 1);
}
