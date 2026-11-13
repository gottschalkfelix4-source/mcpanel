import { openPromise, type Entry } from 'yauzl';

/**
 * Einen einzelnen kleinen Eintrag (mods.toml, fabric.mod.json …) aus einem Jar
 * lesen – asynchron und ohne das ganze Archiv in den Speicher zu holen.
 *
 * Vorher las das Panel jedes Jar komplett und synchron ein. Bei einem Modpack
 * mit 400 Mods stand das ganze Panel dabei Sekunden still, über die Freigabe
 * einer Node sogar Minuten.
 *
 * `names` in Vorzugsreihenfolge; geliefert wird der erste, den es gibt.
 * `null`, wenn keiner vorhanden ist, das Archiv nicht lesbar ist oder der
 * Eintrag größer als `maxBytes` wäre.
 */
export async function readJarEntry(file: string, names: string[], maxBytes = 1024 * 1024): Promise<Buffer | null> {
  let zip;
  try {
    zip = await openPromise(file, { lazyEntries: true, autoClose: false });
  } catch {
    return null;
  }
  try {
    const found = new Map<string, Entry>();
    for await (const entry of zip.eachEntry()) {
      if (names.includes(entry.fileName)) {
        found.set(entry.fileName, entry);
        if (found.has(names[0])) break; // Bester Treffer – weiter suchen lohnt nicht.
      }
    }
    const entry = names.map((name) => found.get(name)).find(Boolean);
    if (!entry || entry.uncompressedSize > maxBytes) return null;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of await zip.openReadStreamPromise(entry)) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) return null;
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  } finally {
    zip.close();
  }
}

/** `fn` für alle Elemente, höchstens `limit` gleichzeitig; Ergebnis in Eingabereihenfolge. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
