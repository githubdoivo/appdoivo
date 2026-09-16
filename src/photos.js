// Decoding and size-checking a photo submitted as a JPEG data URL.
//
// This lived inside votes.js while Snatch entries were the only thing in the
// app carrying a photo. Wall posts now carry one too, and the choice was to
// move it here rather than let plaza.js import from votes.js: the two
// features share nothing else, and a copy would have been one more place to
// forget when the ceiling or the format check changes.

// Generous ceiling over what an 800px-JPEG-then-base64 photo should ever
// weigh (the client resizes before sending) - this is the actual
// enforcement, since a client-side cap alone can't be trusted.
export const MAX_PHOTO_BYTES = 400 * 1024;

/**
 * Decodes+validates a photo submitted as a JPEG data URL. Only JPEG is
 * accepted - the client always exports to JPEG before sending, so anything
 * else is either a bug or a bypass attempt. Returns { buffer, mime } or
 * { error }.
 */
export function decodeJpegDataUrl(photoBase64) {
  const prefix = 'data:image/jpeg;base64,';
  if (typeof photoBase64 !== 'string' || !photoBase64.startsWith(prefix)) {
    return { error: 'err_photo_invalid' };
  }
  let buffer;
  try {
    buffer = Buffer.from(photoBase64.slice(prefix.length), 'base64');
  } catch {
    return { error: 'err_photo_invalid' };
  }
  // JPEG magic bytes - catches empty/garbage payloads a spoofed prefix alone wouldn't.
  if (buffer.length < 2 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return { error: 'err_photo_invalid' };
  }
  if (buffer.length > MAX_PHOTO_BYTES) {
    return { error: 'err_photo_too_large' };
  }
  return { buffer, mime: 'image/jpeg' };
}
