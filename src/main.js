import { World } from './sim/world.js';
import { Renderer } from './render/renderer.js';
import { Timeline } from './ui/timeline.js';
import { BODIES, BODY } from './sim/bodies.js';
import { T_START, T_END, T_INTERVENE_MIN, KMS, MEARTH, MJUP, AU_KM, RSUN_AU, YEAR_S, ENGULF_FACTOR } from './sim/constants.js';
import { SUN_PHASE_NAMES } from './sim/sun.js';
import { stateToElements } from './sim/kepler.js';
import { formatTime, formatTimeShort, formatSpan, eraName } from './sim/history.js';
import { describeLook } from './sim/surface.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Playback rates, in simulated years per real second.
const RATES = [
  [1 / YEAR_S, 'real time'], [1 / 8766, '1 hour / s'], [1 / 365.25, '1 day / s'], [7 / 365.25, '1 week / s'], [1 / 12, '1 month / s'],
  [1, '1 year / s'], [10, '10 years / s'], [100, '100 years / s'], [1e3, '1,000 years / s'], [1e4, '10,000 years / s'],
  [1e5, '100,000 years / s'], [1e6, '1 million years / s'], [1e7, '10 million years / s'], [1e8, '100 million years / s'],
];
const KIND_NAME = { rocky: 'Rocky planet', gas: 'Gas giant', ice: 'Ice giant', dwarf: 'Dwarf planet', moon: 'Moon' };

// --- simulation plumbing ----------------------------------------------------
let jobSeq = 0;
function spawnJob(spec, onChunk) {
  const worker = new Worker(new URL('./sim/worker.js', import.meta.url), { type: 'module' });
  const job = ++jobSeq;
  worker.onmessage = (e) => { if (e.data.job === job) onChunk(e.data); if (e.data.done) worker.terminate(); };
  worker.onerror = (e) => console.error('simulation worker failed', e.message);
  worker.postMessage({ type: 'start', job, ...spec });
  return { cancel: () => worker.terminate() };
}

const world = new World(spawnJob);
const renderer = new Renderer($('view'));
const app = {
  t: 0, tPrev: 0, playing: false, dir: 1, rateIdx: 11,
  tool: null, nudge: { dir: 'prograde', u: 0.62 }, well: { pos: null, mu: 0.55, du: 0.4 },
  state: world.makeState(),
  scrubbing: false,
};
window.__longnow = { world, renderer, app }; // handy in the console

const timeline = new Timeline($('timeline'), {
  onScrub: (t) => { app.t = t; app.playing = false; app.scrubbing = true; syncTransport(); },
  onJump: (ev) => jumpTo(ev),
  onHover: (ev, x, y, t) => showTip(ev, x, y, t),
});

// --- transport --------------------------------------------------------------
function syncTransport() {
  $('btn-play').textContent = app.playing && app.dir > 0 ? '❚❚' : '▶';
  $('btn-play').classList.toggle('on', app.playing && app.dir > 0);
  $('btn-rev').classList.toggle('on', app.playing && app.dir < 0);
  $('btn-rev').textContent = app.playing && app.dir < 0 ? '❚❚' : '◀';
  $('speed').value = app.rateIdx;
  $('speed-out').textContent = RATES[app.rateIdx][1];
}
function play(dir) {
  if (app.playing && app.dir === dir) app.playing = false;
  else {
    app.dir = dir; app.playing = true;
    if (dir > 0 && app.t >= T_END) app.t = T_START;
    if (dir < 0 && app.t <= T_START) app.t = T_END;
  }
  syncTransport();
}
function setRate(i) { app.rateIdx = Math.max(0, Math.min(RATES.length - 1, i)); syncTransport(); }
function rateFor(yearsPerSecond) {
  let best = 0;
  for (let i = 0; i < RATES.length; i++) if (RATES[i][0] <= yearsPerSecond * 1.01) best = i;
  return best;
}

const liveEvents = () => world.events().filter((e) => !e.averted);
function jumpTo(ev) {
  app.playing = false;
  app.t = Math.max(T_START, Math.min(T_END, ev.t - (ev.lead ?? 0)));
  if (ev.rate) setRate(rateFor(ev.rate));
  // Point the camera at what is about to happen.
  const focus = ev.focus ?? 'sun';
  const exists = focus === 'sun' || world.stateAt(app.t).bodies.find((b) => b.id === focus)?.exists;
  if (ev.view === 'system' || !exists) renderer.frameSystem();
  else if (ev.dist) renderer.focus(focus, ev.dist);
  else if (focus === 'sun') renderer.focus('sun', Math.max(world.stateAt(app.t).sun.radiusAU * 9, ev.kind === 'sun' ? 0.06 : 3));
  else renderer.frameBody(focus);
  showToast(ev, 9000);
  if (timeline.x(app.t) < 0 || timeline.x(app.t) > timeline.w) timeline.setView(app.t - timeline.span / 2, app.t + timeline.span / 2);
  syncTransport();
}
function hop(dir) {
  const evs = liveEvents();
  const eps = Math.max(1e-6, Math.abs(app.t) * 1e-12);
  let target = null;
  if (dir > 0) target = evs.find((e) => e.t - (e.lead ?? 0) > app.t + eps);
  else for (const e of evs) if (e.t - (e.lead ?? 0) < app.t - eps) target = e;
  if (target) jumpTo(target);
}

$('btn-play').onclick = () => play(1);
$('btn-rev').onclick = () => play(-1);
$('btn-prev').onclick = () => hop(-1);
$('btn-next').onclick = () => hop(1);
$('speed').oninput = (e) => setRate(+e.target.value);
$('btn-now').onclick = () => { app.t = 0; app.playing = false; syncTransport(); timeline.follow(0); };
$('btn-fit').onclick = () => timeline.fit();
$('btn-chron').onclick = () => { $('chronicle').hidden = !$('chronicle').hidden; $('help').hidden = true; renderChronicle(); };
$('btn-help').onclick = () => { $('help').hidden = !$('help').hidden; $('chronicle').hidden = true; };

// --- camera input -----------------------------------------------------------
const view = $('view');
const pointers = new Map();
let dragMoved = 0, pinch = 0, lastClick = 0;
view.addEventListener('pointerdown', (e) => {
  view.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  dragMoved = 0;
  view.classList.add('dragging');
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); }
});
view.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p[0], dy = e.clientY - p[1];
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (pinch > 0) renderer.zoom(pinch / d);
    pinch = d;
    dragMoved = 99;
    return;
  }
  dragMoved += Math.abs(dx) + Math.abs(dy);
  if (dragMoved > 4) renderer.rotate(dx, dy);
});
const endPointer = (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  view.classList.remove('dragging');
  if (dragMoved <= 4 && e.type === 'pointerup') clickScene(e.clientX, e.clientY);
};
view.addEventListener('pointerup', endPointer);
view.addEventListener('pointercancel', endPointer);
view.addEventListener('wheel', (e) => { e.preventDefault(); renderer.zoom(Math.exp(e.deltaY * 0.0016)); }, { passive: false });

function clickScene(x, y) {
  if (app.tool === 'well') {
    const p = renderer.eclipticPoint(x, y);
    if (p && Math.hypot(p[0], p[1]) < 5000) { app.well.pos = p; renderTool(); }
    return;
  }
  const id = renderer.pick(x, y);
  const now = performance.now();
  if (id) {
    if (now - lastClick < 350 && id === renderer.focusId) renderer.frameBody(id);
    else renderer.focus(id);
    renderChips();
  }
  lastClick = now;
}

addEventListener('resize', () => { renderer.resize(); timeline.resize(); });
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
  const k = e.key;
  if (k === ' ') { e.preventDefault(); play(app.dir > 0 || !app.playing ? 1 : -1); }
  else if (k === ',' || k === '<') setRate(app.rateIdx - 1);
  else if (k === '.' || k === '>') setRate(app.rateIdx + 1);
  else if (k === 'ArrowLeft') { e.preventDefault(); hop(-1); }
  else if (k === 'ArrowRight') { e.preventDefault(); hop(1); }
  else if (k === 'r' || k === 'R') play(-1);
  else if (k === 'z' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); undo(); }
  else if (k === 'Escape') { $('help').hidden = true; $('chronicle').hidden = true; setTool(null); }
  else if (k === '0') renderer.frameSystem();
  else if (k === '1') renderer.frameBody('sun');
  else if (k >= '2' && k <= '9') { const id = BODIES[+k - 2].id; if (app.state.bodies.find((b) => b.id === id)?.exists) renderer.frameBody(id); }
  renderChips();
});

// --- body chips and labels --------------------------------------------------
const chipIds = ['system', 'sun', ...BODIES.map((b) => b.id)];
function renderChips() {
  const el = $('bodies');
  const html = chipIds.map((id) => {
    if (id === 'system') return `<button class="chip" data-id="system"><i style="--c:#555"></i>Whole system</button>`;
    const b = app.state.bodies.find((x) => x.id === id);
    const exists = id === 'sun' || b?.exists;
    if (id === 'theia' && !exists) return '';
    const color = id === 'sun' ? '#ffd27a' : BODY[id].color;
    return `<button class="chip${renderer.focusId === id ? ' on' : ''}${exists ? '' : ' gone'}" data-id="${id}"><i style="--c:${color}"></i>${id === 'sun' ? 'Sun' : BODY[id].name}</button>`;
  }).join('');
  if (html !== renderChips.last) { el.innerHTML = html; renderChips.last = html; }
}
$('bodies').addEventListener('click', (e) => {
  const id = e.target.closest('.chip')?.dataset.id;
  if (!id) return;
  if (id === 'system') renderer.frameSystem();
  else if (id === 'sun' || app.state.bodies.find((b) => b.id === id)?.exists) renderer.frameBody(id);
  else { renderer.focusId === id || (infoOverride = id); }
  if (id !== 'system' && (id === 'sun' || app.state.bodies.find((b) => b.id === id)?.exists)) infoOverride = null;
  renderChips();
});
let infoOverride = null;

const labelEls = {};
function updateLabels() {
  const layer = $('labels');
  const seen = new Set();
  // Focus first, then by mass, so the important names win when they overlap.
  const list = renderer.screen.slice().sort((a, b) => (b.id === renderer.focusId) - (a.id === renderer.focusId) || b.mass - a.mass);
  const placed = [];
  for (const s of list) {
    let el = labelEls[s.id];
    if (!el) {
      el = labelEls[s.id] = document.createElement('div');
      el.className = 'lbl';
      el.innerHTML = `<i></i><span>${s.id === 'sun' ? 'Sun' : BODY[s.id].name}</span>`;
      el.style.color = s.id === 'sun' ? '#ffd9a0' : BODY[s.id].color;
      el.onclick = () => { renderer.focus(s.id); renderChips(); };
      el.ondblclick = () => renderer.frameBody(s.id);
      layer.appendChild(el);
    }
    seen.add(s.id);
    const crowded = placed.some((p) => Math.abs(p.x - s.x) < 46 && Math.abs(p.y - s.y) < 13);
    // Behind the disc of something nearer?
    const eclipsed = renderer.screen.some((o) => o !== s && o.depth < s.depth && o.px > 6 && Math.hypot(o.x - s.x, o.y - s.y) < o.px);
    const hidden = !s.onScreen || eclipsed || (crowded && s.id !== renderer.focusId) || s.px > 60;
    el.style.display = hidden ? 'none' : '';
    if (hidden) continue;
    placed.push(s);
    el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translateY(-50%)`;
    el.classList.toggle('nodot', s.px > 2.5);
    el.classList.toggle('focus', s.id === renderer.focusId);
    el.firstChild.nextSibling.style.transform = `translate(${Math.max(0, s.px * 0.75).toFixed(0)}px, ${(-9 - Math.max(0, s.px * 0.75)).toFixed(0)}px)`;
  }
  for (const id in labelEls) if (!seen.has(id)) labelEls[id].style.display = 'none';
}

// --- info card --------------------------------------------------------------
const num = (x, d = 2) => x.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 });
function auOrKm(au) { return au < 0.02 ? `${num(au * AU_KM, 0)} km` : `${num(au, au < 10 ? 3 : 2)} AU`; }
function fateText(id, t) {
  const f = world.fateOf(id, t);
  if (!f) return 'Not present';
  const when = formatTime(f.t, Math.abs(f.t) * 1e-3 + 1);
  if (f.type === 'unformed') return `Has not formed yet (appears ${when})`;
  if (f.type === 'collision') return `Destroyed in a collision with ${BODY[f.by]?.name ?? f.by}, ${when}`;
  if (f.type === 'sunImpact') return `Fell into the Sun, ${when}`;
  if (f.type === 'engulfed') return `Swallowed by the Sun, ${when}${f.projected ? ' (projected)' : ''}`;
  if (f.type === 'ejected') return `Left the solar system, ${when}`;
  return 'Gone';
}
function renderInfo() {
  const st = app.state, id = infoOverride ?? renderer.focusId;
  let html;
  if (id === 'sun') {
    const s = st.sun;
    html = `<h2>Sun</h2><div class="kind">${SUN_PHASE_NAMES[s.phase]}</div>
      <table>
        <tr><td>Luminosity</td><td>${num(s.L, s.L < 10 ? 3 : 0)} × today</td></tr>
        <tr><td>Radius</td><td>${s.radiusAU > 0.02 ? num(s.radiusAU, 3) + ' AU' : s.R < 0.1 ? num(s.R * 695700, 0) + ' km' : num(s.R, 2) + ' × today'}</td></tr>
        <tr><td>Surface</td><td>${num(s.T, 0)} K</td></tr>
        <tr><td>Mass</td><td>${num(s.M * 100, 1)}% of today</td></tr>
      </table>`;
  } else {
    const b = st.bodies.find((x) => x.id === id);
    const def = BODY[id];
    if (!b.exists) {
      html = `<h2>${def.name}</h2><div class="kind">${KIND_NAME[def.kind]}</div><p class="state">${esc(fateText(id, st.t))}</p>`;
    } else {
      const look = renderer.looks?.[id];
      const desc = look ? describeLook(id, look, def.kind) : null;
      const el = b.el;
      const rows = [];
      if (b.parent === 'sun') {
        rows.push(['From the Sun', auOrKm(b.r)]);
        if (el.bound) { rows.push(['Orbit', `${num(el.q, 3)} – ${num(el.Q, el.Q < 100 ? 3 : 0)} AU`]); rows.push(['Year', formatSpan(el.period)]); }
        else rows.push(['Orbit', 'Unbound — escaping']);
      } else {
        rows.push([`From ${BODY[b.parent].name}`, `${num(Math.hypot(b.rel[0], b.rel[1], b.rel[2]) * AU_KM, 0)} km`]);
        if (el.bound) rows.push(['Month', formatSpan(el.period)]);
      }
      rows.push(['Eccentricity', num(Math.min(el.e, 99), 3)]);
      rows.push(['Sunlight', `${num(b.S, b.S < 10 ? 3 : 0)} × Earth today`]);
      if (look) rows.push(['Equilibrium temp.', `${num(look.Teq, 0)} K`]);
      rows.push(['Mass', b.mass / MEARTH >= 0.1 ? `${num(b.mass / MEARTH, 2)} Earths` : `${num(b.mass / MEARTH, 4)} Earths`]);
      rows.push(['Radius', `${num(b.radius * AU_KM, 0)} km`]);
      const calm = desc && /Living|Temperate|Oceans with|Ocean world|Rivers/.test(desc);
      html = `<h2>${def.name}</h2><div class="kind">${KIND_NAME[def.kind]}${b.parent !== 'sun' ? ` of ${BODY[b.parent].name}` : ''}</div>
        <p class="state${calm ? ' calm' : ''}">${esc(desc ?? '')}</p>
        <table>${rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</table>
        ${b.projected ? '<p class="note">Projected from the last simulated orbit.</p>' : ''}`;
    }
  }
  if (html !== renderInfo.last) { $('info').innerHTML = html; renderInfo.last = html; }
}

// --- intervention tools -----------------------------------------------------
const DIRS = [['prograde', 'Speed up'], ['retro', 'Slow down'], ['out', 'Outward'], ['in', 'Inward'], ['north', 'Up'], ['south', 'Down']];
const nudgeKms = () => 0.01 * Math.pow(10, 4 * app.nudge.u);
const wellMass = () => Math.pow(10, -7 + 7 * app.well.mu); // 0.03 Earth masses … 1 Sun
const wellYears = () => Math.pow(10, -1 + 5 * app.well.du); // 5 weeks … 10,000 years
function massText(m) {
  if (m >= 0.05) return `${num(m, 2)} Suns`;
  if (m >= MJUP * 0.5) return `${num(m / MJUP, 1)} Jupiters`;
  return `${num(m / MEARTH, m / MEARTH < 10 ? 2 : 0)} Earths`;
}
function nudgeTarget() {
  const id = renderer.focusId;
  if (id === 'sun') return null;
  const b = app.state.bodies.find((x) => x.id === id);
  return b?.exists && !b.coasting ? b : null;
}
function nudgeVector(b) {
  const r = [b.rel[0], b.rel[1], b.rel[2]], v = [b.rel[3], b.rel[4], b.rel[5]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const h = norm([r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]]);
  const d = { prograde: norm(v), retro: norm(v).map((x) => -x), out: norm(r), in: norm(r).map((x) => -x), north: h, south: h.map((x) => -x) }[app.nudge.dir];
  const k = nudgeKms() * KMS;
  return [d[0] * k, d[1] * k, d[2] * k];
}
function nudgeOutcome(b, dv) {
  const st = Float64Array.from(b.rel);
  st[3] += dv[0]; st[4] += dv[1]; st[5] += dv[2];
  const el = stateToElements(st, 0, b.mu, {});
  if (b.parent !== 'sun') {
    const host = app.state.bodies.find((x) => x.id === b.parent);
    if (!el.bound) return `${b.def.name} breaks free of ${host.def.name}.`;
    if (el.q < host.radius + b.radius) return `${b.def.name} falls onto ${host.def.name}.`;
    return `New orbit ${num(el.q * AU_KM, 0)}–${num(el.Q * AU_KM, 0)} km from ${host.def.name}, once every ${formatSpan(el.period)}.`;
  }
  if (!el.bound) return `${b.def.name} escapes the Sun entirely.`;
  if (el.q < ENGULF_FACTOR * app.state.sun.radiusAU) return `${b.def.name} falls into the Sun.`;
  const crossed = app.state.bodies.filter((o) => o.exists && o.id !== b.id && o.parent === 'sun' && o.el.bound && o.def.kind !== 'dwarf' && el.q < o.el.Q && el.Q > o.el.q).map((o) => o.def.name);
  return `New orbit ${num(el.q, 2)}–${num(el.Q, 2)} AU, taking ${formatSpan(el.period)} to go round.` + (crossed.length ? ` Crosses the path of ${crossed.join(', ').replace(/, ([^,]*)$/, ' and $1')}.` : '');
}

function setTool(tool) {
  app.tool = app.tool === tool ? null : tool;
  if (app.tool) app.playing = false;
  view.classList.toggle('placing', app.tool === 'well');
  for (const btn of document.querySelectorAll('.seg button')) btn.classList.toggle('on', btn.dataset.tool === app.tool);
  renderTool();
  syncTransport();
}
document.querySelector('.seg').addEventListener('click', (e) => { const t = e.target.closest('button')?.dataset.tool; if (t) setTool(t); });

function renderTool() {
  const el = $('tool-body');
  const can = world.canInterveneAt(app.t);
  const locked = can ? '' : `<p>The planets are still assembling. You can intervene from ${formatTimeShort(T_INTERVENE_MIN)} onward.</p>`;
  let html = '';
  if (!app.tool) {
    html = `<p>Pause at any moment, then push a world off course or open a temporary gravity well. The aftermath is simulated from that instant on.</p>`;
  } else if (app.tool === 'nudge') {
    const b = nudgeTarget();
    if (!b) html = `<p>Click a planet or moon to choose what to push.</p>`;
    else {
      const dv = nudgeVector(b);
      const speed = Math.hypot(b.rel[3], b.rel[4], b.rel[5]) / KMS;
      html = `<p>Give <span class="target">${b.def.name}</span> a sudden change of velocity.</p>
        <div class="dirs">${DIRS.map(([k, n]) => `<button data-dir="${k}" class="${app.nudge.dir === k ? 'on' : ''}">${n}</button>`).join('')}</div>
        <div class="field"><div class="row"><span>Strength</span><b>${num(nudgeKms(), nudgeKms() < 1 ? 2 : 1)} km/s</b></div>
          <input type="range" min="0" max="1" step="0.002" value="${app.nudge.u}" data-k="nudge.u" />
          <div class="row"><span>${num((nudgeKms() / speed) * 100, 1)}% of its orbital speed (${num(speed, 1)} km/s)</span></div></div>
        <p class="outcome">${esc(nudgeOutcome(b, dv))}</p>
        ${locked}<button class="apply" data-apply="nudge" ${can ? '' : 'disabled'}>Apply at this moment</button>`;
    }
  } else {
    const m = wellMass(), d = wellYears();
    let where = 'Click anywhere in space to place it on the plane of the planets.';
    if (app.well.pos) {
      const r = Math.hypot(app.well.pos[0], app.well.pos[1]);
      const dom = (r * Math.sqrt(m)) / (1 + Math.sqrt(m));
      where = `Placed ${num(r, 2)} AU from the Sun. It out-pulls the Sun within ${auOrKm(dom)} of itself. Click elsewhere to move it.`;
    }
    html = `<p>A point of extra gravity, fixed in space, that pulls on everything — the Sun included — and then vanishes.</p>
      <div class="field"><div class="row"><span>Mass</span><b>${massText(m)}</b></div><input type="range" min="0" max="1" step="0.002" value="${app.well.mu}" data-k="well.mu" /></div>
      <div class="field"><div class="row"><span>Lasts</span><b>${formatSpan(d)}</b></div><input type="range" min="0" max="1" step="0.002" value="${app.well.du}" data-k="well.du" /></div>
      <p class="outcome">${where}</p>
      ${locked}<button class="apply" data-apply="well" ${can && app.well.pos ? '' : 'disabled'}>Open the well now</button>`;
  }
  if (html !== renderTool.last) {
    // Keep a slider that is being dragged alive: only swap the text around it.
    const active = document.activeElement;
    if (active && active.type === 'range' && el.contains(active) && renderTool.tool === app.tool) {
      const tmp = document.createElement('div'); tmp.innerHTML = html;
      const pairs = [['.row b', 'b'], ['.outcome', 'p'], ['.field .row + input + .row span', 's']];
      for (const [sel] of pairs) { const a = el.querySelectorAll(sel), b2 = tmp.querySelectorAll(sel); a.forEach((n, i) => { if (b2[i]) n.textContent = b2[i].textContent; }); }
      const ap = el.querySelector('.apply'), ap2 = tmp.querySelector('.apply');
      if (ap && ap2) ap.disabled = ap2.disabled;
    } else el.innerHTML = html;
    renderTool.last = html; renderTool.tool = app.tool;
  }
  // Mirror the choice in the 3D view.
  const b = app.tool === 'nudge' ? nudgeTarget() : null;
  renderer.setPreview(app.tool === 'nudge' && b ? { type: 'nudge', bodyId: b.id, dv: nudgeVector(b) } : app.tool === 'well' && app.well.pos ? { type: 'well', pos: app.well.pos, mass: wellMass() } : null);
}
$('tool-body').addEventListener('input', (e) => {
  const k = e.target.dataset.k;
  if (!k) return;
  const [a, b] = k.split('.');
  app[a][b] = +e.target.value;
  renderTool();
});
$('tool-body').addEventListener('click', (e) => {
  const dir = e.target.closest('[data-dir]')?.dataset.dir;
  if (dir) { app.nudge.dir = dir; renderTool(); return; }
  const what = e.target.closest('[data-apply]')?.dataset.apply;
  if (what === 'nudge') applyNudge();
  if (what === 'well') applyWell();
});

function applyNudge() {
  const b = nudgeTarget();
  if (!b || !world.canInterveneAt(app.t)) return;
  const label = DIRS.find((d) => d[0] === app.nudge.dir)[1].toLowerCase();
  const period = b.el.bound ? b.el.period : 1;
  world.apply({ t: app.t, type: 'nudge', bodyId: b.id, dv: nudgeVector(b), label });
  afterApply(Math.max(1 / 12, Math.min(1e3, period / 6)));
}
function applyWell() {
  if (!app.well.pos || !world.canInterveneAt(app.t)) return;
  world.apply({ t: app.t, type: 'well', pos: app.well.pos.slice(), mass: wellMass(), duration: wellYears() });
  afterApply(Math.max(1 / 365.25, Math.min(100, wellYears() / 12)));
  app.well.pos = null;
}
function afterApply(rate) {
  setTool(null);
  setRate(rateFor(rate));
  app.dir = 1; app.playing = true;
  timeline.show(app.t - 20 * RATES[app.rateIdx][0], app.t + 240 * RATES[app.rateIdx][0]);
  syncTransport();
}
function undo() {
  const iv = world.undo();
  if (iv) { app.t = Math.min(app.t, T_END); showToast({ kind: 'intervention', t: iv.t, title: 'Intervention undone', text: 'History from that moment on has been restored.' }, 4000); }
}

function renderInterventions() {
  const list = world.interventions;
  const html = list.length
    ? list.map((iv) => `<div class="iv"><div class="what" data-goto="${iv.id}">${iv.type === 'nudge' ? `Nudged ${BODY[iv.bodyId].name}` : 'Gravity well'}<small>${formatTime(iv.t, Math.max(1, Math.abs(iv.t) * 1e-4))}</small></div><button title="Remove this and everything after it" data-remove="${iv.id}">✕</button></div>`).join('') +
      `<div class="iv-actions"><button class="btn" data-undo>Undo last</button><button class="btn" data-reset>Restore natural history</button></div>`
    : '';
  if (html !== renderInterventions.last) { $('iv-list').innerHTML = html; renderInterventions.last = html; }
  // Simulation progress.
  const br = world.lastBranch;
  let s = '';
  if (br) {
    const done = formatSpan(br.resolved);
    if (br.status === 'running') s = `Simulating the aftermath: ${done} so far${br.rate > 1 ? ` · ${num(br.rate, 0)} yr/s` : ''}<div class="bar"><i></i></div>`;
    else if (br.status === 'settled') s = `Orbits settled. Simulated ${done}; later times are projected from those orbits.`;
    else if (br.status === 'end') s = `Simulated to the end of the timeline.`;
    else if (br.status === 'unresolved') s = `Still unstable after ${done}. Later times are a rough projection.`;
    else if (br.status === 'error') s = `The simulation stopped unexpectedly after ${done}.`;
  }
  if (s !== renderInterventions.lastStatus) { $('sim-status').innerHTML = s; renderInterventions.lastStatus = s; }
}
$('iv-list').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-remove]')?.dataset.remove;
  if (rm) { world.removeFrom(+rm); return; }
  const go = e.target.closest('[data-goto]')?.dataset.goto;
  if (go) { const iv = world.interventions.find((i) => i.id === +go); if (iv) { app.t = iv.t; app.playing = false; syncTransport(); } return; }
  if (e.target.closest('[data-undo]')) undo();
  if (e.target.closest('[data-reset]')) world.reset();
});

// --- toasts, tooltips, chronicle -------------------------------------------
let toastTimer = 0;
function showToast(ev, ms = 6000) {
  const el = $('toast');
  el.hidden = false;
  el.className = ev.kind === 'dynamics' || ev.kind === 'intervention' ? 'dyn' : '';
  el.innerHTML = `<div class="t">${formatTime(ev.t, Math.max(1, Math.abs(ev.t) * 1e-3))}${ev.projected ? ' · projected' : ''}</div><h3>${esc(ev.title)}</h3><p>${esc(ev.text ?? '')}</p>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.add('fade'); toastTimer = setTimeout(() => { el.hidden = true; }, 600); }, ms);
}
function showTip(ev, x, y, t) {
  const el = $('tip');
  if (!ev) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<b>${esc(ev.title)}</b><div class="when">${formatTime(ev.t, Math.max(1, Math.abs(ev.t) * 1e-3))}${ev.averted ? ' · <span class="tag">averted by your intervention</span>' : ev.projected ? ' · <span class="tag">projected</span>' : ''}</div>${esc(ev.text ?? '')}`;
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(innerWidth - r.width - 8, x - r.width / 2))}px`;
  el.style.top = `${y - r.height - 18}px`;
  void t;
}
function renderChronicle() {
  if ($('chronicle').hidden) return;
  const evs = world.events();
  let nowMarked = false;
  const html = `<div class="panel-title">Chronicle</div>` + evs.map((e) => {
    const cls = `${e.kind}${e.averted ? ' averted' : ''}${!nowMarked && e.t > app.t ? ((nowMarked = true), ' past-now') : ''}`;
    return `<div class="ch ${cls}" data-ev="${esc(e.id)}"><time>${formatTimeShort(e.t)}</time><div><b>${esc(e.title)}</b><small>${e.averted ? 'Averted' : e.projected ? 'Projected' : ''}</small></div></div>`;
  }).join('');
  if (html !== renderChronicle.last) { const top = $('chronicle').scrollTop; $('chronicle').innerHTML = html; $('chronicle').scrollTop = top; renderChronicle.last = html; }
}
$('chronicle').addEventListener('click', (e) => {
  const id = e.target.closest('.ch')?.dataset.ev;
  const ev = world.events().find((x) => x.id === id);
  if (ev) jumpTo(ev);
});

// --- main loop --------------------------------------------------------------
let dataStamp = -1, lastSlow = 0, lastFrame = performance.now();
world.onChange(() => {});

function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (app.playing) {
    app.t += app.dir * RATES[app.rateIdx][0] * dt;
    if (app.t >= T_END) { app.t = T_END; app.playing = false; syncTransport(); }
    if (app.t <= T_START) { app.t = T_START; app.playing = false; syncTransport(); }
  }
  const simDt = app.t - app.tPrev;
  world.stateAt(app.t, app.state);

  // Events crossed since the last frame (while playing, not while scrubbing).
  if (app.playing && simDt !== 0) {
    const lo = Math.min(app.tPrev, app.t), hi = Math.max(app.tPrev, app.t);
    let best = null;
    for (const e of world.events()) {
      if (e.t <= lo || e.t > hi || e.averted || e.kind === 'intervention') continue;
      if (!best || e.rank > best.rank || (e.rank === best.rank && e.kind === 'dynamics')) best = e;
      if (e.kind === 'dynamics' && (e.id.startsWith('dyn-collision') || e.id.startsWith('dyn-sunImpact'))) renderer.flash(e.id.startsWith('dyn-sunImpact') ? 'sun' : e.focus);
      if (e.id === 'theia') renderer.flash('earth');
    }
    if (best && (best.rank >= 2 || best.kind === 'dynamics')) showToast(best);
  }
  app.tPrev = app.t;
  app.scrubbing = false;

  renderer.update(app.state, simDt, dt, world);
  renderer.render();
  updateLabels();

  // Clock.
  const rate = RATES[app.rateIdx][0];
  $('time').textContent = formatTime(app.t, rate);
  $('era').textContent = eraName(app.t);
  $('sunline').textContent = `Sun: ${SUN_PHASE_NAMES[app.state.sun.phase].toLowerCase()}`;
  const badge = $('badge');
  if (app.state.intervention) {
    badge.hidden = false;
    badge.textContent = app.state.projected ? 'Altered · projected' : 'Altered · simulated';
    badge.classList.toggle('projected', app.state.projected);
  } else badge.hidden = true;

  if (world.stamp !== dataStamp && now - lastSlow > 120) {
    dataStamp = world.stamp;
    timeline.setData(world.events(), world.segments());
    renderChronicle();
  }
  if (app.playing) timeline.follow(app.t);
  timeline.draw(app.t, app.state.projected);

  if (now - lastSlow > 160) {
    lastSlow = now;
    renderInfo(); renderChips(); renderTool(); renderInterventions();
  }
}
function loop(now) { frame(now); requestAnimationFrame(loop); }
window.__longnow.tick = (n = 1) => { for (let i = 0; i < n; i++) frame(lastFrame + 16.7); };

timeline.setData(world.events(), world.segments());
world.stateAt(app.t, app.state);
renderer.lastState = app.state;
renderer.frameSystem();
renderer.dist = renderer.distTarget;
syncTransport(); renderChips(); renderTool();
// Build the shaders and load the continents before the first frame.
Promise.all([renderer.warmUp(), renderer.paleo.loaded]).finally(() => {
  $('boot').classList.add('done');
  setTimeout(() => $('boot').remove(), 900);
  lastFrame = performance.now();
  requestAnimationFrame(loop);
});
