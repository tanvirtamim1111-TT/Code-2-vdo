// Turns pasted code (HTML, React/JSX/TSX, Remotion, or plain JS) into a complete
// HTML document that runs inside the preview/render iframe on the virtual clock.
import { transform } from 'sucrase';

const vendor = (file) => new URL(`vendor/${file}`, document.baseURI).href;

const LOCAL_MODULES = {
  react: 'react.mjs',
  'react-dom': 'react-dom.mjs',
  'react-dom/client': 'react-dom-client.mjs',
  'react/jsx-runtime': 'jsx-runtime.mjs',
  'react/jsx-dev-runtime': 'jsx-runtime.mjs',
  'framer-motion': 'framer-motion.mjs',
  'motion/react': 'motion-react.mjs',
  'motion/react-client': 'motion-react.mjs',
  motion: 'motion.mjs',
  gsap: 'gsap.mjs',
  'gsap/all': 'gsap-all.mjs',
  'lucide-react': 'lucide-react.mjs',
  three: 'three.mjs',
  remotion: 'remotion.mjs',
};

function resolveModule(spec) {
  if (LOCAL_MODULES[spec]) return vendor(LOCAL_MODULES[spec]);
  if (/^gsap\/[A-Z]/.test(spec)) return vendor('gsap-all.mjs');
  if (/^https?:\/\//.test(spec)) return spec;
  return `https://esm.sh/${spec}?external=react,react-dom`;
}

function importMap() {
  const imports = {};
  for (const k of Object.keys(LOCAL_MODULES)) imports[k] = vendor(LOCAL_MODULES[k]);
  return `<script type="importmap">${JSON.stringify({ imports })}</script>`;
}

// Strips markdown fences. When several fenced blocks are pasted (html + css + js),
// they are combined into one HTML document.
export function cleanCode(raw) {
  const text = raw.replace(/\r\n/g, '\n');
  const blocks = [...text.matchAll(/```([\w+-]*)[^\n]*\n([\s\S]*?)```/g)];
  if (!blocks.length) return text.trim();
  if (blocks.length === 1) return blocks[0][2].trim();
  let html = '', css = '', js = '', other = [];
  for (const [, lang, body] of blocks) {
    const l = lang.toLowerCase();
    if (l === 'html' || l === 'xml' || l === 'svg') html += body + '\n';
    else if (l === 'css') css += body + '\n';
    else if (l === 'js' || l === 'javascript') js += body + '\n';
    else other.push(body);
  }
  if (!html && !css && !js) return other.sort((a, b) => b.length - a.length)[0].trim();
  if (!html) html = '<body></body>';
  if (css) html = html.includes('</head>') ? html.replace('</head>', `<style>\n${css}</style>\n</head>`) : `<style>\n${css}</style>\n${html}`;
  if (js) html = html.includes('</body>') ? html.replace('</body>', `<script>\n${js}</script>\n</body>`) : `${html}\n<script>\n${js}</script>`;
  return html.trim();
}

export function detectMode(code) {
  const c = code.trim();
  if (!c) return 'empty';
  const hasImport = /^\s*import\s[\s\S]*?from\s*['"]|^\s*import\s*['"]/m.test(c);
  if (/from\s*['"]remotion['"]|useCurrentFrame\s*\(/.test(c)) return 'remotion';
  if (/^\s*(<!doctype|<html|<head|<body)/i.test(c)) return 'html';
  if (hasImport || /export\s+default/.test(c)) return 'react';
  if (/^\s*</.test(c) && !/return\s*\(\s*</.test(c)) return 'html';
  if (/<[A-Za-z][\w.]*[\s>/]/.test(c) && /(function|=>)/.test(c) && /return\s*\(?\s*</.test(c)) return 'react';
  return 'js';
}

export const MODE_LABEL = {
  html: 'HTML / CSS / JS',
  react: 'React (JSX)',
  remotion: 'Remotion',
  js: 'JavaScript',
  empty: '—',
};

// Durations a composition declares in code, used to auto-fill the settings.
// A <Composition .../> tag wins; otherwise `durationInFrames: 300` style config or
// comments are used (not `durationInFrames={90}` props, which are usually Sequences).
export function detectDeclaredConfig(code) {
  const out = {};
  const comp = code.match(/<(?:Composition|Still)\b[\s\S]*?\/?>/);
  const src = comp ? comp[0] : code;
  const sep = comp ? '[:=]\\s*\\{?' : ':';
  const num = (name, digits = '\\d+') => {
    const m = src.match(new RegExp(`\\b${name}\\s*${sep}\\s*(${digits})\\b`));
    return m ? +m[1] : null;
  };
  const d = num('durationInFrames');
  const f = num('fps');
  const w = num('width', '\\d{3,4}');
  const h = num('height', '\\d{3,4}');
  if (f) out.fps = f;
  if (d) out.duration = d / (out.fps || 30);
  if (w && h) { out.width = w; out.height = h; }
  return out;
}

function head(config) {
  return [
    '<meta charset="utf-8">',
    `<meta name="viewport" content="width=${config.width}, initial-scale=1">`,
    `<script>window.__C2V_CONFIG=${JSON.stringify(config)};</script>`,
    `<script src="${vendor('c2v-runtime.js')}"></script>`,
  ].join('\n');
}

function buildHtml(code, config) {
  let html = code;
  // Serve GSAP from the bundled copy so it works offline.
  html = html.replace(/<script[^>]+src=["'][^"']*\/gsap(?:\.min)?\.js(?:\?[^"']*)?["'][^>]*>\s*<\/script>/gi,
    `<script src="${vendor('gsap.min.js')}"></script>`);
  const inject = head(config) + '\n<style>html,body{overflow:hidden}</style>';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${inject}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${inject}</head>`);
  return `<!doctype html><html><head>${inject}</head><body>${html}</body></html>`;
}

function buildJs(code, config) {
  return `<!doctype html><html><head>${head(config)}
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}</style></head>
<body><script>\n${code.replace(/<\/script/gi, '<\\/script')}\n</script></body></html>`;
}

function pickDefaultComponent(code) {
  const names = [...code.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:function|const|let|var|class)\s+([A-Z][\w$]*)/g)].map((m) => m[1]);
  if (!names.length) return null;
  for (const pref of ['App', 'Main', 'Video', 'MyVideo', 'MyComposition', 'Composition', 'Scene', 'Animation']) {
    if (names.includes(pref)) return pref;
  }
  return names[names.length - 1];
}

function compileReact(code) {
  let src = code;
  const selfMount = /createRoot\s*\(|ReactDOM\.render\s*\(|registerRoot\s*\(/.test(src);
  if (!selfMount && !/export\s+default/.test(src)) {
    const name = pickDefaultComponent(src);
    if (name) src += `\nexport default ${name};\n`;
  }
  let out;
  const opts = { jsxRuntime: 'automatic', production: true, filePath: 'App.tsx' };
  try {
    out = transform(src, { ...opts, transforms: ['jsx', 'typescript'] }).code;
  } catch (e) {
    out = transform(src, { ...opts, transforms: ['jsx'] }).code;
  }
  // Drop CSS / asset imports and point bare module names at bundled or CDN copies.
  out = out.replace(/^\s*import\s+['"][^'"]+\.(css|scss|sass|less)['"];?\s*$/gm, '');
  out = out.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\2/g, (m, pre, q, spec) => {
    if (spec.startsWith('.') || spec.startsWith('/')) return `${pre}${q}data:text/javascript,export default {}${q}`;
    return `${pre}${q}${resolveModule(spec)}${q}`;
  });
  return { code: out, selfMount };
}

function buildReact(code, config) {
  const { code: js, selfMount } = compileReact(code);
  const payload = JSON.stringify(js).replace(/</g, '\\u003c');
  return `<!doctype html><html><head>${head(config)}
${importMap()}
<script src="${vendor('tailwind.js')}"></script>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}#root{width:100%;height:100%;position:relative}</style>
</head><body><div id="root"></div>
<script>window.__C2V_CODE=${payload};</script>
<script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
const c2v = window.__c2v;
try {
  const url = URL.createObjectURL(new Blob([window.__C2V_CODE], { type: 'text/javascript' }));
  const mod = await import(url);
  if (!${selfMount} && !window.__c2vRegistered) {
    let C = mod.default;
    if (!C) C = Object.values(mod).find((v) => typeof v === 'function');
    if (!C) throw new Error('কোনো React কম্পোনেন্ট পাওয়া যায়নি (export default দিন)');
    createRoot(document.getElementById('root')).render(React.createElement(C));
  }
} catch (e) {
  c2v.send('error', (e && e.message) || String(e));
}
c2v.send('mounted');
</script></body></html>`;
}

// Returns { html, mode, async } — async docs post a 'mounted' message once ready.
export function buildDocument(rawCode, config) {
  const code = cleanCode(rawCode);
  const mode = detectMode(code);
  if (mode === 'html') return { html: buildHtml(code, config), mode, async: false };
  if (mode === 'react' || mode === 'remotion') return { html: buildReact(code, config), mode, async: true };
  return { html: buildJs(code, config), mode, async: false };
}
