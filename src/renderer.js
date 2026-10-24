// Renders a document frame by frame on the virtual clock and encodes an MP4
// with WebCodecs, entirely on the device.
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { FrameHost, settle } from './frame-host.js';

function avcCodecs(width, height, fps) {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const rate = mbs * fps;
  // Pick an H.264 level big enough for the frame size and rate.
  let level = '28'; // 4.0
  if (rate > 245760 || mbs > 8192) level = '2a'; // 4.2
  if (mbs > 8704) level = '32'; // 5.0
  if (rate > 589824 || mbs > 22080) level = '33'; // 5.1
  return [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.4200${level}`];
}

export async function pickEncoder(width, height, fps, bitrate) {
  if (typeof VideoEncoder === 'undefined') return null;
  const candidates = [
    ...avcCodecs(width, height, fps).map((codec) => ({ codec, mux: 'avc', avc: { format: 'avc' } })),
    { codec: 'vp09.00.40.08', mux: 'vp9' },
    { codec: 'av01.0.08M.08', mux: 'av1' },
  ];
  for (const accel of ['prefer-hardware', 'no-preference']) {
    for (const c of candidates) {
      const config = {
        codec: c.codec, width, height, bitrate, framerate: fps,
        hardwareAcceleration: accel, latencyMode: 'quality',
      };
      if (c.avc) config.avc = c.avc;
      try {
        const s = await VideoEncoder.isConfigSupported(config);
        if (s.supported) return { config: s.config || config, mux: c.mux };
      } catch (e) { /* try next */ }
    }
  }
  return null;
}

// Resolves when the encoder takes a frame off its queue (with a fallback so an encoder
// error, which fires no dequeue event, cannot hang the loop).
function waitDequeue(encoder) {
  const fallback = settle(20);
  if (!('ondequeue' in encoder)) return fallback;
  return Promise.race([new Promise((r) => encoder.addEventListener('dequeue', r, { once: true })), fallback]);
}

export function webCodecsSupported() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

/**
 * @param {object} o
 * @param {{html:string, async:boolean}} o.doc
 * @param {HTMLElement} o.stage  element the hidden render frame is attached to
 * @param {(p:{frame:number,total:number,elapsed:number})=>void} o.onProgress
 * @param {{aborted:boolean}} o.signal
 */
export async function renderVideo({ doc, stage, width, height, fps, duration, bitrate, onProgress, onMessage, signal }) {
  const enc = await pickEncoder(width, height, fps, bitrate);
  if (!enc) throw new Error('এই ব্রাউজারে ভিডিও এনকোডার (WebCodecs) নেই। Chrome-এর নতুন ভার্সন ব্যবহার করুন।');

  const host = new FrameHost(stage, { width, height, onMessage });
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: enc.mux, width, height, frameRate: fps },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encodeError = e; },
  });
  encoder.configure(enc.config);

  const total = Math.max(1, Math.round(duration * fps));
  const frameMs = 1000 / fps;
  const started = performance.now();
  try {
    await host.load(doc);
    for (let i = 0; i < total; i++) {
      if (signal.aborted) throw new Error('বাতিল করা হয়েছে');
      if (encodeError) throw encodeError;
      if (i > 0) host.tick(frameMs);
      await host.settle();
      const canvas = await host.capture();
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round(i * 1e6 / fps),
        duration: Math.round(1e6 / fps),
      });
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      // Wait on the encoder itself rather than timers, which are throttled in the background.
      while (encoder.encodeQueueSize > 4) await waitDequeue(encoder);
      onProgress({ frame: i + 1, total, elapsed: performance.now() - started });
    }
    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
    return {
      blob: new Blob([target.buffer], { type: 'video/mp4' }),
      codec: enc.config.codec,
      seconds: (performance.now() - started) / 1000,
    };
  } finally {
    try { if (encoder.state !== 'closed') encoder.close(); } catch (e) { /* ignore */ }
    host.destroy();
  }
}
