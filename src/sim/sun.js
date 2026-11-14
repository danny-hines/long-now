// The Sun's life, from collapsing protostar to cooling white dwarf.
//
// Anchored to published solar-evolution models:
//  - pre-main sequence: Hayashi/Henyey tracks for a 1 M☉ star
//  - main sequence: Gough (1981) luminosity law, L = L☉ / (1 + 0.4 (1 − t/t☉))
//  - post-main sequence: Schröder & Smith (2008), "Distant future of the Sun
//    and Earth revisited" — red-giant tip 7.59 Gyr from now at 256 R☉ and
//    2730 L☉ having shed a third of its mass, then core-helium burning, the
//    asymptotic giant branch, and a 0.54 M☉ white dwarf.
// Effective temperature always follows from L = 4πR²σT⁴.
import { T_START, T_END, RSUN_AU } from './constants.js';

const GYR = 1e9, MYR = 1e6;
export const TEFF_SUN = 5772;

// Key moments (years from present).
export const SUN_T = {
  zams: T_START + 50 * MYR, // hydrogen fusion ignites
  msEnd: 5.42 * GYR, // core hydrogen exhausted
  rgbStart: 7.0 * GYR,
  rgbTip: 7.59 * GYR, // helium flash
  hbStart: 7.5912 * GYR,
  agbStart: 7.70 * GYR,
  agbTip: 7.72 * GYR, // envelope ejected
  wd: 7.72003 * GYR,
};

const knots = { t: [], L: [], R: [], M: [] };
function add(t, L, R, M) {
  const n = knots.t.length;
  if (n && t <= knots.t[n - 1]) return;
  knots.t.push(t); knots.L.push(L); knots.R.push(R); knots.M.push(M);
}

(function build() {
  // --- Protostar and pre-main sequence (age since T_START) ---
  const pms = [
    [0, 1.5, 6.0, 0.25],
    [3e4, 9.0, 6.0, 0.70],
    [1e5, 8.0, 5.0, 0.92],
    [5e5, 4.0, 3.4, 0.99],
    [1e6, 2.2, 2.6, 1.0],
    [3e6, 1.0, 1.8, 1.0],
    [1e7, 0.5, 1.2, 1.0],
    [2e7, 0.46, 1.0, 1.0],
    [3.2e7, 0.6, 0.95, 1.0],
    [5e7, 0.70, 0.89, 1.0],
  ];
  for (const [age, L, R, M] of pms) add(T_START + age, L, R, M);

  // --- Main sequence ---
  const tSun = -SUN_T.zams; // main-sequence age today
  for (let i = 1; i <= 40; i++) {
    const t = SUN_T.zams + (i / 40) * tSun; // up to t = 0
    const tau = (t - SUN_T.zams) / tSun;
    const L = 1 / (1 + 0.4 * (1 - tau));
    const R = 0.89 + 0.11 * Math.pow(tau, 1.2);
    add(t, L, R, 1.0);
  }
  // Present -> end of main sequence (Schröder & Smith table 1).
  const ms2 = [
    [0.5, 1.045, 1.018], [1.0, 1.093, 1.038], [1.5, 1.143, 1.06], [2.0, 1.197, 1.084], [2.55, 1.26, 1.11],
    [3.0, 1.32, 1.14], [3.5, 1.40, 1.175], [4.0, 1.49, 1.215], [4.5, 1.60, 1.265], [5.0, 1.73, 1.32], [5.42, 1.84, 1.37],
    // Subgiant: the core contracts, the envelope swells and cools.
    [5.8, 1.95, 1.50], [6.2, 2.1, 1.68], [6.6, 2.35, 1.95], [6.85, 2.55, 2.15], [7.0, 2.7, 2.28],
  ];
  for (const [g, L, R] of ms2) add(g * GYR, L, R, 1.0);

  // --- Red giant branch ---
  // Shell-burning luminosity runs away as L ∝ (1 − (t − t0)/τ)^(−7/6); τ is set
  // so that L reaches 2730 L☉ at the tip. Mass loss follows Reimers' law
  // (dM/dt ∝ L R / M), normalised to leave 0.668 M☉ at the tip.
  const L0 = 2.7, Ltip = 2730, t0 = SUN_T.rgbStart;
  const xTip = 1 - Math.pow(Ltip / L0, -6 / 7);
  const tau = (SUN_T.rgbTip - t0) / xTip;
  const rgbL = (t) => L0 * Math.pow(1 - (t - t0) / tau, -7 / 6);
  const giantR = (L, T) => Math.sqrt(L) * (TEFF_SUN / T) ** 2;
  const rgbT = (L) => 4900 * Math.pow(L / L0, Math.log(2602 / 4900) / Math.log(Ltip / L0));
  const N = 400;
  const seg = [];
  for (let i = 1; i <= N; i++) {
    // Geometric spacing toward the tip, where everything happens.
    const rem = Math.pow(1e-5, i / N); // fraction of RGB time remaining... down to 1e-5
    const t = i === N ? SUN_T.rgbTip : SUN_T.rgbTip - (SUN_T.rgbTip - t0) * rem;
    const L = i === N ? Ltip : rgbL(t);
    seg.push({ t, L, R: giantR(L, rgbT(L)) });
  }
  let M = 1.0;
  const integ = (arr, k, Mstart) => {
    // Reimers integral with unit coefficient, to be normalised.
    let m = Mstart, prev = null;
    const out = [];
    for (const p of arr) {
      if (prev) m = Math.max(0.05, m - k * 0.5 * (p.L * p.R + prev.L * prev.R) / m * (p.t - prev.t));
      out.push(m);
      prev = p;
    }
    return out;
  };
  const solveK = (arr, Mstart, Mend) => {
    let lo = 0, hi = 1e-9;
    for (let i = 0; i < 80; i++) {
      const k = 0.5 * (lo + hi);
      const m = integ(arr, k, Mstart);
      if (m[m.length - 1] > Mend) lo = k; else hi = k;
    }
    return 0.5 * (lo + hi);
  };
  const first = { t: t0, L: L0, R: 2.28 };
  let arr = [first, ...seg];
  let ms = integ(arr, solveK(arr, 1.0, 0.668), 1.0);
  for (let i = 1; i < arr.length; i++) add(arr[i].t, arr[i].L, arr[i].R, ms[i]);
  M = 0.668;

  // --- Helium flash and horizontal branch ---
  add(SUN_T.rgbTip + 2e5, 900, 120, M);
  add(SUN_T.rgbTip + 6e5, 150, 28, M);
  add(SUN_T.hbStart, 53.7, 11.2, M);
  add(SUN_T.hbStart + 40 * MYR, 50, 10.6, 0.667);
  add(SUN_T.hbStart + 80 * MYR, 58, 12.5, 0.666);
  add(SUN_T.agbStart, 85, 17, 0.665);

  // --- Asymptotic giant branch, with four thermal pulses at the end ---
  const La = 85, LaTip = 2090, ta = SUN_T.agbStart;
  const xa = 1 - Math.pow(LaTip / La, -6 / 7);
  const taua = (SUN_T.agbTip - ta) / xa;
  const agbT = (L) => 4450 * Math.pow(L / La, Math.log(3200 / 4450) / Math.log(LaTip / La));
  const agb = [{ t: ta, L: La, R: 17 }];
  const NA = 240;
  for (let i = 1; i <= NA; i++) {
    const rem = Math.pow(2e-4, i / NA);
    const t = i === NA ? SUN_T.agbTip : SUN_T.agbTip - (SUN_T.agbTip - ta) * rem;
    let L = i === NA ? LaTip : La * Math.pow(1 - (t - ta) / taua, -7 / 6);
    L = Math.min(L, LaTip);
    // Thermal pulses: helium-shell flashes every ~100 kyr over the last 400 kyr.
    const before = SUN_T.agbTip - t;
    if (before < 4.2e5) {
      const ph = (before % 1e5) / 1e5; // 0 just after a pulse (going back in time)
      const pulse = Math.exp(-ph * 9) * 1.0 - 0.25 * Math.sin(Math.PI * ph) ;
      L *= 1 + pulse;
    }
    agb.push({ t, L, R: giantR(L, agbT(Math.min(L, LaTip)) * (L > LaTip ? Math.pow(L / LaTip, 0.12) : 1)) });
  }
  ms = integ(agb, solveK(agb, 0.665, 0.546), 0.665);
  for (let i = 1; i < agb.length; i++) add(agb[i].t, agb[i].L, agb[i].R, ms[i]);

  // --- Superwind, planetary nebula, white dwarf ---
  const tp = SUN_T.agbTip;
  add(tp + 1.5e3, 3800, 60, 0.5415);
  add(tp + 3e3, 3500, 10, 0.5405);
  add(tp + 6e3, 3500, 0.5, 0.5405);
  add(tp + 1e4, 3000, 0.15, 0.5405);
  add(tp + 2e4, 300, 0.03, 0.5405);
  add(tp + 1e5, 50, 0.02, 0.5405);
  add(tp + 1e6, 3, 0.015, 0.5405);
  add(tp + 1e7, 0.5, 0.0135, 0.5405);
  add(tp + 1e8, 0.05, 0.013, 0.5405);
  add(T_END + 1e8, 0.011, 0.0128, 0.5405);
})();

const KT = Float64Array.from(knots.t);
const KlogL = Float64Array.from(knots.L.map(Math.log));
const KlogR = Float64Array.from(knots.R.map(Math.log));
const KM = Float64Array.from(knots.M);
export const SUN_KNOT_TIMES = KT;

let _last = 0;
function locate(t) {
  const n = KT.length;
  if (t <= KT[0]) return 0;
  if (t >= KT[n - 1]) return n - 2;
  let k = _last;
  if (!(KT[k] <= t && t < KT[k + 1])) {
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (KT[mid] <= t) lo = mid; else hi = mid; }
    k = lo;
    _last = k;
  }
  return k;
}

/** Solar mass (M☉) at time t. */
export function sunMass(t) {
  const k = locate(t);
  const w = Math.max(0, Math.min(1, (t - KT[k]) / (KT[k + 1] - KT[k])));
  return KM[k] + (KM[k + 1] - KM[k]) * w;
}

/** Solar radius in AU at time t. */
export function sunRadiusAU(t) {
  const k = locate(t);
  const w = Math.max(0, Math.min(1, (t - KT[k]) / (KT[k + 1] - KT[k])));
  return Math.exp(KlogR[k] + (KlogR[k + 1] - KlogR[k]) * w) * RSUN_AU;
}

export function sunPhase(t) {
  const age = t - T_START;
  if (age < 5e5) return 'protostar';
  if (t < SUN_T.zams) return 'pre-main-sequence';
  if (t < SUN_T.msEnd) return 'main-sequence';
  if (t < SUN_T.rgbStart) return 'subgiant';
  if (t < SUN_T.rgbTip + 6e5) return 'red-giant';
  if (t < SUN_T.agbStart) return 'helium-burning';
  if (t < SUN_T.agbTip + 3e3) return 'agb';
  if (t < SUN_T.agbTip + 5e4) return 'planetary-nebula';
  return 'white-dwarf';
}

export const SUN_PHASE_NAMES = {
  'protostar': 'Protostar',
  'pre-main-sequence': 'T Tauri star',
  'main-sequence': 'Main-sequence star',
  'subgiant': 'Subgiant',
  'red-giant': 'Red giant',
  'helium-burning': 'Helium-burning giant',
  'agb': 'Asymptotic giant',
  'planetary-nebula': 'Planetary nebula nucleus',
  'white-dwarf': 'White dwarf',
};

/** Full solar state at time t: luminosity (L☉), radius (R☉ and AU), temperature (K), mass (M☉). */
export function sunAt(t, out = {}) {
  const k = locate(t);
  const w = Math.max(0, Math.min(1, (t - KT[k]) / (KT[k + 1] - KT[k])));
  const L = Math.exp(KlogL[k] + (KlogL[k + 1] - KlogL[k]) * w);
  const R = Math.exp(KlogR[k] + (KlogR[k + 1] - KlogR[k]) * w);
  out.L = L;
  out.R = R;
  out.radiusAU = R * RSUN_AU;
  out.M = KM[k] + (KM[k + 1] - KM[k]) * w;
  out.T = TEFF_SUN * Math.pow(L / (R * R), 0.25);
  out.phase = sunPhase(t);
  return out;
}

/** Approximate sRGB colour (linear 0..1) of a black body at temperature T kelvin. */
export function blackbodyRGB(T, out = [0, 0, 0]) {
  // Fit to the CIE 1931 black-body locus (after Tanner Helland), 1000–40000 K.
  const k = Math.max(1000, Math.min(40000, T)) / 100;
  let r, g, b;
  if (k <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(k) - 161.1195681661;
    b = k <= 19 ? 0 : 138.5177312231 * Math.log(k - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(k - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(k - 60, -0.0755148492);
    b = 255;
  }
  const lin = (v) => Math.pow(Math.max(0, Math.min(255, v)) / 255, 2.2);
  out[0] = lin(r); out[1] = lin(g); out[2] = lin(b);
  return out;
}
