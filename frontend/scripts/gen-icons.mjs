/**
 * Erzeugt die PWA-Icons als PNG – ohne Abhängigkeiten, direkt im PNG-Format
 * (zlib steckt in Node). Gezeichnet wird ein 16×16-Pixelraster des
 * Grasblock-Logos, das ganzzahlig hochskaliert wird, damit die Kanten
 * pixelscharf bleiben.
 *
 * Aufruf: node scripts/gen-icons.mjs   (aus dem frontend/-Ordner)
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- Palette --
const C = {
  _: null, // transparent
  D: [0x86, 0x60, 0x43], // Erde
  d: [0x5c, 0x41, 0x30], // Erde dunkel (Sprenkel)
  G: [0x5b, 0x87, 0x31], // Gras
  g: [0x7f, 0xb2, 0x38], // Gras hell
  H: [0x8f, 0xc2, 0x42], // Halmspitze
  K: [0x0d, 0x0d, 0x0f], // Kontur
  W: [0xf2, 0xf2, 0xf4], // Gesicht/Glanz
};

// 16×16 Grasblock mit Kontur, Highlight-Deckel und Erd-Sprenkeln
const SPRITE = [
  'KKKKKKKKKKKKKKKK',
  'KHHgHHgHHgHHgHHK',
  'KgggggggggggggggK'.slice(0, 16),
  'KGGgGGGgGGGgGGGK',
  'KGGGGGGGGGGGGGGK',
  'KDDDDDDDDDDDDDDK',
  'KDDdDDDDDDdDDDDK',
  'KDDDDDDdDDDDDDDK',
  'KDDDDWWDDWWDDDDK',
  'KDDDDWWDDWWDDDDK',
  'KDDDDDDDDDDDDDDK',
  'KDDdDDDDDDDDdDDK',
  'KDDDDDDddDDDDDDK',
  'KDDDDDDDDDDdDDDK',
  'KDdDDDDDDDDDDDDK',
  'KKKKKKKKKKKKKKKK',
];

// ------------------------------------------------------------- PNG-Writer --
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA-Pixelbuffer (w*h*4) als PNG-Datei schreiben. */
function writePng(path, width, height, rgba) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // Filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bittiefe
  ihdr[9] = 6; // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
  console.log(`  ${path.split(/[\\/]/).pop()}  ${width}×${height}  ${png.length} B`);
}

// ------------------------------------------------------------- Rendering ---
function render(size, { background = null, blockShare = 1 } = {}) {
  const rgba = Buffer.alloc(size * size * 4);

  if (background) {
    for (let i = 0; i < size * size; i++) {
      rgba[i * 4] = background[0];
      rgba[i * 4 + 1] = background[1];
      rgba[i * 4 + 2] = background[2];
      rgba[i * 4 + 3] = 255;
    }
  }

  // Block ganzzahlig skalieren und zentrieren
  const scale = Math.max(1, Math.floor((size * blockShare) / 16));
  const block = scale * 16;
  const off = Math.floor((size - block) / 2);

  for (let y = 0; y < block; y++) {
    const row = SPRITE[Math.floor(y / scale)];
    for (let x = 0; x < block; x++) {
      const color = C[row[Math.floor(x / scale)]];
      if (!color) continue;
      const i = ((off + y) * size + off + x) * 4;
      rgba[i] = color[0];
      rgba[i + 1] = color[1];
      rgba[i + 2] = color[2];
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

console.log('PWA-Icons:');
for (const size of [192, 512]) {
  writePng(join(OUT, `icon-${size}.png`), size, size, render(size, { blockShare: 0.94 }));
  // Maskable: volle dunkle Fläche, Block in der sicheren Zone (~60 %)
  writePng(
    join(OUT, `icon-maskable-${size}.png`),
    size,
    size,
    render(size, { background: [0x1e, 0x1e, 0x23], blockShare: 0.62 }),
  );
}
// iOS-Homescreen (undurchsichtig, iOS rundet selbst ab)
writePng(
  join(OUT, 'apple-touch-icon.png'),
  180,
  180,
  render(180, { background: [0x1e, 0x1e, 0x23], blockShare: 0.8 }),
);
