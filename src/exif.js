// Removing the mirror from a photo's EXIF orientation, in place.
//
// Why this exists: the app never mirrored anything of its own. It stores the
// bytes it is given and serves them back untouched, and the browser applies
// the EXIF orientation tag - including the four values that mean "and flip
// it left-to-right". That is correct behaviour and it is what the Photos app
// does too, so the two normally agree.
//
// They stopped agreeing for selfies. An iPhone stores photos as HEIC and
// Safari converts to JPEG at the moment of upload; what comes out has the
// mirror baked into the pixels AND still carries a mirrored orientation tag,
// so a viewer that honours the tag - every browser - flips an already
// flipped photo and shows it backwards.
//
// Rather than re-encode the pixels (which on a 256MB box is exactly the work
// we cannot afford), this rewrites two bytes: the orientation tag drops its
// mirror component and keeps its rotation. 2->1, 4->3, 5->8, 7->6.

// Mirrored orientation -> the same rotation without the flip.
const UNMIRROR = { 2: 1, 4: 3, 5: 8, 7: 6 };

const TAG_ORIENTATION = 0x0112;

/**
 * Finds the EXIF Orientation tag in a JPEG buffer and returns where it is
 * and what it says, or null when there is none to find. Deliberately total:
 * a photo with no EXIF, a truncated file or a segment that does not parse
 * all return null rather than throwing, because every one of those is a
 * photo we should still accept and store as-is.
 */
export function findOrientation(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let p = 2;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff) return null;
    const marker = buf[p + 1];
    // Standalone markers carry no length; start-of-scan means pixel data
    // from here on, so there is no EXIF left to find.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    if (marker === 0xda) return null;
    const len = buf.readUInt16BE(p + 2);
    if (len < 2 || p + 2 + len > buf.length) return null;

    if (marker === 0xe1 && buf.slice(p + 4, p + 10).toString('latin1') === 'Exif\0\0') {
      const tiff = p + 10;
      if (tiff + 8 > buf.length) return null;
      const order = buf.slice(tiff, tiff + 2).toString('latin1');
      if (order !== 'II' && order !== 'MM') return null;
      const little = order === 'II';
      const u16 = (at) => (little ? buf.readUInt16LE(at) : buf.readUInt16BE(at));
      const u32 = (at) => (little ? buf.readUInt32LE(at) : buf.readUInt32BE(at));

      const ifd0 = tiff + u32(tiff + 4);
      if (ifd0 + 2 > buf.length) return null;
      const count = u16(ifd0);
      for (let i = 0; i < count; i++) {
        const entry = ifd0 + 2 + i * 12;
        if (entry + 12 > buf.length) return null;
        if (u16(entry) === TAG_ORIENTATION) {
          // A SHORT sits in the first two bytes of the 4-byte value field.
          const at = entry + 8;
          return { at, little, value: u16(at) };
        }
      }
      return null;
    }
    p += 2 + len;
  }
  return null;
}

/**
 * Strips the mirror from a JPEG's orientation, keeping its rotation.
 * Returns { changed, from, to } - changed is false for a photo that was
 * never mirrored, which is the overwhelming majority of them.
 */
export function unmirrorJpeg(buf) {
  const found = findOrientation(buf);
  if (!found) return { changed: false };
  const to = UNMIRROR[found.value];
  if (!to) return { changed: false, from: found.value };
  if (found.little) buf.writeUInt16LE(to, found.at);
  else buf.writeUInt16BE(to, found.at);
  return { changed: true, from: found.value, to };
}
