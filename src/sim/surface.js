// What each world looks like from space at a given moment: molten or solid,
// wet or dry, iced over or green. Driven by the scripted natural history and,
// crucially, by the sunlight the body actually receives — so moving a planet
// (or waiting for the Sun to swell) changes its face.
import { T_START } from './constants.js';
import { sunAt } from './sun.js';
import { T_GIANT_IMPACT } from './bodies.js';

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => { const u = clamp01((x - a) / (b - a)); return u * u * (3 - 2 * u); };
const GYR = 1e9, MYR = 1e6;
const _sun = {};

/** Orbit-averaged sunlight relative to present-day Earth, from luminosity and orbit. */
export function insolation(L, el, r) {
  if (el && el.bound && el.e < 1) return L / (el.a * el.a * Math.sqrt(1 - el.e * el.e));
  return L / (r * r);
}
/** Black-body equilibrium temperature (K) of a fast rotator with albedo 0.3. */
export const equilibriumTemp = (S) => 255 * Math.pow(Math.max(S, 1e-9), 0.25);

// Sunlight Earth's long-term carbon–silicate thermostat has adapted to: the
// Sun's output on the natural timeline, frozen at today's value for the future
// (by then there is too little CO₂ left to compensate for a brighter Sun).
function adaptedFlux(t) { return sunAt(Math.min(t, 0), _sun).L; }

/**
 * Earth's climate regime from the sunlight S it receives at time t.
 *   frozen     – oceans frozen to the equator
 *   temperate  – liquid oceans (may have ice caps)
 *   moist      – moist greenhouse: oceans evaporating to space
 *   desiccated – oceans gone, runaway greenhouse
 *   molten     – surface rock melts
 */
export function earthClimate(S, t) {
  const x = S / adaptedFlux(t);
  if (S > 420) return 'molten';
  if (S > 1.20) return 'desiccated';
  if (S > 1.10) return 'moist';
  if (x < 0.80) return 'frozen';
  return 'temperate';
}
export const CLIMATE_TEXT = {
  frozen: 'Frozen over',
  temperate: 'Temperate',
  moist: 'Moist greenhouse',
  desiccated: 'Runaway greenhouse',
  molten: 'Molten surface',
};

// Scripted ice-line latitude (degrees; 90 = ice-free) for the natural past.
const ICE_AGES = [
  // [start Ma, end Ma, ice-line latitude]
  [2420, 2220, 8], // Huronian snowball
  [717, 660, 5], // Sturtian snowball
  [650, 635, 5], // Marinoan snowball
  [460, 440, 55], // Late Ordovician
  [340, 265, 50], // Late Paleozoic ice age
  [34, 2.6, 68], // Antarctic ice sheet
  [2.6, -0.5, 62], // Quaternary
];
function scriptedIceLine(t) {
  const ma = -t / MYR;
  let lat = 90;
  for (const [a, b, l] of ICE_AGES) {
    const edge = Math.max(1, (a - b) * 0.12);
    const w = smooth(a + edge, a, ma) * smooth(b - edge, b, ma);
    lat = Math.min(lat, 90 - (90 - l) * w);
  }
  if (t > 0) lat = Math.min(lat, 66 + 24 * smooth(0, 60 * MYR, t)); // caps linger, then a warming Sun wins
  else if (ma < 0.5) lat = Math.min(lat, 66);
  return lat;
}

function impactHeat(t, impacts) {
  // A giant impact leaves a magma ocean that crusts over in a few million years.
  let h = 0;
  if (impacts) for (const im of impacts) {
    const dt = t - im.t;
    if (dt >= 0) h = Math.max(h, clamp01(im.severity) * Math.exp(-dt / (im.severity * 4 * MYR + 1e3)));
  }
  return h;
}

/**
 * Appearance parameters for a body.
 * @param {string} id
 * @param {number} t      time
 * @param {number} S      sunlight received (present Earth = 1)
 * @param {object} ctx    {impacts: [{t, severity}], natural: bool (still on the natural timeline)}
 */
export function bodyLook(id, t, S, ctx = {}) {
  const tau = t - T_START;
  const Teq = equilibriumTemp(S);
  // Any rock glows once sunlight alone heats it past ~1100 K.
  const solarMelt = smooth(1050, 1500, Teq);
  const hit = impactHeat(t, ctx.impacts);
  const look = { Teq, molten: Math.max(solarMelt, hit), S };

  if (id === 'earth') {
    const sinceGI = t - T_GIANT_IMPACT;
    const accretion = 1 - smooth(60 * MYR, 110 * MYR, tau); // magma ocean while assembling
    const afterGI = sinceGI >= 0 ? Math.exp(-sinceGI / (6 * MYR)) : 0;
    look.molten = Math.max(look.molten, accretion * 0.85, afterGI);
    const climate = earthClimate(S, t);
    look.climate = climate;
    const x = S / adaptedFlux(t);
    // Water: oceans condense by ~4.4 Ga; lost in a moist/runaway greenhouse.
    const condensed = smooth(-4.46 * GYR, -4.38 * GYR, t);
    const kept = ctx.waterLost ? 0 : 1 - smooth(1.10, 1.20, S);
    look.ocean = condensed * kept * (1 - clamp01(look.molten * 1.5));
    // Ice line from sunlight relative to what the thermostat is tuned for.
    const iceFromFlux = x >= 0.93 ? 90 : x <= 0.80 ? 0 : 90 * smooth(0.80, 0.93, x);
    look.iceLat = Math.min(scriptedIceLine(t), iceFromFlux);
    if (S > 1.04 && t > 0) look.iceLat = 90;
    if (look.ocean < 0.05 && x > 0.8) look.iceLat = 90;
    // Life on land: plants from ~470 Ma; photosynthesis fails as CO₂ runs out (+0.6–0.9 Gyr).
    const habitable = ctx.alive !== false && climate === 'temperate';
    look.vegetation = habitable ? smooth(-470 * MYR, -360 * MYR, t) * (1 - smooth(0.5 * GYR, 0.9 * GYR, t)) * (1 - smooth(1.02, 1.10, S)) : 0;
    look.rust = smooth(-2.45 * GYR, -2.0 * GYR, t); // oxidised red beds after the Great Oxidation
    // Atmosphere. Hadean steam/CO₂, Archean methane haze, then clear blue; steam again in a moist greenhouse.
    const steamEarly = (1 - smooth(-4.45 * GYR, -4.3 * GYR, t));
    const steamLate = ctx.waterLost ? 0 : smooth(1.08, 1.18, S) * (1 - smooth(1.6, 3.0, S));
    look.haze = Math.max(steamEarly * 0.6, smooth(-3.9 * GYR, -3.5 * GYR, t) * (1 - smooth(-2.5 * GYR, -2.3 * GYR, t)) * 0.45);
    look.cloud = Math.max(0.48, steamEarly * 0.9, steamLate * 0.97);
    if (climate === 'frozen') look.cloud = 0.15;
    look.venusian = smooth(1.22, 2.0, S) * (1 - smooth(60, 300, S)); // thick CO₂ deck once the water is gone
    look.atmosphere = (1 - smooth(200, 900, S)) * (1 - 0.5 * clamp01(look.molten));
    look.seaGreen = 1 - smooth(-2.6 * GYR, -1.8 * GYR, t); // iron-rich Archean seas
    look.lights = ctx.natural !== false && Math.abs(t) < 150 ? 1 : 0;
    look.debris = sinceGI >= 0 && sinceGI < 3000 ? Math.exp(-sinceGI / 400) : 0;
    return look;
  }

  if (id === 'moon') {
    const age = t - T_GIANT_IMPACT;
    look.molten = Math.max(look.molten, Math.exp(-Math.max(0, age) / (25 * MYR)));
    look.maria = smooth(-3.9 * GYR, -3.1 * GYR, t); // basalt floods the big basins
    look.craters = smooth(0, 300 * MYR, age);
    return look;
  }

  if (id === 'mars') {
    look.molten = Math.max(look.molten, 1 - smooth(4 * MYR, 30 * MYR, tau));
    // Wet early Mars (Noachian): lakes and perhaps a northern ocean until ~3.5 Ga.
    const coldEnough = 1 - smooth(1.6, 2.6, S);
    look.water = smooth(-4.4 * GYR, -4.3 * GYR, t) * (1 - smooth(-3.8 * GYR, -3.3 * GYR, t)) * coldEnough;
    look.atmosphere = Math.max(0.12, 0.8 * (1 - smooth(-4.1 * GYR, -3.5 * GYR, t)));
    look.rust = smooth(-3.6 * GYR, -2.8 * GYR, t);
    look.iceCap = S < 0.9 ? 1 : 1 - smooth(0.9, 2.0, S);
    return look;
  }

  if (id === 'venus') {
    look.molten = Math.max(look.molten, 1 - smooth(40 * MYR, 110 * MYR, tau));
    // Early Venus may have kept water for a while before its runaway greenhouse.
    const runaway = Math.max(smooth(-4.2 * GYR, -3.6 * GYR, t), smooth(1.35, 1.6, S));
    look.water = (1 - runaway) * smooth(-4.45 * GYR, -4.38 * GYR, t);
    look.cloudDeck = Math.max(0.35, runaway) * (1 - smooth(300, 1500, S));
    return look;
  }

  if (id === 'mercury' || id === 'theia' || id === 'pluto') {
    const cool = id === 'theia' ? 0.7 : 1 - smooth(8 * MYR, 60 * MYR, tau);
    look.molten = Math.max(look.molten, cool);
    look.craters = smooth(50 * MYR, 400 * MYR, tau);
    return look;
  }

  // Giants.
  look.young = Math.exp(-tau / (25 * MYR)); // still glowing with the heat of formation
  look.hot = smooth(350, 1200, Teq); // roasted by the giant Sun
  if (id === 'saturn') {
    // The bright rings are probably young (≲ 400 Myr) and are raining into the planet.
    const natural = smooth(-140 * MYR, -90 * MYR, t) * (1 - smooth(120 * MYR, 320 * MYR, t));
    look.rings = natural * (1 - smooth(8, 40, S));
  }
  return look;
}

/** One-line description of what the surface is doing, for the info panel. */
export function describeLook(id, look, kind) {
  if (kind === 'gas' || kind === 'ice') {
    if (look.young > 0.4) return 'Still glowing from formation';
    if (look.hot > 0.3) return 'Atmosphere being boiled off';
    return null;
  }
  if (look.molten > 0.6) return 'Magma ocean';
  if (look.molten > 0.15) return 'Partly molten crust';
  if (id === 'earth') {
    if (look.climate === 'frozen') return look.ocean > 0.05 ? 'Frozen over — a snowball' : 'Frozen desert';
    if (look.climate === 'moist') return 'Oceans evaporating';
    if (look.climate === 'desiccated') return 'Oceans gone — runaway greenhouse';
    if (look.ocean < 0.05) return 'Dry rock';
    if (look.iceLat < 20) return 'Snowball Earth';
    if (look.vegetation > 0.3) return 'Living world';
    return look.iceLat < 75 ? 'Oceans with polar ice' : 'Ocean world, ice-free';
  }
  if (id === 'mars') return look.water > 0.3 ? 'Rivers, lakes and seas' : 'Cold desert';
  if (id === 'venus') return look.water > 0.3 ? 'Possibly temperate, with seas' : 'Runaway greenhouse';
  return null;
}
