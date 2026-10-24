// Code2Video in-frame runtime.
// Loaded as the very first script inside the preview/render iframe. It replaces the
// page's clock (performance.now, Date, requestAnimationFrame, timers, CSS/WAAPI/SMIL
// animations) with a virtual clock that the parent app advances frame by frame, and
// exposes a capture() that rasterises the current DOM into a canvas.
import { Snapshotter } from './snapshot.js';

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

  // ---- finish events -------------------------------------------------------------
  // Browsers deliver an animation's `finish` event (and CSS animationend/transitionend)
  // only at the next real repaint, which on the virtual clock can be many frames late.
  // When the runtime finishes an animation it delivers these events right away and
  // drops the browser's late duplicate.
  const delivered = new WeakSet(); // animations whose finish event was already sent
  const MARK = Symbol('c2v-event');
  const AP = W.Animation && W.Animation.prototype;
  if (AP) {
    const origAdd = AP.addEventListener;
    const origRemove = AP.removeEventListener;
    const wrappers = new WeakMap();
    const guard = (fn) => {
      if (!wrappers.has(fn)) {
        wrappers.set(fn, function (e) {
          if (e && e.type === 'finish' && !e[MARK] && delivered.has(this)) return undefined;
          return typeof fn === 'function' ? fn.call(this, e) : fn.handleEvent(e);
        });
      }
      return wrappers.get(fn);
    };
    AP.addEventListener = function (type, fn, opts) {
      if (type === 'finish' && fn) return origAdd.call(this, type, guard(fn), opts);
      return origAdd.call(this, type, fn, opts);
    };
    AP.removeEventListener = function (type, fn, opts) {
      if (type === 'finish' && fn && wrappers.has(fn)) return origRemove.call(this, type, wrappers.get(fn), opts);
      return origRemove.call(this, type, fn, opts);
    };
    const desc = Object.getOwnPropertyDescriptor(AP, 'onfinish');
    if (desc && desc.set) {
      const own = new WeakMap();
      Object.defineProperty(AP, 'onfinish', {
        configurable: true,
        enumerable: desc.enumerable,
        get() { return own.has(this) ? own.get(this) : null; },
        set(fn) {
          own.set(this, fn);
          desc.set.call(this, typeof fn === 'function' ? guard(fn) : fn);
        },
      });
    }
  }
  // Late native animationend/transitionend for animations already reported are dropped.
  const sentCss = new Map(); // "kind|name" per element -> count still to swallow
  const cssKey = (el, kind, name) => {
    if (!el.__c2vId) el.__c2vId = Math.random().toString(36).slice(2);
    return `${el.__c2vId}|${kind}|${name}`;
  };
  for (const type of ['animationend', 'transitionend']) {
    W.addEventListener(type, (e) => {
      if (e[MARK]) return;
      const name = type === 'animationend' ? e.animationName : e.propertyName;
      const k = cssKey(e.target, type, name);
      const n = sentCss.get(k);
      if (n) {
        if (n > 1) sentCss.set(k, n - 1); else sentCss.delete(k);
        e.stopImmediatePropagation();
      }
    }, true);
  }

  function finishNow(a) {
    a.finish();
    if (delivered.has(a)) return;
    delivered.add(a);
    try {
      const ev = new AnimationPlaybackEvent('finish', { currentTime: a.currentTime, timelineTime: null });
      ev[MARK] = true;
      a.dispatchEvent(ev);
    } catch (e) { report(e); }
    const target = a.effect && a.effect.target;
    if (!target) return;
    let ev = null;
    let k = null;
    try {
      if (typeof CSSAnimation !== 'undefined' && a instanceof CSSAnimation) {
        const timing = a.effect.getComputedTiming();
        ev = new AnimationEvent('animationend', {
          bubbles: true, animationName: a.animationName,
          elapsedTime: (timing.activeDuration || 0) / 1000, pseudoElement: a.effect.pseudoElement || '',
        });
        k = cssKey(target, 'animationend', a.animationName);
      } else if (typeof CSSTransition !== 'undefined' && a instanceof CSSTransition) {
        const timing = a.effect.getComputedTiming();
        ev = new TransitionEvent('transitionend', {
          bubbles: true, propertyName: a.transitionProperty,
          elapsedTime: (timing.activeDuration || 0) / 1000, pseudoElement: a.effect.pseudoElement || '',
        });
        k = cssKey(target, 'transitionend', a.transitionProperty);
      }
    } catch (e) { ev = null; }
    if (ev) {
      ev[MARK] = true;
      sentCss.set(k, (sentCss.get(k) || 0) + 1);
      safe(() => target.dispatchEvent(ev));
    }
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
        delivered.delete(a);
        animStart.delete(a);
      }
      if (!animStart.has(a)) {
        // The clock is frozen between ticks, so anything new started at the current
        // virtual time; its own currentTime only reflects real milliseconds elapsed.
        animStart.set(a, vt);
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
          finishNow(a);
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
  let snapshotter = null;
  let outCanvas = null;
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
      // One output canvas is reused; the encoder copies each frame out of it.
      if (!outCanvas || outCanvas.width !== width || outCanvas.height !== height) {
        outCanvas = document.createElement('canvas');
        outCanvas.width = width; outCanvas.height = height;
      }
      const out = outCanvas;
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
      if (!snapshotter) snapshotter = new Snapshotter(W);
      await snapshotter.draw(ctx, width, height);
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

  // ---- change detection ------------------------------------------------------
  // A compact per-element description of what is on screen, used to work out how
  // long the animation runs. Numbers are rounded so easing tails count as settled.
  const FP_PROPS = ['transform', 'translate', 'rotate', 'scale', 'opacity', 'visibility', 'left', 'top', 'right', 'bottom',
    'width', 'height', 'color', 'background-color', 'background-image', 'background-position', 'filter', 'clip-path',
    'font-size', 'letter-spacing', 'border-radius', 'box-shadow', 'fill', 'stroke', 'stroke-dashoffset', 'offset-distance'];
  const roundNums = (str) => str
    .replace(/-?\d+\.\d+/g, (m) => (+m).toFixed(2).replace(/^-(0\.00)$/, '$1'))
    // An identity transform looks the same as none (framer-motion swaps them after a while).
    .replace(/matrix\(1(\.00)?, 0(\.00)?, 0(\.00)?, 1(\.00)?, 0(\.00)?, 0(\.00)?\)/g, 'none');
  const hashStr = (str) => {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };
  let fpCanvas = null;
  function canvasSig(c) {
    if (!c.width || !c.height) return '';
    try {
      if (!fpCanvas) { fpCanvas = document.createElement('canvas'); fpCanvas.width = 16; fpCanvas.height = 9; }
      const x = fpCanvas.getContext('2d', { willReadFrequently: true });
      x.clearRect(0, 0, 16, 9);
      x.drawImage(c, 0, 0, 16, 9);
      const d = x.getImageData(0, 0, 16, 9).data;
      let sig = '';
      for (let i = 0; i < d.length; i++) sig += (d[i] >> 4).toString(16);
      return sig;
    } catch (e) { return ''; }
  }
  function fingerprint(limit = 3000, raw = false) {
    const out = [];
    const walk = (el, path) => {
      if (out.length >= limit) return;
      if (/^(SCRIPT|STYLE|LINK|META|TEMPLATE|NOSCRIPT)$/.test(el.tagName)) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') { out.push([path, 0]); return; }
      let sig = el.tagName;
      for (const p of FP_PROPS) sig += '|' + cs.getPropertyValue(p);
      for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) sig += c.nodeValue;
      if (el.namespaceURI === 'http://www.w3.org/2000/svg') for (const a of el.attributes) sig += `|${a.name}=${a.value}`;
      if (el.tagName === 'CANVAS') sig += canvasSig(el);
      if (el.tagName === 'VIDEO') sig += `|v${Math.min(el.currentTime, el.duration || Infinity).toFixed(1)}`;
      out.push([path, raw ? roundNums(sig) : hashStr(roundNums(sig))]);
      let i = 0;
      for (let c = el.firstElementChild; c; c = c.nextElementSibling) walk(c, `${path}/${i++}`);
    };
    if (document.body) walk(document.body, 'b');
    return out;
  }

  // Lets the host wait until React/Vue renders and other async work have settled.
  let mutated = false;
  const observe = () => {
    new MutationObserver(() => { mutated = true; })
      .observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  };
  if (document.documentElement) observe();
  else document.addEventListener('readystatechange', observe, { once: true });

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
    fingerprint,
    takeMutated: () => { const m = mutated; mutated = false; return m; },
  };
})();
