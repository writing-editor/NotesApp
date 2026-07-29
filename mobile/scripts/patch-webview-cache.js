// mobile/scripts/patch-webview-cache.js
//
// Disables Android WebView's own native HTTP disk cache in the generated
// MainActivity.java.
//
// WHY THIS EXISTS:
// The app already has a fully versioned cache at the Service Worker layer
// (see AppCode/mobile-sw.js — CACHE_NAME keyed to the build's run_number,
// old caches purged on activate, controllerchange forces an immediate
// reload). That layer is correct and sufficient on its own.
//
// But Android WebView also keeps its OWN native HTTP disk cache underneath
// the Service Worker, independent of it. That native cache is not tied to
// the app's version at all and is NOT cleared by installing an update —
// only by clearing app data or uninstalling. This is a long-documented
// WebView behavior (same-URL sub-resources — images especially, but any
// fetch — can keep being served from this layer even though the
// underlying bytes changed), and it is the most likely explanation if
// "changes only appear after uninstall/reinstall" persists even with the
// Service Worker's versioning working correctly.
//
// Since the Service Worker already owns cache invalidation deliberately
// and correctly, the WebView's redundant native cache is pure downside
// here — this disables it via WebSettings.setCacheMode(LOAD_NO_CACHE).
//
// This must run AFTER `cap add android` / `cap sync android` (MainActivity.java
// doesn't exist before that) and before the Gradle build step.

const fs = require('fs');
const path = require('path');

const MAIN_ACTIVITY = path.resolve(
  __dirname,
  '../android/app/src/main/java/com/yourname/manuscript/MainActivity.java'
);

const PATCHED_MARKER = '// __WEBVIEW_CACHE_PATCH__';

function main() {
  if (!fs.existsSync(MAIN_ACTIVITY)) {
    throw new Error(
      `[Patch] FATAL: ${MAIN_ACTIVITY} not found. Run this after ` +
      `'cap add android' / 'cap sync android', not before.`
    );
  }

  let src = fs.readFileSync(MAIN_ACTIVITY, 'utf8');

  if (src.includes(PATCHED_MARKER)) {
    console.log('[Patch] MainActivity.java already patched — skipping.');
    return;
  }

  if (!src.includes('import com.getcapacitor.BridgeActivity;')) {
    throw new Error(
      '[Patch] FATAL: MainActivity.java does not extend BridgeActivity as ' +
      'expected — refusing to patch a file that looks different from what ' +
      'this script was written against.'
    );
  }

  // Insert an onCreate() override that reaches into the Capacitor Bridge's
  // WebView and disables its native HTTP cache, right after super.onCreate().
  const importInsert = `import com.getcapacitor.BridgeActivity;\nimport android.webkit.WebSettings;\nimport android.os.Bundle;`;
  src = src.replace('import com.getcapacitor.BridgeActivity;', importInsert);

  const classOpenRegex = /public class MainActivity extends BridgeActivity \{/;
  if (!classOpenRegex.test(src)) {
    throw new Error(
      '[Patch] FATAL: could not find "public class MainActivity extends ' +
      'BridgeActivity {" — MainActivity.java structure may have changed.'
    );
  }

  const onCreateOverride = `public class MainActivity extends BridgeActivity {
    ${PATCHED_MARKER}
    // See mobile/scripts/patch-webview-cache.js for why this exists: the
    // Service Worker (AppCode/mobile-sw.js) already owns cache invalidation
    // correctly and deliberately. WebView's own native HTTP cache sits
    // underneath it, isn't tied to the app's version, and isn't cleared by
    // an app update — only by clearing app data or uninstalling. Disabling
    // it here removes that redundant, unversioned caching layer entirely.
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        this.bridge.getWebView().getSettings().setCacheMode(WebSettings.LOAD_NO_CACHE);
    }
`;

  src = src.replace(classOpenRegex, onCreateOverride);

  fs.writeFileSync(MAIN_ACTIVITY, src, 'utf8');
  console.log('[Patch] MainActivity.java patched: WebView native HTTP cache disabled.');
}

main();