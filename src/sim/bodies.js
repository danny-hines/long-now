// The cast, and the natural (un-meddled) history of each body's orbit and bulk.
//
// Present-day orbits are JPL's J2000 mean elements. The formation era follows
// the mainstream picture: gas giants grow inside the gas disc within ~4 Myr,
// the giant planets then migrate from a compact configuration to today's
// orbits (an early "Nice model" instability), the rocky planets assemble over
// tens of millions of years, and the Moon is born from a giant impact between
// the proto-Earth and a Mars-sized body ("Theia") ~58 Myr after the first solids.
import { G, DEG, TAU, AU_KM, MEARTH, T_START, T_END, J2000_OFFSET, REARTH_AU, ENGULF_FACTOR } from './constants.js';
import { sunMass, sunRadiusAU, SUN_KNOT_TIMES, SUN_T } from './sun.js';
import { SecularTrack } from './tracks.js';

const MYR = 1e6;
export const T_GIANT_IMPACT = -4.51e9;
export const T_INSTABILITY = T_START + 8 * MYR;
export const T_DISC_GONE = T_START + 5 * MYR;

const km = (v) => v / AU_KM;
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const ramp = (tau, a, b) => smooth((tau - a) / (b - a));
function piecewise(pts, x) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const w = (x - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]);
      return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * w;
    }
  }
  return pts[pts.length - 1][1];
}

// id, name, kind, mass (M☉), radius (km), J2000 elements [a, e, i°, L°, ϖ°, Ω°],
// secular rates [ϖ°/cy, Ω°/cy], axial tilt°, sidereal day (h), marker colour
const RAW = [
  ['mercury', 'Mercury', 'rocky', 1.6601e-7, 2439.7, [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593], [0.16047689, -0.12534081], 0.03, 1407.6, '#b8aca0'],
  ['venus', 'Venus', 'rocky', 2.4478e-6, 6051.8, [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255], [0.00268329, -0.27769418], 177.4, -5832.5, '#e8cf9a'],
  ['earth', 'Earth', 'rocky', 3.0034896e-6, 6371.0, [1.00000261, 0.01671123, 0.00001531, 100.46457166, 102.93768193, 0.0], [0.32327364, 0.0], 23.44, 23.934, '#6fa8ff'],
  ['mars', 'Mars', 'rocky', 3.2272e-7, 3389.5, [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891], [0.44441088, -0.29257343], 25.19, 24.62, '#e0764a'],
  ['jupiter', 'Jupiter', 'gas', 9.5479e-4, 69911, [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909], [0.21252668, 0.20469106], 3.13, 9.925, '#e3c39b'],
  ['saturn', 'Saturn', 'gas', 2.8588e-4, 58232, [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448], [-0.41897216, -0.28867794], 26.73, 10.66, '#ead9a6'],
  ['uranus', 'Uranus', 'ice', 4.3662e-5, 25362, [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503], [0.40805281, 0.04240589], 97.77, -17.24, '#a8e4e8'],
  ['neptune', 'Neptune', 'ice', 5.1514e-5, 24622, [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574], [-0.32241464, -0.00508664], 28.32, 16.11, '#5b7ef0'],
  ['pluto', 'Pluto', 'dwarf', 6.55e-9, 1188.3, [39.48211675, 0.2488273, 17.14001206, 238.92903833, 224.06891629, 110.30393684], [-0.04062942, -0.01183482], 122.5, -153.3, '#c9b29b'],
];

export const BODIES = RAW.map(([id, name, kind, mass, rkm, el, rates, tilt, day, color]) => ({
  id, name, kind, mass, radius: km(rkm), parent: 'sun', tilt: tilt * DEG, dayHours: day, color,
  el: { a: el[0], e: el[1], i: el[2] * DEG, L: el[3] * DEG, varpi: el[4] * DEG, Om: el[5] * DEG, dVarpi: rates[0] * DEG / 100, dOm: rates[1] * DEG / 100 },
}));
BODIES.push({
  id: 'moon', name: 'Moon', kind: 'moon', mass: 3.6943e-8, radius: km(1737.4), parent: 'earth', tilt: 1.54 * DEG, dayHours: 655.7, color: '#c8c8c8',
  el: { a: km(384400), e: 0.0549, i: 5.145 * DEG, L: 218.32 * DEG, varpi: 83.35 * DEG, Om: 125.04 * DEG, dVarpi: TAU / 8.85, dOm: -TAU / 18.6 },
});
BODIES.push({
  id: 'theia', name: 'Theia', kind: 'rocky', mass: 0.11 * MEARTH, radius: km(3400), parent: 'sun', tilt: 10 * DEG, dayHours: 9, color: '#d89a6a',
  el: null,
});
export const BODY = Object.fromEntries(BODIES.map((b) => [b.id, b]));
export const BODY_IDS = BODIES.map((b) => b.id);

// ---------------------------------------------------------------------------
// Formation scripts. tau = years since T_START.
// ---------------------------------------------------------------------------
const ME = MEARTH;
const GROW = {
  mercury: { appear: 1.0e6, frac: (tau) => ramp(tau, 0.6e6, 25e6) },
  venus: { appear: 0.8e6, frac: (tau) => ramp(tau, 0.4e6, 50e6) },
  earth: {
    appear: 0.7e6,
    frac: (tau, t) => (t < T_GIANT_IMPACT ? 0.9 * ramp(tau, 0.3e6, 45e6) : 1),
  },
  theia: { appear: 3e6, frac: (tau) => ramp(tau, 2e6, 25e6) },
  mars: { appear: 0.6e6, frac: (tau) => ramp(tau, 0.3e6, 6e6) },
  jupiter: { appear: 0.4e6, frac: (tau) => piecewise([[0.3e6, 0], [1.0e6, 10], [2.5e6, 30], [3.2e6, 317.8]], tau) / 317.8 },
  saturn: { appear: 0.9e6, frac: (tau) => piecewise([[0.7e6, 0], [2.2e6, 12], [3.2e6, 25], [3.9e6, 95.16]], tau) / 95.16 },
  uranus: { appear: 1.5e6, frac: (tau) => ramp(tau, 1.0e6, 4.5e6) },
  neptune: { appear: 1.8e6, frac: (tau) => ramp(tau, 1.2e6, 5.0e6) },
  pluto: { appear: 2.0e6, frac: (tau) => ramp(tau, 1.5e6, 10e6) },
  moon: { appear: T_GIANT_IMPACT - T_START + 40, frac: (tau, t) => ramp(t - T_GIANT_IMPACT, 20, 1200) },
};

// Giant-planet migration: 0 before the instability, → 1 afterwards.
const migr = (t) => (t <= T_INSTABILITY ? 0 : 1 - Math.exp(-(t - T_INSTABILITY) / (7 * MYR)));
const START_ORBIT = {
  jupiter: { a: 5.45 }, saturn: { a: 8.2 }, uranus: { a: 12.0 }, neptune: { a: 16.0 },
  pluto: { a: 28.0, e: 0.05, i: 3 * DEG },
};

// Earth–Moon distance in Earth radii. Tidal recession, pinned to the giant
// impact, tidal rhythmites (620 Ma), banded-iron Milankovitch cycles
// (1.4 and 2.46 Ga) and lunar laser ranging today (3.8 cm/yr).
const MOON_A = [
  [0, 3.8], [1e3, 4.0], [1e5, 8], [1e6, 12], [1e7, 18], [1e8, 26],
  [T_GIANT_IMPACT * -1 - 4.0e9, 34], [-T_GIANT_IMPACT - 3.2e9, 44], [-T_GIANT_IMPACT - 2.46e9, 50.4],
  [-T_GIANT_IMPACT - 1.4e9, 53.5], [-T_GIANT_IMPACT - 0.62e9, 58.2], [-T_GIANT_IMPACT, 60.27],
  [-T_GIANT_IMPACT + 1e9, 62.3], [-T_GIANT_IMPACT + 3e9, 64.5], [-T_GIANT_IMPACT + 8e9, 67],
];
export function moonDistanceRE(t) {
  const x = t - T_GIANT_IMPACT;
  if (x <= 0) return MOON_A[0][1];
  // Interpolate in log-time: recession is fast at first and ever slower.
  const lx = Math.log10(Math.max(1, x));
  for (let i = 1; i < MOON_A.length; i++) {
    if (x <= MOON_A[i][0]) {
      const l0 = Math.log10(Math.max(1, MOON_A[i - 1][0])), l1 = Math.log10(MOON_A[i][0]);
      const w = (lx - l0) / (l1 - l0);
      return MOON_A[i - 1][1] + (MOON_A[i][1] - MOON_A[i - 1][1]) * w;
    }
  }
  return MOON_A[MOON_A.length - 1][1];
}

/** Mass (M☉) and radius (AU) of a body at time t in the natural history. */
export function naturalBulk(id, t, out = {}) {
  const b = BODY[id];
  const g = GROW[id];
  const tau = t - T_START;
  let f = Math.max(g.frac(tau, t), 1e-4);
  out.mass = b.mass * f;
  let r = b.radius * Math.pow(f, b.kind === 'gas' ? 0.36 : 0.31);
  // Young giants are still hot and puffed up.
  if (b.kind === 'gas' || b.kind === 'ice') r *= 1 + 0.25 * Math.exp(-tau / 30e6);
  out.radius = r;
  return out;
}

// ---------------------------------------------------------------------------
// Baseline tracks
// ---------------------------------------------------------------------------
function baseGrid() {
  const set = new Set();
  const add = (t) => { if (t >= T_START && t <= T_END) set.add(t); };
  add(T_START); add(0); add(T_END);
  for (let tau = 1e4; tau < 140 * MYR; tau *= 1.1) add(T_START + tau);
  for (let tau = 0; tau <= 140 * MYR; tau += 1 * MYR) add(T_START + tau);
  for (let x = 10; x < 4.6e9; x *= 1.5) add(T_GIANT_IMPACT + x);
  for (let x = 1; x < 2e7; x *= 1.5) add(T_GIANT_IMPACT - x); // Theia's approach
  add(T_GIANT_IMPACT);
  for (let t = -4.42e9; t < SUN_T.rgbStart; t += 20 * MYR) add(t);
  for (let i = 0; i < SUN_KNOT_TIMES.length; i++) if (SUN_KNOT_TIMES[i] > SUN_T.msEnd) add(SUN_KNOT_TIMES[i]);
  return Float64Array.from([...set].sort((a, b) => a - b));
}

function buildPlanetTrack(b, grid) {
  const g = GROW[b.id];
  const tStart = T_START + g.appear;
  const s0 = START_ORBIT[b.id];
  const k = { t: [], a: [], e: [], inc: [], Om: [], w: [], mu: [] };
  let tEnd = Infinity;
  let prevGap = null;
  for (let j = 0; j < grid.length; j++) {
    const t = grid[j];
    const ms = sunMass(t);
    let a = b.el.a, e = b.el.e, inc = b.el.i;
    if (s0) {
      const m = migr(t);
      a = s0.a + (b.el.a - s0.a) * m;
      e = (s0.e ?? b.el.e * 0.3) + (b.el.e - (s0.e ?? b.el.e * 0.3)) * m;
      if (s0.i !== undefined) inc = s0.i + (b.el.i - s0.i) * m;
    }
    if (t > 0) a *= 1 / ms; // adiabatic expansion as the Sun sheds mass
    const yrs = t + J2000_OFFSET;
    const varpi = b.el.varpi + b.el.dVarpi * yrs, Om = b.el.Om + b.el.dOm * yrs;
    k.t.push(t); k.a.push(a); k.e.push(e); k.inc.push(inc); k.Om.push(Om); k.w.push(varpi - Om);
    k.mu.push(G * (ms + naturalBulk(b.id, t).mass));
    if (t > 0 && tEnd === Infinity) {
      const gap = a * (1 - e) - ENGULF_FACTOR * sunRadiusAU(t);
      if (gap <= 0) tEnd = prevGap === null ? t : grid[j - 1] + (t - grid[j - 1]) * (prevGap / (prevGap - gap));
      prevGap = gap;
    }
  }
  const n0 = Math.sqrt(G * (1 + b.mass) / b.el.a ** 3);
  const M0 = b.el.L - b.el.varpi + (n0 - b.el.dVarpi) * J2000_OFFSET;
  return new SecularTrack(k, { t: 0, M: M0 }, tStart, tEnd);
}

function buildMoonTrack(b, grid, earthTrack) {
  const k = { t: [], a: [], e: [], inc: [], Om: [], w: [], mu: [] };
  for (let j = 0; j < grid.length; j++) {
    const t = grid[j];
    if (t < T_GIANT_IMPACT) continue;
    const yrs = t + J2000_OFFSET;
    const varpi = b.el.varpi + b.el.dVarpi * yrs, Om = b.el.Om + b.el.dOm * yrs;
    k.t.push(t); k.a.push(moonDistanceRE(t) * REARTH_AU);
    k.e.push(b.el.e); k.inc.push(b.el.i); k.Om.push(Om); k.w.push(varpi - Om);
    k.mu.push(G * (BODY.earth.mass + naturalBulk('moon', t).mass));
  }
  const n0 = Math.sqrt(G * (BODY.earth.mass + b.mass) / b.el.a ** 3);
  const M0 = b.el.L - b.el.varpi + (n0 - b.el.dVarpi) * J2000_OFFSET;
  return new SecularTrack(k, { t: 0, M: M0 }, T_START + GROW.moon.appear, earthTrack.tEnd);
}

/**
 * Theia shares Earth's orbit, parked near the L4 point 60° ahead, until its
 * libration grows unstable and it spirals into the proto-Earth.
 */
export function theiaOffset(t) {
  const x = T_GIANT_IMPACT - t; // years before impact
  if (x <= 0) return 0;
  const drift = 60 * DEG * (1 - Math.exp(-x / 900)); // final spiral-in
  const lib = 14 * DEG * Math.sin(TAU * x / 310) * Math.exp(-x / 6000) * (1 - Math.exp(-x / 400));
  return drift + lib;
}

let _baseline = null;
/** Natural-history tracks, keyed by body id. Built once. */
export function baselineTracks() {
  if (_baseline) return _baseline;
  const grid = baseGrid();
  const tracks = {};
  for (const b of BODIES) {
    if (b.id === 'moon' || b.id === 'theia') continue;
    tracks[b.id] = buildPlanetTrack(b, grid);
  }
  tracks.moon = buildMoonTrack(BODY.moon, grid, tracks.earth);
  tracks.theia = { coOrbital: 'earth', tStart: T_START + GROW.theia.appear, tEnd: T_GIANT_IMPACT, exists(t) { return t >= this.tStart && t < this.tEnd; } };
  _baseline = tracks;
  return tracks;
}
