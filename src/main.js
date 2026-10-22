import './style.css';
import { buildDocument, cleanCode, detectMode, detectDeclaredConfig, MODE_LABEL } from './build-doc.js';
import { FrameHost, settle } from './frame-host.js';
import { renderVideo, webCodecsSupported, pickEncoder } from './renderer.js';
import { saveVideo, shareVideo, canShare, isNative, resetShare } from './save.js';
import { EXAMPLES } from './examples.js';

const $ = (id) => document.getElementById(id);
const el = {
  code: $('code'), modeBadge: $('modeBadge'), paste: $('pasteBtn'), examples: $('exampleSelect'), clear: $('clearBtn'),
  previewBtn: $('previewBtn'), stageWrap: $('stageWrap'), stage: $('stage'), stageEmpty: $('stageEmpty'),
  status: $('previewStatus'), play: $('playBtn'), restart: $('restartBtn'), scrub: $('scrub'), time: $('timeText'),
  log: $('logBox'), format: $('format'), fps: $('fps'), duration: $('duration'), autoDur: $('autoDur'),
  quality: $('quality'), renderBtn: $('renderBtn'), progressBox: $('progressBox'), bar: $('bar'),
  progressText: $('progressText'), cancel: $('cancelBtn'), result: $('result'), video: $('resultVideo'),
  resultInfo: $('resultInfo'), download: $('downloadBtn'), share: $('shareBtn'), saveInfo: $('saveInfo'),
  support: $('support'), renderStage: $('renderStage'), install: $('installBtn'), apk: $('apkLink'),
};

const STORE = 'c2v-state-v1';
const store = {
  load() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; } },
  save(s) { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch (e) { /* ignore */ } },
};

// ---- settings ----------------------------------------------------------------
function settings() {
  const [width, height] = el.format.value.split('x').map(Number);
  const fps = Number(el.fps.value);
  const duration = Math.max(0.5, Math.min(300, Number(el.duration.value) || 10));
  return { width, height, fps, duration, bitrate: Number(el.quality.value) * 1e6 * (width * height) / (1920 * 1080) };
}

function persist() {
  store.save({
    code: el.code.value, format: el.format.value, fps: el.fps.value, duration: el.duration.value, quality: el.quality.value,
  });
}

function ensureFormat(width, height) {
  const v = `${width}x${height}`;
  if (![...el.format.options].some((o) => o.value === v)) {
    const o = document.createElement('option');
    o.value = v; o.textContent = `কাস্টম — ${width}×${height}`;
    el.format.appendChild(o);
  }
  el.format.value = v;
}

function restore() {
  const s = store.load();
  if (s.code) el.code.value = s.code;
  if (s.format) { const [w, h] = s.format.split('x').map(Number); if (w && h) ensureFormat(w, h); }
  if (s.fps) el.fps.value = s.fps;
  if (s.duration) el.duration.value = s.duration;
  if (s.quality) el.quality.value = s.quality;
}

// ---- log -------------------------------------------------------------------
const logLines = [];
function log(msg) {
  if (!msg) return;
  const line = String(msg).slice(0, 400);
  if (logLines[logLines.length - 1] === line) return;
  logLines.push(line);
  if (logLines.length > 30) logLines.shift();
  el.log.hidden = false;
  el.log.textContent = logLines.map((l) => `⚠ ${l}`).join('\n');
  el.log.scrollTop = el.log.scrollHeight;
}
function clearLog() { logLines.length = 0; el.log.hidden = true; el.log.textContent = ''; }

function onFrameMessage(m) {
  if (m.type === 'error' || m.type === 'console') log(m.data);
  if (m.type === 'composition' && m.data) {
    const { width, height, fps, durationInFrames } = m.data;
    let changed = false;
    if (width && height && el.format.value !== `${width}x${height}`) { ensureFormat(width, height); changed = true; }
    if (fps && Number(el.fps.value) !== fps) {
      if (![...el.fps.options].some((o) => Number(o.value) === fps)) {
        const o = document.createElement('option'); o.value = fps; o.textContent = fps; el.fps.appendChild(o);
      }
      el.fps.value = String(fps); changed = true;
    }
    if (durationInFrames && fps) {
      const d = Math.round((durationInFrames / fps) * 100) / 100;
      if (Number(el.duration.value) !== d) { el.duration.value = d; changed = true; }
    }
    if (changed) { persist(); schedulePreviewRebuild(); }
  }
}

// ---- mode badge --------------------------------------------------------------
function updateMode() {
  const mode = detectMode(cleanCode(el.code.value));
  el.modeBadge.textContent = MODE_LABEL[mode];
}

// ---- preview -----------------------------------------------------------------
const preview = {
  host: null, playing: false, last: 0, loading: false, token: 0, cfg: null, doc: null, seeking: false,
};

function fitStage() {
  const cfg = preview.cfg || settings();
  el.stageWrap.style.aspectRatio = `${cfg.width} / ${cfg.height}`;
  const maxH = window.innerHeight * 0.7;
  const card = el.stageWrap.parentElement;
  const cs = getComputedStyle(card);
  const wrapW = card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  let w = wrapW;
  if (w * cfg.height / cfg.width > maxH) w = maxH * cfg.width / cfg.height;
  el.stageWrap.style.width = `${w}px`;
  const scale = w / cfg.width;
  el.stage.style.transform = `scale(${scale})`;
}

function setPlaying(p) {
  preview.playing = p;
  el.play.textContent = p ? '❚❚' : '▶';
  preview.last = performance.now();
}

function updateTime() {
  const dur = settings().duration;
  const t = preview.host ? preview.host.time() / 1000 : 0;
  el.time.textContent = `${t.toFixed(1)} / ${dur.toFixed(1)}s`;
  if (!preview.seeking) el.scrub.value = String(Math.round(Math.min(1, t / dur) * 1000));
}

async function buildPreview({ autoplay = true, detect = true } = {}) {
  const raw = el.code.value;
  if (!raw.trim()) { el.status.textContent = 'আগে কোড দিন'; return false; }
  const token = ++preview.token;
  setPlaying(false);
  clearLog();
  const code = cleanCode(raw);
  const mode = detectMode(code);
  if (detect && (mode === 'react' || mode === 'remotion')) {
    // Size/fps/length a Remotion composition declares in code.
    const declared = detectDeclaredConfig(code);
    if (declared.width && declared.height) ensureFormat(declared.width, declared.height);
    if (declared.fps && [...el.fps.options].some((o) => Number(o.value) === declared.fps)) el.fps.value = String(declared.fps);
    if (declared.duration) el.duration.value = Math.round(declared.duration * 100) / 100;
  }
  const cfg = settings();
  preview.cfg = cfg;
  fitStage();
  if (preview.host) { preview.host.destroy(); preview.host = null; }
  el.stageEmpty.hidden = true;
  el.status.textContent = 'লোড হচ্ছে…';
  preview.loading = true;

  let doc;
  try {
    doc = buildDocument(raw, { width: cfg.width, height: cfg.height, fps: cfg.fps, durationInFrames: Math.round(cfg.duration * cfg.fps) });
  } catch (e) {
    preview.loading = false;
    el.status.textContent = 'কোডে ভুল আছে';
    log(e.message || e);
    return false;
  }
  preview.doc = doc;
  const host = new FrameHost(el.stage, { width: cfg.width, height: cfg.height, onMessage: onFrameMessage });
  preview.host = host;
  try {
    await host.load(doc);
  } catch (e) {
    log(e.message || e);
  }
  if (token !== preview.token) return false;
  preview.loading = false;
  el.status.textContent = MODE_LABEL[doc.mode];
  if (detect && (doc.mode === 'html' || doc.mode === 'js')) {
    const d = host.detectDuration();
    if (d) el.duration.value = d;
  }
  persist();
  updateTime();
  if (autoplay) setPlaying(true);
  return true;
}

let rebuildTimer = null;
function schedulePreviewRebuild() {
  clearTimeout(rebuildTimer);
  if (!preview.host) return;
  rebuildTimer = setTimeout(() => buildPreview({ autoplay: preview.playing, detect: false }), 300);
}

async function seekTo(seconds) {
  if (!preview.host || preview.loading) return;
  const wasPlaying = preview.playing;
  setPlaying(false);
  preview.seeking = true;
  const cfg = preview.cfg;
  const target = seconds * 1000;
  if (target < preview.host.time() - 1) {
    const token = ++preview.token;
    preview.loading = true;
    await preview.host.load(preview.doc);
    preview.loading = false;
    if (token !== preview.token) { preview.seeking = false; return; }
  }
  const step = 1000 / cfg.fps;
  let n = 0;
  while (preview.host.time() + step <= target + 0.01) {
    preview.host.tick(step);
    if (++n % 3 === 0) await settle(1);
  }
  const rest = target - preview.host.time();
  if (rest > 0) preview.host.tick(rest);
  await settle(2);
  preview.seeking = false;
  updateTime();
  if (wasPlaying) setPlaying(true);
}

function loop(now) {
  requestAnimationFrame(loop);
  const host = preview.host;
  if (!host || preview.loading || preview.seeking || !host.api) return;
  if (preview.playing) {
    const dt = Math.min(100, now - preview.last);
    preview.last = now;
    const dur = settings().duration * 1000;
    if (host.time() + dt >= dur) {
      // Loop back to the start, like the final video would on repeat.
      preview.loading = true;
      host.load(preview.doc).catch((e) => log(e.message)).finally(() => {
        preview.loading = false; preview.last = performance.now();
      });
      return;
    }
    host.tick(dt);
    updateTime();
  }
}
requestAnimationFrame(loop);

// ---- rendering -------------------------------------------------------------------
let renderJob = null;
let resultBlob = null;
let resultName = '';
let wakeLock = null;

async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { /* not available */ }
}

function fmtTime(s) {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60);
  return m ? `${m}মি ${s % 60}সে` : `${s}সে`;
}

async function startRender() {
  if (renderJob) return;
  const raw = el.code.value;
  if (!raw.trim()) { alert('আগে কোড পেস্ট করুন'); return; }
  const cfg = settings();
  let doc;
  try {
    doc = buildDocument(raw, { width: cfg.width, height: cfg.height, fps: cfg.fps, durationInFrames: Math.round(cfg.duration * cfg.fps) });
  } catch (e) {
    log(e.message || e); return;
  }
  setPlaying(false);
  const signal = { aborted: false };
  renderJob = signal;
  el.renderBtn.disabled = true;
  el.previewBtn.disabled = true;
  el.progressBox.hidden = false;
  el.result.hidden = true;
  el.bar.style.width = '0%';
  el.progressText.textContent = 'প্রস্তুত হচ্ছে…';
  await keepAwake(true);
  try {
    const out = await renderVideo({
      doc, stage: el.renderStage, ...cfg, signal, onMessage: onFrameMessage,
      onProgress: ({ frame, total, elapsed }) => {
        const pct = (frame / total) * 100;
        el.bar.style.width = `${pct.toFixed(1)}%`;
        const eta = (elapsed / frame) * (total - frame) / 1000;
        el.progressText.textContent = `ফ্রেম ${frame}/${total} · ${pct.toFixed(0)}% · বাকি ~${fmtTime(eta)}`;
      },
    });
    resultBlob = out.blob;
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    resultName = `code2video-${cfg.width}x${cfg.height}-${stamp}.mp4`;
    resetShare();
    if (el.video.src) URL.revokeObjectURL(el.video.src);
    el.video.src = URL.createObjectURL(resultBlob);
    el.resultInfo.textContent = `${cfg.width}×${cfg.height} · ${cfg.fps}fps · ${cfg.duration}s · ${(resultBlob.size / 1048576).toFixed(1)} MB · ${fmtTime(out.seconds)}-এ তৈরি`;
    el.saveInfo.textContent = '';
    el.share.hidden = !canShare(resultBlob, resultName);
    el.result.hidden = false;
    el.progressText.textContent = '✅ সম্পন্ন!';
    el.result.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {
    el.progressText.textContent = `❌ ${e.message || e}`;
    if (!signal.aborted) log(e.message || e);
  } finally {
    renderJob = null;
    el.renderBtn.disabled = false;
    el.previewBtn.disabled = false;
    keepAwake(false);
  }
}

// ---- events -----------------------------------------------------------------
el.previewBtn.addEventListener('click', () => buildPreview());
el.play.addEventListener('click', () => {
  if (!preview.host) { buildPreview(); return; }
  setPlaying(!preview.playing);
});
el.restart.addEventListener('click', () => { if (preview.host) seekTo(0).then(() => setPlaying(true)); else buildPreview(); });
el.scrub.addEventListener('input', () => {
  preview.seeking = true;
  const t = (Number(el.scrub.value) / 1000) * settings().duration;
  el.time.textContent = `${t.toFixed(1)} / ${settings().duration.toFixed(1)}s`;
});
el.scrub.addEventListener('change', () => {
  preview.seeking = false;
  seekTo((Number(el.scrub.value) / 1000) * settings().duration);
});

let codeTimer = null;
el.code.addEventListener('input', () => {
  clearTimeout(codeTimer);
  codeTimer = setTimeout(() => { updateMode(); persist(); }, 250);
});

el.paste.addEventListener('click', async () => {
  try {
    const t = await navigator.clipboard.readText();
    if (t) { el.code.value = t; updateMode(); persist(); buildPreview(); }
  } catch (e) {
    el.code.focus();
    alert('বক্সে লং-প্রেস করে “Paste” চাপুন');
  }
});
el.clear.addEventListener('click', () => {
  el.code.value = ''; updateMode(); persist();
  if (preview.host) { preview.host.destroy(); preview.host = null; }
  el.stageEmpty.hidden = false; el.status.textContent = ''; clearLog(); updateTime();
});
for (const ex of EXAMPLES) {
  const o = document.createElement('option');
  o.value = ex.id; o.textContent = ex.name;
  el.examples.appendChild(o);
}
el.examples.addEventListener('change', () => {
  const ex = EXAMPLES.find((x) => x.id === el.examples.value);
  el.examples.value = '';
  if (!ex) return;
  el.code.value = ex.code;
  updateMode(); persist(); buildPreview();
});

for (const s of [el.format, el.fps]) s.addEventListener('change', () => { persist(); fitStage(); schedulePreviewRebuild(); });
el.duration.addEventListener('change', () => { persist(); updateTime(); });
el.quality.addEventListener('change', persist);
el.autoDur.addEventListener('click', () => {
  const declared = detectDeclaredConfig(cleanCode(el.code.value));
  const d = (preview.host && preview.host.detectDuration()) || declared.duration;
  if (d) { el.duration.value = Math.round(d * 100) / 100; persist(); updateTime(); }
  else alert('অ্যানিমেশনের নির্দিষ্ট শেষ সময় পাওয়া যায়নি — নিজে সময় লিখে দিন।');
});

el.renderBtn.addEventListener('click', startRender);
el.cancel.addEventListener('click', () => { if (renderJob) renderJob.aborted = true; });
el.download.addEventListener('click', async () => {
  if (!resultBlob) return;
  try { el.saveInfo.textContent = await saveVideo(resultBlob, resultName); } catch (e) { el.saveInfo.textContent = `সেভ হয়নি: ${e.message || e}`; }
});
el.share.addEventListener('click', async () => {
  if (!resultBlob) return;
  try { await shareVideo(resultBlob, resultName); } catch (e) { if (e.name !== 'AbortError') el.saveInfo.textContent = `শেয়ার হয়নি: ${e.message || e}`; }
});

window.addEventListener('resize', fitStage);

// ---- install (PWA) ---------------------------------------------------------------
let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  el.install.hidden = false;
});
el.install.addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  el.install.hidden = true;
});
if (isNative() || window.matchMedia('(display-mode: standalone)').matches) el.apk.hidden = true;

if ('serviceWorker' in navigator && !isNative() && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ---- support check -----------------------------------------------------------------
(async () => {
  if (!webCodecsSupported()) {
    el.support.textContent = '⚠ এই ব্রাউজারে ভিডিও এনকোডিং (WebCodecs) নেই — Android-এ Chrome বা এই অ্যাপের APK ব্যবহার করুন।';
    return;
  }
  const enc = await pickEncoder(1920, 1080, 30, 12e6);
  el.support.textContent = enc
    ? `✓ ভিডিও এনকোডার প্রস্তুত (${enc.config.codec.startsWith('avc') ? 'H.264' : enc.mux.toUpperCase()} MP4)`
    : '⚠ এই ডিভাইসে 1080p এনকোডার পাওয়া যায়নি — ছোট সাইজ চেষ্টা করুন।';
})();

restore();
updateMode();
fitStage();
updateTime();
