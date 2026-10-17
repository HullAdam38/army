'use strict';

/**
 * Checks uploaded pictures without an image library. inspect() works out the
 * real type from the file's bytes (never from its name or the browser's
 * claim), reads the dimensions and returns a copy with metadata removed:
 * phone photos carry EXIF data such as the GPS position they were taken at,
 * which must not end up on a public profile.
 *
 * Supported: PNG, JPEG and WebP. Everything else (GIF, SVG, HTML…) is refused.
 */

const TYPES = {
  png: { mime: 'image/png', name: 'PNG' },
  jpeg: { mime: 'image/jpeg', name: 'JPEG' },
  webp: { mime: 'image/webp', name: 'WebP' },
};

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// PNG chunks that only hold text or timestamps.
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function sniff(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

class BadImage extends Error {}
const bad = (msg = 'That file looks damaged. Try saving it again or pick another picture.') => { throw new BadImage(msg); };

function png(buf) {
  const keep = [PNG_SIG];
  let pos = 8;
  let width = 0;
  let height = 0;
  let ended = false;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + len;
    if (end > buf.length) bad();
    if (pos === 8) {
      if (type !== 'IHDR' || len < 8) bad();
      width = buf.readUInt32BE(pos + 8);
      height = buf.readUInt32BE(pos + 12);
    }
    if (!PNG_DROP.has(type)) keep.push(buf.subarray(pos, end));
    pos = end;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended || !width) bad();
  return { width, height, data: Buffer.concat(keep) };
}

// JPEG markers whose segments carry metadata rather than picture: APP1 (EXIF,
// XMP), APP3–APP13 (incl. IPTC) and APP15, plus comments. APP0 (JFIF), APP2
// (colour profile) and APP14 (Adobe colour transform) are needed to show the
// picture correctly, so they stay.
const JPEG_DROP = (m) => m === 0xe1 || (m >= 0xe3 && m <= 0xed) || m === 0xef || m === 0xfe;
const JPEG_SOF = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

function jpeg(buf) {
  const keep = [buf.subarray(0, 2)];
  let pos = 2;
  let width = 0;
  let height = 0;
  while (pos < buf.length) {
    if (buf[pos] !== 0xff) bad();
    let marker = buf[pos + 1];
    while (marker === 0xff && pos + 2 < buf.length) { pos += 1; marker = buf[pos + 1]; } // fill bytes
    if (marker === undefined) bad();
    if (marker === 0xd9) { keep.push(buf.subarray(pos, pos + 2)); pos += 2; break; } // end of image
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { keep.push(buf.subarray(pos, pos + 2)); pos += 2; continue; }
    if (pos + 4 > buf.length) bad();
    const len = buf.readUInt16BE(pos + 2);
    const end = pos + 2 + len;
    if (len < 2 || end > buf.length) bad();
    if (JPEG_SOF(marker)) {
      if (len < 7) bad();
      height = buf.readUInt16BE(pos + 5);
      width = buf.readUInt16BE(pos + 7);
    }
    if (marker === 0xda) {
      // Start of scan: the compressed picture follows to the end of the file.
      keep.push(buf.subarray(pos));
      pos = buf.length;
      break;
    }
    if (!JPEG_DROP(marker)) keep.push(buf.subarray(pos, end));
    pos = end;
  }
  if (!width || !height) bad();
  return { width, height, data: Buffer.concat(keep) };
}

function webp(buf) {
  const riffEnd = Math.min(buf.length, 8 + buf.readUInt32LE(4));
  const chunks = [];
  let pos = 12;
  let width = 0;
  let height = 0;
  let vp8x = null;
  while (pos + 8 <= riffEnd) {
    const type = buf.toString('latin1', pos, pos + 4);
    const len = buf.readUInt32LE(pos + 4);
    const dataStart = pos + 8;
    const end = dataStart + len + (len % 2);
    if (dataStart + len > buf.length) bad();
    const data = buf.subarray(dataStart, dataStart + len);
    if (type === 'VP8X') {
      if (len < 10) bad();
      width = 1 + data.readUIntLE(4, 3);
      height = 1 + data.readUIntLE(7, 3);
      vp8x = Buffer.from(data);
      vp8x[0] &= ~(0x08 | 0x04); // no EXIF or XMP any more
      chunks.push({ type, data: vp8x });
    } else if (type === 'VP8 ' && !width) {
      if (len < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) bad();
      width = data.readUInt16LE(6) & 0x3fff;
      height = data.readUInt16LE(8) & 0x3fff;
      chunks.push({ type, data });
    } else if (type === 'VP8L' && !width) {
      if (len < 5 || data[0] !== 0x2f) bad();
      width = 1 + (data[1] | ((data[2] & 0x3f) << 8));
      height = 1 + ((data[2] >> 6) | (data[3] << 2) | ((data[4] & 0x0f) << 10));
      chunks.push({ type, data });
    } else if (type !== 'EXIF' && type !== 'XMP ') {
      chunks.push({ type, data });
    }
    pos = end;
  }
  if (!width || !height) bad();
  const parts = [];
  for (const c of chunks) {
    const head = Buffer.alloc(8);
    head.write(c.type, 0, 'latin1');
    head.writeUInt32LE(c.data.length, 4);
    parts.push(head, c.data);
    if (c.data.length % 2) parts.push(Buffer.alloc(1));
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return { width, height, data: Buffer.concat([head, body]) };
}

/**
 * Checks a picture. Returns { type, mime, width, height, data } with the
 * metadata removed, or { error } in words a player understands.
 */
function inspect(buf, { maxBytes = 1024 * 1024, minSide = 32, maxSide = 4096 } = {}) {
  if (!buf || !buf.length) return { error: 'Choose a picture to upload.' };
  if (buf.length > maxBytes) return { error: `That picture is too big. The limit is ${Math.round(maxBytes / 1024)} KB.` };
  const type = sniff(buf);
  if (!type) return { error: 'Use a PNG, JPEG or WebP picture.' };
  let out;
  try {
    out = { png, jpeg, webp }[type](buf);
  } catch (err) {
    if (err instanceof BadImage) return { error: err.message };
    if (err instanceof RangeError) return { error: 'That file looks damaged. Try saving it again or pick another picture.' };
    throw err;
  }
  if (out.width < minSide || out.height < minSide) return { error: `That picture is too small. Use one at least ${minSide} × ${minSide} pixels.` };
  if (out.width > maxSide || out.height > maxSide) return { error: `That picture is too large. Use one at most ${maxSide} × ${maxSide} pixels.` };
  return { type, mime: TYPES[type].mime, width: out.width, height: out.height, data: out.data };
}

module.exports = { TYPES, inspect, sniff };
