// A "track" answers: where is this body, relative to its parent, at time t?
//
// SecularTrack — slowly-evolving Keplerian elements on a set of time knots.
//   Used for the natural history (formation, migration, the Sun's mass loss
//   widening every orbit) and for long-range projection beyond the end of an
//   N-body run. The mean anomaly is accumulated exactly for a piecewise-linear
//   mean motion, so a body moves smoothly at any playback speed.
import { G, TAU, ENGULF_FACTOR } from './constants.js';
import { elementsToState } from './kepler.js';
import { sunMass, sunRadiusAU, SUN_KNOT_TIMES } from './sun.js';

export class SecularTrack {
  /**
   * @param {object} k  knot arrays: t, a, e, inc, Om, w, mu (all same length)
   * @param {{t:number, M:number}} anchor  mean anomaly at one instant
   */
  constructor(k, anchor, tStart = k.t[0], tEnd = k.t[k.t.length - 1]) {
    this.k = k;
    this.tStart = tStart;
    this.tEnd = tEnd;
    const n = k.t.length;
    this.n = new Float64Array(n);
    this.M = new Float64Array(n);
    for (let i = 0; i < n; i++) this.n[i] = Math.sqrt(k.mu[i] / Math.abs(k.a[i] ** 3));
    for (let i = 1; i < n; i++) {
      const dt = k.t[i] - k.t[i - 1];
      this.M[i] = (this.M[i - 1] + 0.5 * (this.n[i] + this.n[i - 1]) * dt) % TAU;
    }
    this._last = 0;
    const off = anchor.M - this._rawM(anchor.t);
    for (let i = 0; i < n; i++) this.M[i] += off;
  }

  _locate(t) {
    const T = this.k.t, n = T.length;
    if (t <= T[0]) return 0;
    if (t >= T[n - 1]) return n - 2;
    let i = this._last;
    if (T[i] <= t && t < T[i + 1]) return i;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (T[mid] <= t) lo = mid; else hi = mid; }
    return (this._last = lo);
  }

  _rawM(t) {
    const i = this._locate(t), T = this.k.t;
    const d = t - T[i], dt = T[i + 1] - T[i];
    return this.M[i] + this.n[i] * d + 0.5 * (this.n[i + 1] - this.n[i]) / dt * d * d;
  }

  exists(t) { return t >= this.tStart && t < this.tEnd; }

  elementsAt(t, el = {}) {
    const k = this.k, i = this._locate(t);
    const dt = k.t[i + 1] - k.t[i];
    const d = t - k.t[i];
    const w = d / dt;
    el.a = k.a[i] + (k.a[i + 1] - k.a[i]) * w;
    el.e = k.e[i] + (k.e[i + 1] - k.e[i]) * w;
    el.i = k.inc[i] + (k.inc[i + 1] - k.inc[i]) * w;
    el.Om = k.Om[i] + (k.Om[i + 1] - k.Om[i]) * w;
    el.w = k.w[i] + (k.w[i + 1] - k.w[i]) * w;
    el.M = this.M[i] + this.n[i] * d + 0.5 * (this.n[i + 1] - this.n[i]) / dt * d * d;
    el.mu = k.mu[i] + (k.mu[i + 1] - k.mu[i]) * w;
    return el;
  }

  stateAt(t, out, o = 0) {
    const el = this.elementsAt(t, _el);
    elementsToState(el, el.mu, out, o);
    return el.mu;
  }
}
const _el = {};

/** A body coasting on a fixed conic (used for ejected, unbound bodies). */
export class KeplerTrack {
  constructor(t0, state, mu) {
    this.t0 = t0; this.s = Float64Array.from(state); this.mu = mu;
    this.tStart = t0; this.tEnd = Infinity;
  }
  exists(t) { return t >= this.tStart; }
}

/**
 * Projects a heliocentric orbit forward from time t0 as the Sun evolves:
 * isotropic mass loss is slow compared with an orbit, so a·M☉ is conserved
 * (the orbit widens as 1/M☉) while its shape is unchanged. The track ends when
 * perihelion falls inside the tidal-capture radius of the swollen Sun.
 *
 * Returns {track, engulfedAt} (engulfedAt = null if the body survives).
 */
export function projectHeliocentric(t0, el, mass, tMax, tidalFactor = ENGULF_FACTOR) {
  const times = [t0];
  for (let i = 0; i < SUN_KNOT_TIMES.length; i++) {
    const tk = SUN_KNOT_TIMES[i];
    if (tk > t0 && tk < tMax) times.push(tk);
  }
  times.push(tMax);
  // Extra knots through quiet stretches so interpolation stays tight.
  const k = { t: [], a: [], e: [], inc: [], Om: [], w: [], mu: [] };
  const m0 = sunMass(t0);
  let engulfedAt = null;
  let prevGap = null;
  for (const t of times) {
    const m = sunMass(t);
    const a = el.a * m0 / m;
    const gap = a * (1 - el.e) - tidalFactor * sunRadiusAU(t);
    if (gap <= 0) {
      if (prevGap === null) engulfedAt = t0;
      else {
        const tp = k.t[k.t.length - 1];
        engulfedAt = tp + (t - tp) * (prevGap / (prevGap - gap));
      }
      k.t.push(t); k.a.push(a); k.e.push(el.e); k.inc.push(el.i); k.Om.push(el.Om); k.w.push(el.w); k.mu.push(G * (m + mass));
      break;
    }
    prevGap = gap;
    k.t.push(t); k.a.push(a); k.e.push(el.e); k.inc.push(el.i); k.Om.push(el.Om); k.w.push(el.w); k.mu.push(G * (m + mass));
  }
  if (k.t.length < 2) {
    // Degenerate (already at the end): duplicate the knot.
    for (const key of Object.keys(k)) k[key].push(k[key][0]);
    k.t[1] = k.t[0] + 1;
  }
  const track = new SecularTrack(k, { t: t0, M: el.M }, t0, engulfedAt ?? Infinity);
  return { track, engulfedAt };
}
