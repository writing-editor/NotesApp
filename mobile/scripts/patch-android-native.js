// mobile/scripts/patch-android-native.js
//
// Wires the native GitFs Capacitor plugin (mobile/plugin/android/) into the
// Capacitor-generated `mobile/android/` project as a new Gradle module.
//
// WHY THIS EXISTS / WHY IT RUNS THIS WAY:
// `mobile/android/` does not exist in the repo — CI generates it fresh on
// every run via `npx cap add android` (see build-android-apk.yml), since
// there's no Android Studio available anywhere in this project's workflow
// to maintain a checked-in native project by hand. That means a plugin
// module can't just "already be there" the way a normal Capacitor plugin
// package would be (installed via npm + `cap sync`, which only wires up
// *published* plugin packages) — this repo's GitFs plugin is local source,
// not an npm package, so it needs its own injection step:
//
//   1. Copy mobile/plugin/android/ into mobile/android/capacitor-gitfs/
//      (a new Gradle module living alongside the auto-generated `app` and
//      `capacitor-android` modules).
//   2. Add the Kotlin Gradle plugin classpath to the root build.gradle —
//      the stock Capacitor Android template is pure Java and has none.
//   3. Add `include ':capacitor-gitfs'` + the project dir mapping to
//      settings.gradle.
//   4. Add `implementation project(':capacitor-gitfs')` to app/build.gradle's
//      dependencies block.
//
// Capacitor 7's BridgeActivity registers plugins via classpath annotation
// scanning (@CapacitorPlugin) automatically — once the module is a
// dependency of `app`, GitFsPlugin needs no manual registration call in
// MainActivity.java at all. This is why this script never touches
// MainActivity.java (compare mobile/scripts/patch-webview-cache.js, which
// does, for an unrelated reason).
//
// Must run AFTER `cap add android` / `cap sync android` (the target
// directories don't exist before that) and BEFORE the Gradle build step.
// Idempotent: safe to re-run against an already-patched project (used by
// the `cap sync android` branch of the workflow, for local iteration).

const fs = require('fs');
const path = require('path');

const MOBILE_ROOT = path.resolve(__dirname, '..');
const ANDROID_ROOT = path.join(MOBILE_ROOT, 'android');
const PLUGIN_SRC = path.join(MOBILE_ROOT, 'plugin', 'android');
const PLUGIN_DEST = path.join(ANDROID_ROOT, 'capacitor-gitfs');
const SETTINGS_GRADLE = path.join(ANDROID_ROOT, 'settings.gradle');
const APP_BUILD_GRADLE = path.join(ANDROID_ROOT, 'app', 'build.gradle');
const ROOT_BUILD_GRADLE = path.join(ANDROID_ROOT, 'build.gradle');

const MARKER = '// __GITFS_NATIVE_PLUGIN__';
const KOTLIN_VERSION = '1.9.24'; // compatible with AGP 8.7.x and JDK 17, matches Capacitor 7's own baseline

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function main() {
  if (!fs.existsSync(ANDROID_ROOT)) {
    throw new Error(
      `[PatchNative] FATAL: ${ANDROID_ROOT} not found. Run this after ` +
      `'cap add android' / 'cap sync android', not before.`
    );
  }
  if (!fs.existsSync(PLUGIN_SRC)) {
    throw new Error(`[PatchNative] FATAL: ${PLUGIN_SRC} not found — plugin source is missing.`);
  }

  // 1. Copy/refresh the plugin module source every run — the module itself
  //    is small and always overwritten wholesale rather than diffed, so a
  //    changed .kt file in mobile/plugin/android/ always makes it into the
  //    generated project, including on the `cap sync android` (not `add`)
  //    branch where the rest of android/ is left alone.
  if (fs.existsSync(PLUGIN_DEST)) fs.rmSync(PLUGIN_DEST, { recursive: true, force: true });
  copyDir(PLUGIN_SRC, PLUGIN_DEST);
  console.log(`[PatchNative] Copied native plugin module into ${PLUGIN_DEST}`);

  // 2. Root build.gradle — the stock Capacitor Android template is pure
  //    Java and carries no Kotlin Gradle plugin classpath at all. Add one
  //    so `apply plugin: 'kotlin-android'` in the new module's build.gradle
  //    (mobile/plugin/android/build.gradle) resolves.
  let rootGradle = fs.readFileSync(ROOT_BUILD_GRADLE, 'utf8');
  if (!rootGradle.includes(MARKER)) {
    rootGradle = rootGradle.replace(
      /classpath 'com\.android\.tools\.build:gradle:[^']+'/,
      (m) => `${m}\n        ${MARKER}\n        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:${KOTLIN_VERSION}'`
    );
    fs.writeFileSync(ROOT_BUILD_GRADLE, rootGradle, 'utf8');
    console.log('[PatchNative] build.gradle: added Kotlin Gradle plugin classpath.');
  } else {
    console.log('[PatchNative] build.gradle already has Kotlin classpath — skipping.');
  }

  // 3. settings.gradle — add the module include, once.
  let settings = fs.readFileSync(SETTINGS_GRADLE, 'utf8');
  if (!settings.includes(MARKER)) {
    settings += `\n${MARKER}\n` +
      `include ':capacitor-gitfs'\n` +
      `project(':capacitor-gitfs').projectDir = new File('./capacitor-gitfs')\n`;
    fs.writeFileSync(SETTINGS_GRADLE, settings, 'utf8');
    console.log('[PatchNative] settings.gradle: added capacitor-gitfs module include.');
  } else {
    console.log('[PatchNative] settings.gradle already includes capacitor-gitfs — skipping.');
  }

  // 4. app/build.gradle — add the module dependency, once.
  let appGradle = fs.readFileSync(APP_BUILD_GRADLE, 'utf8');
  if (!appGradle.includes(MARKER)) {
    const depRegex = /dependencies\s*\{/;
    if (!depRegex.test(appGradle)) {
      throw new Error(
        '[PatchNative] FATAL: could not find a "dependencies {" block in ' +
        'app/build.gradle — Capacitor\'s generated project structure may ' +
        'have changed.'
      );
    }
    appGradle = appGradle.replace(
      depRegex,
      `dependencies {\n    ${MARKER}\n    implementation project(':capacitor-gitfs')`
    );
    fs.writeFileSync(APP_BUILD_GRADLE, appGradle, 'utf8');
    console.log('[PatchNative] app/build.gradle: added capacitor-gitfs dependency.');
  } else {
    console.log('[PatchNative] app/build.gradle already depends on capacitor-gitfs — skipping.');
  }

  console.log('[PatchNative] Native GitFs plugin wired in successfully.');
}

main();