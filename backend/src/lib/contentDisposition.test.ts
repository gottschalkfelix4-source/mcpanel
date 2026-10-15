import { describe, expect, it } from 'vitest';
import { attachment } from './contentDisposition.js';
import { canonicalDownloadPath } from '../auth/downloadPath.js';

describe('attachment', () => {
  it('liefert ASCII-Rückfall und den echten Namen kodiert', () => {
    expect(attachment('Welt Größe.tar.gz')).toBe(
      `attachment; filename="Welt Gr__e.tar.gz"; filename*=UTF-8''Welt%20Gr%C3%B6%C3%9Fe.tar.gz`,
    );
  });

  it('lässt Anführungszeichen und Zeilenumbrüche nicht in die Kopfzeile', () => {
    const header = attachment('a"b\\c\r\nSet-Cookie: x=1.txt');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.split(';')[1]).toBe(' filename="a_b_c__Set-Cookie: x=1.txt"');
  });

  it('nimmt einen Standardnamen, wenn nichts übrig bleibt', () => {
    expect(attachment('')).toContain('filename="download"');
  });
});

describe('canonicalDownloadPath', () => {
  it('entfernt das Token und sortiert die Abfrage', () => {
    expect(canonicalDownloadPath('/api/servers/a/files/download?token=xyz&path=%2Fworld&b=1'))
      .toBe('/api/servers/a/files/download?b=1&path=%2Fworld');
  });

  it('behandelt + und %20 gleich', () => {
    expect(canonicalDownloadPath('/api/x?path=mein+ordner')).toBe(canonicalDownloadPath('/api/x?path=mein%20ordner'));
  });

  it('unterscheidet andere Pfade', () => {
    expect(canonicalDownloadPath('/api/servers/a/backups/1/download'))
      .not.toBe(canonicalDownloadPath('/api/servers/b/backups/1/download'));
    expect(canonicalDownloadPath('/api/servers/a/backups/1/download?token=t')).toBe('/api/servers/a/backups/1/download');
  });
});
