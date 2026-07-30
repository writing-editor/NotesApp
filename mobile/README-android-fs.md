# Android: real filesystem + native git (replaces LightningFS/isomorphic-git)

## The two problems this solves

1. **Slow git push/pull on the phone.** The old mobile path ran
   isomorphic-git inside a Service Worker, and isomorphic-git's browser
   `http` client can't make cross-origin requests to GitHub directly
   (CORS) — so every clone/fetch/push byte was relayed through the public,
   shared, rate-limited `https://cors.isomorphic-git.org` proxy. That
   extra hop, plus isomorphic-git's own JS pack-file handling, was the
   main source of the slowness.

2. **No real files on disk.** The old mobile vault lived entirely inside
   LightningFS, which is IndexedDB pretending to be a filesystem. Nothing
   outside the app's own JS could see it — not a file manager, not USB
   file transfer, not Obsidian. Git was the *only* way in or out, which
   also made it a single point of failure (a bad pull/merge had no local
   "just open the file" fallback).

## What changed

Android now uses:

- **A real folder on the device's own storage**
  (`context.getExternalFilesDir(null)/ManuScript`, i.e.
  `Android/data/com.yourname.manuscript/files/ManuScript` under Internal
  storage) as the git working tree. This is a genuine `java.io.File`
  location — visible over USB-MTP, in any file manager, and reachable
  from Obsidian's own "open folder" picker.

- **Native git via [JGit](https://www.eclipse.org/jgit/)** instead of
  isomorphic-git. JGit is a pure-Java git implementation (Maven Central,
  no native `.so` code) that talks to GitHub directly over HTTPS. CORS is
  a *browser* `fetch()`/`XMLHttpRequest` restriction — it was never a
  concept that applied to native JVM networking — so this removes the
  `cors.isomorphic-git.org` hop entirely. This is the actual fix for the
  slowness, not just a workaround.

- **A small Kotlin Capacitor plugin, `GitFs`** (`mobile/plugin/android/`),
  exposing plain filesystem primitives (read/write/mkdir/readdir/delete)
  and git operations (clone/status/commit/pull/push/checkRemote) to JS.

- **`mobile/plugin/src/android-bridge.js`**, a page-context replacement
  for `mobile-sw.js` that answers the exact same `/api/*` routes
  `AppCode/public/client.js` already calls, just backed by the `GitFs`
  plugin instead of LightningFS. `client.js` itself needed **no changes**
  to work against real files — only which script intercepts `/api/*`
  changed. `AppCode/public/index.html` picks the right one at runtime:
  Capacitor+Android → `android-bridge.bundle.js`; every other platform
  (mobile-web/PWA install, Electron, plain browser) is unaffected and
  keeps using `sw.js` exactly as before.

- **An explicit, optional Export/Import-to-folder pair** (Settings →
  "Local folder", Android only), for people who want the vault mirrored
  to a *second*, arbitrary SAF-picked folder — a Syncthing folder,
  Downloads, a folder already open in Obsidian elsewhere, etc. This is a
  plain file copy, independent of git, using Android's Storage Access
  Framework (`ACTION_OPEN_DOCUMENT_TREE`).

## Why not "isomorphic-git operates directly on the SAF folder"?

This was the first design considered, and it's worth explaining precisely
why it isn't what got built, since it looks like the more direct fix.

JGit's `Repository`/`FileRepositoryBuilder` (and, on the JS side,
isomorphic-git's own `fs` adapter contract) are built entirely around
`java.io.File` / POSIX-style paths. Android's Storage Access Framework
exposes an arbitrary user-picked folder only as a `content://` URI +
`DocumentFile` — not a `java.io.File`, and there is **no supported,
version-stable way to turn an arbitrary SAF tree into a real file path**:

- On Android 11+ (scoped storage), most picked folders have no path at
  all reachable without private/hidden reflection APIs that Google
  doesn't support and that break across OS versions.
- A SAF folder can be backed by a cloud provider's own `DocumentsProvider`
  (Nextcloud, Syncthing-via-SAF, a cloud drive) with **no real file on
  the device at all** — every read/write is a network or provider call.
  Git needs random-access reads/writes and atomic renames during pack
  operations; that doesn't hold up over a `DocumentsProvider` that may not
  even be local.

So "just point git at whatever folder the user picks" isn't a reliable
foundation for something as read/write-heavy and atomicity-sensitive as a
git repository — it would work for some folders (plain local ones) and
silently misbehave for others (cloud-backed ones), which is worse than a
predictable single real location. That's why the real git repo lives in
the app's own real, always-local storage, and SAF is used only for the
simple, tolerant operation it's actually good at: copying whole files in
or out on demand (Export/Import).

## Files

```
mobile/plugin/
  android/
    build.gradle                 Gradle module definition (JGit, DocumentFile, coroutines deps)
    src/main/AndroidManifest.xml
    src/main/java/com/manuscript/gitfs/
      GitFsPlugin.kt              Capacitor plugin surface (fs primitives + git methods + SAF export/import)
      GitOps.kt                   JGit-backed clone/status/commit/pull/push/checkRemote
      SafMirror.kt                Plain recursive file copy in/out of a SAF-picked folder
  src/
    index.js                      registerPlugin('GitFs') — thin JS-side handle
    android-bridge.js              Full /api/* router (replaces mobile-sw.js on Android only)

mobile/scripts/
  patch-android-native.js         CI-time injector: wires capacitor-gitfs into the freshly
                                   generated android/ project (settings.gradle, root build.gradle
                                   Kotlin classpath, app/build.gradle dependency)
  sync-server-files.js            Now also bundles android-bridge.js -> www/android-bridge.bundle.js
                                   (unchanged: still bundles mobile-sw.js -> www/sw.js for every
                                   other platform)

AppCode/public/index.html         Runtime check: Capacitor+Android loads android-bridge.bundle.js
                                   instead of registering sw.js; also adds the Settings "Local
                                   folder" section (Android-only, hidden elsewhere)
AppCode/public/client.js          Wires up the Local Folder section's path display + Export/
                                   Import buttons (Android-only)
AppCode/server.js                 _progress.json upgraded to per-file scroll tracking (see below)
AppCode/mobile-sw.js              Same per-file progress upgrade, kept in sync for the old
                                   LightningFS path (still used on mobile-web/PWA installs)

.github/workflows/build-android-apk.yml
                                   New step: "Inject native GitFs plugin" runs
                                   patch-android-native.js right after cap add/sync android
```

## Why the plugin has to be injected in CI rather than just committed

There is no `mobile/android/` directory checked into this repo at all —
CI generates it fresh every run via `npx cap add android` (see the
workflow), since there's no Android Studio anywhere in this project's
workflow to maintain a hand-edited native project. A normal Capacitor
plugin would ship as an npm package that `cap sync` wires up
automatically, but `GitFs` is local, unpublished source — so
`patch-android-native.js` copies it into the generated project as its own
Gradle module and wires `settings.gradle`/`build.gradle` by hand, every
run, right after `cap add android` (or `cap sync android` on a rebuild).
It's idempotent — safe to run against an already-patched project.

Capacitor 7's `BridgeActivity` registers plugins via classpath annotation
scanning (`@CapacitorPlugin`), so once `capacitor-gitfs` is a Gradle
dependency of `app`, `GitFsPlugin` needs no manual registration call
anywhere — `MainActivity.java` (itself also generated fresh every run) is
never touched by this.

## Per-file reading progress

`_progress.json` used to store a single `{ path, scrollTop, savedAt }`
record — only the *last-viewed* file's scroll position, overwritten every
time any file was opened. It's now `{ lastPath, files: { "<relPath>": {
scrollTop, savedAt } } }` — every file remembers its own position, and
`loadChapter()` looks it up and restores it every time that file is
opened (not just at app boot). `server.js`, `mobile-sw.js`, and
`android-bridge.js` all implement this the same way, including an
in-memory migration of the old single-record shape so a vault last
touched by an older build doesn't lose its one saved position. This file
is still excluded from git commits (`lib/git-Sync.js`'s existing
`_progress.json` filter), same as before — it's per-device telemetry, not
manuscript content.

## Testing notes / what wasn't (and couldn't be) verified here

This was built and exercised as far as possible without Android Studio or
a device:

- ✅ `npx cap add android` was actually run in a sandbox, and
  `patch-android-native.js` was run against the *real* generated output —
  confirmed it correctly patches `settings.gradle`, root `build.gradle`
  (adds the missing Kotlin plugin classpath — the stock template is pure
  Java), and `app/build.gradle`, and is idempotent on re-run.
- ✅ `sync-server-files.js`'s new bundling step was actually run — both
  `www/sw.js` and `www/android-bridge.bundle.js` build successfully and
  pass their contract checks.
- ❌ A full Gradle build (JGit/AndroidX dependency resolution, actual
  Kotlin compilation) could **not** be run in this sandbox — no network
  path to Maven Central/Google's Maven repo here. The Kotlin was written
  and reviewed carefully against real, current Capacitor 7 and JGit 6.10
  APIs (in particular, the Activity Result API — `startActivityForResult`
  + `@ActivityCallback(PluginCall, ActivityResult)` — rather than the
  legacy `handleOnActivityResult` override, which Capacitor 3+ no longer
  calls for plugins using `@ActivityCallback`), but CI's build step will
  be the first real compile. If it fails, the error will point at a
  specific file/line the way any Gradle build does — nothing here is
  hidden behind generated/opaque code.
- ❌ No physical device or emulator test of the actual clone/pull/push
  speed improvement, or of the SAF export/import flow's permission
  prompts. The speed claim (removing the CORS proxy hop) is an
  architectural fact, not a benchmark — expect it to help substantially,
  but "substantially" wasn't measured here.

## If the Gradle build fails in CI

Most likely causes, in order of likelihood:
1. A JGit/AndroidX version mismatch — check the exact error, bump the
   version in `mobile/plugin/android/build.gradle`.
2. `compileSdk`/`minSdk` too low for a JGit or AndroidX transitive
   dependency — check `mobile/android/variables.gradle` (generated fresh
   each run; currently `compileSdk 35`, `minSdk 23`).
3. `kotlin-gradle-plugin` version incompatibility with the AGP version
   Capacitor's template pins — check `KOTLIN_VERSION` in
   `patch-android-native.js` against whatever AGP version
   `mobile/android/build.gradle` specifies.