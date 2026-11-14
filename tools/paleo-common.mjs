import fs from 'node:fs/promises';
import zlib from 'node:zlib';

// Land-mask raster size (equirectangular, 0.5° per pixel).
export const W = 720;
export const H = 360;

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Writes a greyscale PNG from a byte mask (0/1 or 0..255) for eyeballing frames. */
export async function writePng(file, mask, w, h) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const v = mask[y * w + x];
      raw[y * (w + 1) + 1 + x] = v <= 1 ? v * 255 : v;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  await fs.writeFile(file, png);
}

/** Run-length encodes a 0/1 mask: alternating run lengths starting with 0s, LEB128 varints. */
export function rleEncode(mask) {
  const out = [];
  let cur = 0, run = 0;
  const push = (n) => { while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n >>>= 7; } out.push(n); };
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === cur) run++;
    else { push(run); cur ^= 1; run = 1; }
  }
  push(run);
  return Uint8Array.from(out);
}
