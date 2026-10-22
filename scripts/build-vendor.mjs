// Bundles the libraries that pasted code can import, plus the in-frame runtime,
// into public/vendor so the app works offline (PWA and Android APK).
import { build } from 'esbuild';
import { mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, 'public', 'vendor');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const common = {
  bundle: true,
  minify: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
  target: ['es2020'],
};

await build({
  ...common,
  entryPoints: [path.join(root, 'src/iframe/runtime.js')],
  outfile: path.join(out, 'c2v-runtime.js'),
  format: 'iife',
});

// One bundle holds React + ReactDOM so every facade shares the same instance.
await writeFile(path.join(out, '_react-entry.js'), `
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as JSXRuntime from 'react/jsx-runtime';
export { React, ReactDOM, ReactDOMClient, JSXRuntime };
`);
await build({
  ...common,
  entryPoints: [path.join(out, '_react-entry.js')],
  outfile: path.join(out, 'react-all.mjs'),
  format: 'esm',
  nodePaths: [path.join(root, 'node_modules')],
});
await rm(path.join(out, '_react-entry.js'));

function facade(name, ns, mod) {
  const keys = Object.keys(require(mod)).filter((k) => k !== 'default' && /^[A-Za-z_$][\w$]*$/.test(k));
  const body = `import { ${ns} as M } from './react-all.mjs';\nexport default M.default || M;\nexport const { ${keys.join(', ')} } = M;\n`;
  return writeFile(path.join(out, name), body);
}
await facade('react.mjs', 'React', 'react');
await facade('react-dom.mjs', 'ReactDOM', 'react-dom');
await facade('react-dom-client.mjs', 'ReactDOMClient', 'react-dom/client');
await facade('jsx-runtime.mjs', 'JSXRuntime', 'react/jsx-runtime');

const reactExternals = ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'];
const libs = {
  'framer-motion.mjs': 'framer-motion',
  'motion-react.mjs': 'motion/react',
  'motion.mjs': 'motion',
  'gsap.mjs': 'gsap',
  'gsap-all.mjs': 'gsap/all',
  'lucide-react.mjs': 'lucide-react',
  'three.mjs': 'three',
};
const hasDefault = new Set(['gsap', 'gsap/all']);
for (const [file, mod] of Object.entries(libs)) {
  const entry = path.join(out, `_entry-${file}.js`);
  const def = hasDefault.has(mod) ? `export { default } from '${mod}';` : `import * as M from '${mod}';\nexport default M;`;
  await writeFile(entry, `export * from '${mod}';\n${def}\n`);
  await build({
    ...common,
    entryPoints: [entry],
    outfile: path.join(out, file),
    format: 'esm',
    external: reactExternals,
    nodePaths: [path.join(root, 'node_modules')],
  });
  await rm(entry);
}

await build({
  ...common,
  entryPoints: [path.join(root, 'src/iframe/remotion.js')],
  outfile: path.join(out, 'remotion.mjs'),
  format: 'esm',
  external: reactExternals,
});

await copyFile(require.resolve('@tailwindcss/browser'), path.join(out, 'tailwind.js'));

// Classic-script build for pasted HTML that loads GSAP from a CDN (works offline).
await copyFile(path.join(root, 'node_modules/gsap/dist/gsap.min.js'), path.join(out, 'gsap.min.js'));

console.log('vendor built →', path.relative(root, out));
