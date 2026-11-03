// Every image that can be deployed (anything under site/) must carry no
// metadata at all: no Exif (which is where GPS lives), no XMP, no IPTC, no
// ICC profile, no comments, and nothing appended after the image. This walks
// the JPEG structure directly instead of trusting the tool that stripped the
// photos, and anything it can't fully parse is a failure, not a pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';

const SITE = new URL('../site/', import.meta.url).pathname;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.heic', '.heif', '.tif', '.tiff', '.bmp']);

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const hex = (marker) => `0xFF${marker.toString(16).toUpperCase()}`;

// Returns { metadata: [markers found], trailingBytes: bytes after the end marker }.
// Throws if the file isn't a well-formed JPEG.
export function scanJpeg(bytes) {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) throw new Error('not a JPEG (no start marker)');
  const metadata = [];
  let offset = 2;
  for (;;) {
    if (offset + 2 > bytes.length) throw new Error('file ends before the end-of-image marker');
    if (bytes[offset] !== 0xff) throw new Error(`expected a marker at byte ${offset}`);
    const marker = bytes[offset + 1];
    if (marker === 0xff) { offset += 1; continue; }            // fill byte
    if (marker === 0xd9) { offset += 2; break; }               // end of image
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { offset += 2; continue; } // no length
    if (offset + 4 > bytes.length) throw new Error('file ends inside a segment header');
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) throw new Error(`bad segment length at byte ${offset}`);
    // APP1..APP15 (APP0 is the plain JFIF header) and COM (comments).
    if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) metadata.push(hex(marker));
    offset += 2 + length;
    if (marker === 0xda) {
      // Start of scan: compressed image data follows. Skip to the next real
      // marker (0xFF followed by anything except 0x00 stuffing or RST0-7),
      // because progressive JPEGs can carry more segments between scans.
      while (offset + 1 < bytes.length
        && !(bytes[offset] === 0xff && bytes[offset + 1] !== 0x00 && !(bytes[offset + 1] >= 0xd0 && bytes[offset + 1] <= 0xd7))) {
        offset += 1;
      }
    }
  }
  return { metadata, trailingBytes: bytes.length - offset };
}

const b = (...parts) => Buffer.from(parts.flat());
const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
const SOS = [0xff, 0xda, 0x00, 0x03, 0x00];
const ENTROPY = [0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]; // includes stuffing and a restart marker
const APP1 = [0xff, 0xe1, 0x00, 0x04, 0xaa, 0xbb];

test('scanner: a clean image passes', () => {
  assert.deepEqual(scanJpeg(b(SOI, SOS, ENTROPY, EOI)), { metadata: [], trailingBytes: 0 });
});

test('scanner: spots Exif in the header', () => {
  assert.deepEqual(scanJpeg(b(SOI, APP1, SOS, ENTROPY, EOI)).metadata, ['0xFFE1']);
});

test('scanner: spots metadata hidden between progressive scans', () => {
  assert.deepEqual(scanJpeg(b(SOI, SOS, ENTROPY, APP1, SOS, ENTROPY, EOI)).metadata, ['0xFFE1']);
});

test('scanner: spots data appended after the end of the image', () => {
  assert.equal(scanJpeg(b(SOI, SOS, ENTROPY, EOI, [0xde, 0xad, 0xbe, 0xef])).trailingBytes, 4);
});

test('scanner: a truncated or fake JPEG fails loudly instead of passing', () => {
  assert.throws(() => scanJpeg(b(SOI, SOS, ENTROPY)), /ends before/);
  assert.throws(() => scanJpeg(Buffer.from('<html>not an image</html>')), /not a JPEG/);
});

for (const path of filesUnder(SITE)) {
  const ext = extname(path).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) continue;
  const name = path.slice(SITE.length);
  if (ext === '.jpg' || ext === '.jpeg') {
    test(`${name} has no metadata and nothing appended`, () => {
      assert.deepEqual(scanJpeg(readFileSync(path)), { metadata: [], trailingBytes: 0 });
    });
  } else {
    test(`${name}: only JPEGs are allowed in site/ until ${ext} has its own metadata check`, () => {
      assert.fail(`${name} is a ${ext} file, which this test can't check for location data`);
    });
  }
}
