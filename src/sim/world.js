// The world line: natural history, plus whatever the player has done to it.
//
// Time before the first intervention comes from the scripted/secular baseline.
// Each intervention starts a "branch": an N-body run in a worker that streams
// back orbit samples. For times the run has reached, positions are
// reconstructed from those samples; beyond it they are projected from the
// last known orbits (with the Sun's evolution still applied).
import { G, T_START, T_END, T_INTERVENE_MIN, KMS, MEARTH, REARTH_AU, AU_KM } from './constants.js';
import { keplerStep, stateToElements, elementsToState } from './kepler.js';
import { sunAt } from './sun.js';
import { BODIES, BODY, baselineTracks, naturalBulk, theiaOffset, moonDistanceRE } from './bodies.js';
import { SecularTrack, projectHeliocentric } from './tracks.js';
import { REC, REC_WELL, PARENT_SUN, PARENT_NONE, PARENT_DROPPED, FLAG_BREAK } from './nbody.js';
import { NATURAL_EVENTS } from './history.js';
import { insolation, earthClimate } from './surface.js';

const _a = new Float64Array(6), _b = new Float64Array(6);
const _el = {};
const _sun = {};

class Stream {
  constructor(rec) { this.rec = rec; this.data = new Float64Array(rec * 128); this.n = 0; this._k = 0; }
  append(arr) {
    if (!arr.length) return;
    const need = this.n * this.rec + arr.length;
    if (need > this.data.length) {
      const grown = new Float64Array(Math.max(need, this.data.length * 2));
      grown.set(this.data.subarray(0, this.n * this.rec));
      this.data = grown;
    }
    this.data.set(arr, this.n * this.rec);
    this.n += arr.length / this.rec;
  }
  /** Index of the last record with time <= tRel (or -1). */
  find(tRel) {
    const { data, rec, n } = this;
    if (n === 0 || data[0] > tRel) return -1;
    let k = this._k;
    if (k < n && data[k * rec] <= tRel && (k + 1 >= n || data[(k + 1) * rec] > tRel)) return k;
    let lo = 0, hi = n;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (data[mid * rec] <= tRel) lo = mid; else hi = mid; }
    return (this._k = lo);
  }
  lastTime() { return this.n ? this.data[(this.n - 1) * this.rec] : -Infinity; }
}

class Branch {
  constructor(t0, slotIds, wells) {
    this.t0 = t0;
    this.slotIds = slotIds;
    this.slotOf = Object.fromEntries(slotIds.map((id, i) => [id, i]));
    this.streams = slotIds.map(() => new Stream(REC));
    this.wells = wells;
    this.wellStreams = wells.map(() => new Stream(REC_WELL));
    this.resolved = 0; // years past t0 the N-body run has reached
    this.status = 'running';
    this.events = [];
    this.rate = 0;
    this.tails = null;
    this.tailsAt = -1;
    this.climateCursor = 0;
    this.climate = [];
  }

  /** Long-range projections from the last simulated state of each body. */
  ensureTails() {
    if (this.tails && this.tailsAt === this.resolved) return this.tails;
    const tails = this.slotIds.map(() => null);
    const tEnd = T_END + 2;
    // Planets first, then moons (which end with their host).
    for (let pass = 0; pass < 2; pass++) {
      this.streams.forEach((st, slot) => {
        if (!st.n) return;
        const k = st.n - 1, o = k * REC, d = st.data;
        const parent = d[o + 2];
        if (parent === PARENT_NONE || parent === PARENT_DROPPED) return;
        const tAbs = this.t0 + d[o];
        if (pass === 0 && parent === PARENT_SUN) {
          stateToElements(d, o + 3, d[o + 11], _el);
          if (_el.bound) {
            const { track, engulfedAt } = projectHeliocentric(tAbs, _el, d[o + 9], tEnd);
            tails[slot] = { track, engulfedAt, parent: -1, mass: d[o + 9], radius: d[o + 10] };
          } else {
            tails[slot] = { coast: true, parent: -1 };
          }
        } else if (pass === 1 && parent >= 0) {
          stateToElements(d, o + 3, d[o + 11], _el);
          const host = tails[parent];
          if (!_el.bound || !host) { tails[slot] = { coast: true, parent }; return; }
          const kn = { t: [], a: [], e: [], inc: [], Om: [], w: [], mu: [] };
          const isMoon = this.slotIds[slot] === 'moon' && this.slotIds[parent] === 'earth';
          const base = moonDistanceRE(tAbs);
          const stop = Math.min(tEnd, host.engulfedAt ?? tEnd);
          for (let j = 0; j <= 40; j++) {
            const t = j === 40 ? Math.max(stop, tAbs + 1) : tAbs + Math.pow(10, 1 + j * 0.24);
            if (j < 40 && t >= stop) continue;
            // The Moon keeps receding at its natural pace.
            const a = _el.a * (isMoon ? moonDistanceRE(t) / base : 1);
            kn.t.push(t); kn.a.push(a); kn.e.push(_el.e); kn.inc.push(_el.i); kn.Om.push(_el.Om); kn.w.push(_el.w); kn.mu.push(d[o + 11]);
          }
          kn.t.unshift(tAbs); kn.a.unshift(_el.a); kn.e.unshift(_el.e); kn.inc.unshift(_el.i); kn.Om.unshift(_el.Om); kn.w.unshift(_el.w); kn.mu.unshift(d[o + 11]);
          tails[slot] = { track: new SecularTrack(kn, { t: tAbs, M: _el.M }, tAbs, host.engulfedAt ?? Infinity), engulfedAt: host.engulfedAt ?? null, parent, mass: d[o + 9], radius: d[o + 10] };
        }
      });
    }
    this.tails = tails;
    this.tailsAt = this.resolved;
    return tails;
  }

  /** Earth's climate regime at each new sample (incremental; appends to this.climate). */
  scanClimate() {
    const slot = this.slotOf.earth;
    if (slot === undefined) return;
    const st = this.streams[slot], d = st.data;
    let k = this.climateCursor;
    for (; k < st.n; k++) {
      const o = k * REC, par = d[o + 2];
      if (par === PARENT_NONE || par === PARENT_DROPPED) { k = st.n; break; }
      if (par !== PARENT_SUN) continue;
      if (k > 0 && d[o] - this._clT < 0.5) continue; // climate does not change in days
      this._clT = d[o];
      const t = this.t0 + d[o];
      stateToElements(d, o + 3, d[o + 11], _el);
      const c = earthClimate(insolation(sunAt(t, _sun).L, _el, Math.hypot(d[o + 3], d[o + 4], d[o + 5])), t);
      if (this._clCur === undefined) { this._clCur = c; this.climate.push({ t, climate: c }); continue; }
      if (c === this._clCur) { this._clPending = null; continue; }
      // Require a new regime to persist before flagging it.
      const p = this._clPending;
      if (p && p.c === c) {
        if (++p.n >= 3 || t - p.t > 50) { this.climate.push({ t: p.t, climate: c }); this._clCur = c; this._clPending = null; }
      } else this._clPending = { c, t, n: 1 };
    }
    this.climateCursor = k;
  }

  /**
   * Evaluates one body at absolute time t. Fills body.rel/mu/mass/radius/parentSlot.
   * Returns false if the body does not exist then.
   */
  evalBody(slot, t, body) {
    const st = this.streams[slot];
    const tRel = t - this.t0;
    let k = st.find(tRel);
    if (k < 0) return false;
    const d = st.data;
    let o = k * REC;
    let parent = d[o + 2];
    body.projected = false;
    body.coasting = false;
    if (parent === PARENT_NONE) return false;
    if (parent === PARENT_DROPPED) {
      // Left the system: coast on the last orbit.
      if (k === 0) return false;
      o -= REC; parent = d[o + 2];
      keplerStep(d, o + 3, d[o + 11], tRel - d[o], body.rel, 0);
      body.mu = d[o + 11]; body.mass = d[o + 9]; body.radius = d[o + 10]; body.parentSlot = parent; body.coasting = true;
      return true;
    }
    body.mass = d[o + 9]; body.radius = d[o + 10]; body.mu = d[o + 11]; body.parentSlot = parent;
    if (k === st.n - 1) {
      if (tRel <= d[o] + 1e-9) { for (let i = 0; i < 6; i++) body.rel[i] = d[o + 3 + i]; return true; }
      // Beyond the simulated horizon: long-range projection.
      const tail = this.ensureTails()[slot];
      body.projected = true;
      if (!tail) return false;
      if (tail.coast) { keplerStep(d, o + 3, d[o + 11], tRel - d[o], body.rel, 0); body.coasting = parent === PARENT_SUN; return true; }
      if (!tail.track.exists(t)) return false;
      body.mu = tail.track.stateAt(t, body.rel, 0);
      return true;
    }
    keplerStep(d, o + 3, d[o + 11], tRel - d[o], _a, 0);
    const o1 = o + REC;
    if (d[o1 + 2] !== parent || (d[o1 + 1] & FLAG_BREAK)) {
      for (let i = 0; i < 6; i++) body.rel[i] = _a[i];
      return true;
    }
    // Blend the forward and backward Kepler arcs (in polar form, so a small
    // phase disagreement cannot pull the body off its orbit).
    keplerStep(d, o1 + 3, d[o1 + 11], tRel - d[o1], _b, 0);
    const w = (tRel - d[o]) / (d[o1] - d[o]);
    const ra = Math.hypot(_a[0], _a[1], _a[2]), rb = Math.hypot(_b[0], _b[1], _b[2]);
    let x = _a[0] / ra * (1 - w) + _b[0] / rb * w, y = _a[1] / ra * (1 - w) + _b[1] / rb * w, z = _a[2] / ra * (1 - w) + _b[2] / rb * w;
    const len = Math.hypot(x, y, z) || 1;
    const r = ra * (1 - w) + rb * w;
    body.rel[0] = x / len * r; body.rel[1] = y / len * r; body.rel[2] = z / len * r;
    for (let i = 3; i < 6; i++) body.rel[i] = _a[i] * (1 - w) + _b[i] * w;
    body.mu = d[o + 11] * (1 - w) + d[o1 + 11] * w;
    return true;
  }
}

let _ivId = 1;

export class World {
  /**
   * @param {(spec: object, onChunk: (msg: object) => void) => {cancel: () => void}} spawnJob
   */
  constructor(spawnJob) {
    this.spawnJob = spawnJob;
    this.base = baselineTracks();
    this.interventions = [];
    this.listeners = new Set();
    this._events = null;
    this._eventsStamp = -1;
    this.stamp = 0; // bumps whenever the world line changes
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _changed() { this.stamp++; for (const fn of this.listeners) fn(); }

  makeState() {
    return {
      t: 0, sun: {}, wells: [], projected: false, intervention: null,
      bodies: BODIES.map((def) => ({
        id: def.id, def, exists: false, mass: 0, radius: 0, mu: 0, parent: 'sun', parentSlot: -1,
        rel: new Float64Array(6), pos: new Float64Array(3), vel: new Float64Array(3), el: {}, S: 0, r: 0,
        projected: false, coasting: false,
      })),
    };
  }

  /** The intervention whose branch governs time t (or null for the natural timeline). */
  governing(t) {
    let iv = null;
    for (const i of this.interventions) if (i.t <= t) iv = i; else break;
    return iv;
  }

  /** Full system state at time t. */
  stateAt(t, state = this.makeState()) {
    state.t = t;
    sunAt(t, state.sun);
    const iv = this.governing(t);
    state.intervention = iv;
    state.projected = false;
    const br = iv?.branch;
    const byId = {};
    for (const b of state.bodies) {
      byId[b.id] = b;
      b.projected = false; b.coasting = false; b.parent = b.def.parent; b.exists = false;
      if (!br) {
        const tr = this.base[b.id];
        if (!tr.exists(t)) continue;
        b.exists = true;
        const bulk = naturalBulk(b.id, t, b);
        if (tr.coOrbital) continue; // filled in below
        b.mu = tr.stateAt(t, b.rel, 0);
      } else {
        const slot = br.slotOf[b.id];
        if (slot === undefined) continue;
        b.exists = br.evalBody(slot, t, b);
        if (!b.exists) continue;
        b.parent = b.parentSlot >= 0 ? br.slotIds[b.parentSlot] : 'sun';
        if (b.projected) state.projected = true;
      }
    }
    if (!br && byId.theia.exists) {
      // Theia rides Earth's orbit, a fixed angle ahead.
      const e = byId.earth, th = byId.theia;
      const ang = theiaOffset(t), c = Math.cos(ang), s = Math.sin(ang);
      th.rel[0] = c * e.rel[0] - s * e.rel[1]; th.rel[1] = s * e.rel[0] + c * e.rel[1]; th.rel[2] = e.rel[2];
      th.rel[3] = c * e.rel[3] - s * e.rel[4]; th.rel[4] = s * e.rel[3] + c * e.rel[4]; th.rel[5] = e.rel[5];
      th.mu = e.mu;
    }
    // Absolute (heliocentric) positions.
    for (const b of state.bodies) b._done = false;
    const resolve = (b, depth) => {
      if (b._done || !b.exists) return;
      b._done = true;
      const p = b.parent !== 'sun' ? byId[b.parent] : null;
      if (p && p.exists && depth < 4) {
        resolve(p, depth + 1);
        for (let i = 0; i < 3; i++) { b.pos[i] = p.pos[i] + b.rel[i]; b.vel[i] = p.vel[i] + b.rel[3 + i]; }
      } else {
        if (p && !p.exists) b.parent = 'sun';
        for (let i = 0; i < 3; i++) { b.pos[i] = b.rel[i]; b.vel[i] = b.rel[3 + i]; }
      }
    };
    for (const b of state.bodies) {
      if (!b.exists) continue;
      resolve(b, 0);
      stateToElements(b.rel, 0, b.mu, b.el);
      b.r = Math.hypot(b.pos[0], b.pos[1], b.pos[2]);
    }
    for (const b of state.bodies) {
      if (!b.exists) continue;
      const host = b.parent !== 'sun' ? byId[b.parent] : b;
      b.S = insolation(state.sun.L, host.el, host.r);
    }
    // Active gravity wells.
    state.wells.length = 0;
    if (br) {
      br.wells.forEach((w, k) => {
        if (t < w.tStart || t >= w.tEnd) return;
        const st = br.wellStreams[k];
        const j = st.find(t - br.t0);
        let pos = w.pos;
        if (j >= 0 && Number.isFinite(st.data[j * REC_WELL + 1])) {
          const o = j * REC_WELL;
          pos = [st.data[o + 1], st.data[o + 2], st.data[o + 3]];
          if (j + 1 < st.n && Number.isFinite(st.data[o + REC_WELL + 1])) {
            const u = (t - br.t0 - st.data[o]) / (st.data[o + REC_WELL] - st.data[o]);
            pos = pos.map((v, i) => v + (st.data[o + REC_WELL + 1 + i] - v) * u);
          }
        }
        state.wells.push({ pos, mass: w.mass, tStart: w.tStart, tEnd: w.tEnd, eps: w.eps });
      });
    }
    return state;
  }

  // --- interventions -------------------------------------------------------

  canInterveneAt(t) { return t >= T_INTERVENE_MIN && t < T_END - 1; }

  /**
   * @param {object} iv  {t, type:'nudge', bodyId, dv:[x,y,z] (AU/yr)} or
   *                     {t, type:'well', pos:[x,y,z], mass, duration, eps}
   */
  apply(iv) {
    if (!this.canInterveneAt(iv.t)) return null;
    const state = this.stateAt(iv.t);
    // The future beyond this moment is rewritten.
    this._truncate(iv.t);
    const bodies = [];
    for (const b of state.bodies) {
      if (!b.exists || b.coasting) continue;
      const st = Float64Array.from(b.rel);
      if (iv.type === 'nudge' && iv.bodyId === b.id) { st[3] += iv.dv[0]; st[4] += iv.dv[1]; st[5] += iv.dv[2]; }
      bodies.push({ id: b.id, mass: b.mass, radius: b.radius, parent: b.parent, state: st });
    }
    const wells = state.wells.map((w) => ({ ...w }));
    if (iv.type === 'well') wells.push({ pos: iv.pos.slice(), mass: iv.mass, tStart: iv.t, tEnd: iv.t + iv.duration, eps: iv.eps ?? 0.02 });
    const record = { ...iv, id: _ivId++ };
    const branch = new Branch(iv.t, bodies.map((b) => b.id), wells);
    // Seed each stream so the branch is defined at its first instant.
    bodies.forEach((b, slot) => {
      const parent = b.parent === 'sun' ? PARENT_SUN : branch.slotOf[b.parent];
      const host = b.parent === 'sun' ? null : bodies[parent];
      const mu = host ? G * (host.mass + b.mass) : state.bodies.find((x) => x.id === b.id).mu;
      branch.streams[slot].append(Float64Array.from([0, FLAG_BREAK, parent, ...b.state, b.mass, b.radius, mu]));
    });
    record.branch = branch;
    record.job = this.spawnJob({ t0: iv.t, tEnd: T_END, bodies, wells }, (msg) => this._onChunk(record, msg));
    this.interventions.push(record);
    this._changed();
    return record;
  }

  _onChunk(record, msg) {
    const br = record.branch;
    if (!this.interventions.includes(record)) return;
    msg.streams.forEach((arr, slot) => br.streams[slot].append(arr));
    msg.wells.forEach((arr, k) => br.wellStreams[k].append(arr));
    for (const e of msg.events) br.events.push(e);
    br.resolved = msg.tRel;
    br.rate = msg.rate ?? br.rate;
    if (msg.done) br.status = msg.status;
    if (msg.error) br.error = msg.error;
    this._changed();
  }

  _truncate(t) {
    while (this.interventions.length && this.interventions[this.interventions.length - 1].t >= t) {
      this.interventions.pop().job?.cancel();
    }
    // An earlier branch that had run past t is cut back and will not resume;
    // the new branch supersedes it from t onward.
    const prev = this.interventions[this.interventions.length - 1];
    if (prev) prev.job?.cancel();
  }

  /** Removes the most recent intervention. */
  undo() {
    const last = this.interventions.pop();
    if (!last) return null;
    last.job?.cancel();
    // Resume the previous branch if it had been cut short.
    const prev = this.interventions[this.interventions.length - 1];
    if (prev && prev.branch.status === 'running') this._resume(prev);
    this._changed();
    return last;
  }

  /** Removes intervention `id` and everything after it. */
  removeFrom(id) {
    const idx = this.interventions.findIndex((i) => i.id === id);
    if (idx < 0) return;
    while (this.interventions.length > idx) this.interventions.pop().job?.cancel();
    const prev = this.interventions[this.interventions.length - 1];
    if (prev && prev.branch.status === 'running') this._resume(prev);
    this._changed();
  }

  reset() {
    for (const i of this.interventions) i.job?.cancel();
    this.interventions = [];
    this._changed();
  }

  _resume(record) {
    // Restart the run from the branch's last simulated state.
    const br = record.branch;
    const t = br.t0 + br.resolved;
    const state = this.stateAt(t);
    const bodies = [];
    for (const b of state.bodies) {
      if (!b.exists || b.coasting || br.slotOf[b.id] === undefined) continue;
      bodies.push({ id: b.id, mass: b.mass, radius: b.radius, parent: b.parent, state: Float64Array.from(b.rel) });
    }
    // Slots must line up with the original run: re-map by id.
    const order = br.slotIds;
    const offset = br.resolved;
    record.job = this.spawnJob({ t0: t, tEnd: T_END, bodies, wells: state.wells.map((w) => ({ ...w })) }, (msg) => {
      if (!this.interventions.includes(record)) return;
      const map = bodies.map((b) => br.slotOf[b.id]);
      msg.streams.forEach((arr, s) => {
        for (let o = 0; o < arr.length; o += REC) { arr[o] += offset; if (arr[o + 2] >= 0) arr[o + 2] = map[arr[o + 2]]; }
        br.streams[map[s]].append(arr);
      });
      for (const e of msg.events) br.events.push(e);
      br.resolved = offset + msg.tRel;
      br.rate = msg.rate ?? br.rate;
      if (msg.done) br.status = msg.status;
      this._changed();
    });
    void order;
  }

  // --- status for the UI ---------------------------------------------------

  /** Time up to which the current world line has actually been simulated (Infinity if natural). */
  get lastBranch() { return this.interventions.length ? this.interventions[this.interventions.length - 1].branch : null; }

  /** Segments of the timeline: [{t0, t1, kind: 'natural'|'simulated'|'projected', status}] */
  segments() {
    const out = [];
    const ivs = this.interventions;
    out.push({ t0: T_START, t1: ivs.length ? ivs[0].t : T_END, kind: 'natural' });
    ivs.forEach((iv, i) => {
      const end = i + 1 < ivs.length ? ivs[i + 1].t : T_END;
      const res = Math.min(end, iv.t + iv.branch.resolved);
      out.push({ t0: iv.t, t1: res, kind: 'simulated', status: iv.branch.status });
      if (res < end) out.push({ t0: res, t1: end, kind: 'projected', status: iv.branch.status });
    });
    return out;
  }

  // --- events --------------------------------------------------------------

  /** All dynamic (simulation) events on the current world line, in time order. */
  dynamicEvents() {
    const out = [];
    const ivs = this.interventions;
    ivs.forEach((iv, i) => {
      const end = i + 1 < ivs.length ? ivs[i + 1].t : Infinity;
      for (const e of iv.branch.events) if (e.t < end) out.push(e);
    });
    return out;
  }

  /** What became of a body, if it is gone by time t: {type, t, by} or null. */
  fateOf(id, t) {
    const ivs = this.interventions;
    if (!ivs.length || t < ivs[0].t) {
      const tr = this.base[id];
      if (t < tr.tStart) return { type: 'unformed', t: tr.tStart };
      if (t >= tr.tEnd) return id === 'theia' ? { type: 'collision', t: tr.tEnd, by: 'earth' } : { type: 'engulfed', t: tr.tEnd };
      return null;
    }
    let fate = null;
    for (const e of this.dynamicEvents()) {
      if (e.t > t) break;
      if (e.type === 'collision' && e.b === id) fate = { type: 'collision', t: e.t, by: e.a };
      else if ((e.type === 'sunImpact' || e.type === 'engulfed' || e.type === 'ejected') && e.a === id) fate = { type: e.type, t: e.t };
    }
    if (fate) return fate;
    const iv = this.governing(t);
    const br = iv.branch;
    const slot = br.slotOf[id];
    if (slot === undefined) return id === 'theia' ? { type: 'collision', t: this.base.theia.tEnd, by: 'earth' } : { type: 'gone', t: iv.t };
    if (t > br.t0 + br.resolved) {
      const tail = br.ensureTails()[slot];
      if (tail && tail.engulfedAt != null && t >= tail.engulfedAt) return { type: 'engulfed', t: tail.engulfedAt, projected: true };
    }
    return null;
  }

  /** Giant impacts suffered by a body up to now (for molten-surface rendering). */
  impactsOn(id) {
    if (this._impStamp !== this.stamp) { this._impCache = {}; this._impStamp = this.stamp; }
    if (this._impCache[id]) return this._impCache[id];
    const list = (this._impCache[id] = []);
    if (!this.interventions.length) return list;
    for (const e of this.dynamicEvents()) {
      if (e.type === 'collision' && e.a === id) {
        const ratio = Math.min(1, e.massB / e.massA);
        list.push({ t: e.t, severity: Math.min(1, 0.25 + 0.75 * Math.pow(ratio, 0.25) * Math.min(1.5, e.speed / 12)) });
      }
    }
    return list;
  }

  _naturalClimate(tFirst) {
    if (this._natClimate && this._natClimateFor === tFirst) return this._natClimate;
    const out = [];
    let cur = 'temperate';
    const eb = this.base.earth;
    // Sunlight on the natural timeline only changes with the Sun, slowly.
    for (let t = -4.3e9; t < Math.min(tFirst, eb.tEnd); t += 1e7) {
      const el = eb.elementsAt(t, _el);
      const c = earthClimate(sunAt(t, _sun).L / (el.a * el.a * Math.sqrt(1 - el.e * el.e)), t);
      if (c !== cur) { out.push({ t, climate: c, from: cur, projected: false }); cur = c; }
    }
    this._natClimate = out; this._natClimateFor = tFirst;
    return out;
  }

  /** Earth's climate turning points along the current world line: [{t, climate, from, projected}]. */
  _scanClimate() {
    const ivs = this.interventions;
    const out = this._naturalClimate(ivs.length ? ivs[0].t : T_END).slice();
    let cur = out.length ? out[out.length - 1].climate : 'temperate';
    const push = (t, c, projected) => { if (c !== cur) { out.push({ t, climate: c, from: cur, projected }); cur = c; } };
    ivs.forEach((iv, i) => {
      const br = iv.branch;
      const slot = br.slotOf.earth;
      if (slot === undefined) return;
      br.scanClimate();
      const end = i + 1 < ivs.length ? ivs[i + 1].t : Infinity;
      for (const c of br.climate) { if (c.t >= end) break; push(c.t, c.climate, false); }
      if (end === Infinity) {
        const tail = br.ensureTails()[slot];
        if (tail?.track) {
          const t0 = br.t0 + br.resolved, t1 = Math.min(T_END, tail.engulfedAt ?? T_END);
          for (let t = t0; t < t1; t += Math.max(1e5, (t1 - t0) / 1500)) {
            const el = tail.track.elementsAt(t, _el);
            push(t, earthClimate(sunAt(t, _sun).L / (el.a * el.a * Math.sqrt(1 - el.e * el.e)), t), true);
          }
        }
      }
    });
    return out;
  }

  /** Has Earth been sterilised / dried out by time t on this world line? */
  earthStatus(t) {
    const info = this._info();
    let waterLost = false, alive = true;
    for (const c of info.climate) {
      if (c.t > t) break;
      if (c.climate === 'desiccated' || c.climate === 'molten') { waterLost = true; alive = false; }
      if (c.climate === 'frozen' || c.climate === 'moist') alive = false;
    }
    for (const im of info.earthImpacts) if (im.t <= t && im.severity > 0.35) alive = false;
    return { waterLost, alive, natural: !this.interventions.length || t < this.interventions[0].t, impacts: info.earthImpacts };
  }

  _info() {
    if (this._infoStamp === this.stamp) return this._infoCache;
    this._infoCache = { climate: this._scanClimate(), earthImpacts: this.impactsOn('earth') };
    this._infoStamp = this.stamp;
    return this._infoCache;
  }

  /** The flagged timeline: natural milestones (some now averted), dynamics, interventions. */
  events() {
    if (this._eventsStamp === this.stamp) return this._events;
    const name = (id) => BODY[id]?.name ?? id;
    const out = [];
    const ivs = this.interventions;
    const tFirst = ivs.length ? ivs[0].t : Infinity;
    const dyn = this.dynamicEvents();
    const info = this._info();

    // Things that happened to bodies, for judging later milestones.
    const goneAt = {};
    for (const e of dyn) {
      if (e.type === 'collision') goneAt[e.b] = Math.min(goneAt[e.b] ?? Infinity, e.t);
      else if (e.type === 'sunImpact' || e.type === 'engulfed' || e.type === 'ejected') goneAt[e.a] = Math.min(goneAt[e.a] ?? Infinity, e.t);
    }
    const moonLeft = dyn.find((e) => e.a === 'moon' && (e.type === 'escaped' || e.type === 'captured'))?.t ?? goneAt.moon ?? Infinity;
    const resurfaced = info.earthImpacts.find((im) => im.severity > 0.35)?.t ?? Infinity;
    const unlivable = info.climate.find((c) => c.climate !== 'temperate')?.t ?? Infinity;
    const lastBr = this.lastBranch;

    for (const ev of NATURAL_EVENTS) {
      let averted = false;
      if (ev.t > tFirst) {
        const need = ev.needs;
        if (need === 'pristine') averted = true;
        else if (need === 'earth') averted = (goneAt.earth ?? Infinity) < ev.t || resurfaced < ev.t;
        else if (need === 'life') averted = (goneAt.earth ?? Infinity) < ev.t || resurfaced < ev.t || unlivable < ev.t;
        else if (need === 'moon') averted = moonLeft < ev.t;
        else if (need !== 'always') averted = (goneAt[need] ?? Infinity) < ev.t;
      }
      out.push({ ...ev, averted, natural: true });
    }

    // Engulfments by the giant Sun (from the natural tracks, or projected orbits).
    if (!ivs.length) {
      for (const b of BODIES) {
        const tr = this.base[b.id];
        if (b.id === 'theia' || b.id === 'moon' || !Number.isFinite(tr.tEnd)) continue;
        out.push({ id: `engulf-${b.id}`, t: tr.tEnd, rank: 3, kind: 'sun', focus: b.id, title: `${b.name} is swallowed by the Sun`, natural: true,
          text: b.id === 'earth' ? 'Earth\'s orbit has widened as the Sun lost mass, but not enough: tidal drag pulls the scorched planet into the red giant\'s envelope.' : `The swelling red giant reaches ${b.name}'s orbit and the planet spirals in.` });
      }
    } else {
      const tails = lastBr.ensureTails();
      tails.forEach((tail, slot) => {
        const id = lastBr.slotIds[slot];
        if (!tail || tail.engulfedAt == null || tail.parent >= 0) return;
        out.push({ id: `engulf-${id}`, t: tail.engulfedAt, rank: 3, kind: 'sun', focus: id, projected: true, title: `${name(id)} is swallowed by the Sun`,
          text: `Projected from ${name(id)}'s orbit at the end of the simulated period.` });
      });
    }

    // Climate turning points for Earth.
    const CLIMATE_EVENT = {
      frozen: ['Earth freezes over', 'Too little sunlight reaches Earth; ice spreads from the poles to the equator.'],
      moist: ['Earth\'s oceans begin to boil away', 'Sunlight passes the moist-greenhouse limit. Water vapour floods the stratosphere and escapes to space.'],
      desiccated: ['Earth\'s oceans are gone', 'A runaway greenhouse takes hold. What was a blue planet becomes a second Venus.'],
      molten: ['Earth\'s surface melts', 'The crust itself turns to magma under the glare of the Sun.'],
      temperate: ['Earth thaws', 'Sunlight returns to the range where liquid water is stable.'],
    };
    for (const c of info.climate) {
      if (c.climate === 'temperate' && c.from !== 'frozen') continue;
      const [title, text] = CLIMATE_EVENT[c.climate];
      if ((goneAt.earth ?? Infinity) < c.t) continue;
      out.push({ id: `climate-${c.climate}-${c.t}`, t: c.t, rank: 3, kind: 'earth', focus: 'earth', title, text, projected: c.projected, natural: c.t < tFirst });
    }

    // What the simulation found.
    for (const e of dyn) {
      const A = name(e.a), B = e.b ? name(e.b) : '';
      let title, text, focus = e.a, rank = 3;
      const v = e.speed ? `${e.speed.toFixed(e.speed < 10 ? 1 : 0)} km/s` : '';
      if (e.type === 'collision') {
        if (e.withHost) { title = `${A} is destroyed with ${name(e.withHost)}`; text = `${A} is lost in the collision.`; rank = 2; }
        else { title = `${B} collides with ${A}`; text = `Impact at ${v}. ${B} is absorbed; ${A} is left with ${(e.massA + e.massB) / MEARTH >= 10 ? ((e.massA + e.massB) / MEARTH).toFixed(0) : ((e.massA + e.massB) / MEARTH).toFixed(2)} Earth masses.`; }
      } else if (e.type === 'sunImpact') {
        title = `${A} falls into the Sun`; text = e.withHost ? `${A} is carried in with ${name(e.withHost)}.` : `${A} plunges into the Sun at ${v}.`; focus = 'sun'; if (e.withHost) rank = 2;
      } else if (e.type === 'engulfed') {
        title = `${A} is swallowed by the Sun`; text = `${A} passes inside the bloated Sun's tidal reach and spirals in.`;
      } else if (e.type === 'ejected') {
        title = e.bound ? `${A} is flung to the edge of the system` : `${A} is ejected from the solar system`;
        text = e.withHost ? `${A} leaves along with ${name(e.withHost)}.` : e.bound ? `${A} is now on an orbit thousands of AU across.` : `${A} is unbound from the Sun, leaving at ${v}. It will wander the galaxy alone.`;
        if (e.withHost) rank = 2;
      } else if (e.type === 'escaped') {
        title = `${A} is torn away from ${B}`; text = `${A} is no longer bound to ${B} and now orbits the Sun on its own.`;
      } else if (e.type === 'captured') {
        title = `${A} is captured by ${B}`; text = `${A} settles into orbit around ${B}.`;
      } else continue;
      out.push({ id: `dyn-${e.type}-${e.a}-${e.t}`, t: e.t, rank, kind: 'dynamics', focus, title, text });
    }

    // The player's own marks.
    for (const iv of ivs) {
      const title = iv.type === 'nudge' ? `You nudged ${name(iv.bodyId)}` : 'You opened a gravity well';
      const text = iv.type === 'nudge'
        ? `Velocity changed by ${(Math.hypot(...iv.dv) / KMS).toFixed(Math.hypot(...iv.dv) / KMS < 10 ? 2 : 0)} km/s${iv.label ? ` (${iv.label})` : ''}.`
        : `${iv.mass >= 0.01 ? iv.mass.toFixed(2) + ' solar masses' : (iv.mass / MEARTH).toFixed(iv.mass / MEARTH < 10 ? 1 : 0) + ' Earth masses'} held in place for ${iv.duration >= 1 ? iv.duration.toFixed(0) + ' yr' : (iv.duration * 365.25).toFixed(0) + ' days'}.`;
      out.push({ id: `iv-${iv.id}`, t: iv.t, rank: 3, kind: 'intervention', focus: iv.type === 'nudge' ? iv.bodyId : 'sun', title, text, interventionId: iv.id });
    }

    out.sort((p, q) => p.t - q.t);
    this._events = out;
    this._eventsStamp = this.stamp;
    return out;
  }
}

export { T_START, T_END, T_INTERVENE_MIN, REARTH_AU, AU_KM, elementsToState };
