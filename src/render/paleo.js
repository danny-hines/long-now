// Earth's coastlines through time, as a texture the Earth shader can morph.
// Each frame of public/data/paleo.bin is a 1-bit land mask; here it becomes a
// signed-distance field, and the two fields bracketing the current time are
// uploaded side by side (red/green) so the shader can blend between them.
import * as THREE from 'three';
import { signedDistance, rleDecode } from './edt.js';

const RANGE = 24; // pixels of distance stored either side of the coast

export class Paleo {
  constructor() {
    this.ready = false;
    this.frames = [];
    this.cache = new Map();
    this.pair = [-1, -1];
    this.mix = 0;
    this.texture = null;
  }

  async load(url) {
    const buf = await (await fetch(url)).arrayBuffer();
    const headLen = new DataView(buf).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headLen)));
    this.W = header.W; this.H = header.H;
    this.payload = new Uint8Array(buf, 4 + headLen);
    this.frames = header.frames;
    const data = new Uint8Array(this.W * this.H * 2).fill(0);
    this.texture = new THREE.DataTexture(data, this.W, this.H, THREE.RGFormat, THREE.UnsignedByteType);
    this.texture.wrapS = THREE.RepeatWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
    this.ready = true;
    this._warm(0);
  }

  _field(i) {
    let f = this.cache.get(i);
    if (f) return f;
    const fr = this.frames[i];
    const mask = rleDecode(this.payload.subarray(fr.o, fr.o + fr.n), this.W * this.H);
    const sd = signedDistance(mask, this.W, this.H, RANGE);
    f = new Uint8Array(sd.length);
    for (let k = 0; k < sd.length; k++) f[k] = Math.max(0, Math.min(255, Math.round(127.5 + (sd[k] / RANGE) * 127.5)));
    this.cache.set(i, f);
    return f;
  }

  // Precompute fields in idle moments so scrubbing never stalls.
  _warm(i) {
    if (i >= this.frames.length) return;
    const run = (deadline) => {
      let k = i;
      do { this._field(k++); } while (k < this.frames.length && deadline && deadline.timeRemaining() > 12);
      this._warm(k);
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 400 });
    else setTimeout(() => run(null), 30);
  }

  /** Points the texture at the two frames around time t (years). Returns the blend factor. */
  update(t) {
    if (!this.ready) return 0;
    const fr = this.frames, n = fr.length;
    let lo = 0, hi = n - 1;
    if (t <= fr[0].t) { lo = hi = 0; }
    else if (t >= fr[n - 1].t) { lo = hi = n - 1; }
    else {
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (fr[mid].t <= t) lo = mid; else hi = mid; }
    }
    if (this.pair[0] !== lo || this.pair[1] !== hi) {
      const a = this._field(lo), b = this._field(hi);
      const data = this.texture.image.data;
      for (let k = 0, j = 0; k < a.length; k++, j += 2) { data[j] = a[k]; data[j + 1] = b[k]; }
      this.texture.needsUpdate = true;
      this.pair = [lo, hi];
    }
    this.mix = hi === lo ? 0 : (t - fr[lo].t) / (fr[hi].t - fr[lo].t);
    return this.mix;
  }
}
