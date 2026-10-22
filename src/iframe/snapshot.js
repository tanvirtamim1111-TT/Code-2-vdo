// Rasterises the live DOM into a canvas by serialising it into an SVG <foreignObject>.
// Only computed styles that differ from the browser defaults are written, fonts are
// embedded once (only the families, weights and character subsets actually used) and
// images are inlined from a cache, which keeps every frame small and fast.

const XHTML = 'http://www.w3.org/1999/xhtml';
const SVGNS = 'http://www.w3.org/2000/svg';
const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'TEMPLATE', 'NOSCRIPT', 'BASE']);
const COPY_ATTRS = ['colspan', 'rowspan', 'dir', 'lang'];
const SANDBOX = Symbol('c2v-sandbox');

const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// ---- fonts -----------------------------------------------------------------------

function parseRanges(value) {
  if (!value) return null;
  const out = [];
  for (let part of value.split(',')) {
    part = part.trim().replace(/^u\+/i, '');
    if (!part) continue;
    if (part.includes('?')) {
      out.push([parseInt(part.replace(/\?/g, '0'), 16), parseInt(part.replace(/\?/g, 'F'), 16)]);
    } else if (part.includes('-')) {
      const [a, b] = part.split('-');
      out.push([parseInt(a, 16), parseInt(b, 16)]);
    } else {
      const v = parseInt(part, 16);
      out.push([v, v]);
    }
  }
  return out.length ? out : null;
}

function parseWeight(value) {
  const map = { normal: 400, bold: 700 };
  const nums = String(value || '400').trim().split(/\s+/).map((v) => map[v] || parseFloat(v) || 400);
  return [nums[0], nums[1] == null ? nums[0] : nums[1]];
}

const cleanFamily = (f) => f.trim().replace(/^["']|["']$/g, '').toLowerCase();

class FontEmbedder {
  constructor(doc) {
    this.doc = doc;
    this.faces = null; // all @font-face rules found in the page
    this.embedded = new Map(); // face -> css text with data: URL, or null when it failed
    this.usage = new Map(); // "family|weight|style" -> Set of code points
    this.files = new Map(); // font file URL -> Promise<data URL | null>
    this.dirty = false;
    this.css = '';
  }

  async collectFaces() {
    const faces = [];
    const seen = new Set();
    const addRules = async (rules, base) => {
      for (const rule of rules) {
        if (rule.type === CSSRule.FONT_FACE_RULE) {
          faces.push({ rule, style: rule.style, base });
        } else if (rule.type === CSSRule.IMPORT_RULE) {
          await addSheet(rule.styleSheet, new URL(rule.href, base).href);
        } else if (rule.cssRules) {
          await addRules(rule.cssRules, base);
        }
      }
    };
    const addText = async (text, base) => {
      // Constructed sheets ignore @import, so follow them by hand.
      for (const m of text.matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)["']?\s*\)?[^;]*;/g)) {
        await addHref(new URL(m[1], base).href);
      }
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text.replace(/@import[^;]+;/g, ''));
      await addRules(sheet.cssRules, base);
    };
    const addHref = async (href) => {
      if (seen.has(href)) return;
      seen.add(href);
      try {
        const res = await fetch(href);
        if (res.ok) await addText(await res.text(), href);
      } catch (e) { /* offline or blocked */ }
    };
    const addSheet = async (sheet, href) => {
      let rules = null;
      try { rules = sheet && sheet.cssRules; } catch (e) { rules = null; }
      if (rules) {
        if (href) seen.add(href);
        await addRules(rules, href || this.doc.baseURI);
      } else if (href) {
        // Cross-origin stylesheet (e.g. Google Fonts): read its text instead.
        await addHref(href);
      }
    };
    for (const sheet of Array.from(this.doc.styleSheets)) await addSheet(sheet, sheet.href);
    this.faces = faces.map((f) => {
      const s = f.style;
      return {
        ...f,
        family: cleanFamily(s.getPropertyValue('font-family')),
        weight: parseWeight(s.getPropertyValue('font-weight')),
        italic: /italic|oblique/.test(s.getPropertyValue('font-style')),
        ranges: parseRanges(s.getPropertyValue('unicode-range')),
      };
    });
  }

  // Records which font/character combinations a text node needs.
  use(cs, text) {
    const key = `${cs.fontFamily}|${cs.fontWeight}|${cs.fontStyle}`;
    let set = this.usage.get(key);
    if (!set) { set = new Set(); this.usage.set(key, set); this.dirty = true; }
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp >= 32 && !set.has(cp)) { set.add(cp); this.dirty = true; }
    }
  }

  neededFaces() {
    const need = new Set();
    for (const [key, cps] of this.usage) {
      const [familyList, weightStr, styleStr] = key.split('|');
      const weight = parseFloat(weightStr) || 400;
      const italic = /italic|oblique/.test(styleStr);
      for (const fam of familyList.split(',').map(cleanFamily)) {
        let candidates = this.faces.filter((f) => f.family === fam);
        if (!candidates.length) continue;
        const sameStyle = candidates.filter((f) => f.italic === italic);
        if (sameStyle.length) candidates = sameStyle;
        const dist = (f) => (weight < f.weight[0] ? f.weight[0] - weight : weight > f.weight[1] ? weight - f.weight[1] : 0);
        const best = Math.min(...candidates.map(dist));
        for (const f of candidates) {
          if (dist(f) !== best) continue;
          if (!f.ranges || [...cps].some((cp) => f.ranges.some(([a, b]) => cp >= a && cp <= b))) need.add(f);
        }
      }
    }
    return need;
  }

  async embed(face) {
    const src = face.style.getPropertyValue('src');
    const urls = [...src.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)\s*(format\([^)]*\))?/g)];
    if (!urls.length) return null;
    // Prefer woff2, then whatever comes first.
    const pick = urls.find((u) => /woff2/.test(u[2] || u[1])) || urls[0];
    let dataUrl = pick[1];
    if (!dataUrl.startsWith('data:')) {
      const abs = new URL(dataUrl, face.base).href;
      if (!this.files.has(abs)) {
        this.files.set(abs, fetch(abs).then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? blobToDataURL(b) : null)));
      }
      dataUrl = await this.files.get(abs);
      if (!dataUrl) return null;
    }
    const parts = [];
    for (let i = 0; i < face.style.length; i++) {
      const name = face.style[i];
      // font-display:swap would let the SVG image paint with a fallback font.
      if (name === 'src' || name === 'font-display') continue;
      parts.push(`${name}:${face.style.getPropertyValue(name)}`);
    }
    parts.push(`src:url("${dataUrl}")${pick[2] ? ` ${pick[2]}` : ''}`);
    return `@font-face{${parts.join(';')}}`;
  }

  // Returns the @font-face CSS for everything used so far, fetching new faces as needed.
  async update() {
    if (!this.faces) await this.collectFaces();
    if (!this.dirty) return this.css;
    this.dirty = false;
    const jobs = [];
    for (const face of this.neededFaces()) {
      if (this.embedded.has(face)) continue;
      this.embedded.set(face, null);
      jobs.push(this.embed(face).then((css) => this.embedded.set(face, css)).catch(() => {}));
    }
    if (jobs.length) {
      await Promise.all(jobs);
      this.css = [...this.embedded.values()].filter(Boolean).join('\n');
    }
    return this.css;
  }
}

// ---- snapshotter ---------------------------------------------------------------------

export class Snapshotter {
  constructor(win) {
    this.win = win;
    this.doc = win.document;
    this.defaults = new Map();
    this.images = new Map(); // url -> data URL | null (failed) ; pending in this.loading
    this.loading = new Map();
    this.fonts = new FontEmbedder(this.doc);
    this.props = null;
    this.sandbox = null;
  }

  setupSandbox() {
    const f = this.doc.createElement('iframe');
    f[SANDBOX] = true;
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;left:-20000px;top:0;width:100px;height:100px;border:0;visibility:hidden;pointer-events:none';
    this.doc.documentElement.appendChild(f);
    const d = f.contentDocument;
    d.open();
    d.write('<!doctype html><html><head></head><body></body></html>');
    d.close();
    this.sandbox = f;
    const probe = d.createElement('div');
    d.body.appendChild(probe);
    const cs = f.contentWindow.getComputedStyle(probe);
    const props = [];
    for (let i = 0; i < cs.length; i++) {
      const p = cs[i];
      if (p.startsWith('--') || p.startsWith('animation') || p.startsWith('transition') || p === 'will-change') continue;
      props.push(p);
    }
    this.props = props;
    this.alwaysProps = new Set(props.filter((p) => /^(border(-(top|right|bottom|left|block|inline)(-(start|end))?)?-width|outline-width|column-rule-width)$/.test(p)));
  }

  defaultsFor(tag, svg) {
    const key = svg ? `svg:${tag}` : tag;
    let d = this.defaults.get(key);
    if (d) return d;
    const sd = this.sandbox.contentDocument;
    let el;
    if (svg) {
      const root = sd.createElementNS(SVGNS, 'svg');
      sd.body.appendChild(root);
      el = tag === 'svg' ? root : root.appendChild(sd.createElementNS(SVGNS, tag));
    } else {
      el = sd.body.appendChild(sd.createElement(tag));
    }
    const cs = this.sandbox.contentWindow.getComputedStyle(el);
    d = new Map();
    for (const p of this.props) d.set(p, cs.getPropertyValue(p));
    this.defaults.set(key, d);
    (svg ? el.ownerSVGElement || el : el).remove();
    return d;
  }

  styleText(cs, defaults, extra) {
    let out = '';
    for (const p of this.props) {
      let v = cs.getPropertyValue(p);
      // Widths read as 0 whenever the style is none, so a default-looking width can
      // still differ from the default once a style (e.g. Tailwind's `solid`) is set.
      if (v === defaults.get(p) && !this.alwaysProps.has(p)) continue;
      if (v.includes('url(')) v = this.inlineUrls(v);
      out += `${p}:${v};`;
    }
    return extra ? out + extra : out;
  }

  inlineUrls(value) {
    return value.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/g, (m, url) => {
      if (url.startsWith('data:') || url.startsWith('#')) return m;
      const data = this.image(url);
      return data ? `url("${data}")` : 'none';
    });
  }

  // Cached data URL for an image; starts loading it if unknown.
  image(url) {
    const abs = new URL(url, this.doc.baseURI).href;
    if (abs.startsWith('data:')) return abs;
    if (this.images.has(abs)) return this.images.get(abs);
    if (!this.loading.has(abs)) {
      this.loading.set(abs, fetch(abs)
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => (b ? blobToDataURL(b) : null))
        .catch(() => null)
        .then((d) => { this.images.set(abs, d); this.loading.delete(abs); }));
    }
    return null;
  }

  serialize(node, out, pseudo, parentSvg) {
    if (node.nodeType === 3) {
      const text = node.nodeValue;
      if (!text) return;
      const parent = node.parentElement;
      if (parent && /\S/.test(text)) this.fonts.use(this.win.getComputedStyle(parent), text);
      out.push(escText(text));
      return;
    }
    if (node.nodeType !== 1 || SKIP.has(node.tagName) || node[SANDBOX]) return;
    const el = node;
    const isSvg = el.namespaceURI === SVGNS;
    const cs = this.win.getComputedStyle(el);
    if (!isSvg && cs.display === 'none') return;
    let tag = isSvg ? el.tagName : el.tagName.toLowerCase();
    if (!isSvg && (tag === 'html' || tag === 'body')) tag = 'div';
    if (tag === 'style' || tag === 'script') return;

    let attrs = '';
    let children = true;
    let replaced = null;

    if (isSvg) {
      for (const a of el.attributes) {
        if (a.name === 'style' || a.name.startsWith('on')) continue;
        let v = a.value;
        if ((a.name === 'href' || a.name === 'xlink:href') && tag === 'image' && !v.startsWith('data:')) v = this.image(v) || '';
        attrs += ` ${a.name}="${escAttr(v)}"`;
      }
      if (tag === 'svg' && !parentSvg) attrs += ` xmlns="${SVGNS}"`;
    } else {
      for (const name of COPY_ATTRS) if (el.hasAttribute(name)) attrs += ` ${name}="${escAttr(el.getAttribute(name))}"`;
      if (tag === 'img') {
        const src = el.currentSrc || el.src;
        const data = src ? this.image(src) : null;
        attrs += ` src="${escAttr(data || 'data:image/gif;base64,R0lGODlhAQABAAAAACw=')}"`;
        children = false;
      } else if (tag === 'canvas') {
        let data = '';
        try { data = el.toDataURL(); } catch (e) { /* tainted */ }
        replaced = `<img src="${escAttr(data)}" style="${escAttr(this.styleText(cs, this.defaultsFor('img')))}"/>`;
      } else if (tag === 'video') {
        let data = '';
        try {
          const c = this.doc.createElement('canvas');
          c.width = el.videoWidth || 1; c.height = el.videoHeight || 1;
          c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
          data = c.toDataURL('image/jpeg', 0.92);
        } catch (e) { /* not ready or tainted */ }
        replaced = `<img src="${escAttr(data)}" style="${escAttr(this.styleText(cs, this.defaultsFor('img'), 'object-fit:' + cs.objectFit + ';'))}"/>`;
      } else if (tag === 'iframe') {
        replaced = `<div style="${escAttr(this.styleText(cs, this.defaultsFor('div')))}"></div>`;
      } else if (tag === 'input') {
        if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked) attrs += ' checked="checked"'; } else attrs += ` value="${escAttr(el.value)}"`;
        attrs += ` type="${escAttr(el.type)}"`;
        children = false;
      } else if (tag === 'textarea') {
        out.push(`<textarea style="${escAttr(this.styleText(cs, this.defaultsFor('textarea')))}">${escText(el.value)}</textarea>`);
        return;
      }
    }
    if (replaced) { out.push(replaced); return; }

    let style = this.styleText(cs, this.defaultsFor(tag, isSvg));
    if (el === this.doc.documentElement) {
      style += `width:${this.width}px;height:${this.height}px;overflow:hidden;margin:0;`;
      style += this.rootBackground;
    } else if (el === this.doc.body && this.rootBackground) {
      style += 'background:none;';
    }

    // ::before / ::after
    let pid = '';
    if (!isSvg) {
      for (const which of ['::before', '::after']) {
        const ps = this.win.getComputedStyle(el, which);
        const content = ps.content;
        if (!content || content === 'none' || content === 'normal') continue;
        if (!pid) { pid = String(pseudo.length + 1); attrs += ` data-p="${pid}"`; }
        pseudo.push(`[data-p="${pid}"]${which}{${this.styleText(ps, this.defaultsFor('span'))}content:${content};}`);
      }
    }

    out.push(`<${tag}${attrs}${style ? ` style="${escAttr(style)}"` : ''}>`);
    if (children) {
      for (let c = el.firstChild; c; c = c.nextSibling) this.serialize(c, out, pseudo, isSvg && tag !== 'foreignObject');
    }
    out.push(`</${tag}>`);
  }

  computeRootBackground() {
    // The body background paints the whole viewport when <html> has none.
    const clear = (cs) => (cs.backgroundImage === 'none') && /^(transparent|rgba\(0, 0, 0, 0\))$/.test(cs.backgroundColor);
    const h = this.win.getComputedStyle(this.doc.documentElement);
    const b = this.doc.body && this.win.getComputedStyle(this.doc.body);
    if (!clear(h) || !b || clear(b)) return '';
    let s = '';
    for (const p of ['background-color', 'background-image', 'background-size', 'background-position', 'background-repeat', 'background-attachment', 'background-origin', 'background-clip']) {
      let v = b.getPropertyValue(p);
      if (v.includes('url(')) v = this.inlineUrls(v);
      s += `${p}:${v};`;
    }
    return s;
  }

  build() {
    this.rootBackground = this.computeRootBackground();
    const out = [];
    const pseudo = [];
    this.serialize(this.doc.documentElement, out, pseudo, false);
    return { out, pseudo };
  }

  // Draws the current state of the page into ctx (width x height).
  async draw(ctx, width, height) {
    this.width = width;
    this.height = height;
    if (!this.sandbox) this.setupSandbox();
    let { out, pseudo } = this.build();
    // First frames may discover images/fonts that are not loaded yet: load, then rebuild.
    if (this.loading.size || this.fonts.dirty) {
      await Promise.all([...this.loading.values()]);
      await this.fonts.update();
      ({ out, pseudo } = this.build());
      await this.fonts.update();
    }
    const css = this.fonts.css + pseudo.join('');
    const rootOpen = out[0].replace(/^<div/, `<div xmlns="${XHTML}"`);
    out[0] = css ? `${rootOpen}<style>${escText(css)}</style>` : rootOpen;
    const svg = `<svg xmlns="${SVGNS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject x="0" y="0" width="100%" height="100%">${out.join('')}</foreignObject></svg>`;
    // A data: URL (not a blob: URL) keeps the canvas untainted in Chrome.
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
  }
}
