import { expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { compareModFiles } from './modpackDiff.js';
const mod = (id: string, version: string) => {
  const zip = new AdmZip(); zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ id, version }))); return zip.toBuffer();
};
it('erkennt Aktualisierungen trotz unterschiedlicher Dateinamen anhand der Mod-ID', () => {
  const result = compareModFiles(new Map([['mod-1.jar', mod('beispiel', '1')]]), new Map([['mod-2.jar', mod('beispiel', '2')]]));
  expect(result.updated).toEqual([{ before: 'mod-1.jar', after: 'mod-2.jar' }]);
  expect(result.added).toEqual([]); expect(result.removed).toEqual([]);
});
it('unterscheidet gleiche Inhalte von neuen, gelöschten und ersetzten Dateien', () => {
  const same = mod('gleich', '1');
  const result = compareModFiles(new Map([['gleich.jar', same], ['alt.jar', Buffer.from('alt')], ['ersetzt.jar', Buffer.from('vorher')]]),
    new Map([['gleich.jar', same], ['neu.jar', Buffer.from('neu')], ['ersetzt.jar', Buffer.from('nachher')]]));
  expect(result).toEqual({ unchanged: 1, added: ['neu.jar'], removed: ['alt.jar'], updated: [{ before: 'ersetzt.jar', after: 'ersetzt.jar' }] });
});
it.each(['META-INF/mods.toml', 'META-INF/neoforge.mods.toml'])('ordnet Forge-Dateien über die Mod-ID zu: %s', entry => {
  const jar = (version: string) => { const zip = new AdmZip(); zip.addFile(entry, Buffer.from(`[[mods]]\nmodId="beispiel"\nversion="${version}"`)); return zip.toBuffer(); };
  expect(compareModFiles(new Map([['alt.jar', jar('1')]]), new Map([['neu.jar', jar('2')]])).updated).toHaveLength(1);
});
