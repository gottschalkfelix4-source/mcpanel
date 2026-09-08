import { Transform } from 'node:stream';
import { badRequest } from './errors.js';

export function byteLimit(maxBytes = Infinity): Transform {
  let bytes = 0;
  return new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > maxBytes) callback(badRequest('Speicherkontingent reicht für diese Datei nicht aus'));
    else callback(null, chunk);
  } });
}
