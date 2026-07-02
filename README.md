# Write

A markdown-based manuscript reader and margin-note editor. Keep your book as `.md` files in a git repository, read and annotate it from your laptop or your phone, and sync changes via git — no cloud service, no proprietary format.

Your writing lives in plain markdown files inside a folder called the **vault** (`book/`), version-controlled with git. The app renders your chapters, lets you click into any paragraph to edit it, and lets you drop margin notes (queries, TODOs, references) anywhere in the text — all stored as plain-text markers directly inside your `.md` files, so nothing is ever locked into a database you can't read yourself.

---

## Part 1 — For the user

### What this app does

- **Reads** your manuscript, organized into Front Matter / Chapters / Back Matter, based on folder structure.
- **Renders** markdown properly (headings, bold, italics, lists, blockquotes) instead of showing raw text.
- **Lets you edit** any paragraph in place by clicking it.
- **Lets you add margin notes** — a note is stored right in the text as `[mn: your note here]`, or typed as `[mn.todo: ...]` / `[mn.query: ...]` / `[mn.ref: ...]` for different note categories.
- **Remembers your place** — reopening the app returns you to the last chapter and scroll position you were at.
- **Syncs via git** — commits happen automatically as you edit; pushing and pulling to GitHub (or any git remote) is manual, on your command, from the Settings sheet.
- Works as:
  - A laptop app (a small local server, `server.js`, serving the same interface a browser or the desktop shell renders)
  - A phone app (the exact same reading/editing interface, but running fully offline inside an embedded browser — there is no phone-side server; more on this below)

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

### Using it on your laptop

1. Run `node server.js` from the `AppCode` folder (see that folder's own setup instructions for dependencies).
2. Open the served address in your browser.
3. Point Settings at your git repository the first time; after that, it's remembered.

### Using it on your phone (Android)

1. Install the APK (built automatically by GitHub Actions on every push — check the repo's Actions tab for the latest build artifact).
2. On first launch, open Settings and paste your repository URL and a **GitHub Personal Access Token** (see below for exactly which permissions it needs).
3. Tap **Clone**. This downloads your vault onto the phone, stored in the browser's local database (not a folder you can browse with a file manager — that's normal, see the developer section for why).
4. Read, edit, add notes as normal. Every edit is committed locally, automatically. Nothing leaves your phone until you tap **Push**.

**Token permissions needed:**
- **Classic PAT:** the `repo` scope.
- **Fine-grained PAT:** access to this specific repository, with **Contents: Read and write** permission.

Without write access, cloning and reading will work, but **Push will fail with a 401 error.**

**Known current limitation:** conflict resolution (if you edit the same file on two devices before syncing) isn't handled gracefully yet — if you hit a conflict, resolve it from the laptop app for now.

---

## Part 2 — For the developer (or an LLM picking this project back up)

### Why this project looks the way it does

This app began as a normal Node.js/Express server (`AppCode/server.js`) meant to run on a laptop, reading and writing real files on disk, and using `simple-git`/native git for sync. The **mobile pivot** need was: ship the same app as an Android APK, with **no server to run** — a phone can't host a persistent backend process the way a laptop can.

The solution adopted (in `AppCode/mobile-sw.js`) was to **reimplement the entire Express API as a Service Worker**, using two browser-native technologies in place of a real filesystem and a real git binary:

| Laptop concept | Mobile replacement | Why |
|---|---|---|
| Real filesystem (`fs.readFile`, etc.) | `LightningFS` — an in-browser virtual filesystem backed by IndexedDB | A Service Worker has no OS filesystem access; LightningFS emulates POSIX-like paths on top of the one storage a Service Worker *does* have (IndexedDB). |
| Native `git` CLI via `simple-git` | `isomorphic-git` | A pure-JS git implementation that can run in a browser and operate directly on a LightningFS instance instead of a real disk. |
| Express routes (`app.get('/api/...')`) | `fetch` event interception inside the Service Worker | The Service Worker intercepts every `/api/*` request the frontend makes and answers it locally — from the frontend's point of view, it's indistinguishable from talking to a real server. |

This means **`AppCode/mobile-sw.js` is a full backend**, not a thin shim — every route that exists in `server.js` has (or should have) a matching implementation here, operating against LightningFS instead of disk. Read both files side by side before changing either one.

### The two service workers — don't confuse them

There are **two different files that could be called "the service worker,"** and mixing them up has caused real bugs in this project's history:

- **`AppCode/sw.js`** — a caching/offline-queue proxy. It expects a *real* backend behind it and mostly just forwards `/api/*` requests to the network, queuing writes for retry when offline. This is meant for the **laptop web app**, layered on top of the real Express server for offline resilience — it is not a backend by itself.
- **`AppCode/mobile-sw.js`** — the actual LightningFS/isomorphic-git backend described above, meant to *be* the backend when there is no server. This is what ships inside the Android APK.

They register on the same scope with similar-looking cache names. **If the wrong one ever gets bundled into the mobile build, the app will appear to "clone successfully" but silently do nothing** — `sw.js`'s network-passthrough logic has no server to talk to on a phone, so writes vanish and reads come back empty. `mobile/scripts/sync-server-files.js` has a build-time guard that fails loudly if the wrong worker gets bundled (checks the built output contains `manuscript-fs` and `/api/git/clone`) — do not remove that check.

### Critical gotchas already discovered (don't re-debug these)

1. **`Buffer` is not defined in a Service Worker.** `isomorphic-git` and `LightningFS` both reference Node's `Buffer` global internally. esbuild's `platform: 'browser'` target does not polyfill this automatically. Fix already in place: `sync-server-files.js` injects the npm `buffer` package as a global via esbuild's `inject` option, plus `define: { global: 'self' }`. If you ever rebuild the bundler config from scratch, this must be re-added or every git operation throws "missing buffer dependency."

2. **`CapacitorHttp` does NOT bypass CORS for Service Worker fetches.** It only intercepts `fetch`/`XMLHttpRequest` calls made from JS running in the WebView page context. Anything `isomorphic-git` does from inside `mobile-sw.js` still hits real browser CORS. The current fix is routing all git network operations (clone/push/pull) through `https://cors.isomorphic-git.org` as a `corsProxy`. If this proxy ever goes down or rate-limits, git sync breaks — this is the single most fragile dependency in the project.

3. **File paths with spaces.** Filenames like `01-chapter one.md` arrive at `/api/chapter?path=...` URL-encoded (`chapter%20one.md`). `LightningFS` needs the literal decoded string. Every route reading a `path` query param must call `decodeURIComponent()` on it first — several early implementations missed this and it looked like "some files didn't clone" when actually they cloned fine but couldn't be read back.

4. **Auto-commit must never throw.** Every note/edit route wraps its `autoCommit()` call in `.catch()` and treats failure as non-fatal — a user should be able to add notes and edit paragraphs before a git repo even exists (or if commit fails for any reason), without the UI breaking. Never make editing hard-depend on git succeeding.

5. **Path prefixing for git operations.** `isomorphic-git`'s `dir` is always `GIT_ROOT` (`/MyWritings`), never `VAULT` (`/MyWritings/book`). Any file path used in `git.add`/`git.commit` must be prefixed with `book/` relative to `GIT_ROOT` — a vault-relative path like `chapters/x.md` must become `book/chapters/x.md` before being passed to git, or commits silently no-op.

6. **Token storage is not yet real secure storage.** `getStoredToken()`/`setStoredToken()` in `client.js` are written as a thin wrapper around `capacitor-secure-storage-plugin`, with a plaintext fallback (reading directly from the settings input field) for when the plugin isn't wired up. Confirm the plugin is actually linked (`npx cap sync android` must run after `npm install` in CI) before relying on it — until then, the token is effectively stored in plain memory only, not persisted encrypted at rest.

7. **Progress-save was scroll-only, not navigation- or lifecycle-aware.** The original implementation only wrote `/api/progress` from a debounced scroll listener. Switching chapters without scrolling, or closing the app immediately after opening a chapter, saved nothing — the app would always reopen at the first file. Fixed by also saving immediately on chapter switch and on `visibilitychange` → `hidden` (using `fetch(..., { keepalive: true })` so the request survives the page tearing down). If progress-loss bugs resurface, check this logic first before assuming it's a mobile/LightningFS-specific issue — the underlying bug was actually shared code and reproduced on the laptop too.

### Routes implemented in `mobile-sw.js` (mirrors `server.js`)

| Route | Status |
|---|---|
| `POST /api/git/clone` | ✅ implemented, verifies `book/` exists post-clone |
| `GET /api/git/status` | ✅ implemented (ahead/behind computed via `git.log` diff, not a native equivalent) |
| `POST /api/git/commit` | ✅ implemented |
| `POST /api/git/pull` | ✅ implemented, classifies conflict/network/generic errors |
| `POST /api/git/push` | ✅ implemented, commits outstanding changes first |
| `GET/POST /api/git/config` | ✅ implemented, persisted to `git-config.json` in LightningFS (token deliberately excluded) |
| `GET /api/manifest` | ✅ implemented, reads `_meta.md` YAML frontmatter or falls back to first-line heuristics |
| `GET /api/chapter` | ✅ implemented, full `parseMd()` port — not a stub |
| `GET/PUT /api/block` | ✅ implemented — powers click-to-edit |
| `POST/DELETE/PATCH /api/note` | ✅ implemented — add/remove/retype margin notes |
| `GET/POST /api/progress` | ✅ implemented |
| `GET /api/export/pdf` | ❌ intentionally 501s — Puppeteer/Typst can't run in-browser; tell the user to use the laptop app |
| `GET /api/browse`, `/api/open-vault` | ❌ intentionally omitted — native filesystem browsing is meaningless inside a Service Worker sandbox |

### Auto-commit vs. push — this is intentional, not a bug

Every note/edit action creates an **immediate local commit** the moment it succeeds — this is cheap (no network) and durable (survives app kill/crash without losing work). **Pushing to the remote is always a separate, manual, user-triggered action.** This mirrors normal git workflow (commit often, push deliberately) and avoids attempting a network call — which can fail for auth/connectivity reasons — on every keystroke-triggered save. Do not "fix" this into auto-push; it's correct as designed.

### The markdown/note parser (`parseMd`)

Ported verbatim from `AppCode/lib/parse.js` into `mobile-sw.js` (not reimplemented — it's pure JS with no Node-only APIs, so it bundles cleanly). It does three things in one pass:

1. Extracts `[mn...]` / `[mn.type: ...]` markers into a `notes` array, replacing them in-place with null-byte placeholders so surrounding text reflow doesn't shift character offsets.
2. Splits the document into blocks (paragraphs) separated by blank lines, tracking each block's starting character offset (`data-block`) — this is what the frontend's click-to-edit feature uses to know which byte range of the raw file to send back on save.
3. Renders headings/lists/blockquotes/code fences via `marked`, and hand-rolls inline formatting (`**bold**`, `*italic*`, `~~strike~~`) plus `data-off`/`data-seg` span wrapping for everything else, so individual text runs within a paragraph are independently addressable.

If you ever need to change note syntax or add a new note type, this is the one place to edit — the regex `MN_RE` and the `NOTE_TYPE_CLASS` map are the two things that define what's recognized.

### Build pipeline

```
AppCode/mobile-sw.js  ──esbuild bundle──▶  mobile/www/sw.js   (registered by the app)
AppCode/public/*.js,*.html,*.css  ──copy──▶  mobile/www/*
                                             │
                                    npx cap sync android
                                             │
                                    GitHub Actions builds the APK
```

`mobile/scripts/sync-server-files.js` does the esbuild bundling and the copy step, and includes a hard build-time check that fails the pipeline if the wrong service worker (`sw.js` instead of `mobile-sw.js`) ends up in the output — see gotcha #2 above for why this matters.

### App identity

- **App display name:** "Write" (`capacitor.config.json` → `appName`, and Android `res/values/strings.xml` → `app_name`).
- **Android application ID:** `com.yourname.manuscript` — **intentionally left unchanged** during the rename from "Manuscript" to "Write." Changing the `appId` makes Android treat future builds as a completely different app and would wipe any existing install's local data (including any vault a user has already cloned on their phone). Only change this deliberately, with users warned in advance.
- **Internal identifiers deliberately left alone:** LightningFS database name (`manuscript-fs`), Service Worker cache names, `BroadcastChannel` name, git commit author fallback string (`'Manuscript'`), and npm package `name` fields. None of these are user-visible, and renaming the LightningFS DB name specifically would orphan any already-cloned vault on an existing install (it would look for a fresh, empty database under a different name).

### If you're an LLM picking this project back up

Read, in this order:
1. This README.
2. `AppCode/server.js` and `AppCode/lib/git-sync.js` — the laptop reference implementation; the mobile port must stay behaviorally equivalent to this.
3. `AppCode/mobile-sw.js` — the actual mobile backend.
4. `AppCode/public/client.js` — the shared frontend, works against either backend.

Before adding any new route or feature: check whether it already exists in `server.js` first. If it does, port it into `mobile-sw.js` following the same LightningFS/isomorphic-git patterns already established there rather than inventing a new approach. If it's genuinely laptop-only (filesystem browsing, PDF export via Puppeteer/Typst), don't port it — stub it with a clear error message instead, as done for `/api/export/pdf`.

Before shipping any change to `mobile-sw.js` or the build pipeline, verify against the gotchas list above — most of the bugs hit during this project's development were re-discoveries of the same handful of root causes (Buffer polyfill, CORS-in-a-Service-Worker, URL-encoded paths, git path prefixing).