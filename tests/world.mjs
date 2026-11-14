// Checks for the world line / branching layer, with the N-body run inline.
import { World } from '../src/sim/world.js';
import { NBody } from '../src/sim/nbody.js';
import { KMS, REARTH_AU, T_END } from '../src/sim/constants.js';
import { formatTime, formatTimeShort, eraName } from '../src/sim/history.js';
import { bodyLook, describeLook } from '../src/sim/surface.js';

let failed = 0;
const check = (name, cond, detail = '') => { console.log(`${cond ? '  ok ' : ' FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!cond) failed++; };

// A fake worker: each job can be advanced by hand.
const jobs = [];
function spawn(spec, onChunk) {
  const sim = new NBody(spec);
  const job = {
    sim, cancelled: false,
    advance(years) {
      const target = sim.tRel + years;
      while (sim.tRel < target && !job.cancelled) {
        for (let k = 0; k < 500 && sim.tRel < target; k++) sim.step();
        sim.emit(0);
        const d = sim.drain();
        onChunk({ tRel: sim.tRel, streams: d.streams, wells: d.wells, events: d.events, done: false, status: 'running', rate: 1 });
      }
    },
    cancel() { job.cancelled = true; },
  };
  jobs.push(job);
  return job;
}

const world = new World(spawn);
console.log('\n== Natural timeline');
{
  const s = world.stateAt(0);
  const e = s.bodies.find((b) => b.id === 'earth'), m = s.bodies.find((b) => b.id === 'moon');
  check('Earth exists today at ~1 AU with S≈1', e.exists && Math.abs(e.r - 0.989) < 0.01 && Math.abs(e.S - 1) < 0.01, `r=${e.r.toFixed(3)} S=${e.S.toFixed(3)}`);
  check('Moon orbits Earth', m.exists && m.parent === 'earth' && Math.abs(Math.hypot(m.pos[0] - e.pos[0], m.pos[1] - e.pos[1], m.pos[2] - e.pos[2]) / REARTH_AU - 60) < 5);
  const s2 = world.stateAt(-4.52e9);
  const th = s2.bodies.find((b) => b.id === 'theia'), e2 = s2.bodies.find((b) => b.id === 'earth');
  const ang = Math.atan2(th.pos[1], th.pos[0]) - Math.atan2(e2.pos[1], e2.pos[0]);
  check('Theia leads the proto-Earth by ~60° before the impact', th.exists && Math.abs((((ang * 180 / Math.PI) % 360) + 360) % 360 - 60) < 16, `${((((ang * 180 / Math.PI) % 360) + 360) % 360).toFixed(1)}°`);
  check('no Moon before the giant impact', !s2.bodies.find((b) => b.id === 'moon').exists);
  const ev = world.events();
  console.log('   ' + ev.length + ' natural events; future: ' + ev.filter((x) => x.t > 0).map((x) => `${x.title} (${formatTimeShort(x.t)})`).join(' · '));
  check('engulfment and ocean-loss events are derived', ev.some((x) => x.id === 'engulf-earth') && ev.some((x) => x.title.includes('boil away')) && ev.some((x) => x.title.includes('oceans are gone')));
  const boil = ev.find((x) => x.title.includes('boil away')), dry = ev.find((x) => x.title.includes('oceans are gone'));
  check('oceans start boiling ~1.1 Gyr and are gone ~2 Gyr from now', Math.abs(boil.t - 1.08e9) < 1e8 && Math.abs(dry.t - 2.0e9) < 2e8, `${formatTimeShort(boil.t)}, ${formatTimeShort(dry.t)}`);
  for (const [t, step] of [[-4.568e9, 1e6], [-66e6, 1e5], [-12400, 100], [0, 1], [0.0001, 0.001], [150, 1], [1.1e9, 1e7], [7.59e9, 1e3]]) console.log(`   ${String(t).padStart(12)}  ${formatTime(t, step).padEnd(34)} ${formatTimeShort(t).padEnd(10)} ${eraName(t)}`);
  for (const t of [-4.5e9, -4.2e9, -3e9, -2.3e9, -7e8, -3e8, 0, 1.5e9, 3e9, 7.58e9]) {
    const st = world.stateAt(t); const b = st.bodies.find((x) => x.id === 'earth');
    const look = bodyLook('earth', t, b.S, world.earthStatus(t));
    console.log(`   Earth ${formatTimeShort(t).padEnd(9)} S=${b.S.toFixed(2).padStart(7)} ${String(look.climate).padEnd(10)} molten=${look.molten.toFixed(2)} ocean=${look.ocean.toFixed(2)} ice=${look.iceLat.toFixed(0).padStart(2)}° veg=${look.vegetation.toFixed(2)} cloud=${look.cloud.toFixed(2)}  ${describeLook('earth', look, 'rocky')}`);
  }
}

console.log('\n== Intervention: push Earth outward 100 Myr ago');
{
  const t = -100e6;
  const st = world.stateAt(t);
  const e = st.bodies.find((b) => b.id === 'earth');
  const v = Math.hypot(e.vel[0], e.vel[1], e.vel[2]);
  const dv = [e.vel[0] / v * 4 * KMS, e.vel[1] / v * 4 * KMS, e.vel[2] / v * 4 * KMS];
  const iv = world.apply({ t, type: 'nudge', bodyId: 'earth', dv, label: 'prograde' });
  check('intervention recorded', !!iv && world.interventions.length === 1);
  const s0 = world.stateAt(t);
  check('state is continuous at the instant of the nudge', Math.hypot(s0.bodies[2].pos[0] - e.pos[0], s0.bodies[2].pos[1] - e.pos[1]) < 1e-9);
  jobs[0].advance(3000);
  const br = iv.branch;
  console.log(`   resolved ${br.resolved.toFixed(0)} yr; samples per body: ${br.streams.map((x) => x.n).join(',')}`);
  const s1 = world.stateAt(t + 1500);
  const e1 = s1.bodies.find((b) => b.id === 'earth'), m1 = s1.bodies.find((b) => b.id === 'moon');
  check('Earth now on a wider, eccentric orbit', e1.el.a > 1.25 && e1.el.e > 0.2, `a=${e1.el.a.toFixed(3)} e=${e1.el.e.toFixed(3)} S=${e1.S.toFixed(2)}`);
  check('Moon came along', m1.exists && m1.parent === 'earth' && Math.hypot(m1.rel[0], m1.rel[1], m1.rel[2]) / REARTH_AU < 80, `d=${(Math.hypot(m1.rel[0], m1.rel[1], m1.rel[2]) / REARTH_AU).toFixed(1)} R⊕`);
  // smoothness of interpolated motion
  let maxJump = 0, prev = null;
  for (let tt = t + 1000; tt < t + 1010; tt += 0.01) {
    const s = world.stateAt(tt).bodies[2];
    if (prev) maxJump = Math.max(maxJump, Math.hypot(s.pos[0] - prev[0], s.pos[1] - prev[1]) - Math.hypot(s.vel[0], s.vel[1]) * 0.01);
    prev = [s.pos[0], s.pos[1]];
  }
  check('interpolated motion is smooth', maxJump < 1e-3, `max excess step ${maxJump.toExponential(2)} AU`);
  const sP = world.stateAt(t + 5e6);
  check('beyond the horizon the state is a projection', sP.projected && sP.bodies[2].exists && Math.abs(sP.bodies[2].el.a - e1.el.a) < 0.05);
  const ev = world.events();
  const averted = ev.filter((x) => x.averted).map((x) => x.title);
  console.log('   averted: ' + averted.join(' · '));
  console.log('   new: ' + ev.filter((x) => !x.natural).map((x) => `${x.title} (${formatTimeShort(x.t)}${x.projected ? ', projected' : ''})`).join(' · '));
  check('Chicxulub is averted, the Sun\'s fate is not', averted.includes('Chicxulub impact') && !averted.includes('Helium flash'));
  check('Earth freezes and later life is averted', ev.some((x) => x.title === 'Earth freezes over') && averted.includes('Homo sapiens'));
  const look = bodyLook('earth', t + 1500, e1.S, world.earthStatus(t + 1500));
  console.log(`   Earth look: ${describeLook('earth', look, 'rocky')} (ice line ${look.iceLat.toFixed(0)}°, vegetation ${look.vegetation.toFixed(2)})`);
  check('before the nudge the world is untouched', world.stateAt(t - 10).bodies[2].el.a < 1.01 && !world.stateAt(t - 10).intervention);
  const segs = world.segments();
  check('timeline has natural, simulated and projected segments', segs.length === 3 && segs[1].kind === 'simulated' && segs[2].kind === 'projected');
}

console.log('\n== Second intervention, then undo');
{
  const t2 = -100e6 + 2000;
  const iv2 = world.apply({ t: t2, type: 'well', pos: [3, 0, 0], mass: 0.01, duration: 20 });
  check('second intervention stacks', world.interventions.length === 2 && jobs[0].cancelled);
  jobs[1].advance(200);
  const sw = world.stateAt(t2 + 5);
  check('well is reported while active (the Sun is pulled toward it)', sw.wells.length === 1 && sw.wells[0].pos[0] < 3 && sw.wells[0].pos[0] > 2, JSON.stringify(sw.wells.map((w) => w.pos.map((x) => +x.toFixed(3)))));
  check('well is gone afterwards', world.stateAt(t2 + 50).wells.length === 0);
  world.undo();
  check('undo removes it and resumes the first branch', world.interventions.length === 1 && jobs.length === 3 && !jobs[2].cancelled);
  const before = world.lastBranch.resolved;
  jobs[2].advance(2000);
  check('resumed branch keeps extending', world.lastBranch.resolved > before + 1900, `${before.toFixed(0)} → ${world.lastBranch.resolved.toFixed(0)}`);
  const s = world.stateAt(-100e6 + 4000);
  check('state is valid in the resumed stretch', s.bodies[2].exists && s.bodies[2].el.a > 1.25 && !s.projected);
  world.apply({ t: -200e6, type: 'nudge', bodyId: 'mars', dv: [0, 0, 0.1] });
  check('an earlier intervention replaces later ones', world.interventions.length === 1 && world.interventions[0].t === -200e6);
  world.reset();
  check('reset restores natural history', world.interventions.length === 0 && !world.events().some((x) => x.averted));
}

console.log('\n== Collision bookkeeping');
{
  const t = 1000;
  const st = world.stateAt(t);
  const m = st.bodies.find((b) => b.id === 'moon');
  const iv = world.apply({ t, type: 'nudge', bodyId: 'moon', dv: [-m.rel[3] * 0.98, -m.rel[4] * 0.98, -m.rel[5] * 0.98], label: 'stop' });
  jobs[jobs.length - 1].advance(5);
  const ev = world.events();
  const hit = ev.find((x) => x.kind === 'dynamics');
  check('Moon impact is flagged', !!hit && hit.title === 'Moon collides with Earth', hit ? `${hit.title} — ${hit.text}` : '');
  const after = world.stateAt(t + 2);
  check('Moon is gone, Earth is molten', !after.bodies.find((b) => b.id === 'moon').exists && bodyLook('earth', t + 2, 1, world.earthStatus(t + 2)).molten > 0.3);
  const f = world.fateOf('moon', t + 2);
  check('fate of the Moon is recorded', f && f.type === 'collision' && f.by === 'earth');
  check('life on Earth is averted from then on', ev.find((x) => x.id === 'photosynthesis').averted);
  world.reset();
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
