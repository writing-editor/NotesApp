# ManuScript

A markdown-based manuscript reader and margin-note editor. Keep your book as `.md` files in a git repository, read and annotate it from your laptop, your desktop, or your phone, and sync changes via git — no cloud service, no proprietary format.

Your writing lives in plain markdown files inside a folder called the **vault** (`book/`), version-controlled with git. The app renders your chapters, lets you click into any paragraph to edit it, and lets you drop margin notes (queries, TODOs, references) anywhere in the text — all stored as plain-text markers directly inside your `.md` files, so nothing is ever locked into a database you can't read yourself.

---

## Part 1 — For the user

### What this app does

- **Reads** your manuscript, organized into Front Matter / Chapters / Back Matter, based on folder structure.
- **Renders** markdown properly (headings, bold, italics, lists, blockquotes) instead of showing raw text.
- **Lets you edit** any paragraph in place by clicking it.
- **Lets you add margin notes** — a note is stored right in the text as `[mn: your note here]`, or typed as `[mn.todo: ...]` / `[mn.query: ...]` / `[mn.ref: ...]` for different note categories.
- **Remembers your place** — reopening the app returns you to the last chapter and scroll position you were at.
- **Syncs via git** — edits are staged as you go; everything pending is bundled into a single commit the moment you tap **Push**. Pulling from GitHub (or any git remote) is likewise manual, on your command, from the Settings sheet.
- Works as:
  - A **laptop app** — a small local server, `server.js`, opened in your browser.
  - A **desktop app (Linux/Ubuntu)** — the same server, wrapped in a native window with Electron. No terminal required.
  - A **phone app (Android)** — the same reading/editing interface, running fully offline inside an embedded browser; there is no phone-side server (more on this below).

### Setting up your vault

Your git repository should look like this:

```
your-repo/
└── book/
    ├── _meta.md          ← title, author, description (optional but recommended)
    ├── front/
    │   └── 01-introduction.md
    ├── chapters/
    │   ├── 01-chapter one.md
    │   └── 02-chapter two.md
    └── back/
        └── 01-acknowledgements.md
```

- Filenames are numbered so they sort in reading order; the number prefix and dashes are stripped for display (`01-chapter one.md` → "chapter one" in the sidebar).
- `_meta.md` can contain a YAML frontmatter block:
  ```
  ---
  title: My Book
  author: Jane Doe
  description: A story about...
  ---
  ```
- Margin notes look like `[mn: this needs a citation]` right inline in your prose — the app renders them as small superscript markers and hides the bracket syntax from the reading view.

### Using it on your laptop (browser)

1. Run `node server.js` from the `AppCode` folder (see that folder's own setup instructions for dependencies).
2. Open the served address in your browser.
3. Point Settings at your git repository the first time; after that, it's remembered.

### Using it on the desktop (Ubuntu / Linux, Electron)

1. Download the latest `.AppImage` or `.deb` from the repo's Actions tab (built automatically by GitHub Actions on every push) or from Releases if published there.
2. **AppImage:** `chmod +x ManuScript-*.AppImage && ./ManuScript-*.AppImage`. **deb:** `sudo dpkg -i manuscript-desktop_*.deb` and launch it from your applications menu.
3. On first launch you'll see the same vault picker as the browser version — point it at your git repository once, and it's remembered.

**Updating:** re-run the same install command with a newer build — `sudo dpkg -i` over an existing `.deb` install updates in place (no uninstall needed); for `.AppImage`, just replace the old file with the new one. Each CI build now stamps a distinct version (`1.0.<CI run number>`) so it's easy to tell builds apart.

This build is a thin native wrapper: it starts the exact same `AppCode/server.js` in the background and opens a window pointed at it, so behavior matches the browser version exactly.

### Using it on your phone (Android)

1. Install the APK (built automatically by GitHub Actions on every push — check the repo's Actions tab for the latest build artifact).
2. On first launch, open Settings and paste your repository URL and a **GitHub Personal Access Token** (see below for exactly which permissions it needs).
3. Tap **Clone**. This downloads your vault onto the phone, stored in the browser's local database (not a folder you can browse with a file manager — that's normal, see the developer section for why).
4. Read, edit, add notes as normal. Each edit is staged locally as you make it; nothing is committed until you tap **Push**, at which point every pending change is bundled into a single commit. Nothing leaves your phone until you tap **Push**.

**Updating:** install a newer APK over the old one directly — Android allows this without uninstalling first as long as CI is signing with a persistent release keystore (see the developer section); if the signing secrets haven't been set up yet, Android will reject the update install and you'll need to uninstall the old one first.

**Token permissions needed (all platforms — laptop, desktop, and phone):**

`isomorphic-git` talks to GitHub over HTTPS directly and never uses your system git/SSH credentials, no matter how the local `git` CLI is configured on that machine — so a Personal Access Token is required in Settings on every platform, including the laptop and Electron desktop app, not just the phone.

- **Classic PAT:** the `repo` scope.
- **Fine-grained PAT:** access to this specific repository, with **Contents: Read and write** permission.

Without write access, cloning and reading will work, but **Push will fail with a 401 error.**

On the laptop and desktop app, the token is stored in local storage, unencrypted. On the phone, it's stored in the device's secure storage instead.

**Known current limitation:** conflict resolution (if you edit the same file on two devices before syncing) isn't handled gracefully yet — if you hit a conflict, resolve it from the laptop or desktop app for now.

---

## Part 2 — For the developer (or an LLM picking this project back up)

### Layout of this repo

```
AppCode/     — the actual app: Express server, frontend, CodeMirror editor, markdown/note parser
electron/    — thin desktop wrapper around AppCode/server.js (Linux build via electron-builder)
mobile/      — Capacitor Android shell; ports AppCode's API to a Service Worker (see below)
book/        — an example/your own vault (front/chapters/back structure described above)
```

### The frontend editor (CodeMirror 6)

The reading/editing surface is a single always-on CodeMirror 6 instance, built from `AppCode/editor-src/*.js` into `public/mn-editor.bundle.js` (see `editor-src/build.js`) and mounted once per chapter by `mountLiveEditor()` in `public/client.js`:

- `editor-src/main.js` — creates the CM6 `EditorView` and wires its callbacks (`onChange`, `onNotesChanged`, `onLayoutChanged`, selection events) into `client.js`.
- `editor-src/livePreview.js` — Obsidian-style live preview: hides markdown syntax marks (`#`, `**`, etc.) except on the line the cursor is on.
- `editor-src/noteWidgets.js` — renders `[mn: ...]` / `[mn.type: ...]` markers as `span.mn-anchor > sup.mn-marker` markup.
- `editor-src/marginSync.js` — tells `client.js` when the note list/layout needs recomputing.

Whole-file text goes through `/api/raw` (GET on chapter load, debounced PUT on every change).

**CM6 gotcha worth knowing:** CodeMirror 6 only renders DOM nodes for lines inside (or very near) the current scroll viewport. Looking up a note's position with `document.querySelector('.mn-anchor[data-note-id=...]')` fails for any note below/above what CM6 has currently drawn. Fix: `editor-src/main.js` exposes `getNoteMetrics(charPos)`, which reads CM6's internal height map via `view.lineBlockAt()` — this works for any position whether or not it's currently drawn — and `positionChips()` in `client.js` uses that for vertical positioning instead of a DOM lookup.

### Three shells, one backend contract

`AppCode/server.js` is the reference backend — a normal Express server reading/writing real files on disk and using `isomorphic-git`/native git for sync. Every other shell either runs that same file unmodified, or reimplements its API contract:

| Shell | How it gets a backend |
|---|---|
| **Laptop (browser)** | Runs `AppCode/server.js` directly with `node server.js`. |
| **Desktop (Electron, Linux)** | `electron/main.js` `require()`s the same `AppCode/server.js` in-process on a free local port, then opens a `BrowserWindow` at it. No API changes, no separate implementation — see below. |
| **Phone (Android/Capacitor)** | A phone can't host a persistent backend process, so `AppCode/mobile-sw.js` reimplements the entire Express API as a Service Worker running against an in-browser virtual filesystem — see below. |

#### Desktop (Electron)

`electron/main.js` does three things: picks a free local port, `require()`s `AppCode/server.js` in-process with that port set via `process.env.PORT` (no vault path passed, so it boots to the same vault-picker UI the browser flow already has via `/api/browse` + `/api/open-vault`), then polls the port and opens a `BrowserWindow` once it answers. `electron/package.json` uses `electron-builder` to package `AppCode` (including its `node_modules`, built via CI) as an `extraResource` and produce an `AppImage` and a `.deb`. Because this shell runs the real `server.js` with real filesystem and git access, it needs no LightningFS/Service Worker port — it's the least novel of the three shells.

#### Phone (Android/Capacitor)

The mobile pivot's requirement was: ship an Android APK with no server to run. The solution, in `AppCode/mobile-sw.js`, reimplements the Express API as a Service Worker using two browser-native replacements:

| Laptop concept | Mobile replacement | Why |
|---|---|---|
| Real filesystem (`fs.readFile`, etc.) | `LightningFS` — an in-browser virtual filesystem backed by IndexedDB | A Service Worker has no OS filesystem access. |
| Native `git` CLI | `isomorphic-git` | A pure-JS git implementation that can operate directly on a LightningFS instance. |
| Express routes | `fetch` event interception inside the Service Worker | Indistinguishable from a real server, from the frontend's point of view. |

`AppCode/mobile-sw.js` is a full backend, not a thin shim — every route in `server.js` has (or should have) a matching implementation here. Read both files side by side before changing either one.

**Two different files could be called "the service worker" — don't confuse them:**
- `AppCode/sw.js` — a caching/offline-queue proxy for the **laptop web app**. It expects a real backend behind it and forwards `/api/*` to the network; it is not a backend by itself.
- `AppCode/mobile-sw.js` — the actual LightningFS/isomorphic-git backend that ships inside the Android APK.

They register on the same scope with similar-looking cache names. If the wrong one gets bundled into the mobile build, the app appears to "clone successfully" but silently does nothing. `mobile/scripts/sync-server-files.js` has a build-time check that fails loudly if this happens (verifies the built output contains `manuscript-fs` and `/api/git/clone`) — do not remove that check.

### Critical gotchas already discovered (don't re-debug these)

1. **`Buffer` is not defined in a Service Worker.** `isomorphic-git` and `LightningFS` both reference Node's `Buffer` global internally; esbuild's `platform: 'browser'` target does not polyfill this. Fix in `sync-server-files.js`: inject the npm `buffer` package as a global via esbuild's `inject` option, plus `define: { global: 'self' }`.

2. **`CapacitorHttp` does NOT bypass CORS for Service Worker fetches.** It only intercepts `fetch`/`XMLHttpRequest` from JS in the WebView page context — `isomorphic-git` calls from inside `mobile-sw.js` still hit real browser CORS. Current fix: route all git network operations through `https://cors.isomorphic-git.org` as a `corsProxy`. This is the single most fragile dependency in the mobile build.

3. **File paths with spaces.** Filenames like `01-chapter one.md` arrive URL-encoded (`chapter%20one.md`); `LightningFS` needs the decoded string. Every route reading a `path` query param must call `decodeURIComponent()` on it first.

4. **Git operations must never throw into a note/edit route.** Saving a paragraph or note only ever stages the change (`git add`); it never commits. If a git call in that path fails (e.g. no repo configured yet), it's caught and treated as non-fatal — editing must never hard-depend on git succeeding.

5. **Path prefixing for git operations.** `isomorphic-git`'s `dir` is always `GIT_ROOT`, never `VAULT` (`GIT_ROOT/book`). A vault-relative path like `chapters/x.md` must become `book/chapters/x.md` before being passed to git, or commits silently no-op.

6. **Token storage is not yet real secure storage.** `getStoredToken()`/`setStoredToken()` in `client.js` wrap `capacitor-secure-storage-plugin`, with a plaintext fallback when the plugin isn't wired up. Confirm `npx cap sync android` runs after `npm install` in CI before relying on it.

7. **Progress-save is chapter-switch- and lifecycle-aware, not just scroll-based.** `/api/progress` saves on chapter switch and on `visibilitychange` → `hidden` (via `fetch(..., { keepalive: true })`), not only from a debounced scroll listener — otherwise switching chapters without scrolling, or closing the app right after opening one, would save nothing.

### Routes implemented in `mobile-sw.js` (mirrors `server.js`)

| Route | Status |
|---|---|
| `POST /api/git/clone` | ✅ implemented, verifies `book/` exists post-clone |
| `GET /api/git/status` | ✅ implemented (ahead/behind via `git.log` diff) |
| `POST /api/git/commit` | ✅ implemented — bundles all pending staged changes into one commit |
| `POST /api/git/pull` | ✅ implemented, classifies conflict/network/generic errors |
| `POST /api/git/push` | ✅ implemented, commits outstanding changes first |
| `GET/POST /api/git/config` | ✅ implemented, persisted to `git-config.json` in LightningFS (token deliberately excluded) |
| `GET /api/manifest` | ✅ implemented, reads `_meta.md` YAML frontmatter or falls back to first-line heuristics |
| `GET /api/chapter` | ✅ implemented, full `parseMd()` port |
| `POST/DELETE/PATCH /api/note` | ✅ implemented — add/remove/retype margin notes |
| `GET/POST /api/progress` | ✅ implemented |
| `GET /api/export/pdf` | ❌ intentionally 501s — Puppeteer/Typst can't run in-browser; use the laptop or desktop app |
| `GET /api/browse`, `/api/open-vault` | ❌ intentionally omitted — native filesystem browsing is meaningless inside a Service Worker sandbox |

### Staging vs. committing vs. push — this is intentional, not a bug

Every note/edit action only stages the change (`git add`) the moment it succeeds — cheap and durable, and it means a crash or a killed app loses nothing, since the working-tree change is already on disk (or in LightningFS). Nothing is committed at that point.

A commit is only created in two places, both of which sweep up *everything* staged since the last commit into one commit, not one commit per file or per edit:
- tapping **Commit** in Settings (`POST /api/git/commit` → `commitAll()`), if you want to checkpoint locally without pushing yet;
- tapping **Push**, which calls `commitAll()` internally first (see `gitSync.push`) so nothing pending is left behind, then pushes.

This is why `git log` on this repo should normally show one commit per push/manual-commit action, not one per keystroke or per note. `commitAll()` also deliberately excludes `_progress.json` (per-device scroll position, rewritten constantly) so it never forces a noise commit on its own.

Pushing to the remote is always a separate, manual, user-triggered action. Do not "fix" this into auto-push.

**Dead code note:** `autoCommit()`/`commitFile()` in both `server.js` and `mobile-sw.js` (and `gitSync.commitFile` in `lib/git-Sync.js`) implement a per-file immediate-commit path from an earlier design. They are no longer called by any route in either file. They're left in place for now rather than deleted outright — if you're touching git-sync code, don't assume they run.

### The markdown/note parser (`parseMd`)

Lives in `AppCode/lib/parse.js` (ported verbatim into `mobile-sw.js`, since it's pure JS with no Node-only APIs). It does three things in one pass:

1. Extracts `[mn...]` / `[mn.type: ...]` markers into a `notes` array, replacing them in-place with null-byte placeholders so surrounding text reflow doesn't shift character offsets.
2. Splits the document into blocks (paragraphs) separated by blank lines, tracking each block's starting character offset.
3. Renders headings/lists/blockquotes/code fences via `marked`, and hand-rolls inline formatting (`**bold**`, `*italic*`, `~~strike~~`) plus span wrapping for individually-addressable text runs.

If you ever need to change note syntax or add a new note type, this is the one place to edit — the regex `MN_RE` and the `NOTE_TYPE_CLASS` map define what's recognized.

### Build pipelines

**Desktop (Electron):**
```
AppCode/  ──npm install, npm run build:editor──▶  bundled AppCode (incl. node_modules)
                                                    │
                                          electron-builder extraResource
                                                    │
                                       AppImage + .deb (GitHub Actions)
```

**Mobile (Capacitor):**
```
AppCode/mobile-sw.js  ──esbuild bundle──▶  mobile/www/sw.js   (registered by the app)
AppCode/public/*.js,*.html,*.css  ──copy──▶  mobile/www/*
                                             │
                                    npx cap sync android
                                             │
                                    GitHub Actions builds the APK
```

`mobile/scripts/sync-server-files.js` does the mobile esbuild bundling/copy step and includes the build-time guard mentioned above — do not remove it.

### Updating an installed build without uninstalling first

Both platforms now stamp a distinct, always-increasing version on every CI build (`1.0.<GitHub Actions run number>`), instead of a hardcoded version that never changed:

- **Linux (`.deb`/`AppImage`):** `sudo dpkg -i` a new `.deb` over an existing install already updates in place — this always worked, the version bump just makes builds distinguishable. `.AppImage` has no install step at all; "updating" means replacing the file.
- **Android (APK):** requires two things to update-install without uninstalling — a higher `versionCode` (now set from the CI run number in `build-android-apk.yml`) AND the same signing key across builds. The signing key requires one-time setup: generate a keystore, base64-encode it, and add it plus its passwords as repo secrets (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` — see the comment above the "Write release keystore" step in that workflow for exact commands). Until those secrets exist, the workflow silently falls back to Capacitor's default (non-persistent) debug signing, and installing a new build will require uninstalling the old one first, same as before.

### App identity

- **App display name:** "ManuScript" — `mobile/capacitor.config.json` → `appName`, Android `res/values/strings.xml` → `app_name`, and `electron/package.json` → `build.productName`.

### If you're an LLM picking this project back up

Read, in this order:
1. This README.
2. `AppCode/server.js` and `AppCode/lib/git-Sync.js` — the reference implementation; both the Electron and mobile shells must stay behaviorally equivalent to this.
3. `electron/main.js` — the desktop shell, if you're touching desktop packaging.
4. `AppCode/mobile-sw.js` — the mobile backend, if you're touching mobile.
5. `AppCode/public/client.js` — the shared frontend, works against any of the three backends.
6. `AppCode/editor-src/*.js` — the CodeMirror 6 editor `client.js` mounts; read this before changing anything related to editing, note markers, or margin-chip layout.

Before adding any new route or feature: check whether it already exists in `server.js` first. The Electron shell needs no porting (it runs `server.js` directly) — only the mobile Service Worker needs a matching port, following the same LightningFS/isomorphic-git patterns already established there. If a feature is genuinely laptop/desktop-only (filesystem browsing, PDF export via Puppeteer/Typst), don't port it to mobile — stub it with a clear error message instead, as done for `/api/export/pdf`.

Before shipping any change to `mobile-sw.js` or its build pipeline, check the gotchas list above first — most bugs hit during this project's history were re-discoveries of the same handful of root causes (Buffer polyfill, CORS-in-a-Service-Worker, URL-encoded paths, git path prefixing).

---

## Future ideas (not committed to, not scheduled — maybe someday)

### Real-folder access to the vault on mobile

Right now, on mobile, the vault only exists inside LightningFS — a virtual filesystem backed by IndexedDB (see "Phone (Android/Capacitor)" above). There is no real folder a file manager, Obsidian, or a USB cable can see. If the network or GitHub is down, there's currently no way to get the vault off the phone except through git itself.

The idea discussed: let the phone also mirror the vault to a real folder on-device, using `@capacitor/filesystem` and Android's Storage Access Framework, so a file manager (or another app like Obsidian) can read/write it directly — giving a manual, git-independent way to sync between devices (e.g. copy the folder over USB, or through a synced folder app) when network or git isn't available.

Two ways this could go, discussed and deliberately **not** chosen yet because of the complexity tradeoff:

- **Replace LightningFS with a real-filesystem adapter** so isomorphic-git operates directly on the SAF-exposed folder — one source of truth, no double-copy, but touches the single most fragile part of the mobile build (per the CORS/Buffer gotchas above) and SAF's `content://` URIs don't map cleanly onto the plain-path `fs` interface isomorphic-git expects. Higher risk.
- **Keep LightningFS as-is, add a manual export/import mirror step** — a "sync to folder" / "sync from folder" action that just copies files, independent of git entirely. Lower risk, but on its own it has no way to know if the folder version and the LightningFS version have both changed since the last sync.

The natural next question — should the app detect edits made directly in the mirrored folder (e.g. from Obsidian) rather than requiring a manual sync tap — was discussed and deliberately deferred: doing it safely means either (a) staying manual and accepting that editing both sides between syncs can silently overwrite one, or (b) adding real conflict detection, which quickly requires the same kind of conflict-resolution UI this app already punts on for git conflicts ("resolve on laptop"). Decided this is more complexity than it's worth for now — a plain manual mirror, no auto-detection, no merge logic, is the version worth building if this ever gets picked up.



Flagged during a full pass through the codebase, September 2026-era iteration. Left in place for now; listed here so nobody re-discovers these from scratch or assumes they're load-bearing.

**Confirmed dead — zero live callers:**
- `AppCode/lib/pdf.js` (whole file) — Puppeteer-based PDF export, superseded by `AppCode/lib/typst.js`. Its import in `server.js` is already commented out (`server.js:11`).
- `puppeteer` dependency in `AppCode/package.json` — only consumer was `lib/pdf.js`. CI already has to special-case skip its Chromium download (`PUPPETEER_SKIP_DOWNLOAD` in `build-electron-linux.yml`).
- `parseMdPrint()` in `AppCode/lib/parse.js` — only ever called from the dead `lib/pdf.js`.
- `autoCommit()` / `commitFile()` in both `AppCode/server.js` and `AppCode/mobile-sw.js` — leftover from the pre-batch-commit design (see "Staging vs. committing vs. push" above). No route in either file calls them.
- `commitFile()` in `AppCode/lib/git-Sync.js` — exported, but its only caller was the dead `autoCommit()` in `server.js`.
- The commented-out `//const { generatePdf } = require('./lib/pdf');` on `server.js:11`.

**Fixed since first flagged:**
- ~~The "Install embedded Node.js dependencies" step in `build-android-apk.yml`~~ — removed. It `cd`'d into `mobile/www/nodejs`, a directory `sync-server-files.js` never creates under the current Service Worker/LightningFS architecture; leftover from an abandoned earlier design. Gone now.

**Broken, not just redundant — likely an actual CI failure:**
(none currently known — see "Fixed since first flagged" above for the one that was here)

**Technically reachable but effectively unused — defensive fallback, safe to leave:**
- The count-based fallback branch inside `deleteNote()` in both `server.js` and `mobile-sw.js` (used only when `charPos` is omitted from a delete request). The only frontend caller, `client.js`, always sends `charPos`, so this path only fires if a request is built by hand or by a future caller that skips it.

**Cosmetic:**
- `AppCode/package.json`'s `"description"` field still reads "Margin-note reading and annotation server for Obsidian manuscripts" — stale branding from before this became its own app, ManuScript, rather than an Obsidian companion tool.