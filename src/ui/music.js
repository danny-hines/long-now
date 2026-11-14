// Background score: one long ambient track, looped with an equal-power
// crossfade between two <audio> elements so the seam is inaudible.
//
// Browsers only allow sound after a user gesture, so playback begins on the
// first click or key press. The on/off choice is remembered.
const KEY = 'longnow.music';

export class Music {
  constructor(url, { volume = 0.5, fade = 9 } = {}) {
    this.url = url;
    this.volume = volume;
    this.fade = fade; // seconds of overlap at the loop point
    this.enabled = true;
    try { this.enabled = localStorage.getItem(KEY) !== 'off'; } catch {}
    this.started = false;
    this.failed = false;
    this.master = 0; // current overall gain, eased toward the target
    this.crossing = false;
    this.cur = null;
    this.next = null;
  }

  _make() {
    const el = new Audio(this.url);
    el.preload = 'auto';
    el.volume = 0;
    el.addEventListener('error', () => { this.failed = true; });
    return el;
  }

  /** Call from a user gesture. Safe to call repeatedly. */
  start() {
    if (this.started || !this.enabled || this.failed) return;
    this.started = true;
    this.cur = this._make();
    this.next = this._make();
    this.cur.play().catch(() => { this.started = false; });
  }

  setEnabled(on) {
    this.enabled = on;
    try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch {}
    if (on) this.start();
  }
  toggle() { this.setEnabled(!this.enabled); return this.enabled; }

  /** Advance fades; call once per frame with the frame time in seconds. */
  update(dt) {
    if (!this.started || this.failed) return;
    const { cur, next } = this;
    const target = this.enabled ? this.volume : 0;
    this.master += (target - this.master) * Math.min(1, dt * 1.6);
    if (!this.enabled) {
      if (this.master < 0.004) { this.master = 0; if (!cur.paused) cur.pause(); if (!next.paused) next.pause(); return; }
    } else {
      if (cur.paused && !cur.ended) cur.play().catch(() => {});
      if (this.crossing && next.paused && !next.ended) next.play().catch(() => {});
    }
    const d = cur.duration;
    if (cur.ended && !this.crossing) { cur.currentTime = 0; cur.play().catch(() => {}); }
    if (!Number.isFinite(d) || d < this.fade * 3) { cur.volume = this.master; return; }
    const remain = d - cur.currentTime;
    if (!this.crossing && remain <= this.fade) {
      this.crossing = true;
      next.currentTime = 0;
      next.volume = 0;
      next.play().catch(() => {});
    }
    if (this.crossing) {
      const w = Math.min(1, Math.max(0, 1 - remain / this.fade));
      cur.volume = this.master * Math.cos(w * Math.PI / 2);
      next.volume = this.master * Math.sin(w * Math.PI / 2);
      if (cur.ended || remain <= 0.05) {
        cur.pause();
        this.cur = next; this.next = cur;
        this.crossing = false;
      }
    } else cur.volume = this.master;
  }
}
