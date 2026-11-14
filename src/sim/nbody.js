// Gravitational N-body engine for the aftermath of an intervention.
//
// Two integrators share one state:
//
//  * A Wisdom–Holman symplectic map in democratic-heliocentric coordinates.
//    Each step is an exact Kepler orbit about the Sun plus kicks from the
//    other planets, so the quiet solar system can be advanced in steps of
//    ~1/20 of the innermost orbit with no secular energy drift.
//
//  * A Gragg–Bulirsch–Stoer extrapolation integrator (adaptive step, error
//    controlled to ~1e-11) that takes over whenever the symplectic map's
//    assumptions break: planets within a few Hill radii of each other, an
//    artificial gravity well switched on, or a moon being pulled off its planet.
//
// Moons in safe orbits are "folded" into their planet (carried as an exact
// two-body ellipse) and only integrated directly when something threatens them.
//
// Collisions merge bodies (momentum-conserving), anything inside the Sun's
// tidal-capture radius is swallowed, and unbound bodies are flagged as ejected.
// The Sun's mass and radius follow the stellar-evolution model in sun.js.
import { G, ENGULF_FACTOR, KMS } from './constants.js';
import { keplerStep, stateToElements } from './kepler.js';
import { sunMass, sunRadiusAU } from './sun.js';

const K_ENC = 3.0; // switch to BS inside this many mutual Hill radii
const DT_DIV = 14; // WH steps per pericentric period of the innermost body
const BS_TOL = 1e-11;
const BS_SEQ = [2, 4, 6, 8, 10, 12, 14, 16];
const KMAX = BS_SEQ.length;
const HILL_SAFE = 0.4; // a moon is stable inside this fraction of the Hill sphere
const EJECT_FLAG_R = 150; // AU: unbound beyond this counts as ejected
const EJECT_DROP_R = 3000; // AU: stop tracking
// Output: one stream of fixed-size records per body, so that bodies caught in
// a close encounter can be sampled densely without bloating everyone else.
export const REC = 12; // [tRel, flags, parent, x,y,z,vx,vy,vz, mass, radius, mu]
// The state is relative to the parent and follows a Kepler orbit with
// gravitational parameter mu. For planets it is normally given relative to the
// barycentre of everything closer to the Sun (Jacobi-style), which keeps the
// orbit smooth between samples; during close encounters it is exactly heliocentric.
export const REC_WELL = 4; // [tRel, x, y, z] heliocentric (NaN once the well has switched off)
export const PARENT_SUN = -1;
export const PARENT_NONE = -2; // destroyed
export const PARENT_DROPPED = -3; // left the system; coasting on its last orbit
export const FLAG_BREAK = 1; // state is discontinuous here (collision, capture…)
const DENSE_DT = 0.004; // sample spacing (yr) for bodies in a deep encounter

const _el = {};
const _tmp6 = new Float64Array(6);
const _rel = new Float64Array(6);

export class NBody {
  /**
   * @param {object} o
   * @param {number} o.t0
   * @param {Array} o.bodies [{id, mass, radius, parent ('sun' or host id), state:[x,y,z,vx,vy,vz] relative to parent}]
   * @param {Array} [o.wells] [{pos:[x,y,z] heliocentric, mass, tStart, tEnd, eps}]
   */
  constructor({ t0, bodies, wells = [] }) {
    this.t0 = t0;
    this.tRel = 0;
    this.slotIds = bodies.map((b) => b.id);
    const cap = bodies.length + 1;
    this.cap = cap;
    this.n = 1;
    this.m = new Float64Array(cap);
    this.rad = new Float64Array(cap);
    this.s = new Float64Array(6 * cap); // WH: helio pos + bary vel; BS: bary pos + vel
    this.slot = new Int32Array(cap).fill(-1);
    this.host = new Int32Array(cap).fill(-1); // BS mode: index of the planet this body currently orbits
    this.origHost = new Int32Array(cap).fill(-1); // slot of the planet it started around
    this.flag = new Uint8Array(cap); // 1 = ejection reported, 2 = escape-from-host reported
    this.rvPrev = new Float64Array(cap);
    this.sats = Array.from({ length: cap }, () => []);
    this.sunExtra = 0;
    this.m[0] = sunMass(t0);
    this.events = [];
    this.out = bodies.map(() => []);
    this.wellOut = wells.map(() => []);
    this.lastT = new Float64Array(bodies.length).fill(-Infinity);
    this.dense = new Uint8Array(cap); // in a deep encounter this step
    this.near = new Uint8Array(cap); // within encounter range of another planet (BS mode)
    this.denseHold = new Uint8Array(cap);
    this.nSamples = 0;
    this.thin = 1;
    this.lastSampleT = -Infinity;
    this.steps = 0;
    this.bsSteps = 0;
    this.lastEncounter = -Infinity;

    this.wells = wells.map((w) => ({ ...w, a: w.tStart - t0, b: w.tEnd - t0, eps: w.eps ?? 0.02, x: 0, y: 0, z: 0, placed: false }));

    // Heliocentric bodies first (Sun at the origin for now) …
    const index = {};
    bodies.forEach((b, slot) => {
      if (b.parent && b.parent !== 'sun') return;
      const i = this.n++;
      index[b.id] = i;
      this.m[i] = b.mass; this.rad[i] = b.radius; this.slot[i] = slot;
      for (let k = 0; k < 6; k++) this.s[6 * i + k] = b.state[k];
    });
    this.mode = 'bs';
    this._fromInterior();
    this._recentre();
    // … then satellites, folded into their host when it is safe to do so.
    bodies.forEach((b, slot) => {
      if (!b.parent || b.parent === 'sun') return;
      const h = index[b.parent];
      if (h === undefined) return;
      const sat = { slot, mass: b.mass, radius: b.radius, rel: Float64Array.from(b.state), tEpoch: 0, origHost: this.slot[h] };
      // The host's given state is taken as the pair's barycentre.
      this.m[h] += b.mass;
      this.sats[h].push(sat);
      this._describeSat(h, sat);
    });
    for (let h = 1; h < this.n; h++) {
      for (const sat of this.sats[h].slice()) {
        if (!this._satSafe(h, sat, 1)) this._unfold(h, sat);
      }
    }
    this._recentre();
    this.H = 0.002;
    this.dt = 0.005;
    this._placeWells();
    if (this._wantWH()) this._enterWH();
    this.emit(FLAG_BREAK);
  }

  get t() { return this.t0 + this.tRel; }

  // --- frame helpers -------------------------------------------------------

  /**
   * Initial planet states are mean orbits, i.e. each is relative to the
   * barycentre of the Sun plus everything inside it. Convert to true positions.
   */
  _fromInterior() {
    const { s, m, n } = this;
    const order = [];
    for (let i = 1; i < n; i++) order.push(i);
    const r2 = (i) => s[6 * i] ** 2 + s[6 * i + 1] ** 2 + s[6 * i + 2] ** 2;
    order.sort((a, b) => r2(a) - r2(b));
    let M = m[0];
    const C = [0, 0, 0, 0, 0, 0];
    for (const i of order) {
      const o = 6 * i;
      const scale = Math.sqrt((M + m[i]) / (m[0] + m[i]));
      for (let k = 0; k < 3; k++) { s[o + k] += C[k] / M; s[o + 3 + k] = s[o + 3 + k] * scale + C[3 + k] / M; }
      for (let k = 0; k < 6; k++) C[k] += m[i] * s[o + k];
      M += m[i];
    }
  }

  /**
   * State of body i (or of the barycentre of i and the moons orbiting it)
   * relative to the barycentre of the Sun and everything closer in. Writes the
   * 6-vector to out and returns the matching gravitational parameter.
   */
  _interior(i, out) {
    const { s, m, n } = this;
    const wh = this.mode === 'wh';
    if (wh && !this._v0ok) { this._sunVelocity(this._v0 || (this._v0 = [0, 0, 0])); this._v0ok = true; }
    const X0 = wh ? 0 : s[0], Y0 = wh ? 0 : s[1], Z0 = wh ? 0 : s[2];
    const U0 = wh ? this._v0[0] : s[3], V0 = wh ? this._v0[1] : s[4], W0 = wh ? this._v0[2] : s[5];
    // Group = body i plus unfolded moons bound to it.
    let gm = m[i];
    const o = 6 * i;
    let g0 = m[i] * s[o], g1 = m[i] * s[o + 1], g2 = m[i] * s[o + 2], g3 = m[i] * s[o + 3], g4 = m[i] * s[o + 4], g5 = m[i] * s[o + 5];
    if (!wh) {
      for (let k = 1; k < n; k++) {
        if (this.host[k] !== i) continue;
        const p = 6 * k, mk = m[k];
        gm += mk; g0 += mk * s[p]; g1 += mk * s[p + 1]; g2 += mk * s[p + 2]; g3 += mk * s[p + 3]; g4 += mk * s[p + 4]; g5 += mk * s[p + 5];
      }
    }
    g0 /= gm; g1 /= gm; g2 /= gm; g3 /= gm; g4 /= gm; g5 /= gm;
    const ri2 = (g0 - X0) ** 2 + (g1 - Y0) ** 2 + (g2 - Z0) ** 2;
    let M = m[0], c0 = M * X0, c1 = M * Y0, c2 = M * Z0, c3 = M * U0, c4 = M * V0, c5 = M * W0;
    for (let j = 1; j < n; j++) {
      if (j === i || (!wh && this.host[j] === i)) continue;
      const p = 6 * j;
      const rj2 = (s[p] - X0) ** 2 + (s[p + 1] - Y0) ** 2 + (s[p + 2] - Z0) ** 2;
      if (rj2 >= ri2) continue;
      const mj = m[j];
      M += mj; c0 += mj * s[p]; c1 += mj * s[p + 1]; c2 += mj * s[p + 2]; c3 += mj * s[p + 3]; c4 += mj * s[p + 4]; c5 += mj * s[p + 5];
    }
    out[0] = g0 - c0 / M; out[1] = g1 - c1 / M; out[2] = g2 - c2 / M;
    out[3] = g3 - c3 / M; out[4] = g4 - c4 / M; out[5] = g5 - c5 / M;
    return G * (M + gm);
  }

  _recentre() {
    const { s, m, n } = this;
    let M = 0, cx = 0, cy = 0, cz = 0, ux = 0, uy = 0, uz = 0;
    for (let i = 0; i < n; i++) {
      const o = 6 * i, mi = m[i];
      M += mi; cx += mi * s[o]; cy += mi * s[o + 1]; cz += mi * s[o + 2];
      ux += mi * s[o + 3]; uy += mi * s[o + 4]; uz += mi * s[o + 5];
    }
    cx /= M; cy /= M; cz /= M; ux /= M; uy /= M; uz /= M;
    for (let i = 0; i < n; i++) {
      const o = 6 * i;
      s[o] -= cx; s[o + 1] -= cy; s[o + 2] -= cz; s[o + 3] -= ux; s[o + 4] -= uy; s[o + 5] -= uz;
    }
    for (const w of this.wells) if (w.placed) { w.x -= cx; w.y -= cy; w.z -= cz; }
  }

  _enterWH() {
    // barycentric -> democratic heliocentric (positions relative to the Sun)
    this._recentre();
    const { s, n } = this;
    const x0 = s[0], y0 = s[1], z0 = s[2];
    for (let i = 1; i < n; i++) { const o = 6 * i; s[o] -= x0; s[o + 1] -= y0; s[o + 2] -= z0; }
    s[0] = s[1] = s[2] = 0;
    this.mode = 'wh';
    this.near.fill(0); this.denseHold.fill(0); this.host.fill(-1);
    this._setDt(this._chooseDt());
    this._updateThresholds();
    for (let i = 1; i < n; i++) { const o = 6 * i; this.rvPrev[i] = s[o] * s[o + 3] + s[o + 1] * s[o + 4] + s[o + 2] * s[o + 5]; }
  }

  _sunVelocity(out) {
    // In DH coordinates the Sun's barycentric velocity is fixed by momentum conservation.
    const { s, m, n } = this;
    let px = 0, py = 0, pz = 0;
    for (let i = 1; i < n; i++) { const o = 6 * i, mi = m[i]; px += mi * s[o + 3]; py += mi * s[o + 4]; pz += mi * s[o + 5]; }
    out[0] = -px / m[0]; out[1] = -py / m[0]; out[2] = -pz / m[0];
  }

  _enterBS() {
    const { s, m, n } = this;
    const v0 = [0, 0, 0];
    this._sunVelocity(v0);
    let M = m[0], cx = 0, cy = 0, cz = 0;
    for (let i = 1; i < n; i++) { const o = 6 * i, mi = m[i]; M += mi; cx += mi * s[o]; cy += mi * s[o + 1]; cz += mi * s[o + 2]; }
    const x0 = -cx / M, y0 = -cy / M, z0 = -cz / M;
    for (let i = 1; i < n; i++) { const o = 6 * i; s[o] += x0; s[o + 1] += y0; s[o + 2] += z0; }
    s[0] = x0; s[1] = y0; s[2] = z0; s[3] = v0[0]; s[4] = v0[1]; s[5] = v0[2];
    this.mode = 'bs';
    this.H = Math.min(this.H, this.dt);
    this.bsSince = this.tRel;
  }

  /** Heliocentric position and velocity of body i, in either mode. */
  _helio(i, out) {
    const { s } = this, o = 6 * i;
    if (this.mode === 'wh') {
      if (!this._v0ok) { this._sunVelocity(this._v0 || (this._v0 = [0, 0, 0])); this._v0ok = true; }
      const v0 = this._v0;
      out[0] = s[o]; out[1] = s[o + 1]; out[2] = s[o + 2];
      out[3] = s[o + 3] - v0[0]; out[4] = s[o + 4] - v0[1]; out[5] = s[o + 5] - v0[2];
    } else {
      for (let k = 0; k < 6; k++) out[k] = s[o + k] - s[k];
    }
    return out;
  }

  _sunReach() { return ENGULF_FACTOR * sunRadiusAU(this.t); }

  // --- wells ---------------------------------------------------------------

  _placeWells() {
    // Wells are pinned in the inertial frame at the moment they switch on.
    const t = this.tRel;
    for (const w of this.wells) {
      if (!w.placed && t >= w.a - 1e-9 && t < w.b - 1e-9) {
        const sx = this.mode === 'wh' ? 0 : this.s[0], sy = this.mode === 'wh' ? 0 : this.s[1], sz = this.mode === 'wh' ? 0 : this.s[2];
        w.x = sx + w.pos[0]; w.y = sy + w.pos[1]; w.z = sz + w.pos[2];
        w.placed = true;
      }
    }
  }
  _wellActive(w, t) { return w.placed && t >= w.a - 1e-9 && t < w.b - 1e-9; }
  _anyWellActive() { const t = this.tRel; for (const w of this.wells) if (this._wellActive(w, t)) return true; return false; }
  /** Next time (relative) at which a well switches on or off. */
  _nextWellEdge() {
    let e = Infinity;
    const t = this.tRel;
    for (const w of this.wells) {
      if (w.a > t + 1e-9) e = Math.min(e, w.a);
      else if (w.b > t + 1e-9) e = Math.min(e, w.b);
    }
    return e;
  }

  // --- satellites ----------------------------------------------------------

  _describeSat(h, sat) {
    stateToElements(sat.rel, 0, G * this.m[h], _el);
    sat.bound = _el.bound; sat.q = _el.q; sat.Q = _el.Q;
  }

  /** Is this (folded or candidate) satellite orbit safe to treat as an isolated ellipse? */
  _satSafe(h, sat, margin, lookahead = 0) {
    if (!sat.bound) return false;
    if (sat.q < 1.3 * (this.rad[h] + sat.radius)) return false;
    const { s, m, n } = this, o = 6 * h;
    const wh = this.mode === 'wh';
    const sx = wh ? 0 : s[0], sy = wh ? 0 : s[1], sz = wh ? 0 : s[2];
    const hx = s[o] - sx, hy = s[o + 1] - sy, hz = s[o + 2] - sz;
    const r = Math.sqrt(hx * hx + hy * hy + hz * hz);
    const Q = sat.Q * margin;
    if (Q > HILL_SAFE * r * Math.cbrt(m[h] / (3 * m[0]))) return false;
    const lim = 3.5 * Q;
    for (let j = 1; j < n; j++) {
      if (j === h || this.slot[j] === sat.slot) continue;
      const p = 6 * j;
      const dx = s[p] - s[o], dy = s[p + 1] - s[o + 1], dz = s[p + 2] - s[o + 2];
      let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (lookahead > 0) {
        const rdot = (dx * (s[p + 3] - s[o + 3]) + dy * (s[p + 4] - s[o + 4]) + dz * (s[p + 5] - s[o + 5])) / d;
        if (rdot < 0) d += rdot * lookahead;
      }
      if (d < lim) return false;
      if (m[j] > 1e-3 * m[h] && Q > 0.33 * d * Math.cbrt(m[h] / (3 * m[j]))) return false;
    }
    const t = this.tRel;
    for (const w of this.wells) {
      if (!(t + lookahead >= w.a - 1e-9 && t < w.b - 1e-9)) continue;
      const wx = w.placed ? w.x - sx : w.pos[0], wy = w.placed ? w.y - sy : w.pos[1], wz = w.placed ? w.z - sz : w.pos[2];
      const d = Math.sqrt((wx - hx) ** 2 + (wy - hy) ** 2 + (wz - hz) ** 2);
      if (d < lim || Q > 0.33 * d * Math.cbrt(m[h] / (3 * w.mass))) return false;
    }
    return true;
  }

  /** Turns a folded satellite into a directly-integrated body. Requires/enters BS mode. */
  _unfold(h, sat) {
    if (this.mode === 'wh') this._enterBS();
    const { s, m } = this;
    keplerStep(sat.rel, 0, G * m[h], this.tRel - sat.tEpoch, _rel, 0);
    const f = sat.mass / m[h];
    const i = this.n++;
    const o = 6 * h, p = 6 * i;
    for (let k = 0; k < 6; k++) {
      s[p + k] = s[o + k] + (1 - f) * _rel[k];
      s[o + k] -= f * _rel[k];
    }
    m[h] -= sat.mass;
    m[i] = sat.mass; this.rad[i] = sat.radius; this.slot[i] = sat.slot;
    this.host[i] = h; this.origHost[i] = sat.origHost; this.flag[i] = 0; this.sats[i] = [];
    this.sats[h].splice(this.sats[h].indexOf(sat), 1);
    this._emitIndex(h, FLAG_BREAK);
    this._emitIndex(i, FLAG_BREAK);
  }

  /** Folds body i into host h as a satellite (if its orbit is safe). */
  _tryFold(i, h) {
    if (this.sats[i].length) return false;
    const { s, m } = this, o = 6 * h, p = 6 * i;
    for (let k = 0; k < 6; k++) _rel[k] = s[p + k] - s[o + k];
    const sat = { slot: this.slot[i], mass: m[i], radius: this.rad[i], rel: Float64Array.from(_rel), tEpoch: this.tRel, origHost: this.origHost[i] };
    const mh = m[h];
    m[h] = mh + m[i]; // provisional, for the two-body parameter
    this._describeSat(h, sat);
    const ok = this._satSafe(h, sat, 1.35);
    if (!ok) { m[h] = mh; return false; }
    const f = sat.mass / m[h];
    for (let k = 0; k < 6; k++) s[o + k] += f * _rel[k]; // host becomes the pair's barycentre
    this.sats[h].push(sat);
    if (sat.origHost !== this.slot[h]) {
      this.events.push({ t: this.t, type: 'captured', a: this.slotIds[sat.slot], b: this.slotIds[this.slot[h]] });
      sat.origHost = this.slot[h];
    }
    this._remove(i);
    for (let k = 1; k < this.n; k++) if (this.sats[k].includes(sat)) this._emitIndex(k, FLAG_BREAK);
    return true;
  }

  _remove(i) {
    const last = --this.n;
    if (i !== last) {
      const { s } = this;
      for (let k = 0; k < 6; k++) s[6 * i + k] = s[6 * last + k];
      this.m[i] = this.m[last]; this.rad[i] = this.rad[last]; this.slot[i] = this.slot[last];
      this.host[i] = this.host[last]; this.origHost[i] = this.origHost[last]; this.flag[i] = this.flag[last];
      this.rvPrev[i] = this.rvPrev[last]; this.near[i] = this.near[last]; this.denseHold[i] = this.denseHold[last];
      this.sats[i] = this.sats[last];
    }
    this.sats[last] = [];
    for (let k = 1; k < this.n; k++) {
      if (this.host[k] === i) this.host[k] = -1;
      else if (this.host[k] === last) this.host[k] = i;
    }
    this._thrStale = true;
  }

  // --- collisions and removal ---------------------------------------------

  _loseSats(i, type, other) {
    for (const sat of this.sats[i]) {
      this.events.push({ t: this.t, type, a: this.slotIds[sat.slot], b: other, withHost: this.slotIds[this.slot[i]] });
      this._emitGone(sat.slot, PARENT_NONE);
    }
    this.sats[i] = [];
  }

  _sunImpact(i) {
    this._emitIndex(i, 0, true);
    const giant = sunRadiusAU(this.t) > 0.03;
    const id = this.slotIds[this.slot[i]];
    const hp = this._helio(i, _tmp6);
    this.events.push({ t: this.t, type: giant ? 'engulfed' : 'sunImpact', a: id, speed: Math.hypot(hp[3], hp[4], hp[5]) / KMS });
    this._loseSats(i, giant ? 'engulfed' : 'sunImpact', undefined);
    if (this.mode === 'bs') {
      const { s, m } = this, o = 6 * i, M = m[0] + m[i];
      for (let k = 0; k < 6; k++) s[k] = (m[0] * s[k] + m[i] * s[o + k]) / M;
    }
    this.sunExtra += this.m[i];
    this.m[0] += this.m[i];
    this._emitGone(this.slot[i], PARENT_NONE);
    this._remove(i);
    this._afterTopologyChange(-1);
  }

  _merge(i, j) {
    // i, j >= 1; the heavier body survives.
    if (this.m[j] > this.m[i]) { const k = i; i = j; j = k; }
    this._emitIndex(i, 0, true);
    this._emitIndex(j, 0, true);
    const { s, m } = this, o = 6 * i, p = 6 * j;
    const speed = Math.hypot(s[o + 3] - s[p + 3], s[o + 4] - s[p + 4], s[o + 5] - s[p + 5]);
    const M = m[i] + m[j];
    const a = this.slotIds[this.slot[i]], b = this.slotIds[this.slot[j]];
    for (let k = 0; k < 6; k++) s[o + k] = (m[i] * s[o + k] + m[j] * s[p + k]) / M;
    this.events.push({ t: this.t, type: 'collision', a, b, speed: speed / KMS, massA: m[i], massB: m[j] });
    this._loseSats(j, 'collision', a);
    this._loseSats(i, 'collision', a);
    this.rad[i] = Math.cbrt(this.rad[i] ** 3 + this.rad[j] ** 3);
    m[i] = M;
    const survivor = this.slot[i];
    this._emitGone(this.slot[j], PARENT_NONE);
    this._remove(j);
    this._afterTopologyChange(survivor);
  }

  _afterTopologyChange(survivorSlot) {
    this._v0ok = false;
    this._thrStale = true;
    for (let k = 1; k < this.n; k++) if (this.slot[k] === survivorSlot) this._emitIndex(k, FLAG_BREAK, true);
  }

  // --- Wisdom–Holman -------------------------------------------------------

  /**
   * WH step: a fixed fraction of the shortest orbital period. Very eccentric
   * orbits are resolved only down to a/4; inside the matching radius (rcrit)
   * the adaptive integrator handles the pericentre passage instead.
   */
  _chooseDt() {
    let best = Infinity;
    const mu = G * this.m[0];
    const reach = this._sunReach();
    this._v0ok = false;
    for (let i = 1; i < this.n; i++) {
      const hp = this._helio(i, _tmp6);
      stateToElements(hp, 0, mu, _el);
      const floor = _el.bound ? 0.25 * _el.a : 0.5 * Math.sqrt(hp[0] * hp[0] + hp[1] * hp[1] + hp[2] * hp[2]);
      const q = Math.max(_el.q, floor, reach);
      const p = 2 * Math.PI * Math.sqrt(q * q * q / mu);
      if (p < best) best = p;
    }
    return Math.min(best / DT_DIV, 50);
  }

  _rcrit(dt) {
    // Radius at which the local orbital period is only ~10 steps long.
    return Math.cbrt(G * this.m[0] * (0.7 * DT_DIV * dt / (2 * Math.PI)) ** 2);
  }

  _setDt(dt) {
    this.dt = dt;
    const rc = this._rcrit(dt);
    this.rcrit2 = rc * rc;
  }

  _updateThresholds() {
    const { s, m, n, cap } = this;
    if (!this.thr2 || this.thr2.length < cap * cap) { this.thr2 = new Float64Array(cap * cap); this.fine = new Float64Array(cap * cap); }
    const m0 = this.m[0];
    for (let i = 1; i < n; i++) {
      const o = 6 * i;
      const ri = Math.hypot(s[o], s[o + 1], s[o + 2]), vi = Math.hypot(s[o + 3], s[o + 4], s[o + 5]);
      const hi = ri * Math.cbrt(m[i] / (3 * m0));
      for (let j = i + 1; j < n; j++) {
        const p = 6 * j;
        const rj = Math.hypot(s[p], s[p + 1], s[p + 2]), vj = Math.hypot(s[p + 3], s[p + 4], s[p + 5]);
        const hj = rj * Math.cbrt(m[j] / (3 * m0));
        const fine = K_ENC * (hi + hj) + 6 * (this.rad[i] + this.rad[j]);
        const coarse = fine + 1.6 * this.dt * (vi + vj);
        this.fine[i * cap + j] = fine;
        this.thr2[i * cap + j] = coarse * coarse;
      }
    }
    this._thrStale = false;
  }

  _kick(h) {
    const { s, m, n, cap, thr2 } = this;
    let close = false;
    for (let i = 1; i < n; i++) {
      const o = 6 * i, mi = G * m[i];
      const xi = s[o], yi = s[o + 1], zi = s[o + 2];
      let ax = 0, ay = 0, az = 0;
      for (let j = i + 1; j < n; j++) {
        const p = 6 * j;
        const dx = s[p] - xi, dy = s[p + 1] - yi, dz = s[p + 2] - zi;
        const r2 = dx * dx + dy * dy + dz * dz;
        const inv = h / (r2 * Math.sqrt(r2));
        const mj = G * m[j];
        ax += mj * dx * inv; ay += mj * dy * inv; az += mj * dz * inv;
        s[p + 3] -= mi * dx * inv; s[p + 4] -= mi * dy * inv; s[p + 5] -= mi * dz * inv;
        if (r2 < thr2[i * cap + j]) {
          const d = Math.sqrt(r2);
          const rdot = (dx * (s[p + 3] - s[o + 3]) + dy * (s[p + 4] - s[o + 4]) + dz * (s[p + 5] - s[o + 5])) / d;
          if (d + Math.min(0, rdot) * 1.6 * this.dt < this.fine[i * cap + j]) close = true;
        }
      }
      s[o + 3] += ax; s[o + 4] += ay; s[o + 5] += az;
    }
    return close;
  }

  _jump(h) {
    const { s, m, n } = this;
    let px = 0, py = 0, pz = 0;
    for (let i = 1; i < n; i++) { const o = 6 * i, mi = m[i]; px += mi * s[o + 3]; py += mi * s[o + 4]; pz += mi * s[o + 5]; }
    const f = h / m[0];
    px *= f; py *= f; pz *= f;
    for (let i = 1; i < n; i++) { const o = 6 * i; s[o] += px; s[o + 1] += py; s[o + 2] += pz; }
  }

  _whStep() {
    const { s } = this;
    const dt = this.dt, h = 0.5 * dt;
    const mu = G * this.m[0];
    this._kick(h);
    this._jump(h);
    for (let i = 1; i < this.n; i++) keplerStep(s, 6 * i, mu, dt, s, 6 * i);
    this._jump(h);
    const close = this._kick(h);
    this.tRel += dt;
    this.m[0] = sunMass(this.t) + this.sunExtra;
    this._v0ok = false;
    this.steps++;

    // The Sun: direct hits, and perihelion passages inside its reach.
    const reach = this._sunReach();
    let deep = false;
    for (let i = 1; i < this.n; i++) {
      const o = 6 * i;
      const r2 = s[o] * s[o] + s[o + 1] * s[o + 1] + s[o + 2] * s[o + 2];
      const rv = s[o] * s[o + 3] + s[o + 1] * s[o + 4] + s[o + 2] * s[o + 5];
      if (r2 < this.rcrit2) deep = true;
      let hit = r2 < (reach + this.rad[i]) ** 2;
      if (!hit && this.rvPrev[i] < 0 && rv >= 0 && r2 < 400 * reach * reach) {
        stateToElements(this._helio(i, _tmp6), 0, mu, _el);
        hit = _el.q < reach + this.rad[i];
      }
      this.rvPrev[i] = rv;
      if (hit) { this._sunImpact(i); i--; }
    }

    if ((this.steps & 31) === 0 || this._thrStale) {
      this._updateThresholds();
      this._checkEjections();
      if ((this.steps & 255) === 0) {
        const dtNew = this._chooseDt();
        if (dtNew < this.dt * 0.9 || dtNew > this.dt * 1.25) { this._setDt(dtNew); this._updateThresholds(); }
      }
    }
    // Folded moons: is anything about to disturb them?
    if ((this.steps & 3) === 0) {
      let pending = null;
      for (let h = 1; h < this.n; h++) {
        for (const sat of this.sats[h]) {
          if (!this._satSafe(h, sat, 1, 5 * dt)) (pending || (pending = [])).push([h, sat]);
        }
      }
      if (pending) {
        this._enterBS();
        for (const [h, sat] of pending) this._unfold(h, sat); // unfolding only appends, so h stays valid
        return;
      }
    }
    if (close || deep || this._nextWellEdge() <= this.tRel + dt) this._enterBS();
  }

  _checkEjections() {
    const mu0 = G * this.m[0];
    for (let i = 1; i < this.n; i++) {
      const hp = this._helio(i, _tmp6);
      const r = Math.hypot(hp[0], hp[1], hp[2]);
      if (r < EJECT_FLAG_R) continue;
      const v2 = hp[3] * hp[3] + hp[4] * hp[4] + hp[5] * hp[5];
      const energy = 0.5 * v2 - (mu0 + G * this.m[i]) / r;
      const id = this.slotIds[this.slot[i]];
      if (energy > 0 && !(this.flag[i] & 1)) {
        this.flag[i] |= 1;
        this._emitIndex(i, 0);
        this.events.push({ t: this.t, type: 'ejected', a: id, speed: Math.sqrt(2 * energy) / KMS });
        for (const sat of this.sats[i]) this.events.push({ t: this.t, type: 'ejected', a: this.slotIds[sat.slot], withHost: id });
      }
      if (r > EJECT_DROP_R) {
        if (!(this.flag[i] & 1)) {
          this.events.push({ t: this.t, type: 'ejected', a: id, speed: 0, bound: true });
          for (const sat of this.sats[i]) this.events.push({ t: this.t, type: 'ejected', a: this.slotIds[sat.slot], withHost: id, bound: true });
        }
        this._emitIndex(i, 0);
        this._emitGone(this.slot[i], PARENT_DROPPED);
        for (const sat of this.sats[i]) this._emitGone(sat.slot, PARENT_DROPPED);
        const wasWH = this.mode === 'wh';
        this._remove(i); i--;
        this._v0ok = false;
        if (wasWH) { this._setDt(this._chooseDt()); this._updateThresholds(); }
      }
    }
  }

  // --- Bulirsch–Stoer ------------------------------------------------------

  _accel(y, f, t) {
    // y = [x,v] per body (6 each); f = dy/dt.
    const { m, n } = this;
    for (let i = 0; i < n; i++) { const o = 6 * i; f[o] = y[o + 3]; f[o + 1] = y[o + 4]; f[o + 2] = y[o + 5]; f[o + 3] = 0; f[o + 4] = 0; f[o + 5] = 0; }
    for (let i = 0; i < n; i++) {
      const o = 6 * i, mi = G * m[i];
      const xi = y[o], yi = y[o + 1], zi = y[o + 2];
      let ax = 0, ay = 0, az = 0;
      for (let j = i + 1; j < n; j++) {
        const p = 6 * j;
        const dx = y[p] - xi, dy = y[p + 1] - yi, dz = y[p + 2] - zi;
        const r2 = dx * dx + dy * dy + dz * dz;
        const inv = 1 / (r2 * Math.sqrt(r2));
        const mj = G * m[j];
        ax += mj * dx * inv; ay += mj * dy * inv; az += mj * dz * inv;
        f[p + 3] -= mi * dx * inv; f[p + 4] -= mi * dy * inv; f[p + 5] -= mi * dz * inv;
      }
      f[o + 3] += ax; f[o + 4] += ay; f[o + 5] += az;
    }
    for (const w of this.wells) {
      if (!this._wellActive(w, t)) continue;
      const gm = G * w.mass, e2 = w.eps * w.eps;
      for (let i = 0; i < n; i++) {
        const o = 6 * i;
        const dx = w.x - y[o], dy = w.y - y[o + 1], dz = w.z - y[o + 2];
        const r2 = dx * dx + dy * dy + dz * dz + e2;
        const inv = gm / (r2 * Math.sqrt(r2));
        f[o + 3] += dx * inv; f[o + 4] += dy * inv; f[o + 5] += dz * inv;
      }
    }
  }

  _bsAlloc() {
    const D = 6 * this.cap;
    if (this._bs && this._bs.D === D) return this._bs;
    const mk = () => new Float64Array(D);
    return (this._bs = { D, y0: mk(), f0: mk(), za: mk(), zb: mk(), f: mk(), yk: mk(), sc: mk(), tab: Array.from({ length: KMAX }, mk) });
  }

  /** One adaptive BS step. Returns the step actually taken. */
  _bsStep(Hmax) {
    const b = this._bsAlloc();
    const { s, n } = this;
    const D = 6 * n;
    const { y0, f0, za, zb, f, yk, sc, tab } = b;
    const tMid = this.tRel;
    for (let i = 0; i < D; i++) y0[i] = s[i];
    this._accel(y0, f0, tMid);
    let H = Math.min(this.H, Hmax);
    for (let attempt = 0; attempt < 40; attempt++) {
      // Error scale: per-body size of position / velocity.
      for (let i = 0; i < n; i++) {
        const o = 6 * i;
        const vv = Math.hypot(y0[o + 3], y0[o + 4], y0[o + 5]);
        const aa = Math.hypot(f0[o + 3], f0[o + 4], f0[o + 5]);
        const ps = Math.hypot(y0[o], y0[o + 1], y0[o + 2]) + vv * H + 1e-9;
        const vs = vv + aa * H + 1e-9;
        sc[o] = sc[o + 1] = sc[o + 2] = ps; sc[o + 3] = sc[o + 4] = sc[o + 5] = vs;
      }
      let converged = -1;
      for (let k = 0; k < KMAX; k++) {
        const ns = BS_SEQ[k], h = H / ns;
        // Modified midpoint.
        for (let i = 0; i < D; i++) { za[i] = y0[i]; zb[i] = y0[i] + h * f0[i]; }
        let zm = za, zn = zb;
        for (let step = 1; step < ns; step++) {
          this._accel(zn, f, tMid);
          for (let i = 0; i < D; i++) zm[i] += 2 * h * f[i];
          const sw = zm; zm = zn; zn = sw;
        }
        this._accel(zn, f, tMid);
        for (let i = 0; i < D; i++) yk[i] = 0.5 * (zn[i] + zm[i] + h * f[i]);
        // Polynomial extrapolation in h².
        let err = 0;
        if (k === 0) { for (let i = 0; i < D; i++) tab[0][i] = yk[i]; continue; }
        for (let i = 0; i < D; i++) {
          let c = yk[i];
          for (let j = 1; j <= k; j++) {
            const prev = tab[j - 1][i];
            tab[j - 1][i] = c;
            const ratio = ns / BS_SEQ[k - j];
            c = c + (c - prev) / (ratio * ratio - 1);
          }
          const e = Math.abs(c - tab[k - 1][i]) / sc[i];
          if (e > err) err = e;
          tab[k][i] = c;
        }
        if (k >= 2 && err < BS_TOL) { converged = k; break; }
      }
      if (converged >= 0 || H < 1e-9) {
        const res = tab[converged >= 0 ? converged : KMAX - 1];
        for (let i = 0; i < D; i++) s[i] = res[i];
        this.tRel += H;
        this.H = converged >= 0 && converged <= 4 ? H * 1.5 : converged >= 7 ? H * 0.6 : converged === 6 ? H * 0.85 : H * 1.1;
        this.m[0] = sunMass(this.t) + this.sunExtra;
        this.bsSteps++; this.steps++;
        return H;
      }
      H *= 0.4;
    }
    throw new Error('Bulirsch–Stoer step failed to converge');
  }

  _bsAdvance() {
    const b = this._bsAlloc();
    const edge = this._nextWellEdge();
    const Hmax = Math.min(edge - this.tRel, 25);
    const H = this._bsStep(Hmax);
    if (edge - this.tRel <= 1e-9) { this.tRel = edge; this._placeWells(); }
    const { s, m, n } = this;
    const y0 = b.y0;
    const reach = this._sunReach();

    // Collisions: check the end state and, for fast fly-throughs, a Hermite
    // interpolant of the relative motion across the step.
    let hitI = -1, hitJ = -1;
    outer: for (let i = 0; i < n; i++) {
      const o = 6 * i;
      const Ri = i === 0 ? reach : this.rad[i];
      for (let j = i + 1; j < n; j++) {
        const p = 6 * j;
        const R = Ri + this.rad[j];
        const dx = s[p] - s[o], dy = s[p + 1] - s[o + 1], dz = s[p + 2] - s[o + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < R * R) { hitI = i; hitJ = j; break outer; }
        const wx = s[p + 3] - s[o + 3], wy = s[p + 4] - s[o + 4], wz = s[p + 5] - s[o + 5];
        const reachStep = Math.sqrt(wx * wx + wy * wy + wz * wz) * H;
        if (d2 < (R + reachStep) * (R + reachStep)) {
          const ax = y0[p] - y0[o], ay = y0[p + 1] - y0[o + 1], az = y0[p + 2] - y0[o + 2];
          const ux = (y0[p + 3] - y0[o + 3]) * H, uy = (y0[p + 4] - y0[o + 4]) * H, uz = (y0[p + 5] - y0[o + 5]) * H;
          for (let q = 1; q < 12; q++) {
            const u = q / 12, u2 = u * u, u3 = u2 * u;
            const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
            const cx = h00 * ax + h10 * ux + h01 * dx + h11 * wx * H;
            const cy = h00 * ay + h10 * uy + h01 * dy + h11 * wy * H;
            const cz = h00 * az + h10 * uz + h01 * dz + h11 * wz * H;
            if (cx * cx + cy * cy + cz * cz < R * R) { hitI = i; hitJ = j; break outer; }
          }
        }
      }
    }
    if (hitI === 0) { this._sunImpact(hitJ); return; }
    if (hitI > 0) { this._merge(hitI, hitJ); return; }

    // Hosts, folding, and whether we still need this integrator.
    if ((this.bsSteps & 3) === 0) {
      const m0 = m[0];
      for (let i = 1; i < n; i++) { this.host[i] = -1; this.near[i] = 0; this.denseHold[i] = 0; }
      for (let i = 1; i < this.n; i++) {
        const o = 6 * i;
        const ri = Math.hypot(s[o] - s[0], s[o + 1] - s[1], s[o + 2] - s[2]);
        const hi = ri * Math.cbrt(m[i] / (3 * m0));
        for (let j = i + 1; j < this.n; j++) {
          const p = 6 * j;
          const dx = s[p] - s[o], dy = s[p + 1] - s[o + 1], dz = s[p + 2] - s[o + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const rj = Math.hypot(s[p] - s[0], s[p + 1] - s[1], s[p + 2] - s[2]);
          const hj = rj * Math.cbrt(m[j] / (3 * m0));
          const fine = K_ENC * (hi + hj) + 6 * (this.rad[i] + this.rad[j]);
          if (d < 1.3 * fine) {
            // Is the lighter one in orbit around the heavier?
            const big = m[i] >= m[j] ? i : j, small = big === i ? j : i;
            const hillBig = big === i ? hi : hj;
            const w2 = (s[p + 3] - s[o + 3]) ** 2 + (s[p + 4] - s[o + 4]) ** 2 + (s[p + 5] - s[o + 5]) ** 2;
            const bound = 0.5 * w2 - G * (m[i] + m[j]) / d < 0;
            if (bound && d < hillBig) {
              this.host[small] = big;
            } else {
              this.near[i] = 1; this.near[j] = 1;
              if (d < 1.5 * (hi + hj)) { this.denseHold[i] = 1; this.denseHold[j] = 1; }
            }
          }
        }
      }
      // Report moons that have been torn away from their original planet.
      for (let i = 1; i < this.n; i++) {
        if (this.origHost[i] >= 0 && !(this.flag[i] & 2) && this.host[i] === -1) {
          let hIdx = -1;
          for (let k = 1; k < this.n; k++) if (this.slot[k] === this.origHost[i]) hIdx = k;
          let free = hIdx < 0;
          if (!free) {
            const o = 6 * i, p = 6 * hIdx;
            const d = Math.hypot(s[p] - s[o], s[p + 1] - s[o + 1], s[p + 2] - s[o + 2]);
            const rh = Math.hypot(s[p] - s[0], s[p + 1] - s[1], s[p + 2] - s[2]) * Math.cbrt(m[hIdx] / (3 * m0));
            free = d > 1.5 * rh;
          }
          if (free) {
            this.flag[i] |= 2;
            this.events.push({ t: this.t, type: 'escaped', a: this.slotIds[this.slot[i]], b: this.slotIds[this.origHost[i]] });
          }
        }
      }
      // Fold settled moons back into their planets.
      for (let i = this.n - 1; i >= 1; i--) {
        const h = this.host[i];
        if (h > 0 && h < this.n && i < this.n) this._tryFold(i, h);
      }
      if ((this.bsSteps & 31) === 0) this._checkEjections();
      if (this._wantWH()) this._enterWH();
    }
  }

  _needBSNow() {
    if (this._anyWellActive()) return true;
    const { s, m } = this, m0 = m[0];
    for (let i = 1; i < this.n; i++) {
      const o = 6 * i;
      const hi = Math.hypot(s[o] - s[0], s[o + 1] - s[1], s[o + 2] - s[2]) * Math.cbrt(m[i] / (3 * m0));
      for (let j = i + 1; j < this.n; j++) {
        const p = 6 * j;
        const d = Math.hypot(s[p] - s[o], s[p + 1] - s[o + 1], s[p + 2] - s[o + 2]);
        const hj = Math.hypot(s[p] - s[0], s[p + 1] - s[1], s[p + 2] - s[2]) * Math.cbrt(m[j] / (3 * m0));
        if (d < 1.3 * (K_ENC * (hi + hj) + 6 * (this.rad[i] + this.rad[j]))) return true;
      }
    }
    return false;
  }

  _wantWH() {
    if (this.n < 2) return false;
    if (this._nextWellEdge() <= this.tRel + 1e-6) return false;
    if (this._needBSNow()) return false;
    // Nobody may be inside the radius where the symplectic step is too coarse.
    const { s } = this;
    const rc = 1.15 * this._rcrit(this._chooseDt());
    for (let i = 1; i < this.n; i++) {
      const o = 6 * i;
      if ((s[o] - s[0]) ** 2 + (s[o + 1] - s[1]) ** 2 + (s[o + 2] - s[2]) ** 2 < rc * rc) return false;
    }
    return true;
  }

  // --- output --------------------------------------------------------------

  _push(slot, flags, parent, st, o, sub, mass, radius, mu) {
    const out = this.out[slot];
    out.push(this.tRel, flags, parent);
    if (sub < 0) for (let k = 0; k < 6; k++) out.push(st[o + k]);
    else for (let k = 0; k < 6; k++) out.push(st[o + k] - this.s[sub + k]);
    out.push(mass, radius, mu);
    this.lastT[slot] = this.tRel;
    this.nSamples++;
  }

  /**
   * Records body i (and any moons folded into it). `exact` forces a truly
   * heliocentric state, used while the body is in a close encounter.
   */
  _emitIndex(i, flags, exact = false) {
    const { s, m } = this;
    let mass = m[i];
    for (const sat of this.sats[i]) {
      keplerStep(sat.rel, 0, G * m[i], this.tRel - sat.tEpoch, sat.rel, 0);
      sat.tEpoch = this.tRel;
      this._push(sat.slot, flags, this.slot[i], sat.rel, 0, -1, sat.mass, sat.radius, G * m[i]);
      mass -= sat.mass; // the planet's listed mass excludes its folded moons
    }
    const h = this.mode === 'bs' ? this.host[i] : -1;
    if (h > 0 && h < this.n) {
      this._push(this.slot[i], flags, this.slot[h], s, 6 * i, 6 * h, mass, this.rad[i], G * (m[h] + m[i]));
    } else if (exact || this.near[i]) {
      this._push(this.slot[i], flags, PARENT_SUN, this._helio(i, _tmp6), 0, -1, mass, this.rad[i], G * (m[0] + m[i]));
    } else {
      const mu = this._interior(i, _tmp6);
      this._push(this.slot[i], flags, PARENT_SUN, _tmp6, 0, -1, mass, this.rad[i], mu);
    }
  }

  _emitGone(slot, code) {
    this.out[slot].push(this.tRel, FLAG_BREAK, code, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }

  /** Records every body. */
  emit(flags) {
    this._v0ok = false;
    for (let i = 1; i < this.n; i++) this._emitIndex(i, flags);
    const { s } = this, wh = this.mode === 'wh';
    this.wells.forEach((w, k) => {
      const on = this._wellActive(w, this.tRel);
      if (!on && !w.wasOn) return;
      this.wellOut[k].push(this.tRel, on ? w.x - (wh ? 0 : s[0]) : NaN, on ? w.y - (wh ? 0 : s[1]) : NaN, on ? w.z - (wh ? 0 : s[2]) : NaN);
      w.wasOn = on;
    });
    this.lastSampleT = this.tRel;
    if (this.nSamples > 300000 * this.thin) this.thin *= 2;
  }

  _sampleSpacing() {
    let sp = Math.max(0.02, Math.min(2000, 0.002 * this.tRel)) * this.thin;
    if (this.mode === 'bs' && this._anyWellActive()) sp = Math.min(sp, 0.05 * this.thin);
    return sp;
  }

  /** Advances by one integrator step, sampling as needed. */
  step() {
    if (this.n < 2) { this.tRel += 1000; return; }
    if (this.mode === 'wh') this._whStep(); else this._bsAdvance();
    if (this.tRel - this.lastSampleT >= this._sampleSpacing()) this.emit(0);
    else if (this.mode === 'bs') {
      // Bodies in a deep encounter get their own dense samples.
      const dd = DENSE_DT * this.thin;
      for (let i = 1; i < this.n; i++) {
        if (this.denseHold[i] && this.tRel - this.lastT[this.slot[i]] >= dd) { this._v0ok = false; this._emitIndex(i, 0, true); }
      }
    }
  }

  /** Takes the accumulated samples and events, clearing the buffers. */
  drain() {
    const streams = this.out.map((a) => Float64Array.from(a));
    const wells = this.wellOut.map((a) => Float64Array.from(a));
    const events = this.events;
    this.out = this.out.map(() => []);
    this.wellOut = this.wellOut.map(() => []);
    this.events = [];
    return { streams, wells, events };
  }

  /**
   * True when nothing further is expected to happen dynamically: every
   * surviving planet is on a bound orbit, well separated from its neighbours.
   */
  isSettled() {
    if (this.mode !== 'wh') return false;
    const mu = G * this.m[0];
    const list = [];
    this._v0ok = false;
    for (let i = 1; i < this.n; i++) {
      stateToElements(this._helio(i, _tmp6), 0, mu, _el);
      if (!_el.bound) { if (this.flag[i] & 1) continue; return false; }
      if (this.m[i] < 1e-8) continue;
      list.push({ a: _el.a, q: _el.q, Q: _el.Q, m: this.m[i] });
    }
    list.sort((x, y) => x.a - y.a);
    for (let k = 0; k + 1 < list.length; k++) {
      const A = list[k], B = list[k + 1];
      const rh = Math.cbrt((A.m + B.m) / (3 * this.m[0])) * 0.5 * (A.a + B.a);
      if (B.q - A.Q < 5 * rh) return false;
    }
    return true;
  }

  /** Total energy (for tests). Only meaningful with no wells and constant solar mass. */
  energy() {
    const wasWH = this.mode === 'wh';
    if (wasWH) this._enterBS();
    const { s, m, n } = this;
    let E = 0;
    for (let i = 0; i < n; i++) {
      const o = 6 * i;
      E += 0.5 * m[i] * (s[o + 3] ** 2 + s[o + 4] ** 2 + s[o + 5] ** 2);
      for (let j = i + 1; j < n; j++) {
        const p = 6 * j;
        E -= G * m[i] * m[j] / Math.hypot(s[p] - s[o], s[p + 1] - s[o + 1], s[p + 2] - s[o + 2]);
      }
    }
    if (wasWH) { const dt = this.dt; this._enterWH(); this._setDt(dt); this._updateThresholds(); }
    return E;
  }
}
