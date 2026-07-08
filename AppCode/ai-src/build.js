// Builds ai-src/main.js into public/mn-ai.bundle.js as a global `window.MnAI`.
// Run via `npm run build:ai` (see package.json). Twin of editor-src/build.js —
// same target/format story, since this also has to run inside the Electron
// BrowserWindow's Chromium (current) as well as, if this ever stops being
// desktop-gated, the same Capacitor WebViews the editor bundle supports.
const path = require('path');
const { build } = require('esbuild');

const ROOT = path.resolve(__dirname, '..');

build({
  entryPoints: [path.join(__dirname, 'main.js')],
  outfile: path.join(ROOT, 'public', 'mn-ai.bundle.js'),
  bundle: true,
  minify: true,
  sourcemap: true,
  format: 'iife',
  globalName: 'MnAI',
  platform: 'browser',
  target: ['es2019', 'safari12'],
}).then(() => {
  console.log('[build:ai] wrote public/mn-ai.bundle.js');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});