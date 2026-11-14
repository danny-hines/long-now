// Background score: one long ambient track, looped with an equal-power
// crossfade between two <audio> elements so the seam is inaudible.
//
// Browsers only allow sound after a user gesture, so playback begins on the
// first click, tap or key press. The on/off choice is remembered.
//
// Levels are set on Web Audio gain nodes rather than on the elements: iOS
// ignores HTMLMediaElement.volume, which would leave the track at full volume
// with no fades. Where Web Audio is missing, element volume is the fallback.
const KEY = 'longnow.music';

export class Music {
  constructor(url, { volume = 0.5, fade = 9 } = {}) {
    this.url = url;
    this.volume = volume;
    this.fade = fade; // seconds of overlap at the loop point
    this.enabled = true;
    try { this.enabled = localStorage.getItem(KEY) !== 'off'; } catch {}
    this.started = false;
    this.starting = false;
    this.failed = false;
    this.hidden = false;
    this.master = 0; // current overall gain, eased toward the target
    this.crossing = false;
    this.cur = null;
    this.next = null;
    this.ctx = null;
    this.retryAt = 0; // seconds until a refused play() is tried again
  }

  _make() {
    const el = new Audio(this.url);
    el.preload = 'auto';
    el.addEventListener('error', () => { this.failed = true; });
    el.gain = null;
    if (this.ctx) {
      try {
        el.gain = this.ctx.createGain();
        el.gain.gain.value = 0;
        this.ctx.createMediaElementSource(el).connect(el.gain).connect(this.ctx.destination);
      } catch { el.gain = null; }
    }
    if (!el.gain) el.volume = 0;
    return el;
  }
  _level(el, v) {
    if (el.gain) el.gain.gain.value = v;
    else el.volume = v;
  }
  _play(el) {
    const p = el.play();
    return p && typeof p.then === 'function' ? p : Promise.resolve();
  }

  /**
   * Call from a user gesture (a click, a key, or a finger lifting — a finger
   * going down does not count). Safe to call on every gesture: once the music
   * is running it only wakes an audio context the browser has put to sleep.
   */
  start() {
    if (this.ctx && this.ctx.state !== 'running' && this.enabled && !this.hidden) this.ctx.resume().catch(() => {});
    if (this.started && this.enabled && !this.hidden && this.cur.paused && !this.cur.ended) this._play(this.cur).catch(() => {});
    if (this.started || this.starting || !this.enabled || this.failed) return;
    this.starting = true;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      try { if (AC) this.ctx = new AC(); } catch { this.ctx = null; }
      if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    }
    if (!this.cur) {
      this.cur = this._make();
      this.next = this._make();
    }
    // Start the second element inside the gesture too, silently, so that the
    // loop is allowed to bring it in later with no gesture to hand.
    const { next } = this;
    next.muted = true;
    this._play(next).then(() => { next.pause(); next.currentTime = 0; }).catch(() => {}).finally(() => { next.muted = false; });
    this._play(this.cur).then(() => { this.started = true; }).catch(() => {}).finally(() => { this.starting = false; });
  }

  setEnabled(on) {
    this.enabled = on;
    try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch {}
    if (on) this.start();
  }
  toggle() { this.setEnabled(!this.enabled); return this.enabled; }

  /** Tab or app sent to the background: stop at once rather than play on unseen. */
  setHidden(hidden) {
    this.hidden = hidden;
    if (!this.started) return;
    if (hidden) {
      this.cur.pause(); this.next.pause();
      this.master = 0;
      this._level(this.cur, 0); this._level(this.next, 0);
    } else {
      this.retryAt = 0;
      if (this.ctx && this.ctx.state !== 'running' && this.enabled) this.ctx.resume().catch(() => {});
    }
  }

  /** Advance fades; call once per frame with the frame time in seconds. */
  update(dt) {
    if (!this.started || this.failed || this.hidden) return;
    const { cur, next } = this;
    const target = this.enabled ? this.volume : 0;
    this.master += (target - this.master) * Math.min(1, dt * 1.6);
    // A play() the browser refuses (it wants a fresh gesture after a spell in
    // the background) is retried once a second, not every frame.
    this.retryAt -= dt;
    const resume = (el) => { if (this.retryAt <= 0) { this.retryAt = 1; this._play(el).catch(() => {}); } };
    if (!this.enabled) {
      if (this.master < 0.004) { this.master = 0; this._level(cur, 0); this._level(next, 0); if (!cur.paused) cur.pause(); if (!next.paused) next.pause(); return; }
    } else {
      if (cur.paused && !cur.ended) resume(cur);
      if (this.crossing && next.paused && !next.ended) resume(next);
    }
    const d = cur.duration;
    if (cur.ended && !this.crossing) { cur.currentTime = 0; resume(cur); }
    if (!Number.isFinite(d) || d < this.fade * 3) { this._level(cur, this.master); return; }
    const remain = d - cur.currentTime;
    if (!this.crossing && remain <= this.fade) {
      this.crossing = true;
      next.currentTime = 0;
      this._level(next, 0);
      this._play(next).catch(() => {});
    }
    if (this.crossing) {
      const w = Math.min(1, Math.max(0, 1 - remain / this.fade));
      this._level(cur, this.master * Math.cos(w * Math.PI / 2));
      this._level(next, this.master * Math.sin(w * Math.PI / 2));
      if (cur.ended || remain <= 0.05) {
        cur.pause();
        this._level(cur, 0);
        this.cur = next; this.next = cur;
        this.crossing = false;
      }
    } else this._level(cur, this.master);
  }
}
