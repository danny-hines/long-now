// Builds public/data/paleo.bin: a time series of 1-bit land masks for Earth.
//
//   1800 Ma → today   real plate reconstructions (see fetch-paleo.mjs)
//   4400 → 1800 Ma    procedural: the 1800 Ma cratons, drifted, warped and
//                     shrunk back toward a water world (nobody knows the map)
//   today → +250 Myr  the present continents rotated rigidly toward a rough
//                     "Pangaea Proxima" (a projection, not a prediction)
//   +250 → +1200 Myr  procedural drift of that supercontinent
//
//   node tools/pack-paleo.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { W, H, writePng, rleEncode } from './paleo-common.mjs';
import { realFrameTimes } from './fetch-paleo.mjs';
import { signedDistance } from '../src/render/edt.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(ROOT, '.cache', 'paleo');
const OUT = path.join(ROOT, '..', 'public', 'data', 'paleo.bin');
const DEG = Math.PI / 180;

// --- sphere helpers ---------------------------------------------------------
const DIRS = new Float32Array(W * H * 3);
const AREA = new Float32Array(H);
for (let y = 0; y < H; y++) {
  const lat = Math.PI / 2 - ((y + 0.5) / H) * Math.PI;
  AREA[y] = Math.cos(lat);
  for (let x = 0; x < W; x++) {
    const lon = ((x + 0.5) / W) * 2 * Math.PI - Math.PI;
    const o = (y * W + x) * 3;
    DIRS[o] = Math.cos(lat) * Math.cos(lon); DIRS[o + 1] = Math.cos(lat) * Math.sin(lon); DIRS[o + 2] = Math.sin(lat);
  }
}
const axisOf = (lonDeg, latDeg) => [Math.cos(latDeg * DEG) * Math.cos(lonDeg * DEG), Math.cos(latDeg * DEG) * Math.sin(lonDeg * DEG), Math.sin(latDeg * DEG)];
function rotate(v, a, ang, out) {
  const c = Math.cos(ang), s = Math.sin(ang), d = (a[0] * v[0] + a[1] * v[1] + a[2] * v[2]) * (1 - c);
  out[0] = v[0] * c + (a[1] * v[2] - a[2] * v[1]) * s + a[0] * d;
  out[1] = v[1] * c + (a[2] * v[0] - a[0] * v[2]) * s + a[1] * d;
  out[2] = v[2] * c + (a[0] * v[1] - a[1] * v[0]) * s + a[2] * d;
  return out;
}
function sampleField(f, v) {
  const lon = Math.atan2(v[1], v[0]), lat = Math.asin(Math.max(-1, Math.min(1, v[2])));
  let x = ((lon + Math.PI) / (2 * Math.PI)) * W - 0.5, y = ((Math.PI / 2 - lat) / Math.PI) * H - 0.5;
  y = Math.max(0, Math.min(H - 1.001, y));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const xa = ((x0 % W) + W) % W, xb = (xa + 1) % W;
  return (f[y0 * W + xa] * (1 - fx) + f[y0 * W + xb] * fx) * (1 - fy) + (f[(y0 + 1) * W + xa] * (1 - fx) + f[(y0 + 1) * W + xb] * fx) * fy;
}
function sampleMask(m, v) {
  const lon = Math.atan2(v[1], v[0]), lat = Math.asin(Math.max(-1, Math.min(1, v[2])));
  const x = Math.min(W - 1, Math.max(0, Math.floor(((lon + Math.PI) / (2 * Math.PI)) * W)));
  const y = Math.min(H - 1, Math.max(0, Math.floor(((Math.PI / 2 - lat) / Math.PI) * H)));
  return m[y * W + x];
}
function landFraction(mask) {
  let a = 0, tot = 0;
  for (let y = 0; y < H; y++) { let n = 0; for (let x = 0; x < W; x++) n += mask[y * W + x]; a += n * AREA[y]; tot += W * AREA[y]; }
  return a / tot;
}

// --- smooth 3D noise --------------------------------------------------------
function hash3(i, j, k, s) {
  let h = (i * 374761393 + j * 668265263 + k * 2147483647 + s * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise3(x, y, z, s) {
  const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
  const fx = x - i, fy = y - j, fz = z - k;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const L = (a, b, t) => a + (b - a) * t;
  return L(
    L(L(hash3(i, j, k, s), hash3(i + 1, j, k, s), u), L(hash3(i, j + 1, k, s), hash3(i + 1, j + 1, k, s), u), v),
    L(L(hash3(i, j, k + 1, s), hash3(i + 1, j, k + 1, s), u), L(hash3(i, j + 1, k + 1, s), hash3(i + 1, j + 1, k + 1, s), u), v), w) * 2 - 1;
}
function fbm(x, y, z, s, oct = 4) {
  let a = 0.5, f = 1, sum = 0;
  for (let o = 0; o < oct; o++) { sum += a * noise3(x * f, y * f, z * f, s + o * 17); a *= 0.5; f *= 2.03; }
  return sum;
}

/**
 * Procedural drift: view a source distance field through a slowly rotating,
 * slowly warping lens `dt` Myr away from it, then pick the sea level that
 * yields the wanted land fraction.
 */
function drifted(srcSdf, dt, targetFraction, seed, axis) {
  const field = new Float32Array(W * H);
  const v = [0, 0, 0], q = [0, 0, 0];
  const amp = 0.42 * (1 - Math.exp(-Math.abs(dt) / 500));
  const phase = dt * 0.0011;
  const ang = -0.085 * DEG * dt;
  for (let i = 0; i < W * H; i++) {
    v[0] = DIRS[i * 3]; v[1] = DIRS[i * 3 + 1]; v[2] = DIRS[i * 3 + 2];
    rotate(v, axis, ang, q);
    const wx = fbm(q[0] * 1.6 + phase, q[1] * 1.6, q[2] * 1.6, seed), wy = fbm(q[0] * 1.6, q[1] * 1.6 + phase, q[2] * 1.6, seed + 91), wz = fbm(q[0] * 1.6, q[1] * 1.6, q[2] * 1.6 + phase, seed + 173);
    q[0] += amp * wx; q[1] += amp * wy; q[2] += amp * wz;
    const n = Math.hypot(q[0], q[1], q[2]);
    q[0] /= n; q[1] /= n; q[2] /= n;
    field[i] = sampleField(srcSdf, q) + 5 * amp * fbm(v[0] * 5, v[1] * 5 + phase * 2, v[2] * 5, seed + 300, 3);
  }
  // Sea level by bisection on area-weighted land fraction.
  let lo = -60, hi = 60;
  const mask = new Uint8Array(W * H);
  for (let it = 0; it < 24; it++) {
    const mid = 0.5 * (lo + hi);
    for (let i = 0; i < W * H; i++) mask[i] = field[i] > mid ? 1 : 0;
    if (landFraction(mask) > targetFraction) lo = mid; else hi = mid;
  }
  return mask;
}

// --- future: rigid continental rotations toward a supercontinent -------------
function labelGroups(mask) {
  const label = new Int32Array(W * H).fill(-1);
  const groups = []; // per component: group id
  const stack = [];
  let n = 0;
  for (let start = 0; start < W * H; start++) {
    if (!mask[start] || label[start] >= 0) continue;
    let sx = 0, sy = 0, sz = 0, count = 0;
    stack.push(start); label[start] = n;
    while (stack.length) {
      const i = stack.pop();
      const x = i % W, y = (i / W) | 0;
      sx += DIRS[i * 3]; sy += DIRS[i * 3 + 1]; sz += DIRS[i * 3 + 2]; count++;
      for (const j of [y * W + ((x + 1) % W), y * W + ((x + W - 1) % W), y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
        if (j >= 0 && mask[j] && label[j] < 0) { label[j] = n; stack.push(j); }
      }
    }
    const lon = Math.atan2(sy, sx) / DEG, lat = Math.asin(sz / Math.hypot(sx, sy, sz)) / DEG;
    let g = 0; // Africa–Eurasia: the fixed reference
    if (lat < -60) g = 3; // Antarctica
    else if (lon > -170 && lon < -25) g = 1; // the Americas and Greenland
    else if ((lon > 110 && lat < -9) || (lon > 130 && lat < -1 && lat > -12)) g = 2; // Australia, New Guinea, New Zealand
    groups.push(g);
    n++;
  }
  const masks = [0, 1, 2, 3].map(() => new Uint8Array(W * H));
  for (let i = 0; i < W * H; i++) if (label[i] >= 0) masks[groups[label[i]]][i] = 1;
  return masks;
}
const FUTURE_ROT = [
  { axis: axisOf(0, 90), deg: -4 }, // Africa–Eurasia turns slightly
  { axis: axisOf(0, 90), deg: 44 }, // the Atlantic closes
  { axis: axisOf(45, 0), deg: 31 }, // Australia runs north into Asia
  { axis: axisOf(-30, 0), deg: 24 }, // Antarctica drifts toward the Indian Ocean
];
function futureFrame(groupMasks, myr) {
  const u = Math.min(1, myr / 250);
  const mask = new Uint8Array(W * H);
  const v = [0, 0, 0], q = [0, 0, 0];
  for (let i = 0; i < W * H; i++) {
    v[0] = DIRS[i * 3]; v[1] = DIRS[i * 3 + 1]; v[2] = DIRS[i * 3 + 2];
    for (let g = 0; g < 4; g++) {
      rotate(v, FUTURE_ROT[g].axis, -FUTURE_ROT[g].deg * DEG * u, q);
      if (sampleMask(groupMasks[g], q)) { mask[i] = 1; break; }
    }
  }
  return mask;
}

function fixPoles(mask) {
  // Polygons that enclose a pole can leave slivers unfilled along the map
  // edge. Within 9° of a pole, a row that is mostly land is treated as all land.
  for (let k = 0; k < 18; k++) {
    for (const y of [k, H - 1 - k]) {
      let n = 0;
      for (let x = 0; x < W; x++) n += mask[y * W + x];
      if (n > 0.3 * W) mask.fill(1, y * W, (y + 1) * W);
    }
  }
  return mask;
}

async function main() {
  const frames = []; // {t (years), mask}
  for (const ma of realFrameTimes()) {
    const buf = await fs.readFile(path.join(CACHE, `mask_${ma}.bin`));
    frames.push({ t: -ma * 1e6, mask: fixPoles(Uint8Array.from(buf)), real: true });
  }
  const oldest = frames.find((f) => f.t === -1800e6).mask;
  const today = frames.find((f) => f.t === 0).mask;

  // Deep time.
  const sdfOld = signedDistance(oldest, W, H, 60);
  const f0 = landFraction(oldest);
  const axisA = axisOf(70, 35);
  for (let ma = 1850; ma <= 4400; ma += 50) {
    const frac = f0 * Math.pow(Math.max(0, 1 - (ma - 1800) / 2650), 1.5);
    frames.push({ t: -ma * 1e6, mask: drifted(sdfOld, ma - 1800, frac, 7, axisA) });
    if (ma % 500 === 0) console.log(`${ma} Ma procedural, land ${(frac * 100).toFixed(1)}%`);
  }

  // The future.
  const groups = labelGroups(today);
  let last = today;
  for (let myr = 10; myr <= 250; myr += 10) {
    last = futureFrame(groups, myr);
    frames.push({ t: myr * 1e6, mask: last });
  }
  const sdfSuper = signedDistance(last, W, H, 60);
  const fS = landFraction(last);
  const axisB = axisOf(-40, 50);
  for (let myr = 300; myr <= 1200; myr += 50) {
    frames.push({ t: myr * 1e6, mask: drifted(sdfSuper, myr - 250, fS, 23, axisB) });
  }
  console.log(`land fraction today ${(landFraction(today) * 100).toFixed(1)}%, +250 Myr ${(fS * 100).toFixed(1)}%`);

  frames.sort((a, b) => a.t - b.t);
  const payloads = frames.map((f) => rleEncode(f.mask));
  let offset = 0;
  const header = {
    W, H,
    source: 'Cao et al. 2024 plate model via GPlates Web Service (CC BY 4.0) for 1800 Ma to present; procedural elsewhere',
    frames: frames.map((f, i) => { const e = { t: f.t, o: offset, n: payloads[i].length, real: !!f.real }; offset += payloads[i].length; return e; }),
  };
  const hj = Buffer.from(JSON.stringify(header));
  const head = Buffer.alloc(4); head.writeUInt32LE(hj.length);
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, Buffer.concat([head, hj, ...payloads.map((p) => Buffer.from(p))]));
  console.log(`${frames.length} frames → ${OUT} (${((4 + hj.length + offset) / 1024).toFixed(0)} KB)`);

  // Contact sheet for eyeballing.
  const pick = [-4000e6, -3000e6, -2200e6, -1800e6, 0, 100e6, 250e6, 700e6];
  const sheet = new Uint8Array(W * 2 * H * 4);
  pick.forEach((t, k) => {
    const f = frames.find((x) => x.t === t);
    const ox = (k % 2) * W, oy = ((k / 2) | 0) * H;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) sheet[(oy + y) * W * 2 + ox + x] = f.mask[y * W + x] ? 255 : (x === 0 || y === 0 ? 90 : 20);
  });
  await writePng(path.join(CACHE, 'sheet.png'), sheet, W * 2, H * 4);
}

main().catch((e) => { console.error(e); process.exit(1); });
