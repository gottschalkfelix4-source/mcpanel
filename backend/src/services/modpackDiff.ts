import crypto from 'node:crypto';
import AdmZip from 'adm-zip';

function identity(filename: string, data: Buffer): string {
  try {
    const zip = new AdmZip(data);
    const fabric = zip.getEntry('fabric.mod.json');
    if (fabric) {
      const id = JSON.parse(fabric.getData().toString('utf8')).id;
      if (typeof id === 'string' && id) return `mod:${id}`;
    }
    const quilt = zip.getEntry('quilt.mod.json');
    if (quilt) {
      const id = JSON.parse(quilt.getData().toString('utf8')).quilt_loader?.id;
      if (typeof id === 'string' && id) return `mod:${id}`;
    }
    const forge = zip.getEntry('META-INF/neoforge.mods.toml') ?? zip.getEntry('META-INF/mods.toml');
    const id = forge?.getData().toString('utf8').match(/\[\[mods\]\][\s\S]*?modId\s*=\s*["']([^"']+)["']/)?.[1];
    if (id) return `mod:${id}`;
  } catch { /* Ohne lesbare Metadaten nur identische Dateinamen zuordnen. */ }
  return `datei:${filename}`;
}

/** Versionen über Mod-ID zuordnen; erst ein anderer Inhalt zählt als Änderung. */
export function describeModFile(filename: string, data: Buffer) {
  return { id: identity(filename, data), filename, hash: crypto.createHash('sha256').update(data).digest('hex') };
}

export function compareModDescriptors(current: ReturnType<typeof describeModFile>[], incoming: ReturnType<typeof describeModFile>[]) {
  const group = (files: ReturnType<typeof describeModFile>[]) => {
    const result = new Map<string, { filename: string; hash: string }>();
    for (const { id, filename, hash } of files) {
      // Mehrere Dateien derselben Mod dürfen sich nicht gegenseitig verdecken.
      result.set(result.has(id) ? `${id}:${filename}` : id, { filename, hash });
    }
    return result;
  };
  const before = group(current), after = group(incoming);
  const added: string[] = [], removed: string[] = [], updated: { before: string; after: string }[] = [];
  let unchanged = 0;
  for (const [id, item] of after) {
    const old = before.get(id);
    if (!old) added.push(item.filename);
    else if (old.hash !== item.hash) updated.push({ before: old.filename, after: item.filename });
    else unchanged++;
  }
  for (const [id, item] of before) if (!after.has(id)) removed.push(item.filename);
  return { added: added.sort(), removed: removed.sort(), updated, unchanged };
}

export function compareModFiles(current: Map<string, Buffer>, incoming: Map<string, Buffer>) {
  const describe = (files: Map<string, Buffer>) => [...files].map(([name, data]) => describeModFile(name, data));
  return compareModDescriptors(describe(current), describe(incoming));
}
