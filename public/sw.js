// Offline support: the app shell and bundled libraries are cached on first visit.
const CACHE = 'c2v-v1';
const PRECACHE = [
  './', 'index.html', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/c2v-runtime.js', 'vendor/react-all.mjs', 'vendor/react.mjs', 'vendor/react-dom.mjs',
  'vendor/react-dom-client.mjs', 'vendor/jsx-runtime.mjs', 'vendor/framer-motion.mjs', 'vendor/motion-react.mjs',
  'vendor/motion.mjs', 'vendor/gsap.mjs', 'vendor/gsap-all.mjs', 'vendor/gsap.min.js', 'vendor/lucide-react.mjs',
  'vendor/three.mjs', 'vendor/remotion.mjs', 'vendor/tailwind.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // Pages: network first so updates show up; everything else: cache first.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('index.html'))));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  })));
});
