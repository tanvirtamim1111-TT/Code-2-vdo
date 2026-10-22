// Lightweight stand-in for the `remotion` package, driven by the Code2Video virtual clock.
// Covers the APIs Claude-written Remotion compositions commonly use.
import React, { createContext, useContext, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';

const c2v = window.__c2v;
const cfg = () => Object.assign({ width: 1920, height: 1080, fps: 30, durationInFrames: 300 }, c2v.config || {});

let listeners = new Set();
c2v.onTick(() => { for (const l of listeners) l(); });
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
const getAbsFrame = () => Math.floor((c2v.time() / 1000) * cfg().fps + 1e-6);

const SequenceContext = createContext({ from: 0, durationInFrames: Infinity });
const ConfigContext = createContext(null);
const FrozenFrame = createContext(null);

export function useCurrentFrame() {
  const live = useSyncExternalStore(subscribe, getAbsFrame, getAbsFrame);
  const frozen = useContext(FrozenFrame);
  const seq = useContext(SequenceContext);
  return (frozen == null ? live : frozen) - seq.from;
}

export function useVideoConfig() {
  const override = useContext(ConfigContext);
  const c = cfg();
  return Object.assign({ id: 'main', defaultProps: {}, props: {} }, c, override || {});
}

export const useCurrentScale = () => 1;
export const getInputProps = () => ({});
export const staticFile = (p) => p;
export const delayRender = () => 0;
export const continueRender = () => {};
export const cancelRender = (e) => { throw e; };
export const prefetch = () => ({ free: () => {}, waitUntilDone: () => Promise.resolve() });
export const VERSION = 'code2video-shim';

export const AbsoluteFill = React.forwardRef(function AbsoluteFill({ style, ...rest }, ref) {
  return React.createElement('div', {
    ref,
    ...rest,
    style: {
      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column', ...style,
    },
  });
});

export function Sequence({ from = 0, durationInFrames = Infinity, children, layout = 'absolute-fill', style, name, ...rest }) {
  const parent = useContext(SequenceContext);
  const abs = useSyncExternalStore(subscribe, getAbsFrame, getAbsFrame);
  const start = parent.from + from;
  const parentEnd = parent.from + parent.durationInFrames;
  const end = Math.min(start + durationInFrames, parentEnd);
  if (abs < start || abs >= end) return null;
  const value = { from: start, durationInFrames };
  const content = layout === 'none' ? children : React.createElement(AbsoluteFill, { style, ...rest }, children);
  return React.createElement(SequenceContext.Provider, { value }, content);
}

function SeriesSequence() { return null; }
export function Series({ children }) {
  let offset = 0;
  const out = [];
  React.Children.forEach(children, (child, i) => {
    if (!child) return;
    const { durationInFrames = Infinity, offset: o = 0, children: c, ...rest } = child.props;
    offset += o;
    out.push(React.createElement(Sequence, { key: i, from: offset, durationInFrames, ...rest }, c));
    offset += durationInFrames;
  });
  return React.createElement(React.Fragment, null, out);
}
Series.Sequence = SeriesSequence;

export function Loop({ durationInFrames, times = Infinity, children, layout, style }) {
  const frame = useCurrentFrame();
  const iteration = Math.max(0, Math.floor(frame / durationInFrames));
  if (iteration >= times) return null;
  return React.createElement(Sequence, {
    from: iteration * durationInFrames, durationInFrames, layout, style,
  }, children);
}

export function Freeze({ frame, active = true, children }) {
  const parent = useContext(SequenceContext);
  if (!active) return children;
  return React.createElement(FrozenFrame.Provider, { value: parent.from + frame }, children);
}

// ---- media ---------------------------------------------------------------
export const Img = React.forwardRef((props, ref) => React.createElement('img', { ref, ...props }));
export const Video = React.forwardRef(({ startFrom, endAt, volume, playbackRate, ...props }, ref) =>
  React.createElement('video', { ref, muted: true, playsInline: true, ...props }));
export const OffthreadVideo = Video;
export const Html5Video = Video;
export const Audio = () => null;
export const Html5Audio = Audio;
export const IFrame = (props) => React.createElement('iframe', props);

// ---- easing / interpolation ------------------------------------------------
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dsx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-6) break;
      const d = dsx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1;
    if (Math.abs(sx(t) - x) > 1e-5) {
      t = x;
      for (let i = 0; i < 40; i++) { const v = sx(t); if (v < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    }
    return sy(t);
  };
}

export const Easing = {
  linear: (t) => t,
  ease: bezier(0.42, 0, 1, 1),
  quad: (t) => t * t,
  cubic: (t) => t * t * t,
  poly: (n) => (t) => Math.pow(t, n),
  sin: (t) => 1 - Math.cos((t * Math.PI) / 2),
  circle: (t) => 1 - Math.sqrt(1 - t * t),
  exp: (t) => Math.pow(2, 10 * (t - 1)),
  elastic: (b = 1) => { const p = b * Math.PI; return (t) => 1 - Math.pow(Math.cos((t * Math.PI) / 2), 3) * Math.cos(t * p); },
  back: (s = 1.70158) => (t) => t * t * ((s + 1) * t - s),
  bounce: (t) => {
    if (t < 1 / 2.75) return 7.5625 * t * t;
    if (t < 2 / 2.75) { const t2 = t - 1.5 / 2.75; return 7.5625 * t2 * t2 + 0.75; }
    if (t < 2.5 / 2.75) { const t2 = t - 2.25 / 2.75; return 7.5625 * t2 * t2 + 0.9375; }
    const t2 = t - 2.625 / 2.75; return 7.5625 * t2 * t2 + 0.984375;
  },
  bezier,
  in: (e) => e,
  out: (e) => (t) => 1 - e(1 - t),
  inOut: (e) => (t) => (t < 0.5 ? e(t * 2) / 2 : 1 - e((1 - t) * 2) / 2),
};

export function interpolate(input, inputRange, outputRange, options = {}) {
  const { easing = (t) => t, extrapolateLeft = 'extend', extrapolateRight = 'extend' } = options;
  if (inputRange.length !== outputRange.length) throw new Error('inputRange and outputRange must have the same length');
  let i = 1;
  while (i < inputRange.length - 1 && input > inputRange[i]) i++;
  const inMin = inputRange[i - 1], inMax = inputRange[i];
  const outMin = outputRange[i - 1], outMax = outputRange[i];
  let x = input;
  if (x < inMin) {
    if (extrapolateLeft === 'clamp') x = inMin;
    else if (extrapolateLeft === 'identity') return input;
  }
  if (x > inMax) {
    if (extrapolateRight === 'clamp') x = inMax;
    else if (extrapolateRight === 'identity') return input;
  }
  if (inMax === inMin) return outMin;
  let t = (x - inMin) / (inMax - inMin);
  t = easing(t);
  return outMin + (outMax - outMin) * t;
}

function parseColor(c) {
  const ctx = parseColor.ctx || (parseColor.ctx = document.createElement('canvas').getContext('2d'));
  ctx.fillStyle = '#000';
  ctx.fillStyle = c;
  const v = ctx.fillStyle;
  if (v[0] === '#') {
    return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), 1];
  }
  const m = v.match(/[\d.]+/g).map(Number);
  return [m[0], m[1], m[2], m[3] == null ? 1 : m[3]];
}
export function interpolateColors(input, inputRange, outputRange) {
  const cols = outputRange.map(parseColor);
  const ch = (k) => interpolate(input, inputRange, cols.map((c) => c[k]), { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return `rgba(${Math.round(ch(0))}, ${Math.round(ch(1))}, ${Math.round(ch(2))}, ${ch(3)})`;
}

function springRaw(frame, fps, { damping = 10, mass = 1, stiffness = 100, overshootClamping = false } = {}, from, to) {
  if (frame <= 0) return from;
  let x = from, v = 0;
  const steps = Math.ceil(frame * 4);
  const dt = frame / fps / steps;
  for (let i = 0; i < steps; i++) {
    const a = (-stiffness * (x - to) - damping * v) / mass;
    v += a * dt;
    x += v * dt;
    if (overshootClamping && ((to >= from && x > to) || (to < from && x < to))) { x = to; v = 0; }
  }
  return x;
}
export function measureSpring({ fps, config = {}, threshold = 0.005, from = 0, to = 1 }) {
  for (let f = 1; f < fps * 60; f++) {
    let settled = true;
    for (let g = f; g < f + fps; g++) {
      if (Math.abs(springRaw(g, fps, config, from, to) - to) > threshold * Math.abs(to - from || 1)) { settled = false; break; }
    }
    if (settled) return f;
  }
  return fps * 60;
}
const springCache = new Map();
function naturalDuration(fps, config) {
  const key = fps + JSON.stringify(config);
  if (!springCache.has(key)) springCache.set(key, measureSpring({ fps, config }));
  return springCache.get(key);
}
export function spring({ frame, fps, config = {}, from = 0, to = 1, delay = 0, durationInFrames, reverse = false }) {
  let f = frame - delay;
  const natural = naturalDuration(fps, config);
  if (durationInFrames) f = f * (natural / durationInFrames);
  if (reverse) f = natural - f;
  const v = springRaw(f, fps, config, 0, 1);
  return from + (to - from) * v;
}

// Deterministic seeded random, like remotion's random().
export function random(seed) {
  if (seed === null) return Math.random();
  const s = String(seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  let t = (h += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---- compositions ----------------------------------------------------------
let reported = false;
export function Composition({ component, lazyComponent, width, height, fps, durationInFrames, defaultProps = {}, id }) {
  const c = cfg();
  if (!reported) {
    reported = true;
    c2v.send('composition', { width, height, fps, durationInFrames, id });
  }
  const Comp = component;
  if (!Comp) return null;
  const override = { width: width || c.width, height: height || c.height, fps: fps || c.fps, durationInFrames: durationInFrames || c.durationInFrames, id: id || 'main', defaultProps };
  return React.createElement(ConfigContext.Provider, { value: override },
    React.createElement(AbsoluteFill, { style: { overflow: 'hidden' } }, React.createElement(Comp, defaultProps)));
}
export const Still = Composition;
export const Folder = ({ children }) => {
  // Only the first composition is shown.
  const first = React.Children.toArray(children)[0];
  return first || null;
};

export function registerRoot(Root) {
  window.__c2vRegistered = true;
  const el = document.getElementById('root');
  createRoot(el).render(React.createElement(Root));
}

export default {
  useCurrentFrame, useVideoConfig, interpolate, interpolateColors, spring, measureSpring, Easing, random,
  AbsoluteFill, Sequence, Series, Loop, Freeze, Img, Video, OffthreadVideo, Audio, Composition, Still,
  Folder, registerRoot, staticFile, delayRender, continueRender,
};
