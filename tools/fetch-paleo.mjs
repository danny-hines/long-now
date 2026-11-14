// Fetches reconstructed continental outlines from the GPlates Web Service and
// rasterises each one to a 1-bit equirectangular land mask.
//
//   node tools/fetch-paleo.mjs
//
// Raw responses and masks are cached under tools/.cache/paleo (gitignored), so
// re-running only downloads what is missing. `tools/pack-paleo.mjs` then turns
// the masks (plus procedural deep-time/future frames) into public/data/paleo.bin.
//
// Data: Cao et al. 2024 full-plate model (0–1800 Ma), served by gws.gplates.org,
// licensed CC BY 4.0. See CREDITS.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { geoEquirectangular, geoPath, geoArea } from 'd3-geo';
import { W, H, writePng } from './paleo-common.mjs';

const MODEL = 'CAO2024';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(ROOT, '.cache', 'paleo');

export function realFrameTimes() {
  const times = [];
  for (let t = 0; t <= 600; t += 10) times.push(t);
  for (let t = 620; t <= 1800; t += 20) times.push(t);
  return times;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchFrame(ma) {
  const file = path.join(CACHE, `raw_${ma}.json`);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {}
  const url = `https://gws.gplates.org/reconstruct/coastlines_low/?time=${ma}&model=${MODEL}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'paleo-bake/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const json = JSON.parse(text);
      if (!json.features?.length) throw new Error('empty feature collection');
      await fs.writeFile(file, text);
      await sleep(400);
      return json;
    } catch (err) {
      console.warn(`  ${ma} Ma attempt ${attempt} failed: ${err.message}`);
      await sleep(1500 * attempt);
    }
  }
  throw new Error(`could not fetch ${ma} Ma`);
}

// Collects projected rings from d3-geo and scanline-fills them (even-odd).
class RasterContext {
  constructor(mask) {
    this.mask = mask;
    this.rings = [];
    this.cur = null;
  }
  beginPath() { this.rings = []; this.cur = null; }
  moveTo(x, y) { this.cur = [[x, y]]; this.rings.push(this.cur); }
  lineTo(x, y) { this.cur.push([x, y]); }
  closePath() {}
  arc() {}
  fill() {
    let y0 = Infinity, y1 = -Infinity;
    for (const r of this.rings) for (const p of r) { if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    const ya = Math.max(0, Math.floor(y0)), yb = Math.min(H - 1, Math.ceil(y1));
    const xs = [];
    for (let y = ya; y <= yb; y++) {
      const sy = y + 0.5;
      xs.length = 0;
      for (const r of this.rings) {
        for (let i = 0, n = r.length; i < n; i++) {
          const a = r[i], b = r[(i + 1) % n];
          if ((a[1] <= sy && b[1] > sy) || (b[1] <= sy && a[1] > sy)) {
            xs.push(a[0] + ((sy - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
          }
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.ceil(xs[k] - 0.5)), xb = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
        for (let x = xa; x <= xb; x++) this.mask[y * W + x] = 1;
      }
    }
  }
}

export function rasterise(geojson) {
  const mask = new Uint8Array(W * H);
  const ctx = new RasterContext(mask);
  const projection = geoEquirectangular().scale(W / (2 * Math.PI)).translate([W / 2, H / 2]).precision(0.3);
  const draw = geoPath(projection, ctx);
  for (const f of geojson.features) {
    const g = f.geometry;
    if (!g || g.type !== 'Polygon') continue;
    // d3-geo treats ring winding as meaningful on the sphere; a "polygon"
    // covering more than a hemisphere is really one that is wound backwards.
    if (geoArea(g) > 2 * Math.PI) g.coordinates = g.coordinates.map((r) => r.slice().reverse());
    if (geoArea(g) > 2 * Math.PI) continue;
    ctx.beginPath();
    draw(g);
    ctx.fill();
  }
  return mask;
}

async function main() {
  await fs.mkdir(CACHE, { recursive: true });
  const times = realFrameTimes();
  let done = 0;
  for (const ma of times) {
    const out = path.join(CACHE, `mask_${ma}.bin`);
    try { await fs.access(out); done++; continue; } catch {}
    const json = await fetchFrame(ma);
    const mask = rasterise(json);
    await fs.writeFile(out, mask);
    let land = 0;
    for (let i = 0; i < mask.length; i++) land += mask[i];
    done++;
    console.log(`${ma} Ma  ${json.features.length} polygons  land px ${(100 * land / mask.length).toFixed(1)}%  (${done}/${times.length})`);
    if (ma % 100 === 0) await writePng(path.join(CACHE, `preview_${ma}.png`), mask, W, H);
  }
  console.log('all frames cached');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
