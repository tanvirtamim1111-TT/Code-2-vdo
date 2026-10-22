// Code2Video in-frame runtime.
// Loaded as the very first script inside the preview/render iframe. It replaces the
// page's clock (performance.now, Date, requestAnimationFrame, timers, CSS/WAAPI/SMIL
// animations) with a virtual clock that the parent app advances frame by frame, and
// exposes a capture() that rasterises the current DOM into a canvas.
import { toCanvas, getFontEmbedCSS } from 'html-to-image';

(function () {
  const W = window;
  const real = {
    now: performance.now.bind(performance),
    raf: W.requestAnimationFrame.bind(W),
    caf: W.cancelAnimationFrame.bind(W),
    setTimeout: W.setTimeout.bind(W),
    clearTimeout: W.clearTimeout.bind(W),
    setInterval: W.setInterval.bind(W),
    clearInterval: W.clearInterval.bind(W),
    Date: W.Date,
  };
  const epoch = real.Date.now();

  let vt = 0; // virtual milliseconds since load
  // While true (during capture) timers and rAF go to the real browser APIs, so
  // the capture library can await images without waiting on the frozen clock.
  let passthrough = false;
  const tickListeners = new Set();

  const send = (type, data) => {
    try { W.parent.postMessage({ __c2v: true, type, data }, '*'); } catch (e) { /* ignore */ }
  };

  // ---- clock -------------------------------------------------------------
  performance.now = () => vt;

  class VDate extends real.Date {
    constructor(...args) {
      if (args.length === 0) super(epoch + vt);
      else super(...args);
    }
    static now() { return epoch + vt; }
  }
  VDate.parse = real.Date.parse;
  VDate.UTC = real.Date.UTC;
  W.Date = VDate;

  // ---- timers ------------------------------------------------------------
  const timers = new Map();
  let nextId = 1e8;
  let seq = 0;

  function addTimer(fn, delay, args, repeat) {
    const id = nextId++;
    const d = Math.max(0, Number(delay) || 0);
    timers.set(id, { fn, d, args, repeat, due: vt + d, seq: seq++ });
    return id;
  }
  W.setTimeout = function (fn, delay, ...args) {
    if (passthrough) return real.setTimeout(fn, delay, ...args);
    return addTimer(fn, delay, args, false);
  };
  W.setInterval = function (fn, delay, ...args) {
    if (passthrough) return real.setInterval(fn, delay, ...args);
    return addTimer(fn, delay, args, true);
  };
  W.clearTimeout = W.clearInterval = function (id) {
    if (timers.has(id)) timers.delete(id);
    else { real.clearTimeout(id); real.clearInterval(id); }
  };

  // ---- requestAnimationFrame -----------------------------------------------
  let rafQueue = new Map();
  let rafId = 1;
  W.requestAnimationFrame = function (cb) {
    if (passthrough) return -real.raf(cb);
    const id = rafId++;
    rafQueue.set(id, cb);
    return id;
  };
  W.cancelAnimationFrame = function (id) {
    if (id < 0) real.caf(-id);
    else rafQueue.delete(id);
  };

  // WebGL canvases must keep their buffer so they can be read back after drawing.
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
      attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
    }
    return origGetContext.call(this, type, attrs);
  };

  function report(err) {
    const msg = err && (err.stack || err.message) ? (err.message || String(err)) : String(err);
    send('error', msg);
  }
  function safe(fn, ...args) {
    try {
      if (typeof fn === 'function') fn(...args);
      else if (typeof fn === 'string') (0, eval)(fn);
    } catch (e) { report(e); }
  }

  // ---- animations (CSS animations/transitions, WAAPI, SMIL) ----------------
  const animStart = new WeakMap();
  const animDone = new WeakSet();
  function syncAnimations() {
    let list = [];
    try { list = document.getAnimations ? document.getAnimations() : []; } catch (e) { /* ignore */ }
    for (const a of list) {
      if (animDone.has(a)) {
        if (a.playState !== 'running') continue;
        // Restarted by the page (e.g. a.play()) — track it again from now.
        animDone.delete(a);
        animStart.delete(a);
      }
      if (!animStart.has(a)) {
        animStart.set(a, vt - (a.currentTime > 0 ? a.currentTime : 0));
        try { a.pause(); } catch (e) { /* ignore */ }
      }
      try {
        const rate = a.playbackRate || 1;
        const t = (vt - animStart.get(a)) * rate;
        const timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
        const end = timing ? timing.endTime : Infinity;
        if (rate > 0 && Number.isFinite(end) && t >= end) {
          // finish() fires the finished promise/event that libraries such as
          // framer-motion wait on; a paused animation would never fire it.
          animDone.add(a);
          a.finish();
        } else {
          a.currentTime = t;
        }
      } catch (e) { /* ignore */ }
    }
    const svgs = document.getElementsByTagName('svg');
    for (const s of svgs) {
      if (typeof s.setCurrentTime === 'function' && !(s.ownerSVGElement)) {
        try { s.pauseAnimations(); s.setCurrentTime(vt / 1000); } catch (e) { /* ignore */ }
      }
    }
    for (const v of document.getElementsByTagName('video')) {
      try {
        v.pause();
        const dur = v.duration;
        let t = vt / 1000;
        if (v.loop && dur > 0) t = t % dur;
        if (Math.abs(v.currentTime - t) > 0.001) v.currentTime = t;
      } catch (e) { /* ignore */ }
    }
  }

  // Advance the virtual clock by dt milliseconds.
  function tick(dt) {
    const target = vt + Math.max(0, dt || 0);
    let guard = 0;
    while (guard++ < 100000) {
      let best = null; let bestId = null;
      for (const [id, t] of timers) {
        if (t.due <= target && (!best || t.due < best.due || (t.due === best.due && t.seq < best.seq))) {
          best = t; bestId = id;
        }
      }
      if (!best) break;
      if (best.due > vt) vt = best.due;
      if (best.repeat) { best.due = vt + Math.max(best.d, 1); best.seq = seq++; } else timers.delete(bestId);
      safe(best.fn, ...best.args);
    }
    vt = target;
    const q = rafQueue;
    rafQueue = new Map();
    for (const cb of q.values()) safe(cb, vt);
    syncAnimations();
    for (const l of tickListeners) safe(l, vt);
  }

  // ---- capture --------------------------------------------------------------
  let fontCSS = null;
  function bgColor() {
    const isClear = (c) => !c || c === 'transparent' || /rgba\(.*,\s*0\)$/.test(c);
    const h = getComputedStyle(document.documentElement).backgroundColor;
    if (!isClear(h)) return h;
    const b = document.body && getComputedStyle(document.body).backgroundColor;
    if (!isClear(b)) return b;
    return '#ffffff';
  }

  // Pages made only of canvases (canvas 2D / WebGL / p5 / three.js) are composited
  // directly, which is far faster than going through the DOM serialiser.
  function canvasOnly() {
    const body = document.body;
    if (!body) return null;
    const canvases = body.getElementsByTagName('canvas');
    if (!canvases.length) return null;
    if (body.querySelector('img,svg,video,iframe,input,button,textarea,select')) return null;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const p = n.parentElement;
      if (n.nodeValue.trim() && p && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) {
        const st = getComputedStyle(p);
        if (st.display !== 'none' && st.visibility !== 'hidden') return null;
      }
    }
    return Array.from(canvases);
  }

  async function capture(width, height) {
    passthrough = true;
    try {
      const out = document.createElement('canvas');
      out.width = width; out.height = height;
      const ctx = out.getContext('2d');
      const canvases = canvasOnly();
      if (canvases) {
        ctx.fillStyle = bgColor();
        ctx.fillRect(0, 0, width, height);
        for (const c of canvases) {
          const st = getComputedStyle(c);
          if (st.display === 'none' || st.visibility === 'hidden' || !c.width || !c.height) continue;
          const r = c.getBoundingClientRect();
          ctx.globalAlpha = parseFloat(st.opacity) || 1;
          try { ctx.drawImage(c, r.left, r.top, r.width, r.height); } catch (e) { report(e); }
        }
        ctx.globalAlpha = 1;
        return out;
      }
      const root = document.documentElement;
      if (fontCSS === null) {
        try { fontCSS = await getFontEmbedCSS(root); } catch (e) { fontCSS = ''; }
      }
      const c = await toCanvas(root, {
        width, height, canvasWidth: width, canvasHeight: height,
        pixelRatio: 1, skipAutoScale: true, cacheBust: false,
        backgroundColor: bgColor(), fontEmbedCSS: fontCSS,
        imagePlaceholder: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
        filter: (node) => !(node.tagName === 'SCRIPT' || node.tagName === 'NOSCRIPT'),
      });
      ctx.drawImage(c, 0, 0, width, height);
      return out;
    } finally {
      passthrough = false;
    }
  }

  // Waits for fonts and images so the first frame is not captured half loaded.
  async function ready(timeout = 8000) {
    {
      const waits = [];
      if (document.fonts && document.fonts.ready) waits.push(document.fonts.ready);
      for (const img of document.images) {
        if (!img.complete) waits.push(new Promise((r) => { img.onload = img.onerror = r; }));
      }
      await Promise.race([
        Promise.all(waits),
        new Promise((r) => real.setTimeout(r, timeout)),
      ]);
    }
  }

  W.addEventListener('error', (e) => report(e.error || e.message));
  W.addEventListener('unhandledrejection', (e) => report(e.reason));
  const origErr = console.error.bind(console);
  console.error = (...a) => { origErr(...a); send('console', a.map(String).join(' ')); };

  W.__c2v = {
    tick,
    capture,
    ready,
    time: () => vt,
    onTick: (fn) => { tickListeners.add(fn); return () => tickListeners.delete(fn); },
    config: W.__C2V_CONFIG || {},
    send,
    realSetTimeout: real.setTimeout,
  };
})();
