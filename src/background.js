// Keeps a render running when the user leaves the app (Android app only): a
// foreground service with a progress notification, see native/background-render.
import { registerPlugin } from '@capacitor/core';
import { isNative } from './save.js';

const BackgroundRender = registerPlugin('BackgroundRender');

let active = false;
let lastUpdate = 0;

export const backgroundSupported = () => isNative();

export async function startBackground(text) {
  if (!isNative()) return;
  try {
    await BackgroundRender.start({ title: 'Code2Video — ভিডিও রেন্ডার হচ্ছে', text });
    active = true;
  } catch (e) {
    console.warn('background render unavailable', e);
  }
}

// Throttled to about once a second; notifications should not update every frame.
export function updateBackground(progress, text) {
  if (!active) return;
  const now = performance.now();
  if (now - lastUpdate < 1000 && progress < 100) return;
  lastUpdate = now;
  BackgroundRender.update({ progress: Math.round(progress), text }).catch(() => {});
}

export async function stopBackground(done) {
  if (!active) return;
  active = false;
  const opts = done ? { doneTitle: done.title, doneText: done.text } : {};
  // Only notify about completion when the user is not looking at the app.
  if (document.visibilityState === 'visible' && !document.hidden) delete opts.doneTitle;
  try { await BackgroundRender.stop(opts); } catch (e) { /* ignore */ }
}
