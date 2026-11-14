// Two-body (Kepler) mechanics: orbital elements <-> state vectors and an exact
// universal-variable propagator that works for elliptic and hyperbolic orbits.
// Frame: heliocentric ecliptic, x/y in the ecliptic plane, z toward ecliptic north.
import { TAU } from './constants.js';

// Stumpff functions c0..c3 of z, written into `c`.
const _c = new Float64Array(4);
function stumpff(z, c) {
  if (z > 0.5) {
    const s = Math.sqrt(z);
    const sn = Math.sin(s), cs = Math.cos(s);
    c[0] = cs; c[1] = sn / s; c[2] = (1 - cs) / z; c[3] = (s - sn) / (z * s);
  } else if (z < -0.5) {
    const s = Math.sqrt(-z);
    const e = Math.exp(s), ei = 1 / e;
    const sh = 0.5 * (e - ei), ch = 0.5 * (e + ei);
    c[0] = ch; c[1] = sh / s; c[2] = (1 - ch) / z; c[3] = (s - sh) / (z * s);
  } else {
    // Series: c_n = sum_k (-z)^k / (2k+n)!
    let c2 = 0.5, c3 = 1 / 6, term2 = 0.5, term3 = 1 / 6;
    for (let k = 0; k < 12; k++) {
      term2 *= -z / ((2 * k + 3) * (2 * k + 4));
      term3 *= -z / ((2 * k + 4) * (2 * k + 5));
      c2 += term2; c3 += term3;
      if (Math.abs(term2) < 1e-17) break;
    }
    c[2] = c2; c[3] = c3; c[1] = 1 - z * c3; c[0] = 1 - z * c2;
  }
}

/**
 * Advances a two-body state by dt. `s` holds [x,y,z,vx,vy,vz] at offset `o`
 * (relative to the central body, gravitational parameter mu); result is written
 * to `out` at offset `oo`. Exact for any conic. Returns false if it failed to converge.
 */
export function keplerStep(s, o, mu, dt, out, oo) {
  const x = s[o], y = s[o + 1], z = s[o + 2], vx = s[o + 3], vy = s[o + 4], vz = s[o + 5];
  if (dt === 0) {
    out[oo] = x; out[oo + 1] = y; out[oo + 2] = z; out[oo + 3] = vx; out[oo + 4] = vy; out[oo + 5] = vz;
    return true;
  }
  const r0 = Math.sqrt(x * x + y * y + z * z);
  const v2 = vx * vx + vy * vy + vz * vz;
  const eta = x * vx + y * vy + z * vz;
  const beta = 2 * mu / r0 - v2; // mu / a
  const zeta = mu - beta * r0;

  let X, lo, hi;
  if (beta > 0) {
    // Bound orbit: remove whole periods so the solver works within ±half a period.
    const sb = Math.sqrt(beta);
    const period = TAU * mu / (beta * sb);
    if (Math.abs(dt) > 0.5 * period) dt -= period * Math.round(dt / period);
    const xp = TAU / sb;
    // |ΔM| ≤ π after the reduction, but the eccentric anomaly can swing further
    // on an eccentric orbit; one full revolution either way always brackets it.
    lo = -xp; hi = xp;
    X = Math.abs(dt) < 0.2 * period ? dt / r0 - 0.5 * dt * dt * eta / (r0 * r0 * r0) : beta * dt / mu;
    if (X < lo) X = lo; else if (X > hi) X = hi;
  } else {
    X = dt / r0;
    lo = -Infinity; hi = Infinity;
  }

  const c = _c;
  let r = r0, ok = false, G1 = 0, G2 = 0, G3 = 0;
  const ftol = 4e-16 * (Math.abs(dt) + 1e-300);
  for (let it = 0; it < 80; it++) {
    stumpff(beta * X * X, c);
    G1 = X * c[1]; G2 = X * X * c[2]; G3 = X * X * X * c[3];
    const res = r0 * X + eta * G2 + zeta * G3 - dt;
    r = r0 + eta * G1 + zeta * G2; // = d(res)/dX, always positive
    if (Math.abs(res) <= ftol) { ok = true; break; }
    if (res > 0) { if (X < hi) hi = X; } else if (X > lo) lo = X;
    // Laguerre–Conway step (n = 5): robust far from the root, cubic near it.
    const fpp = eta * c[0] + zeta * G1;
    const disc = Math.sqrt(Math.abs(16 * r * r - 20 * res * fpp));
    let Xn = X - 5 * res / (r + disc);
    if (!(Xn > lo && Xn < hi)) {
      // Stepped outside the bracket: bisect (or expand an open bracket).
      if (lo === -Infinity) Xn = hi === Infinity ? X - Math.abs(X) - Math.abs(dt) / r0 : hi - Math.abs(hi) - Math.abs(dt) / r0;
      else if (hi === Infinity) Xn = lo + Math.abs(lo) + Math.abs(dt) / r0;
      else Xn = 0.5 * (lo + hi);
    }
    if (Xn === X || (it > 6 && hi - lo <= 2e-16 * Math.abs(X))) { ok = true; break; }
    X = Xn;
  }
  const f = 1 - mu * G2 / r0;
  const g = dt - mu * G3;
  const fd = -mu * G1 / (r0 * r);
  const gd = 1 - mu * G2 / r;
  out[oo] = f * x + g * vx; out[oo + 1] = f * y + g * vy; out[oo + 2] = f * z + g * vz;
  out[oo + 3] = fd * x + gd * vx; out[oo + 4] = fd * y + gd * vy; out[oo + 5] = fd * z + gd * vz;
  return ok;
}

/** Solves Kepler's equation M = E − e·sin E for an ellipse. */
export function eccentricAnomaly(M, e) {
  M = M - TAU * Math.floor(M / TAU);
  if (M > Math.PI) M -= TAU;
  let E = M + e * Math.sin(M) / (1 - Math.sin(M + e) + Math.sin(M) || 1);
  if (e > 0.8) E = M > 0 ? Math.PI * 0.9 : -Math.PI * 0.9;
  for (let i = 0; i < 50; i++) {
    const f = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    const d = f / (fp - 0.5 * f * e * Math.sin(E) / fp); // Halley
    E -= d;
    if (Math.abs(d) < 1e-14) break;
  }
  return E;
}

/** Solves M = e·sinh F − F for a hyperbola. */
export function hyperbolicAnomaly(M, e) {
  let F = Math.asinh(M / e);
  if (Math.abs(M) > 6 * e) F = Math.sign(M) * Math.log(2 * Math.abs(M) / e);
  for (let i = 0; i < 80; i++) {
    const f = e * Math.sinh(F) - F - M;
    const fp = e * Math.cosh(F) - 1;
    const d = f / fp;
    F -= d;
    if (Math.abs(d) < 1e-14 * (1 + Math.abs(F))) break;
  }
  return F;
}

/**
 * Elements -> state. `el` = {a, e, i, Om, w, M}; a < 0 and e > 1 for hyperbolic.
 * Writes [x,y,z,vx,vy,vz] to out at offset o.
 */
export function elementsToState(el, mu, out, o = 0) {
  const { a, e } = el;
  let xp, yp, vxp, vyp;
  if (e < 1) {
    const E = eccentricAnomaly(el.M, e);
    const cE = Math.cos(E), sE = Math.sin(E);
    const b = Math.sqrt(1 - e * e);
    const n = Math.sqrt(mu / (a * a * a));
    const rr = 1 - e * cE;
    xp = a * (cE - e); yp = a * b * sE;
    vxp = -a * n * sE / rr; vyp = a * n * b * cE / rr;
  } else {
    const F = hyperbolicAnomaly(el.M, e);
    const cF = Math.cosh(F), sF = Math.sinh(F);
    const aa = -a;
    const b = Math.sqrt(e * e - 1);
    const n = Math.sqrt(mu / (aa * aa * aa));
    const rr = e * cF - 1;
    xp = aa * (e - cF); yp = aa * b * sF;
    vxp = -aa * n * sF / rr; vyp = aa * n * b * cF / rr;
  }
  const cO = Math.cos(el.Om), sO = Math.sin(el.Om);
  const cw = Math.cos(el.w), sw = Math.sin(el.w);
  const ci = Math.cos(el.i), si = Math.sin(el.i);
  const px = cO * cw - sO * sw * ci, py = sO * cw + cO * sw * ci, pz = sw * si;
  const qx = -cO * sw - sO * cw * ci, qy = -sO * sw + cO * cw * ci, qz = cw * si;
  out[o] = px * xp + qx * yp; out[o + 1] = py * xp + qy * yp; out[o + 2] = pz * xp + qz * yp;
  out[o + 3] = px * vxp + qx * vyp; out[o + 4] = py * vxp + qy * vyp; out[o + 5] = pz * vxp + qz * vyp;
  return out;
}

/**
 * State -> elements. Returns {a, e, i, Om, w, M, nu, q, Q, n, period, bound}.
 * For unbound orbits a < 0, Q = Infinity, period = Infinity.
 */
export function stateToElements(s, o, mu, el = {}) {
  const x = s[o], y = s[o + 1], z = s[o + 2], vx = s[o + 3], vy = s[o + 4], vz = s[o + 5];
  const r = Math.sqrt(x * x + y * y + z * z);
  const v2 = vx * vx + vy * vy + vz * vz;
  const rv = x * vx + y * vy + z * vz;
  const hx = y * vz - z * vy, hy = z * vx - x * vz, hz = x * vy - y * vx;
  const h = Math.sqrt(hx * hx + hy * hy + hz * hz);
  const ex = (vy * hz - vz * hy) / mu - x / r;
  const ey = (vz * hx - vx * hz) / mu - y / r;
  const ez = (vx * hy - vy * hx) / mu - z / r;
  let e = Math.sqrt(ex * ex + ey * ey + ez * ez);
  const inva = 2 / r - v2 / mu;
  if (Math.abs(e - 1) < 1e-9) e = inva > 0 ? 1 - 1e-9 : 1 + 1e-9;
  let a = Math.abs(inva) < 1e-14 ? (inva >= 0 ? 1e14 : -1e14) : 1 / inva;
  const inc = Math.acos(Math.max(-1, Math.min(1, hz / h)));
  let Om, w, nu;
  const nlen = Math.hypot(hx, hy);
  if (nlen > 1e-11 * h) {
    Om = Math.atan2(hx, -hy);
    const nx = -hy / nlen, ny = hx / nlen;
    // In-plane basis: n̂ and ĥ × n̂.
    const mx = (hy * 0 - hz * ny) / h, my = (hz * nx - hx * 0) / h, mz = (hx * ny - hy * nx) / h;
    if (e > 1e-11) w = Math.atan2(ex * mx + ey * my + ez * mz, ex * nx + ey * ny);
    else w = 0;
    const u = Math.atan2(x * mx + y * my + z * mz, x * nx + y * ny);
    nu = u - w;
  } else {
    Om = 0;
    const sgn = hz >= 0 ? 1 : -1;
    w = e > 1e-11 ? Math.atan2(ey * sgn, ex) : 0;
    nu = Math.atan2(y * sgn, x) - w;
  }
  nu -= TAU * Math.round(nu / TAU);
  let M;
  const bound = inva > 0 && e < 1;
  if (bound) {
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
    M = E - e * Math.sin(E);
  } else {
    if (a > 0) a = -a;
    if (e <= 1) e = 1 + 1e-9;
    const t = Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2);
    const F = 2 * Math.atanh(Math.max(-0.999999999, Math.min(0.999999999, t)));
    M = e * Math.sinh(F) - F;
  }
  el.a = a; el.e = e; el.i = inc; el.Om = Om; el.w = w; el.M = M; el.nu = nu;
  el.q = a * (1 - e);
  el.Q = bound ? a * (1 + e) : Infinity;
  el.n = Math.sqrt(mu / Math.abs(a * a * a));
  el.period = bound ? TAU / el.n : Infinity;
  el.bound = bound;
  el.rv = rv;
  return el;
}

/**
 * Fills `out` (xyz triples) with points along the orbit, starting at the
 * body's current position (true anomaly el.nu) and going once around. For
 * hyperbolic orbits the arc is limited to r < rMax. Returns the point count.
 */
export function orbitPoints(el, n, out, rMax = 1e4) {
  const { a, e } = el;
  const cO = Math.cos(el.Om), sO = Math.sin(el.Om);
  const cw = Math.cos(el.w), sw = Math.sin(el.w);
  const ci = Math.cos(el.i), si = Math.sin(el.i);
  const px = cO * cw - sO * sw * ci, py = sO * cw + cO * sw * ci, pz = sw * si;
  const qx = -cO * sw - sO * cw * ci, qy = -sO * sw + cO * cw * ci, qz = cw * si;
  const p = a * (1 - e * e);
  let nu0, span;
  if (e < 1) {
    nu0 = el.nu; span = TAU;
  } else {
    // Asymptote where r reaches rMax: cos(nu) = (p/rMax − 1)/e
    const lim = Math.acos(Math.max(-1, Math.min(1, (p / rMax - 1) / e)));
    nu0 = -lim; span = 2 * lim;
  }
  for (let k = 0; k < n; k++) {
    // Walk backwards from the body so the trail fades behind it.
    const nu = e < 1 ? nu0 - (span * k) / (n - 1) : nu0 + (span * k) / (n - 1);
    const r = p / (1 + e * Math.cos(nu));
    const xp = r * Math.cos(nu), yp = r * Math.sin(nu);
    out[3 * k] = px * xp + qx * yp;
    out[3 * k + 1] = py * xp + qy * yp;
    out[3 * k + 2] = pz * xp + qz * yp;
  }
  return n;
}
