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

  // 2b. Guard against AppCode/sw.js (the network-passthrough / offline-queue
  // worker meant for the laptop+real-backend setup) ever being copied
  // verbatim into www/sw.js instead of the LightningFS-backed mobile-sw.js.
  // The two workers register on the same scope and look superficially similar,
  // so a stray `cp sw.js www/sw.js` elsewhere in the pipeline would silently
  // ship a worker that can never actually clone/write anything on-device.
  const staleSwPath = path.join(MOBILE_WWW, 'sw.js');
  if (fs.existsSync(staleSwPath)) {
    fs.unlinkSync(staleSwPath);
  }

  // 3. Bundle the Mobile Service Worker using ESBuild
  console.log('[Sync] Bundling Mobile Service Worker (mobile-sw.js)...');
  buildSync({
    entryPoints: [path.join(APP_CODE, 'mobile-sw.js')],
    outfile: path.join(MOBILE_WWW, 'sw.js'),
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    nodePaths: [path.join(MOBILE_ROOT, 'node_modules')],
  });

  // 4. Verify the bundle actually contains the LightningFS-backed worker and
  // not, e.g., an accidental empty/wrong output. Fail the build loudly rather
  // than shipping an APK that silently can't clone or persist anything.
  const built = fs.readFileSync(path.join(MOBILE_WWW, 'sw.js'), 'utf8');
  if (!built.includes('manuscript-fs')) {
    throw new Error(
      '[Sync] FATAL: www/sw.js does not reference the LightningFS database ' +
      '("manuscript-fs"). The wrong service worker may have been bundled — ' +
      'check that entryPoints points at AppCode/mobile-sw.js, not AppCode/sw.js.'
    );
  }
  if (!built.includes('/api/git/clone')) {
    throw new Error(
      '[Sync] FATAL: www/sw.js does not implement /api/git/clone. Aborting build.'
    );
  }

  console.log('[Sync] Verified: www/sw.js is the LightningFS mobile worker.');
  console.log('[Sync] Mobile Web Native environment built successfully!');
}

main();