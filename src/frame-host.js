// Hosts one sandbox iframe running a built document on the virtual clock.

const channel = new MessageChannel();
const pending = [];
channel.port1.onmessage = () => { const r = pending.shift(); if (r) r(); };
// A macrotask hop without setTimeout's 4ms clamping.
const hop = () => new Promise((r) => { pending.push(r); channel.port2.postMessage(0); });

// Lets queued React renders, effects and promise chains in the frame run.
export async function settle(rounds = 2) {
  for (let i = 0; i < rounds; i++) await hop();
}

export class FrameHost {
  constructor(parent, { width, height, onMessage }) {
    this.width = width;
    this.height = height;
    this.onMessage = onMessage || (() => {});
    this.iframe = document.createElement('iframe');
    this.iframe.className = 'c2v-frame';
    this.iframe.setAttribute('allow', 'autoplay');
    this.iframe.style.width = `${width}px`;
    this.iframe.style.height = `${height}px`;
    this.iframe.style.border = '0';
    this.iframe.style.background = '#fff';
    parent.appendChild(this.iframe);
    this._listener = (e) => {
      if (e.source !== this.iframe.contentWindow || !e.data || !e.data.__c2v) return;
      if (e.data.type === 'mounted' && this._mounted) this._mounted();
      this.onMessage(e.data);
    };
    window.addEventListener('message', this._listener);
  }

  get win() { return this.iframe.contentWindow; }
  get api() { return this.win && this.win.__c2v; }

  // Loads the document and resolves once it is ready for frame 0.
  async load(doc) {
    const mounted = doc.async ? new Promise((r) => { this._mounted = r; }) : null;
    const loaded = new Promise((r) => { this.iframe.onload = r; });
    this.iframe.srcdoc = doc.html;
    await loaded;
    if (!this.api) throw new Error('রানটাইম লোড হয়নি');
    if (mounted) await Promise.race([mounted, new Promise((r) => setTimeout(r, 20000))]);
    await this.api.ready();
    // A few zero-length ticks let start-up timers, rAF and React effects run.
    for (let i = 0; i < 4; i++) {
      this.api.tick(0);
      await settle(3);
    }
    await this.api.ready(3000);
  }

  tick(ms) { this.api.tick(ms); }
  time() { return this.api ? this.api.time() : 0; }
  capture() { return this.api.capture(this.width, this.height); }

  // Reports what the document's own animations suggest the video length is (seconds).
  detectDuration() {
    try {
      const w = this.win;
      let end = 0;
      let loopLen = 0;
      for (const a of w.document.getAnimations()) {
        const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
        if (!t) continue;
        if (Number.isFinite(t.endTime)) end = Math.max(end, t.endTime);
        else if (Number.isFinite(t.duration)) loopLen = Math.max(loopLen, (t.delay || 0) + t.duration);
      }
      if (w.gsap && w.gsap.globalTimeline) {
        const g = w.gsap.globalTimeline.totalDuration() * 1000;
        if (Number.isFinite(g) && g < 600000) end = Math.max(end, g);
      }
      const ms = end || loopLen;
      return ms > 300 ? Math.min(120, Math.ceil(ms / 100) / 10) : null;
    } catch (e) {
      return null;
    }
  }

  destroy() {
    window.removeEventListener('message', this._listener);
    this.iframe.remove();
  }
}
