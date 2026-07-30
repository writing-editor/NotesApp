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
  ['index.html', 'styles.css', 'markdown-typography.css', 'client.js', 'mn-editor.bundle.js'].forEach((file) => {
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
  //
  // isomorphic-git and LightningFS both reference the Node `Buffer` global
  // internally. esbuild's platform:'browser' target does NOT polyfill Node
  // globals the way webpack does — inside a page context this sometimes gets
  // masked by an ambient polyfill script tag, but a Service Worker has no
  // window/global scope to fall back on, so `Buffer` is simply undefined at
  // runtime. That's the direct cause of "missing buffer dependency" on clone,
  // and very likely why partially-cloned repos were missing files (the clone
  // was throwing mid-write, after refs/some blobs but before the full tree).
  //
  // Fix: inject the `buffer` npm package's Buffer as a real global via
  // esbuild's `inject` option, using a tiny shim module so it's attached to
  // `self` (the Service Worker's global object) before any app code runs.
  const shimPath = path.join(MOBILE_ROOT, '.buffer-shim.js');
  fs.writeFileSync(
    shimPath,
    `import { Buffer } from 'buffer';\nself.Buffer = self.Buffer || Buffer;\nexport { Buffer };\n`
  );

  console.log('[Sync] Bundling Mobile Service Worker (mobile-sw.js)...');
  buildSync({
    entryPoints: [path.join(APP_CODE, 'mobile-sw.js')],
    outfile: path.join(MOBILE_WWW, 'sw.js'),
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    define: { global: 'self' }, // some deps also assume Node's `global`
    inject: [shimPath],
    nodePaths: [path.join(MOBILE_ROOT, 'node_modules')],
  });

  fs.unlinkSync(shimPath);

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

  // 5. Bundle the native Android API bridge (mobile/plugin/src/android-bridge.js).
  //
  // This is what index.html loads *instead of* registering sw.js when
  // running under Capacitor on Android — see the isCapacitorAndroid check
  // added to AppCode/public/index.html. It answers the exact same /api/*
  // surface as sw.js, but backed by the native GitFs Capacitor plugin
  // (real on-device files + JGit) rather than LightningFS/isomorphic-git,
  // via a page-context fetch() interceptor rather than a Service Worker
  // (a Service Worker cannot call a native Capacitor plugin — see the
  // header comment in android-bridge.js for why).
  //
  // Both bundles ship in every build; only one is ever actually used per
  // platform, decided at runtime by index.html's isCapacitorAndroid check.
  // This keeps mobile-web/PWA-install and Electron/desktop completely
  // unaffected — they still get sw.js exactly as before.
  console.log('[Sync] Bundling native Android API bridge (android-bridge.js)...');
  const PLUGIN_SRC = path.join(MOBILE_ROOT, 'plugin', 'src');
  buildSync({
    entryPoints: [path.join(PLUGIN_SRC, 'android-bridge.js')],
    outfile: path.join(MOBILE_WWW, 'android-bridge.bundle.js'),
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    nodePaths: [path.join(MOBILE_ROOT, 'node_modules')],
  });

  const builtBridge = fs.readFileSync(path.join(MOBILE_WWW, 'android-bridge.bundle.js'), 'utf8');
  if (!builtBridge.includes('/api/git/clone')) {
    throw new Error(
      '[Sync] FATAL: www/android-bridge.bundle.js does not implement /api/git/clone. Aborting build.'
    );
  }
  console.log('[Sync] Verified: www/android-bridge.bundle.js implements the native GitFs API bridge.');

  console.log('[Sync] Mobile Web Native environment built successfully!');
}

main();