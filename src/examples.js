// Built-in samples, one per supported code style.
export const EXAMPLES = [
  {
    id: 'html-css',
    name: 'HTML + CSS টাইটেল অ্যানিমেশন',
    code: `<!DOCTYPE html>
<html>
<head>
<style>
  body { margin:0; height:100vh; display:grid; place-items:center; overflow:hidden;
    background: radial-gradient(circle at 30% 30%, #312e81, #0f172a 70%); font-family: system-ui, sans-serif; }
  .title { color:#fff; font-size:140px; font-weight:900; letter-spacing:-4px; display:flex; }
  .title span { display:inline-block; opacity:0; transform: translateY(80px) rotate(8deg);
    animation: rise .8s cubic-bezier(.2,.9,.3,1.3) forwards; }
  .title span:nth-child(2){animation-delay:.08s} .title span:nth-child(3){animation-delay:.16s}
  .title span:nth-child(4){animation-delay:.24s} .title span:nth-child(5){animation-delay:.32s}
  .sub { position:absolute; bottom:28%; color:#a5b4fc; font-size:44px; opacity:0;
    animation: fade 1s 1.2s forwards; }
  .ring { position:absolute; width:900px; height:900px; border-radius:50%; border:4px solid #6366f1;
    opacity:.0; animation: ring 3s 0.4s ease-out infinite; }
  @keyframes rise { to { opacity:1; transform:none } }
  @keyframes fade { to { opacity:1 } }
  @keyframes ring { 0%{transform:scale(.2);opacity:.8} 100%{transform:scale(1.4);opacity:0} }
</style>
</head>
<body>
  <div class="ring"></div>
  <div class="title"><span>H</span><span>E</span><span>L</span><span>L</span><span>O</span></div>
  <div class="sub">Code → Video</div>
</body>
</html>`,
  },
  {
    id: 'canvas',
    name: 'Canvas পার্টিকেল',
    code: `<!DOCTYPE html>
<html><body style="margin:0;background:#020617">
<canvas id="c"></canvas>
<script>
const c = document.getElementById('c'), x = c.getContext('2d');
c.width = innerWidth; c.height = innerHeight;
const P = Array.from({length: 220}, (_, i) => ({
  a: i / 220 * Math.PI * 2, r: 80 + Math.random() * 420, s: .2 + Math.random() * .8, h: 180 + Math.random() * 120
}));
function draw(t) {
  x.fillStyle = 'rgba(2,6,23,.25)'; x.fillRect(0, 0, c.width, c.height);
  for (const p of P) {
    const a = p.a + t / 1000 * p.s;
    const r = p.r * (0.6 + 0.4 * Math.sin(t / 700 + p.a * 3));
    x.fillStyle = 'hsl(' + p.h + ',90%,65%)';
    x.beginPath(); x.arc(c.width/2 + Math.cos(a) * r * 1.6, c.height/2 + Math.sin(a) * r, 5, 0, 7); x.fill();
  }
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
</script></body></html>`,
  },
  {
    id: 'gsap',
    name: 'GSAP টাইমলাইন',
    code: `<!DOCTYPE html>
<html><head>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
<style>
body{margin:0;height:100vh;background:#fef3c7;display:flex;align-items:center;justify-content:center;gap:40px;overflow:hidden}
.box{width:180px;height:180px;border-radius:32px}
.b1{background:#f97316}.b2{background:#ec4899}.b3{background:#8b5cf6}
h1{position:absolute;bottom:15%;font:800 90px system-ui;color:#1f2937;margin:0}
</style></head>
<body>
<div class="box b1"></div><div class="box b2"></div><div class="box b3"></div>
<h1>GSAP Motion</h1>
<script>
const tl = gsap.timeline();
tl.from('.box', { y: -600, rotation: 180, duration: 1.2, stagger: .2, ease: 'bounce.out' })
  .from('h1', { opacity: 0, y: 80, duration: .8 }, '-=0.4')
  .to('.box', { scale: 1.3, borderRadius: '50%', duration: .6, stagger: .1, yoyo: true, repeat: 1 })
  .to('.box', { rotation: 360, duration: 1.2, ease: 'power2.inOut' });
</script></body></html>`,
  },
  {
    id: 'react',
    name: 'React + Framer Motion',
    code: `import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const words = ['Create', 'Animate', 'Render', 'Share'];

export default function App() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % words.length), 1500);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-emerald-500 to-cyan-700 overflow-hidden">
      <motion.div className="absolute w-[700px] h-[700px] rounded-full bg-white/10"
        animate={{ scale: [1, 1.3, 1], rotate: [0, 90, 0] }}
        transition={{ duration: 4, repeat: Infinity }} />
      <AnimatePresence mode="wait">
        <motion.h1 key={words[i]}
          className="text-white text-[160px] font-black tracking-tight"
          initial={{ y: 120, opacity: 0, filter: 'blur(12px)' }}
          animate={{ y: 0, opacity: 1, filter: 'blur(0px)' }}
          exit={{ y: -120, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 120, damping: 14 }}>
          {words[i]}
        </motion.h1>
      </AnimatePresence>
    </div>
  );
}`,
  },
  {
    id: 'remotion',
    name: 'Remotion কম্পোজিশন',
    code: `import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';

const Title = ({ text, color }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 12 } });
  const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
      <h1 style={{ fontSize: 150, fontFamily: 'system-ui', fontWeight: 900, color, opacity,
        transform: \`scale(\${s}) translateY(\${(1 - s) * 200}px)\` }}>{text}</h1>
    </AbsoluteFill>
  );
};

export const MyVideo = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const hue = interpolate(frame, [0, durationInFrames], [220, 320]);
  return (
    <AbsoluteFill style={{ background: \`linear-gradient(135deg, hsl(\${hue},70%,20%), hsl(\${hue + 40},80%,45%))\` }}>
      <Sequence from={0} durationInFrames={90}><Title text="Remotion" color="#fff" /></Sequence>
      <Sequence from={90} durationInFrames={90}><Title text="on Mobile" color="#fde68a" /></Sequence>
      <Sequence from={180}><Title text="Full HD 🎬" color="#a7f3d0" /></Sequence>
    </AbsoluteFill>
  );
};

export default MyVideo;
// durationInFrames: 270, fps: 30`,
  },
];
