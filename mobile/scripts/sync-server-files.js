const fs = require('fs');
const path = require('path');
const { buildSync } = require('esbuild');

const MOBILE_ROOT = path.resolve(__dirname, '..');
const MOBILE_WWW  = path.join(MOBILE_ROOT, 'www');
const APP_CODE    = path.join(MOBILE_ROOT, '../AppCode');

function main() {
  console.log('[Sync] Preparing mobile web assets...');

  // 1. Ensure www folder exists
  if (!fs.existsSync(MOBILE_WWW)) {
    fs.mkdirSync(MOBILE_WWW, { recursive: true });
  }

  // 2. Copy the Frontend UI exactly as it is
  ['index.html', 'styles.css', 'client.js'].forEach((file) => {
    fs.copyFileSync(path.join(APP_CODE, 'public', file), path.join(MOBILE_WWW, file));
  });

  // 3. Bundle the Mobile Service Worker using ESBuild
  console.log('[Sync] Bundling Mobile Service Worker...');
  buildSync({
    entryPoints: [path.join(APP_CODE, 'mobile-sw.js')],
    outfile: path.join(MOBILE_WWW, 'sw.js'),
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    // Tell esbuild to look in sibling mobile/node_modules folder for resolving packages
    nodePaths: [path.join(MOBILE_ROOT, 'node_modules')]
  });

  console.log('[Sync] Mobile Web Native environment built successfully!');
}

main();