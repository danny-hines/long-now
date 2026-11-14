// Signed distance field of a land mask on an equirectangular grid (wrapping in
// longitude). Two masks' distance fields can be blended to morph smoothly
// between coastlines at different times.
//
// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher), in pixels.

const INF = 1e20;

function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s;
    do {
      const p = v[k];
      s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
    } while (s <= z[k] && --k >= 0);
    k++;
    v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = (q - p) * (q - p) + f[p];
  }
}

function distanceTo(mask, W, H, value, pad) {
  // Squared distance from every pixel to the nearest pixel equal to `value`.
  const PW = W + 2 * pad;
  const grid = new Float64Array(PW * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < PW; x++) {
      const sx = ((x - pad) % W + W) % W;
      grid[y * PW + x] = mask[y * W + sx] === value ? 0 : INF;
    }
  }
  const n = Math.max(PW, H);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  for (let x = 0; x < PW; x++) {
    for (let y = 0; y < H; y++) f[y] = grid[y * PW + x];
    edt1d(f, H, d, v, z);
    for (let y = 0; y < H; y++) grid[y * PW + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < PW; x++) f[x] = grid[y * PW + x];
    edt1d(f, PW, d, v, z);
    for (let x = 0; x < PW; x++) grid[y * PW + x] = d[x];
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = Math.sqrt(Math.min(grid[y * PW + x + pad], 1e12));
  return out;
}

/**
 * Signed distance (pixels): positive inside land, negative over ocean,
 * clamped to ±range.
 */
export function signedDistance(mask, W, H, range = 48) {
  let any1 = false, any0 = false;
  for (let i = 0; i < mask.length; i++) { if (mask[i]) any1 = true; else any0 = true; if (any1 && any0) break; }
  const out = new Float32Array(W * H);
  if (!any1) return out.fill(-range);
  if (!any0) return out.fill(range);
  const pad = Math.min(W >> 1, range + 2);
  const toLand = distanceTo(mask, W, H, 1, pad);
  const toSea = distanceTo(mask, W, H, 0, pad);
  for (let i = 0; i < out.length; i++) {
    const d = mask[i] ? toSea[i] - 0.5 : -(toLand[i] - 0.5);
    out[i] = d > range ? range : d < -range ? -range : d;
  }
  return out;
}

/** Decodes a run-length encoded mask (alternating runs starting with 0s, LEB128 varints). */
export function rleDecode(bytes, size) {
  const mask = new Uint8Array(size);
  let pos = 0, cur = 0, i = 0;
  while (i < bytes.length && pos < size) {
    let n = 0, shift = 0, b;
    do { b = bytes[i++]; n |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    if (cur) mask.fill(1, pos, pos + n);
    pos += n; cur ^= 1;
  }
  return mask;
}
