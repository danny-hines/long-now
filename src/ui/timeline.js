// The scrubbable timeline: 12.6 billion years on one bar, zoomable to a single
// year, with flagged events that are re-laid-out whenever the world line changes.
import { T_START, T_END, T_INTERVENE_MIN } from '../sim/constants.js';
import { formatTimeShort } from '../sim/history.js';

const KIND_COLOR = {
  formation: '#c9a27a', sun: '#ffd27a', earth: '#7fb4ff', life: '#8fd68a', planet: '#c7b8e8', sky: '#9a968c',
  now: '#ffffff', dynamics: '#ffb84d', intervention: '#ffb84d',
};
const PAD = 0.02 * (T_END - T_START);

export class Timeline {
  constructor(canvas, { onScrub, onJump, onHover }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onScrub = onScrub; this.onJump = onJump; this.onHover = onHover;
    this.v0 = T_START - PAD; this.v1 = T_END + PAD;
    this.t = 0;
    this.events = [];
    this.segments = [];
    this.layout = [];
    this.hover = null;
    this.dragging = false;
    this._bind();
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(100, r.width); this.h = Math.max(60, r.height);
    this.canvas.width = Math.round(this.w * dpr); this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.barY = this.h - 30;
    this._dirty = true;
  }

  x(t) { return ((t - this.v0) / (this.v1 - this.v0)) * this.w; }
  tAt(x) { return this.v0 + (x / this.w) * (this.v1 - this.v0); }
  get span() { return this.v1 - this.v0; }
  get zoomed() { return this.span < (T_END - T_START) * 0.98; }

  fit() { this.v0 = T_START - PAD; this.v1 = T_END + PAD; this._dirty = true; }
  /** Zooms so that [a, b] fills the middle of the bar. */
  show(a, b) {
    const m = (b - a) * 0.15;
    this.setView(a - m, b + m);
  }
  setView(v0, v1) {
    let span = Math.max(4, Math.min(T_END - T_START + 2 * PAD, v1 - v0));
    let c = (v0 + v1) / 2;
    c = Math.max(T_START - PAD + span / 2, Math.min(T_END + PAD - span / 2, c));
    this.v0 = c - span / 2; this.v1 = c + span / 2;
    this._dirty = true;
  }
  zoomAt(x, factor) {
    const t = this.tAt(x);
    const span = Math.max(4, Math.min(T_END - T_START + 2 * PAD, this.span * factor));
    const f = x / this.w;
    this.setView(t - f * span, t + (1 - f) * span);
  }

  setData(events, segments) { this.events = events; this.segments = segments; this._dirty = true; }

  /** Keeps the playhead in view while playing. */
  follow(t) {
    if (this.dragging) return;
    const x = this.x(t);
    if (x < 0 || x > this.w) this.setView(t - this.span * 0.15, t + this.span * 0.85);
    else if (x > this.w * 0.94 && this.v1 < T_END + PAD) this.setView(this.v0 + this.span * 0.3, this.v1 + this.span * 0.3);
    else if (x < this.w * 0.03 && this.v0 > T_START - PAD) this.setView(this.v0 - this.span * 0.3, this.v1 - this.span * 0.3);
  }

  _bind() {
    const c = this.canvas;
    const local = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    c.addEventListener('pointerdown', (e) => {
      const [x, y] = local(e);
      const hit = this._hit(x, y);
      if (hit) { this.onJump(hit.ev); return; }
      this.dragging = true;
      c.setPointerCapture(e.pointerId);
      this.onScrub(Math.max(T_START, Math.min(T_END, this.tAt(x))));
    });
    c.addEventListener('pointermove', (e) => {
      const [x, y] = local(e);
      if (this.dragging) {
        // Dragging past the edge pans the view.
        if (x < 8 && this.v0 > T_START - PAD) this.setView(this.v0 - this.span * 0.02, this.v1 - this.span * 0.02);
        if (x > this.w - 8 && this.v1 < T_END + PAD) this.setView(this.v0 + this.span * 0.02, this.v1 + this.span * 0.02);
        this.onScrub(Math.max(T_START, Math.min(T_END, this.tAt(x))));
        return;
      }
      const hit = this._hit(x, y);
      if (hit !== this.hover) { this.hover = hit; this._dirty = true; }
      c.style.cursor = hit ? 'pointer' : 'ew-resize';
      this.onHover(hit ? hit.ev : null, e.clientX, e.clientY, this.tAt(x));
    });
    const end = (e) => { if (this.dragging) { this.dragging = false; try { c.releasePointerCapture(e.pointerId); } catch {} } };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { this.hover = null; this._dirty = true; this.onHover(null); });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x] = local(e);
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = (e.deltaX / this.w) * this.span;
        this.setView(this.v0 + d, this.v1 + d);
      } else this.zoomAt(x, Math.exp(e.deltaY * 0.0022));
    }, { passive: false });
    c.addEventListener('dblclick', () => this.fit());
  }

  _hit(x, y) {
    for (let i = this.layout.length - 1; i >= 0; i--) {
      const L = this.layout[i];
      if (L.label && x >= L.lx - 3 && x <= L.lx + L.lw + 3 && y >= L.ly - 11 && y <= L.ly + 4) return L;
    }
    let best = null, bd = 7;
    for (const L of this.layout) {
      const d = Math.abs(L.x - x);
      if (d < bd && y > this.barY - 14 && y < this.barY + 12) { bd = d; best = L; }
    }
    return best;
  }

  _ticks() {
    const span = this.span;
    const target = span / Math.max(4, this.w / 110);
    const p = Math.pow(10, Math.floor(Math.log10(target)));
    const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= target);
    const out = [];
    for (let t = Math.ceil(this.v0 / step) * step; t <= this.v1; t += step) out.push(Math.abs(t) < step * 1e-6 ? 0 : t);
    return { ticks: out, step };
  }

  draw(t, playingProjected) {
    this.t = t;
    const { ctx, w, h, barY } = this;
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px "Avenir Next", "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';

    // Ticks.
    const { ticks, step } = this._ticks();
    ctx.fillStyle = 'rgba(154,150,140,0.9)';
    ctx.strokeStyle = 'rgba(233,230,223,0.16)';
    ctx.lineWidth = 1;
    ctx.textAlign = 'center';
    for (const tk of ticks) {
      const x = Math.round(this.x(tk)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, barY + 4); ctx.lineTo(x, barY + 9); ctx.stroke();
      const label = step < 1e6 && Math.abs(tk) >= 1e6 ? relLabel(tk, step) : formatTimeShort(tk);
      ctx.fillText(label, x, barY + 22);
    }

    // The bar: natural history, simulated stretch, projection.
    const clampX = (tt) => Math.max(-2, Math.min(w + 2, this.x(tt)));
    for (const s of this.segments) {
      const xa = clampX(Math.max(s.t0, T_START)), xb = clampX(Math.min(s.t1, T_END));
      if (xb <= xa) continue;
      ctx.lineWidth = s.kind === 'natural' ? 2 : 3;
      ctx.setLineDash(s.kind === 'projected' ? [5, 4] : []);
      ctx.strokeStyle = s.kind === 'natural' ? 'rgba(233,230,223,0.55)' : s.kind === 'simulated' ? '#63d2c6' : 'rgba(99,210,198,0.6)';
      ctx.beginPath(); ctx.moveTo(xa, barY + 0.5); ctx.lineTo(xb, barY + 0.5); ctx.stroke();
    }
    ctx.setLineDash([]);
    // Formation era, where interventions are not available.
    const xi = clampX(T_INTERVENE_MIN);
    if (xi > 0) {
      ctx.fillStyle = 'rgba(201,162,122,0.10)';
      ctx.fillRect(clampX(T_START), barY - 5, xi - clampX(T_START), 10);
    }

    // Events: place labels by rank, in up to four rows, skipping any that collide.
    if (this._dirty || this._layoutFor !== `${this.v0}|${this.v1}|${w}`) this._layout();
    for (const L of this.layout) {
      const ev = L.ev;
      const col = ev.averted ? 'rgba(154,150,140,0.55)' : KIND_COLOR[ev.kind] || '#ccc';
      const hot = this.hover === L;
      ctx.strokeStyle = col; ctx.fillStyle = col;
      ctx.globalAlpha = ev.averted ? 0.7 : 1;
      if (L.label) {
        ctx.lineWidth = 1;
        ctx.globalAlpha *= 0.55;
        ctx.beginPath(); ctx.moveTo(L.x + 0.5, barY - 6); ctx.lineTo(L.x + 0.5, L.ly + 3); ctx.stroke();
        ctx.globalAlpha = ev.averted ? 0.7 : 1;
        ctx.textAlign = 'left';
        ctx.fillStyle = hot ? '#fff' : ev.averted ? 'rgba(154,150,140,0.75)' : ev.kind === 'dynamics' || ev.kind === 'intervention' ? '#ffb84d' : 'rgba(233,230,223,0.92)';
        ctx.font = `${ev.projected ? 'italic ' : ''}11px "Avenir Next", "Segoe UI", system-ui, sans-serif`;
        ctx.fillText(L.text, L.lx, L.ly);
        if (ev.averted) { ctx.beginPath(); ctx.moveTo(L.lx, L.ly - 4); ctx.lineTo(L.lx + L.lw, L.ly - 4); ctx.strokeStyle = 'rgba(154,150,140,0.75)'; ctx.stroke(); }
        ctx.fillStyle = col; ctx.strokeStyle = col;
      }
      // Marker: diamond for things that happen, ring for projections, bar for interventions.
      const r = hot ? 5 : ev.rank >= 3 ? 4 : 3;
      ctx.beginPath();
      if (ev.kind === 'intervention') { ctx.fillRect(L.x - 1.5, barY - 9, 3, 18); }
      else {
        ctx.moveTo(L.x, barY - r); ctx.lineTo(L.x + r, barY); ctx.lineTo(L.x, barY + r); ctx.lineTo(L.x - r, barY); ctx.closePath();
        if (ev.projected || ev.averted) { ctx.fillStyle = '#000'; ctx.fill(); ctx.lineWidth = 1.2; ctx.stroke(); } else ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // Playhead.
    const px = this.x(t);
    if (px >= -1 && px <= w + 1) {
      ctx.strokeStyle = playingProjected ? 'rgba(99,210,198,0.95)' : '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, 8); ctx.lineTo(px, barY + 9); ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.moveTo(px - 5, 2); ctx.lineTo(px + 5, 2); ctx.lineTo(px, 9); ctx.closePath(); ctx.fill();
    }

    // Overview strip when zoomed in.
    if (this.zoomed) {
      const full = T_END - T_START;
      const a = ((this.v0 - T_START) / full) * w, b = ((this.v1 - T_START) / full) * w;
      ctx.fillStyle = 'rgba(233,230,223,0.12)';
      ctx.fillRect(0, h - 3, w, 2);
      ctx.fillStyle = 'rgba(233,230,223,0.75)';
      ctx.fillRect(Math.max(0, a), h - 3, Math.max(3, b - a), 2);
    }
  }

  _layout() {
    const { ctx, w, barY } = this;
    this._layoutFor = `${this.v0}|${this.v1}|${w}`;
    this._dirty = false;
    const rows = [barY - 16, barY - 32, barY - 48, barY - 64, barY - 80];
    const taken = rows.map(() => []);
    const vis = [];
    for (const ev of this.events) {
      const x = this.x(ev.t);
      if (x < -4 || x > w + 4) continue;
      vis.push({ ev, x, label: false });
    }
    // Most important first; your own actions and their consequences outrank the rest.
    const weight = (e) => e.rank * 10 + (e.kind === 'intervention' ? 9 : e.kind === 'dynamics' ? 8 : e.kind === 'now' ? 7 : 0) - (e.averted ? 12 : 0);
    const order = vis.slice().sort((p, q) => weight(q.ev) - weight(p.ev));
    ctx.font = '11px "Avenir Next", "Segoe UI", system-ui, sans-serif';
    for (const L of order) {
      const text = L.ev.title;
      const lw = ctx.measureText(text).width;
      let lx = L.x + 5;
      if (lx + lw > w - 2) lx = L.x - 5 - lw;
      if (lx < 2) continue;
      for (let r = 0; r < rows.length; r++) {
        // The label and its leader line must not cross labels in this or lower rows.
        const free = taken[r].every(([a, b]) => lx + lw + 8 < a || lx - 8 > b);
        const leaderFree = taken.slice(0, r).every((row) => row.every(([a, b]) => L.x < a - 2 || L.x > b + 2));
        if (free && leaderFree) {
          taken[r].push([lx, lx + lw]);
          L.label = true; L.lx = lx; L.lw = lw; L.ly = rows[r]; L.text = text;
          break;
        }
      }
    }
    // Draw unlabelled markers first so labelled ones sit on top.
    this.layout = vis.sort((p, q) => (p.label ? 1 : 0) - (q.label ? 1 : 0) || weight(p.ev) - weight(q.ev));
  }
}

// When zoomed far in at a distant epoch, tick labels show the fine part only.
function relLabel(t, step) {
  const a = Math.abs(t);
  const unit = step >= 1e3 ? 1e3 : 1;
  const digits = Math.max(0, Math.ceil(Math.log10(a / step)) + 1);
  const big = a >= 1e9 ? [a / 1e9, t < 0 ? ' Ga' : ' Gyr'] : [a / 1e6, t < 0 ? ' Ma' : ' Myr'];
  void unit;
  return `${t > 0 ? '+' : ''}${big[0].toPrecision(Math.min(15, digits))}${big[1]}`;
}
