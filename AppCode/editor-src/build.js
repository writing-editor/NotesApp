// Builds editor-src/main.js into public/mn-editor.bundle.js as a global
// `window.MnEditor`. Run via `npm run build:editor` (see package.json).
// Output filename is deliberately unchanged from the old prebuilt blob so
// mobile/scripts/sync-server-files.js keeps working without modification —
// it just copies this file into mobile/www/ verbatim.
const path = require('path');
const { build } = require('esbuild');

const ROOT = path.resolve(__dirname, '..');

build({
  entryPoints: [path.join(__dirname, 'main.js')],
  outfile: path.join(ROOT, 'public', 'mn-editor.bundle.js'),
  bundle: true,
  minify: true,
  sourcemap: true,
  format: 'iife',
  globalName: 'MnEditor',
  platform: 'browser',
  // Conservative target: must run on older Android system WebViews and
  // WKWebView (Capacitor mobile), not just current desktop Chrome.
  target: ['es2019', 'safari12'],
}).then(() => {
  console.log('[build:editor] wrote public/mn-editor.bundle.js');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});