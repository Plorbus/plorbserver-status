// Every JPEG that can be deployed (anything under site/) must carry no
// metadata at all: no Exif (which is where GPS lives), no XMP, no IPTC, no
// ICC profile, no comments. This walks the JPEG segment list directly
// instead of trusting the tool that stripped the photos.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SITE = new URL('../site/', import.meta.url).pathname;

function jpegsUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return jpegsUnder(path);
    return /\.jpe?g$/i.test(entry.name) ? [path] : [];
  });
}

export function metadataSegments(bytes) {
  if (bytes.readUInt16BE(0) !== 0xffd8) throw new Error('not a JPEG');
  const found = [];
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) break; // image data starts / ends
    const length = bytes.readUInt16BE(offset + 2);
    // APP1..APP15 (APP0 is the plain JFIF header) and COM (comments).
    if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) {
      found.push(`0xFF${marker.toString(16).toUpperCase()}`);
    }
    offset += 2 + length;
  }
  return found;
}

test('the scanner itself spots an Exif segment', () => {
  // SOI, APP1 "Exif", then start-of-scan.
  const withExif = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xff, 0xda]);
  assert.deepEqual(metadataSegments(withExif), ['0xFFE1']);
});

for (const path of jpegsUnder(SITE)) {
  test(`${path.slice(SITE.length)} has no metadata`, () => {
    assert.deepEqual(metadataSegments(readFileSync(path)), []);
  });
}
