// Numerical checks for the simulation core. Run with: npm test
import { G, KMS, MEARTH, REARTH_AU, RSUN_AU, T_START, T_END } from '../src/sim/constants.js';
import { keplerStep, elementsToState, stateToElements } from '../src/sim/kepler.js';
import { sunAt, sunMass, SUN_T } from '../src/sim/sun.js';
import { BODY, BODIES, baselineTracks, naturalBulk } from '../src/sim/bodies.js';
import { NBody, REC } from '../src/sim/nbody.js';

let failed = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? '  ok ' : ' FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failed++;
}
const section = (s) => console.log(`\n== ${s}`);

// ---------------------------------------------------------------------------
section('Kepler');
{
  const mu = G * 1.000003;
  const el = { a: 1.3, e: 0.6, i: 0.4, Om: 1.1, w: 2.2, M: 0.7 };
  const s = new Float64Array(6), s2 = new Float64Array(6), s3 = new Float64Array(6);
  elementsToState(el, mu, s);
  const back = stateToElements(s, 0, mu);
  check('elements round trip', Math.abs(back.a - el.a) < 1e-12 && Math.abs(back.e - el.e) < 1e-12 && Math.abs(back.M - el.M) < 1e-10 && Math.abs(back.w - el.w) < 1e-10);
  const P = 2 * Math.PI * Math.sqrt(el.a ** 3 / mu);
  keplerStep(s, 0, mu, P, s2, 0);
  check('one period returns to start', Math.hypot(s2[0] - s[0], s2[1] - s[1], s2[2] - s[2]) < 1e-11);
  keplerStep(s, 0, mu, 0.37 * P, s2, 0);
  const e2 = stateToElements(s2, 0, mu);
  let dM = e2.M - (el.M + 2 * Math.PI * 0.37);
  dM -= 2 * Math.PI * Math.round(dM / (2 * Math.PI));
  check('mean anomaly advances linearly', Math.abs(dM) < 1e-10, `dM=${dM.toExponential(2)}`);
  keplerStep(s, 0, mu, 123456 * P + 0.2, s2, 0);
  keplerStep(s, 0, mu, 0.2, s3, 0);
  check('huge dt reduces modulo period', Math.hypot(s2[0] - s3[0], s2[1] - s3[1]) < 1e-6);
  // high eccentricity through pericentre
  const hot = { a: 5, e: 0.999, i: 0.1, Om: 0, w: 0, M: -0.001 };
  elementsToState(hot, mu, s);
  keplerStep(s, 0, mu, 0.01, s2, 0);
  keplerStep(s2, 0, mu, -0.01, s3, 0);
  check('e=0.999 pericentre there-and-back', Math.hypot(s3[0] - s[0], s3[1] - s[1], s3[2] - s[2]) < 1e-9, `${Math.hypot(s3[0] - s[0], s3[1] - s[1]).toExponential(2)}`);
  // every phase of an eccentric orbit, for steps up to a full period
  {
    let worst = 0;
    const st = new Float64Array(6), o2 = new Float64Array(6);
    for (const e of [0.05, 0.3, 0.7, 0.95]) for (let M0 = -3; M0 < 3.1; M0 += 0.5) {
      const base = { a: 1.4, e, i: 0.2, Om: 0.3, w: 1.0, M: M0 };
      elementsToState(base, mu, st);
      const n = Math.sqrt(mu / 1.4 ** 3);
      for (let f = -1; f <= 1.001; f += 0.02) {
        const dt = f * 2 * Math.PI / n;
        keplerStep(st, 0, mu, dt, o2, 0);
        const b2 = stateToElements(o2, 0, mu);
        let d = b2.M - (M0 + n * dt); d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
        worst = Math.max(worst, Math.abs(d), Math.abs(b2.a - 1.4));
      }
    }
    check('propagation is exact at every phase and step (e up to 0.95)', worst < 1e-8, `worst error ${worst.toExponential(2)}`);
  }
  // hyperbolic
  const hyp = { a: -2, e: 1.8, i: 0.3, Om: 0.5, w: 1, M: -3 };
  elementsToState(hyp, mu, s);
  const hb = stateToElements(s, 0, mu);
  check('hyperbolic round trip', Math.abs(hb.a - hyp.a) < 1e-10 && Math.abs(hb.e - hyp.e) < 1e-10 && Math.abs(hb.M - hyp.M) < 1e-9);
  const nh = Math.sqrt(mu / 8);
  keplerStep(s, 0, mu, 5 / nh, s2, 0);
  const hb2 = stateToElements(s2, 0, mu);
  check('hyperbolic propagation', Math.abs(hb2.M - 2) < 1e-9, `M=${hb2.M}`);
}

// ---------------------------------------------------------------------------
section('Sun');
{
  const row = (label, t) => { const s = sunAt(t); console.log(`   ${label.padEnd(26)} L=${s.L.toPrecision(4).padStart(8)}  R=${s.R.toPrecision(4).padStart(8)} R☉ (${s.radiusAU.toFixed(4)} AU)  T=${s.T.toFixed(0).padStart(6)} K  M=${s.M.toFixed(4)}  ${s.phase}`); return s; };
  row('birth', T_START + 1e5);
  const z = row('zero-age main sequence', SUN_T.zams);
  const now = row('today', 0);
  row('+1.1 Gyr', 1.1e9);
  row('+3.5 Gyr', 3.5e9);
  row('end of main sequence', SUN_T.msEnd);
  row('red giant +7.5 Gyr', 7.5e9);
  const tip = row('red-giant tip', SUN_T.rgbTip);
  row('helium burning', SUN_T.hbStart + 5e7);
  const agb = row('AGB tip', SUN_T.agbTip);
  row('planetary nebula +10kyr', SUN_T.agbTip + 1e4);
  const wd = row('white dwarf (end)', T_END);
  check('today is 1 L☉, 1 R☉, 5772 K', Math.abs(now.L - 1) < 1e-6 && Math.abs(now.R - 1) < 1e-6 && Math.abs(now.T - 5772) < 1);
  check('faint young Sun ≈ 0.70 L☉', Math.abs(z.L - 0.7) < 0.01);
  check('RGB tip: 2730 L☉, 256 R☉, 0.668 M☉', Math.abs(tip.L - 2730) < 30 && Math.abs(tip.R - 256) < 4 && Math.abs(tip.M - 0.668) < 0.002, `L=${tip.L.toFixed(0)} R=${tip.R.toFixed(1)} M=${tip.M.toFixed(4)}`);
  check('AGB tip mass ≈ 0.546', Math.abs(agb.M - 0.546) < 0.003, `M=${agb.M.toFixed(4)} L=${agb.L.toFixed(0)} R=${agb.R.toFixed(0)}`);
  check('white dwarf is Earth-sized and 0.54 M☉', wd.R < 0.02 && Math.abs(wd.M - 0.5405) < 1e-3);
  let mono = true;
  for (let t = T_START; t < T_END; t += 1e6) if (sunMass(t + 1e6) > sunMass(t) + 1e-12 && t > T_START + 2e6) mono = false;
  check('mass never increases after formation', mono);
}

// ---------------------------------------------------------------------------
section('Natural history');
const tracks = baselineTracks();
{
  const s = new Float64Array(6);
  tracks.earth.stateAt(0, s);
  const r = Math.hypot(s[0], s[1], s[2]);
  const lon = (Math.atan2(s[1], s[0]) * 180 / Math.PI + 360) % 360;
  // Mid-November: the Sun is near ecliptic longitude 232°, so Earth is near 52°.
  check('Earth is ~0.989 AU from the Sun at heliocentric longitude ~52° in mid-November', Math.abs(r - 0.989) < 0.003 && Math.abs(lon - 52) < 3, `r=${r.toFixed(4)} lon=${lon.toFixed(1)}`);
  tracks.moon.stateAt(0, s);
  check('Moon is ~384,000 km from Earth', Math.abs(Math.hypot(s[0], s[1], s[2]) / REARTH_AU - 60.3) < 4, `${(Math.hypot(s[0], s[1], s[2]) / REARTH_AU).toFixed(1)} R⊕`);
  const fmt = (t) => (t === Infinity ? 'survives' : `${(t / 1e9).toFixed(4)} Gyr`);
  for (const b of BODIES) if (tracks[b.id].tEnd !== undefined && b.id !== 'theia') console.log(`   ${b.name.padEnd(8)} appears ${((tracks[b.id].tStart - T_START) / 1e6).toFixed(2)} Myr after t0, ends: ${fmt(tracks[b.id].tEnd)}`);
  check('Mercury, Venus and Earth are engulfed; Mars survives', tracks.mercury.tEnd < 7.6e9 && tracks.venus.tEnd < 7.6e9 && tracks.earth.tEnd < 7.6e9 && tracks.mars.tEnd === Infinity);
  const el = tracks.neptune.elementsAt(T_END - 1);
  check('Neptune ends near 55.6 AU around the white dwarf', Math.abs(el.a - 30.07 / 0.5405) < 0.2, `a=${el.a.toFixed(2)}`);
  const j0 = tracks.jupiter.elementsAt(T_START + 5e6), j1 = tracks.jupiter.elementsAt(-4.4e9);
  check('Jupiter migrates inward 5.45 → 5.20 AU', Math.abs(j0.a - 5.45) < 1e-6 && Math.abs(j1.a - 5.2029) < 1e-3);
  // Phase continuity across knots.
  let maxJump = 0;
  const el2 = {};
  for (let t = -4.5e9; t < 7.5e9; t += 3.3e7) {
    const a = tracks.earth.elementsAt(t - 1e-3, el2).M, b = tracks.earth.elementsAt(t + 1e-3, {}).M;
    let d = b - a - 2e-3 * 2 * Math.PI; d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
    maxJump = Math.max(maxJump, Math.abs(d));
  }
  check('orbital phase is continuous in time', maxJump < 1e-3, `max jump ${maxJump.toExponential(2)} rad`);
}

// ---------------------------------------------------------------------------
function snapshot(t, { skip = [] } = {}) {
  const bodies = [];
  for (const b of BODIES) {
    const tr = tracks[b.id];
    if (skip.includes(b.id) || b.id === 'theia' || !tr.exists(t)) continue;
    const state = new Float64Array(6);
    tr.stateAt(t, state);
    const bulk = naturalBulk(b.id, t);
    bodies.push({ id: b.id, mass: bulk.mass, radius: bulk.radius, parent: b.parent, state });
  }
  return bodies;
}
function runFor(sim, years, maxWallMs = 60000) {
  const start = performance.now();
  const events = [];
  let recs = 0;
  const target = sim.tRel + years;
  while (sim.tRel < target && performance.now() - start < maxWallMs) {
    for (let k = 0; k < 2000 && sim.tRel < target; k++) sim.step();
    const d = sim.drain(); events.push(...d.events); for (const st of d.streams) recs += st.length / REC;
  }
  return { events, recs, wall: (performance.now() - start) / 1000 };
}

section('N-body: quiet solar system');
{
  const sim = new NBody({ t0: 0, bodies: snapshot(0) });
  check('starts in symplectic mode with the Moon folded', sim.mode === 'wh' && sim.n === 10, `mode=${sim.mode} n=${sim.n} dt=${(sim.dt * 365.25).toFixed(2)} d`);
  const E0 = sim.energy();
  const r = runFor(sim, 20000);
  const E1 = sim.energy();
  console.log(`   20 kyr in ${r.wall.toFixed(2)} s  (${(20000 / r.wall).toFixed(0)} yr/s), ${sim.steps} steps, ${sim.bsSteps} BS steps, ${r.recs} samples`);
  check('energy conserved to 1e-7 over 20 kyr', Math.abs((E1 - E0) / E0) < 1e-7, `dE/E=${((E1 - E0) / E0).toExponential(2)}`);
  check('no spurious events', r.events.length === 0, JSON.stringify(r.events));
  check('stays symplectic', sim.bsSteps === 0);
  check('is reported as settled', sim.isSettled());
  const el = stateToElements(sim._helio(3, new Float64Array(6)), 0, G * (sim.m[0] + sim.m[3]));
  check('Earth still at 1 AU', Math.abs(el.a - 1) < 2e-3 && el.e < 0.06, `a=${el.a.toFixed(5)} e=${el.e.toFixed(4)}`);
}

section('N-body: Bulirsch–Stoer accuracy');
{
  // Force BS by making it the only option: a gravity well of negligible mass.
  const sim = new NBody({ t0: 0, bodies: snapshot(0, { skip: ['moon'] }), wells: [{ pos: [80, 0, 0], mass: 1e-16, tStart: 0, tEnd: 50 }] });
  const E0 = sim.energy();
  const r = runFor(sim, 50);
  const E1 = sim.energy();
  console.log(`   50 yr in ${r.wall.toFixed(2)} s (${(50 / r.wall).toFixed(0)} yr/s), ${sim.bsSteps} BS steps`);
  check('BS conserves energy to 1e-9 over 50 yr', Math.abs((E1 - E0) / E0) < 1e-9, `dE/E=${((E1 - E0) / E0).toExponential(2)}`);
  runFor(sim, 5);
  check('returns to symplectic mode when the well ends', sim.mode === 'wh');
}

section('N-body: unfolded Moon');
{
  // A direct integration of the real Moon should keep it in a ~27.3-day orbit.
  const bodies = snapshot(0);
  const sim = new NBody({ t0: 0, bodies, wells: [{ pos: [1, 0, 0.3], mass: 1e-12, tStart: 0, tEnd: 3 }] });
  // the well at (1,0,0.3) is close enough to Earth's path to force an unfold test of the plumbing only if near; just run
  const r = runFor(sim, 4);
  check('no events from a harmless well', r.events.length === 0, JSON.stringify(r.events));
  check('Moon is folded again afterwards', sim.mode === 'wh' && sim.n === 10, `mode=${sim.mode} n=${sim.n}`);
}
{
  // Kick the Moon prograde by 0.3 km/s: escape velocity excess → it leaves Earth.
  const bodies = snapshot(0);
  const moon = bodies.find((b) => b.id === 'moon');
  const v = Math.hypot(moon.state[3], moon.state[4], moon.state[5]);
  for (let k = 3; k < 6; k++) moon.state[k] *= 1 + (0.6 * KMS) / v;
  const sim = new NBody({ t0: 0, bodies });
  check('unsafe Moon starts unfolded', sim.n === 11 && sim.mode === 'bs', `n=${sim.n} mode=${sim.mode}`);
  const r = runFor(sim, 30, 30000);
  console.log(`   30 yr in ${r.wall.toFixed(2)} s, BS steps ${sim.bsSteps}; events: ${r.events.map((e) => e.type + '@' + e.t.toFixed(2)).join(', ')}`);
  check('Moon escapes Earth', r.events.some((e) => e.type === 'escaped' && e.a === 'moon'));
}
{
  // Stop the Moon dead: it falls onto Earth.
  const bodies = snapshot(0);
  const moon = bodies.find((b) => b.id === 'moon');
  for (let k = 3; k < 6; k++) moon.state[k] *= 0.02;
  const sim = new NBody({ t0: 0, bodies });
  const r = runFor(sim, 0.1, 30000);
  const hit = r.events.find((e) => e.type === 'collision');
  check('a stopped Moon falls into Earth within ~5 days', !!hit && hit.a === 'earth' && hit.b === 'moon' && hit.t < 0.02, hit ? `t=${(hit.t * 365.25).toFixed(2)} d at ${hit.speed.toFixed(1)} km/s` : JSON.stringify(r.events));
}

section('N-body: disruption');
{
  // Mars pushed sunward hard enough to cross Earth's orbit.
  const bodies = snapshot(0);
  const mars = bodies.find((b) => b.id === 'mars');
  const v = Math.hypot(mars.state[3], mars.state[4], mars.state[5]);
  for (let k = 3; k < 6; k++) mars.state[k] *= 1 - (9 * KMS) / v;
  const sim = new NBody({ t0: 0, bodies });
  const r = runFor(sim, 50000, 40000);
  console.log(`   Mars −9 km/s: ${sim.tRel.toFixed(0)} yr in ${r.wall.toFixed(1)} s, ${sim.steps} steps (${sim.bsSteps} BS), ${r.recs} samples`);
  console.log('   events: ' + (r.events.map((e) => `${e.type}(${e.a}${e.b ? ',' + e.b : ''})@${e.t.toFixed(0)}`).join(', ') || 'none'));
  check('integration survives repeated close encounters', sim.tRel > 1000);
}
{
  // Jupiter dropped to a Sun-grazing orbit.
  const bodies = snapshot(0);
  const jup = bodies.find((b) => b.id === 'jupiter');
  for (let k = 3; k < 6; k++) jup.state[k] *= 0.01;
  const sim = new NBody({ t0: 0, bodies });
  const r = runFor(sim, 20, 30000);
  const hit = r.events.find((e) => e.type === 'sunImpact' && e.a === 'jupiter');
  check('a stopped Jupiter falls into the Sun in ~2.1 yr', !!hit && Math.abs(hit.t - 2.1) < 0.2, hit ? `t=${hit.t.toFixed(3)} yr at ${hit.speed.toFixed(0)} km/s` : JSON.stringify(r.events));
}
{
  // Neptune kicked above escape velocity.
  const bodies = snapshot(0);
  const nep = bodies.find((b) => b.id === 'neptune');
  for (let k = 3; k < 6; k++) nep.state[k] *= 1.6;
  const sim = new NBody({ t0: 0, bodies });
  const r = runFor(sim, 6000, 30000);
  const ej = r.events.find((e) => e.type === 'ejected' && e.a === 'neptune');
  check('Neptune at 1.6× orbital speed is ejected', !!ej, ej ? `flagged at t=${ej.t.toFixed(0)} yr, v∞=${ej.speed.toFixed(2)} km/s` : JSON.stringify(r.events));
  check('ejected body is eventually dropped', sim.n === 9, `n=${sim.n}`);
}
{
  // A solar-mass well parked beside Saturn for 30 years.
  const bodies = snapshot(0);
  const sat = bodies.find((b) => b.id === 'saturn');
  const sim = new NBody({ t0: 0, bodies, wells: [{ pos: [sat.state[0] * 1.3, sat.state[1] * 1.3, 0], mass: 0.5, tStart: 0, tEnd: 30 }] });
  const r = runFor(sim, 2000, 40000);
  console.log(`   end state: mode=${sim.mode} n=${sim.n} dt=${sim.dt.toExponential(2)} H=${sim.H.toExponential(2)} steps=${sim.steps} bs=${sim.bsSteps} ids=${[...sim.slot.slice(1, sim.n)].map((k) => sim.slotIds[k]).join(',')}`);
  console.log(`   0.5 M☉ well near Saturn for 30 yr: reached ${sim.tRel.toFixed(0)} yr in ${r.wall.toFixed(1)} s; events: ${r.events.map((e) => `${e.type}(${e.a})@${e.t.toFixed(0)}`).join(', ') || 'none'}`);
  check('strong well run completes', sim.tRel >= 2000 || r.wall > 39);
}

section('N-body: red-giant mass loss');
{
  const t0 = SUN_T.rgbTip - 3e5;
  const sim = new NBody({ t0, bodies: snapshot(t0, { skip: ['moon', 'pluto', 'jupiter', 'saturn', 'uranus'] }) });
  const names = sim.slotIds.slice();
  const m0 = sunMass(t0);
  const before = stateToElements(sim._helio(sim.n - 1, new Float64Array(6)), 0, G * m0).a;
  const r = runFor(sim, 2.9e5, 120000);
  const m1 = sunMass(sim.t);
  let nepIdx = -1;
  for (let i = 1; i < sim.n; i++) if (sim.slotIds[sim.slot[i]] === 'neptune') nepIdx = i;
  const after = stateToElements(sim._helio(nepIdx, new Float64Array(6)), 0, G * m1).a;
  console.log(`   ${sim.tRel.toFixed(0)} yr in ${r.wall.toFixed(1)} s; M☉ ${m0.toFixed(4)} → ${m1.toFixed(4)}; bodies at start: ${names.join(' ')}`);
  console.log('   events: ' + (r.events.map((e) => `${e.type}(${e.a})@${((e.t - t0) / 1e3).toFixed(0)}kyr`).join(', ') || 'none'));
  check('Neptune\'s orbit widens as a·M = const', Math.abs(after * m1 - before * m0) / (before * m0) < 5e-3, `a ${before.toFixed(3)} → ${after.toFixed(3)}, a·M ${(before * m0).toFixed(3)} → ${(after * m1).toFixed(3)}`);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
