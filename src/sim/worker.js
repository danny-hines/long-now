// Background thread that plays out the consequences of an intervention.
// It integrates forward from the moment of the change and streams back orbit
// samples and events (collisions, ejections…) as it goes, like a video buffer.
import { NBody } from './nbody.js';

const QUIET_HORIZON = 2e6; // yr to keep integrating once the system looks stable
const MAX_HORIZON = 3e8; // hard cap for systems that never settle

let timer = null;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type !== 'start') return;
  if (timer) clearTimeout(timer);
  run(msg);
};

function run({ job, t0, tEnd, bodies, wells }) {
  let sim;
  try {
    sim = new NBody({ t0, bodies, wells });
  } catch (err) {
    self.postMessage({ type: 'chunk', job, tRel: 0, streams: [], wells: [], events: [], done: true, status: 'error', error: String(err) });
    return;
  }
  const limit = tEnd - t0;
  const wellEnd = wells.reduce((m, w) => Math.max(m, w.tEnd - t0), 0);
  let lastCheck = 0, lastUnsettled = 0;
  let wall0 = performance.now(), tRel0 = 0;

  const slice = () => {
    const start = performance.now();
    let status = 'running';
    try {
      // Small first slices so the first seconds of aftermath appear at once.
      const budget = sim.tRel < 50 ? 12 : 60;
      while (performance.now() - start < budget) {
        for (let k = 0; k < 200; k++) sim.step();
        if (sim.tRel >= limit) { status = 'end'; break; }
        if (sim.n < 2) { status = 'settled'; break; }
        if (sim.tRel >= MAX_HORIZON) { status = 'unresolved'; break; }
        if (sim.tRel - lastCheck >= 5000) {
          lastCheck = sim.tRel;
          if (sim.tRel < wellEnd || !sim.isSettled()) lastUnsettled = sim.tRel;
          else if (sim.tRel - lastUnsettled >= QUIET_HORIZON) { status = 'settled'; break; }
        }
      }
    } catch (err) {
      status = 'error';
      self.postMessage({ type: 'chunk', job, tRel: sim.tRel, streams: [], wells: [], events: [], done: true, status, error: String(err) });
      return;
    }
    sim.emit(0); // every body gets a sample at the chunk boundary
    const { streams, wells: wellStreams, events } = sim.drain();
    const now = performance.now();
    const rate = (sim.tRel - tRel0) / Math.max(1e-3, (now - wall0) / 1000);
    wall0 = now; tRel0 = sim.tRel;
    const done = status !== 'running';
    self.postMessage(
      { type: 'chunk', job, tRel: sim.tRel, streams, wells: wellStreams, events, done, status, rate, mode: sim.mode, settled: done ? status === 'settled' : undefined },
      [...streams.map((s) => s.buffer), ...wellStreams.map((s) => s.buffer)],
    );
    if (!done) timer = setTimeout(slice, 0);
  };
  slice();
}
