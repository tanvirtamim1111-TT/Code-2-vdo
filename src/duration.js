// Works out how long pasted animation code runs by playing it on the virtual clock in
// a hidden frame (much faster than real time) and watching when the picture changes.
import { FrameHost } from './frame-host.js';

// ms of animation time between samples. A whole number keeps the virtual clock exact
// (no float drift) and divides typical loop lengths, so repeats compare equal.
const STEP = 25;
const HOLD = 500; // ms kept on screen after the last change
const MAX_TIME = 300000; // give up after 5 minutes of animation time
const STATIC_STOP = 15000; // nothing changed for this long: the animation has ended
const LIVE_WINDOW = 5000; // elements that changed this recently are still animating
const HIST = 3200; // samples of history kept per element (80s), so loops up to 40s are found

// Smallest period (in samples) with which `comb` repeats over its last two periods.
function findPeriod(comb, minP, maxP) {
  const n = comb.length;
  for (let p = minP; p <= maxP && 2 * p <= n; p++) {
    let ok = true;
    for (let i = n - p; i < n; i++) {
      if (comb[i] !== comb[i - p]) { ok = false; break; }
    }
    if (!ok) continue;
    for (let i = n - p + 1; i < n; i++) if (comb[i] !== comb[i - 1]) return p; // not just static
  }
  return null;
}

function classify(keys, steps, t) {
  let finiteEnd = 0;
  const live = [];
  for (const rec of keys.values()) {
    if (rec.lastChange > t - LIVE_WINDOW) live.push(rec);
    else finiteEnd = Math.max(finiteEnd, rec.lastChange);
  }
  let period = null;
  if (live.length) {
    const n = Math.min(steps, HIST);
    const comb = new Uint32Array(n);
    for (let j = 0; j < n; j++) {
      const slot = (steps - n + j) % HIST;
      let h = 0;
      for (const rec of live) h = (Math.imul(h ^ rec.hist[slot], 16777619) + 1) >>> 0;
      comb[j] = h;
    }
    const p = findPeriod(comb, Math.round(500 / STEP), Math.floor(n / 2));
    if (p) period = p * STEP;
  }
  return { finiteEnd, live: live.length, period };
}

/**
 * Resolves to { seconds, kind } where kind is 'finite' | 'loop' | 'endless' | 'static',
 * or null when cancelled. seconds is null when no length can be determined.
 */
export async function measureDuration({ doc, stage, width, height, signal, onMessage }) {
  const host = new FrameHost(stage, { width, height, onMessage });
  try {
    await host.load(doc);
    if (signal.aborted) return null;
    const keys = new Map(); // element path -> { h, lastChange, hist }
    let t = 0;
    let step = 0;
    let lastAny = 0;
    let anyChange = false;
    const changed = () => { lastAny = t; anyChange = true; };
    const sample = () => {
      const slot = step % HIST;
      const seen = new Set();
      for (const [k, h] of host.api.fingerprint(1500)) {
        seen.add(k);
        let rec = keys.get(k);
        if (!rec) {
          rec = { h, lastChange: t, hist: new Uint32Array(HIST) };
          keys.set(k, rec);
          if (step > 0) changed();
        } else if (rec.h !== h) {
          rec.h = h; rec.lastChange = t; changed();
        }
        rec.hist[slot] = h;
      }
      for (const [k, rec] of keys) {
        if (seen.has(k)) continue;
        if (rec.h !== -1) { rec.h = -1; rec.lastChange = t; changed(); }
        rec.hist[slot] = 0;
      }
      step++;
    };
    sample();
    while (t < MAX_TIME) {
      if (signal.aborted) return null;
      host.tick(STEP);
      t = Math.round(step * STEP);
      await host.settle();
      sample();
      if (t - lastAny >= STATIC_STOP) break;
      if (step % 200 === 0 && t >= 20000) {
        const c = classify(keys, step, t);
        // The one-off part has settled: stop once a loop is confirmed, or after a while.
        if (t - c.finiteEnd >= 15000 && (c.period || t >= 30000)) break;
      }
    }
    if (!anyChange) return { seconds: null, kind: 'static' };
    if (t - lastAny >= STATIC_STOP) return { seconds: (lastAny + HOLD) / 1000, kind: 'finite' };
    const c = classify(keys, step, t);
    if (c.period) return { seconds: Math.max(c.period, c.finiteEnd ? c.finiteEnd + HOLD : 0) / 1000, kind: 'loop' };
    if (c.finiteEnd > 1000) return { seconds: (c.finiteEnd + HOLD) / 1000, kind: 'endless' };
    return { seconds: null, kind: 'endless' };
  } finally {
    host.destroy();
  }
}
