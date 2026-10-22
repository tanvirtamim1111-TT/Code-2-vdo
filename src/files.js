// Loading code from uploaded files, plus images/fonts the code refers to by name.

const CODE_EXT = /\.(html?|css|m?jsx?|tsx?|md|txt|json|svg)$/i;

const readText = (file) => file.text();
const readDataURL = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

const ext = (name) => (name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function isCodeFile(file) {
  if (CODE_EXT.test(file.name)) return true;
  return !file.type || file.type.startsWith('text/');
}

// Puts uploaded CSS/JS into the HTML, replacing <link>/<script src> tags that name them.
function combine(htmlFile, cssFiles, jsFiles) {
  let html = htmlFile.text;
  for (const f of cssFiles) {
    const re = new RegExp(`<link[^>]+href=["'](?:\\.?/)?(?:[^"']*/)?${escRe(f.name)}["'][^>]*>`, 'i');
    const tag = `<style>\n${f.text}\n</style>`;
    if (re.test(html)) html = html.replace(re, () => tag);
    else if (/<\/head>/i.test(html)) html = html.replace(/<\/head>/i, () => `${tag}\n</head>`);
    else html = `${tag}\n${html}`;
  }
  for (const f of jsFiles) {
    const re = new RegExp(`<script([^>]*?)\\s+src=["'](?:\\.?/)?(?:[^"']*/)?${escRe(f.name)}["']([^>]*)>\\s*</script>`, 'i');
    const body = f.text.replace(/<\/script/gi, '<\\/script');
    if (re.test(html)) html = html.replace(re, (m, a, b) => `<script${a}${b}>\n${body}\n</script>`);
    else if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, () => `<script>\n${body}\n</script>\n</body>`);
    else html += `\n<script>\n${body}\n</script>`;
  }
  return html;
}

/**
 * Reads picked files. Returns { code, assets, notes } where assets maps file name to a
 * data: URL and code is null when only assets were picked.
 */
export async function loadFiles(fileList) {
  const files = Array.from(fileList);
  const texts = [];
  const assets = new Map();
  for (const f of files) {
    if (isCodeFile(f) && ext(f.name) !== 'svg') texts.push({ name: f.name, ext: ext(f.name), text: await readText(f) });
    else if (ext(f.name) === 'svg' && files.length === 1) texts.push({ name: f.name, ext: 'svg', text: await readText(f) });
    else assets.set(f.name, await readDataURL(f));
  }
  const notes = [];
  if (!texts.length) return { code: null, assets, notes };

  const html = texts.filter((t) => /^html?$/.test(t.ext));
  const css = texts.filter((t) => t.ext === 'css');
  const js = texts.filter((t) => /^m?js$/.test(t.ext));
  const jsx = texts.filter((t) => /^(jsx|tsx|ts)$/.test(t.ext));

  let code;
  if (html.length) {
    const main = html.find((t) => /^index\.html?$/i.test(t.name)) || html[0];
    code = combine(main, css, js);
    if (html.length > 1) notes.push(`${main.name} ব্যবহার করা হয়েছে`);
  } else if (jsx.length || (js.length && !css.length && js.some((t) => /export\s+default|from\s+['"]react/.test(t.text)))) {
    const pool = jsx.length ? jsx : js;
    const main = pool.find((t) => /export\s+default/.test(t.text) && /App|Video|Composition|Root/.test(t.name))
      || pool.find((t) => /export\s+default/.test(t.text))
      || pool.sort((a, b) => b.text.length - a.text.length)[0];
    code = main.text;
    if (pool.length > 1) notes.push(`${main.name} চালানো হচ্ছে (একাধিক ফাইলের import সাপোর্ট নেই)`);
  } else if (css.length || js.length) {
    code = combine({ text: '<!doctype html><html><head></head><body></body></html>' }, css, js);
  } else {
    code = texts.map((t) => t.text).join('\n\n');
  }
  return { code, assets, notes };
}

// Replaces references such as "logo.png", "./img/logo.png" or url(bg.jpg) with data URLs.
export function applyAssets(code, assets) {
  if (!assets || !assets.size) return code;
  let out = code;
  for (const [name, data] of assets) {
    const re = new RegExp(`(["'(\`])((?:\\.{0,2}/)?(?:[\\w.@~-]+/)*)${escRe(name)}(?=["')\`?#])`, 'g');
    out = out.replace(re, (m, q) => `${q}${data}`);
  }
  return out;
}
