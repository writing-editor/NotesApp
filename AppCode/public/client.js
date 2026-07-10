// ── State ────────────────────────────────────────────────────────────────────
let currentPath      = null;
let currentNotes     = [];
let pendingPos       = null;
let activeChip       = null;
let activeMarker     = null;
let selectedNoteType = '';
let _progressTimer   = null;
let _lastRenderedRaw = ''; // used to skip WS reloads that match what we already rendered
let cachedTOCHeight  = 0;
let tocTicking       = false;
let tocRebuildTimer  = null; // debounces live TOC rebuilds while typing (see scheduleTOCRebuild)

// ── Offline / Service Worker integration ─────────────────────────────────────
// Shows a subtle banner when offline and triggers write-queue replay on reconnect.

function showOfflineBanner(show) {
  let banner = document.getElementById('offline-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'offline-banner';
    banner.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:9999',
      'background:var(--ink)', 'color:var(--paper)',
      'font-family:var(--font-ui)', 'font-size:0.58rem',
      'letter-spacing:0.1em', 'text-transform:uppercase',
      'text-align:center', 'padding:0.45rem 1rem',
      'transform:translateY(-100%)', 'transition:transform 0.25s ease',
      'pointer-events:none',
    ].join(';');
    banner.textContent = 'Offline — edits will sync when connection restores';
    document.body.appendChild(banner);
  }
  // rAF so the element is in DOM before the transition fires
  requestAnimationFrame(() => {
    banner.style.transform = show ? 'translateY(0)' : 'translateY(-100%)';
  });
}

window.addEventListener('online', () => {
  showOfflineBanner(false);
  // Ask the SW to replay any queued writes
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'REPLAY_QUEUE' });
  }
});
window.addEventListener('offline', () => showOfflineBanner(true));

// Listen for SW telling us a replay completed — silently reload the chapter
// so any queued edits are reflected in the view
if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'QUEUE_REPLAYED' && currentPath) {
      silentRefresh();
    }
  });
}

// Show banner immediately if we start offline
if (!navigator.onLine) showOfflineBanner(true);

// ── WebSocket — live reload ──────────────────────────────────────────────────
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(wsProto + '://' + location.host);
ws.onmessage = async e => {
  const msg = JSON.parse(e.data);
  if ((msg.type === 'file-changed' || msg.type === 'file-added') && currentPath) {
    // Ask the server for the current vault root, then compute a relative path.
    // This avoids the hardcoded '/book/' split that breaks on any other folder name.
    try {
      const { vault } = await fetch('/api/vault').then(r => r.json());
      if (!vault) return;
      // Normalise both to forward slashes for comparison
      const normVault   = vault.replace(/\\/g, '/').replace(/\/?$/, '/');
      const normChanged = msg.path.replace(/\\/g, '/');
      if (!normChanged.startsWith(normVault)) return;
      const relChanged = normChanged.slice(normVault.length);
      if (currentPath.replace(/\\/g, '/') === relChanged) {
        silentRefresh();
      }
    } catch {}
  }
};

// ── Manifest & navigation ────────────────────────────────────────────────────
// Rebuilds the sidebar from the current manifest, and returns the flat list
// of valid paths plus the fetched data — but does NOT navigate anywhere.
// Factored out of loadManifest() below so callers that just need the sidebar
// refreshed (e.g. after a git pull, mid-session) don't inherit
// loadManifest()'s boot-time "jump to saved progress or the first chapter"
// behavior, which would yank the person away from whatever they're currently
// reading/editing.
async function renderManifestSidebar(data) {
  document.getElementById('book-title').textContent = data.title;
  document.title = data.title;

  const authorEl = document.getElementById('book-author');
  if (authorEl && data.author) authorEl.textContent = data.author;

  const nav = document.getElementById('sidebar-nav');
  nav.innerHTML = '';

  // Build a lookup so every section (front/chapters/back) always shows,
  // even if it currently has zero files — otherwise there'd be no way to
  // add the very first document to an empty section from the sidebar.
  const sectionDefs = [
    { key: 'front',    label: 'Front Matter' },
    { key: 'chapters', label: 'Chapters' },
    { key: 'back',     label: 'Back Matter' },
  ];
  const sectionsByLabel = {};
  data.sections.forEach(s => { sectionsByLabel[s.label] = s; });

  sectionDefs.forEach(def => {
    const section = sectionsByLabel[def.label] || { label: def.label, files: [] };

    const headRow = document.createElement('div');
    headRow.className = 'nav-section-head';
    const label = document.createElement('div');
    label.className = 'nav-section-label';
    label.textContent = section.label;
    const addBtn = document.createElement('button');
    addBtn.className = 'nav-section-add';
    addBtn.title = `New document in ${section.label}`;
    addBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
    addBtn.addEventListener('click', () => openNewDocPrompt(def.key, def.label));
    headRow.appendChild(label);
    headRow.appendChild(addBtn);
    nav.appendChild(headRow);

    section.files.forEach(file => {
      const item = document.createElement('div');
      item.className = 'nav-item';
      item.textContent = file.label;
      item.dataset.path = file.path;
      item.addEventListener('click', () => {
        loadChapter(file.path);
        closeSidebar();
      });
      nav.appendChild(item);
    });
  });

  return data.sections.flatMap(s => s.files.map(f => f.path));
}

// Re-fetches the manifest and rebuilds the sidebar in place, without
// navigating away from whatever chapter is currently open. For use after an
// action that can change which files exist (e.g. a git pull) but where the
// person's current reading/editing position should be left alone — unlike
// loadManifest(), which is boot-time-oriented and always jumps to the saved
// progress or the first chapter.
async function refreshManifestSidebar() {
  try {
    const res = await fetch('/api/manifest');
    if (!res.ok) return;
    const data = await res.json();
    const allPaths = await renderManifestSidebar(data);
    // If the chapter that's currently open no longer exists post-pull (e.g.
    // it was renamed/deleted upstream), fall back to the same "no valid
    // path" empty state loadManifest() shows, rather than leaving a dead
    // editor open on a file that's gone.
    if (currentPath && !allPaths.includes(currentPath) && allPaths.length) {
      loadChapter(allPaths[0]);
    } else if (!allPaths.length) {
      document.getElementById('page-wrap').innerHTML =
        `<div class="state-msg">No markdown files found in vault.<br><small>Add .md files to front/, chapters/, or back/ inside your book folder.</small></div>`;
    }
  } catch {}
}

async function loadManifest(isRetry = false) {
  let data;
  try {
    const res = await fetch('/api/manifest');
    if (!res.ok) {
      // If server returns 400, it means no vault is set
      if (res.status === 400) throw new Error('NO_VAULT');
      throw new Error('HTTP ' + res.status);
    }
    try {
      data = await res.json();
    } catch {
      // Not valid JSON — on mobile this happens when the fetch raced the
      // Service Worker's own install/activate on a cold start (the request
      // falls through to a plain HTML response before the SW is
      // controlling the page, instead of being routed to the mobile
      // backend). That's transient, so retry shortly before giving up.
      if (!isRetry) { setTimeout(() => loadManifest(true), 400); return; }
      throw new Error('NO_VAULT');
    }
  } catch (e) {
    if (e.message === 'NO_VAULT') {
      const onNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
      document.getElementById('page-wrap').innerHTML = onNative
        ? `<div class="state-msg">No manuscript loaded yet.<br><small>Open <b>Settings</b> and clone a repository to start reading and editing.</small></div>`
        : `<div class="state-msg">No vault selected.<br><small>Click the <b>Open Vault</b> button in the sidebar to set your book folder.</small></div>`;
    } else {
      document.getElementById('page-wrap').innerHTML =
        `<div class="state-msg" style="color:#c0392b;">Could not load manifest: ${e.message}</div>`;
    }
    return;
  }

  const allPaths = await renderManifestSidebar(data);

  if (allPaths.length === 0) {
    document.getElementById('page-wrap').innerHTML =
      `<div class="state-msg">No markdown files found in vault.<br><small>Add .md files to front/, chapters/, or back/ inside your book folder.</small></div>`;
    return;
  }

  // Restore last reading position — only if the saved path is still valid
  try {
    const prog = await fetch('/api/progress').then(r => r.json());
    if (prog.path) {
      // Normalise separators before comparing
      const savedPath = prog.path;
      if (allPaths.includes(savedPath)) {
        await loadChapter(savedPath);
        if (prog.scrollTop) {
          setTimeout(() => {
            const main = document.getElementById('main');
            if (main) main.scrollTop = prog.scrollTop;
          }, 120);
        }
        return;
      }
      // Saved path no longer valid — clear it so we don't hit this next time
      await fetch('/api/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: allPaths[0] || '', scrollTop: 0 }),
      }).catch(() => {});
    }
  } catch {}

  const first = data.sections[0]?.files[0];
  if (first) loadChapter(first.path);
}

// ── Chapter loading ──────────────────────────────────────────────────────────
async function loadChapter(relPath, updateNav = true) {
  currentPath = relPath;

  if (updateNav) {
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.path === relPath);
    });
    const label = document.querySelector(`.nav-item[data-path="${relPath}"]`)?.textContent || '';
    document.getElementById('topbar-chapter').textContent = label;
  }

  // Stage 5 (AI Agent scope refinement): lets the Agent settings panel's
  // "Current chapter" scope label track what's actually open, without
  // ai-src/ needing to know anything about nav markup or currentPath —
  // it just listens for this event. Fired unconditionally (not only when
  // updateNav is true) since the scope is "whatever chapter is loaded",
  // independent of whether the sidebar nav highlight needed updating.
  window.dispatchEvent(new CustomEvent('mn:chapter-changed', {
    detail: { path: relPath, label: document.getElementById('topbar-chapter')?.textContent || relPath },
  }));

  // Persist immediately on navigation — previously progress was only ever
  // saved from the scroll listener, so switching chapters without scrolling
  // (or closing the app right after opening a chapter) never recorded the
  // new path at all. scrollTop is 0 here since we haven't rendered yet;
  // the scroll listener will update it once the reader actually scrolls.
  fetch('/api/progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: relPath, scrollTop: 0 }),
  }).catch(() => {});

  const wrap = document.getElementById('page-wrap');
  wrap.innerHTML = '<div class="state-msg">Loading…</div>';

  await flushPendingSave();

  try {
    const res = await fetch('/api/raw?path=' + encodeURIComponent(relPath));
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      wrap.innerHTML = `<div class="state-msg" style="color:#c0392b;">Error loading chapter: ${err.error || res.status}<br><small>${relPath}</small></div>`;
      return;
    }
    const data = await res.json(); // { raw, words, chars }
    _lastRenderedRaw = data.raw;
    renderChapter(data, relPath);
  } catch (e) {
    wrap.innerHTML = `<div class="state-msg" style="color:#c0392b;">Network error: ${e.message}</div>`;
  }
}

function renderChapter(data, relPath) {
  const wrap = document.getElementById('page-wrap');

  // Derive title from the first ATX h1 in the raw markdown
  const titleMatch = data.raw.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : '';

  const words = data.raw.trim() ? data.raw.trim().split(/\s+/).length : 0;
  const wordCount = words
    ? `<span style="font-family:var(--font-ui);font-size:0.55rem;color:var(--ink-faint);letter-spacing:0.08em;margin-left:1.2rem;">${words.toLocaleString()} words</span>`
    : '';

  wrap.innerHTML = `
    <header class="chapter-header">
      <div class="chapter-label">Draft${wordCount}<span class="save-status" id="save-status-desktop"></span></div>
      <h1>${title}</h1>
    </header>
    <article class="main-text" id="main-text"></article>
    <aside class="margin-col" id="margin-col"></aside>
  `;

  mountLiveEditor(data.raw, relPath);
  buildScrollbarTOC();
  setupProgressSave();
}

// ── Silent refresh — reload the doc without a scroll jump or blink ──────────
// Used for WS file-change signals (e.g. another device/tab edited the same
// file). Skipped while the user is actively typing here — their own edits
// are the source of truth for the doc they're mid-editing.
//
// `force` bypasses the two skip guards below (identical-content and
// pending-local-save). Those guards are correct for the WS case this
// function was built for — a *maybe*-relevant signal that may race with our
// own writes — but wrong for a just-completed git pull: a successful pull is
// new ground truth for the file, not a maybe-stale ping, and the "pending
// local save" guard exists to protect in-progress typing, not to swallow a
// legitimate remote update the person just explicitly asked for by tapping
// Pull. See doSync()'s pull branch below for the call site.
async function silentRefresh({ force = false } = {}) {
  if (!editingPath || !liveEditor) return;
  const path = editingPath; // path the *currently mounted* editor owns

  try {
    const res = await fetch('/api/raw?path=' + encodeURIComponent(path));
    if (!res.ok) return;
    const data = await res.json();

    // Bail if the user has since navigated to a different chapter (or the
    // editor was torn down) while this fetch was in flight — applying a
    // stale response to whatever's mounted now would silently overwrite
    // the wrong chapter, the same class of bug as the save-path race above.
    if (editingPath !== path || !liveEditor) return;

    // Skip if content is identical to what's already loaded (prevents a
    // pointless re-render when we trigger a WS event from our own write).
    if (!force && data.raw === _lastRenderedRaw) return;
    if (!force && saveTimer) return; // a local edit is still pending — don't clobber it

    const main = document.getElementById('main');
    const savedScroll = main ? main.scrollTop : 0;

    _lastRenderedRaw = data.raw;
    liveEditor.setDoc(data.raw);

    if (main) main.scrollTop = savedScroll;
    buildScrollbarTOC();
  } catch {}
}


let _progressScrollAbort = null;

function setupProgressSave() {
  const main = document.getElementById('main');
  if (!main) return;
  // Cancel any previously registered scroll listener before adding a new one.
  // Without this, each chapter load stacks another listener on the same element.
  if (_progressScrollAbort) _progressScrollAbort.abort();
  _progressScrollAbort = new AbortController();

  main.addEventListener('scroll', () => {
    clearTimeout(_progressTimer);
    _progressTimer = setTimeout(() => {
      if (!currentPath) return;
      fetch('/api/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: currentPath, scrollTop: main.scrollTop }),
      }).catch(() => {});
    }, 800);
  }, { passive: true, signal: _progressScrollAbort.signal });
}

// ── Unified live editor (CodeMirror 6) ───────────────────────────────────────
// Replaces the old view-mode/edit-mode split entirely. One CM6 instance is
// mounted directly into #main-text for the lifetime of a chapter: markdown
// syntax is live-previewed (hidden unless the cursor is on that line), note
// markers render as the same .mn-anchor superscripts the old server HTML
// used, and every keystroke schedules a debounced whole-file save via
// /api/raw. See editor-src/main.js and EDITOR_MIGRATION_PLAN.md.
let liveEditor = null;
let saveTimer = null;
let savedStatusTimer = null;

// The file path the *currently mounted editor's* pending/in-flight save(s)
// belong to. This is intentionally a separate variable from `currentPath`:
// `currentPath` is updated the instant chapter navigation begins (so nav
// highlighting / progress-save / etc. can use the new path right away), but
// a save that was scheduled against the *previous* chapter must still be
// written to the *previous* chapter's file even after `currentPath` has
// already moved on. Reading `currentPath` inside scheduleSave's timeout (or
// flushPendingSave) instead of this would PUT the outgoing editor's text to
// the incoming chapter's path — silently overwriting whatever chapter the
// user navigates to next with stale content from the one they left. This
// was exactly the "content bleeds into the next-opened chapter" bug: editing
// the preface, then opening Chapter One before the 600ms debounce fired,
// caused the preface's text to be flushed to Chapter One's path instead.
let editingPath = null;

// Small "saving…/saved" indicator, shown next to the chapter title (mobile
// topbar) and next to the word count (desktop chapter header). Both spots
// share the same .save-status styling; either may be absent depending on
// viewport/render state, so guard each lookup.
function setSaveStatus(text) {
  clearTimeout(savedStatusTimer);
  const mobile = document.getElementById('save-status');
  const desktop = document.getElementById('save-status-desktop');
  if (mobile) mobile.textContent = text;
  if (desktop) desktop.textContent = text;
  if (text === 'Saved') {
    savedStatusTimer = setTimeout(() => {
      if (mobile) mobile.textContent = '';
      if (desktop) desktop.textContent = '';
    }, 1500);
  }
}

function scheduleSave(text) {
  // Capture the path this edit belongs to *now*, at keystroke time — not
  // whatever `currentPath` happens to be when the debounce timer fires.
  const path = editingPath;
  clearTimeout(saveTimer);
  setSaveStatus('Saving…');
  saveTimer = setTimeout(() => {
    if (!path) return;
    fetch('/api/raw', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, text }),
    }).then((res) => {
      setSaveStatus(res.ok ? 'Saved' : 'Save failed');
    }).catch(() => setSaveStatus('Save failed'));
  }, 600);
}

// Debounces a scrollbar-TOC rebuild off the live doc text while the user is
// typing. Bug fix: buildScrollbarTOC() was previously only called on chapter
// load, silent WS refresh, and after a note mutation — never from onChange —
// so adding/editing a heading did not update the popup until the chapter was
// reopened. Rebuilding the TOC re-parses the whole doc and rewrites the popup's
// innerHTML, which is cheap but not free, so this debounces on the same
// keystroke cadence as scheduleSave() rather than rebuilding on every
// keystroke.
function scheduleTOCRebuild() {
  clearTimeout(tocRebuildTimer);
  tocRebuildTimer = setTimeout(() => buildScrollbarTOC(), 400);
}

function mountLiveEditor(rawText, path) {
  if (!window.MnEditor) { console.error('Editor bundle not loaded'); return; }
  const mainText = document.getElementById('main-text');
  if (!mainText) return;

  if (liveEditor) { liveEditor.destroy(); liveEditor = null; }
  clearTimeout(tocRebuildTimer); // don't let a stale rebuild fire against the doc we're replacing

  editingPath = path;

  liveEditor = window.MnEditor.createLiveEditor({
    parent: mainText,
    doc: rawText,
    onChange: (text) => { scheduleSave(text); scheduleTOCRebuild(); },
    onNotesChanged: (notes) => { currentNotes = notes; },
    onLayoutChanged: () => positionChips(),
    onSelectionForNote: ({ text, to, screenRect }) => showSelectionTooltip(text, to, screenRect),
    onSelectionCleared: () => selTooltip.classList.remove('visible'),
  });
}

// Workaround for the "stale inline note-superscript number" bug (see
// BUG_HANDOFF_note_superscript_refresh.md): after any edit that shifts the
// sequential id of notes below it (insert/delete/retype), CM6's incremental
// redraw of the `sup.mn-marker` widgets below the edit point doesn't
// reliably refresh every one of them. Two rounds of trying to fix CM6's
// incremental decoration redraw itself did not resolve it even after
// confirming rebuilds were live — see the handoff doc for the full
// investigation. Neither of us has a browser to inspect the live DOM and
// confirm *why* CM6's diffing misses these ranges, so rather than guess a
// third time, this forces the one thing that's guaranteed to be correct:
// fully tearing down and recreating the CM6 view from the post-edit
// document text after any note mutation. It's heavier than an incremental
// fix (briefly recreates the view, so that one action isn't undo-able with
// Ctrl/Cmd+Z) but it can't leave a stale superscript behind, since every
// widget is freshly built from the current text on remount. Scroll
// position is preserved. Call this after insertNoteAt/retypeNoteById/
// removeNoteById specifically — not after ordinary typing, which remains
// fully incremental and unaffected.
function remountAfterNoteMutation() {
  if (!liveEditor || !editingPath) return;
  // The actual scrollable element is #main (see .main's `overflow-y: auto`
  // in styles.css) — #main-text is just a non-scrolling child article, so
  // reading/writing scrollTop on it was always a no-op. That's why saving a
  // note reset the view to the top: mountLiveEditor() tears down and
  // rebuilds the CM6 view (see the comment above), which drops the browser's
  // native scroll position, and the old restore below never actually put it
  // back because it was targeting the wrong element.
  const main = document.getElementById('main');
  const scrollTop = main ? main.scrollTop : 0;
  const text = liveEditor.getDoc();
  mountLiveEditor(text, editingPath);
  if (!main) return;
  main.scrollTop = scrollTop;
  // Mobile-only follow-up: saveNote() calls this while the on-screen
  // keyboard is still open (the sheet's textarea hasn't been blurred yet).
  // Android's keyboard-dismiss animation triggers an asynchronous viewport
  // resize *after* this function already returns, and that resize itself
  // resets #main's scroll — silently overriding the restore above a moment
  // later. That's why this fix alone didn't hold on the Android app even
  // though the exact same code path is correct and unchanged on desktop,
  // where there's no on-screen keyboard to close. visualViewport's resize
  // event fires once that keyboard-close settles, so re-applying scrollTop
  // there catches the case desktop never has to deal with. The plain
  // setTimeout fallback covers browsers/webviews without visualViewport.
  if (window.visualViewport) {
    const reapply = () => { main.scrollTop = scrollTop; };
    window.visualViewport.addEventListener('resize', reapply, { once: true });
    // Safety timeout in case the keyboard was already closed and no resize
    // event fires at all — don't leave the listener attached forever.
    setTimeout(() => window.visualViewport.removeEventListener('resize', reapply), 600);
  } else {
    setTimeout(() => { main.scrollTop = scrollTop; }, 300);
  }
}

// Flushes any pending debounced save immediately — used before navigating
// away from a chapter so a fast switch never drops the last few keystrokes.
// Must run (and resolve) BEFORE `currentPath`/`editingPath` are reassigned
// to the next chapter, and must target `editingPath` (the outgoing
// chapter), never `currentPath` (which may already be the incoming one).
async function flushPendingSave() {
  if (!saveTimer || !liveEditor || !editingPath) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const path = editingPath;
  await fetch('/api/raw', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, text: liveEditor.getDoc() }),
  }).then((res) => setSaveStatus(res.ok ? 'Saved' : 'Save failed'))
    .catch(() => setSaveStatus('Save failed'));
}

function buildScrollbarTOC() {
  const tocPopup = document.getElementById('toc-popup');
  if (!tocPopup || !liveEditor) return;

  cachedTOCHeight = 0;

  // Parse headings straight from the document text rather than querying
  // rendered `<h1>/<h2>/<h3>` DOM nodes. CM6 only renders elements for
  // lines currently near the viewport, so a DOM query silently misses any
  // heading further down a long chapter — and even a heading that *is*
  // currently rendered loses any `id` we assign it the next time CM6
  // recycles that line's DOM (e.g. after scrolling it out and back into
  // view), breaking the TOC's `#heading-N` link. Matching plain markdown
  // ATX headings (`#`, `##`, `###`) at line start, same as lib/parse.js.
  const text = liveEditor.getDoc();
  const headingRe = /^(#{1,3})\s+(.+)$/gm;
  const headings = [];
  let match;
  while ((match = headingRe.exec(text))) {
    headings.push({ level: match[1].length, text: match[2].trim(), charPos: match.index });
  }

  if (headings.length === 0) {
    tocPopup.innerHTML = '<div class="toc-link toc-h3">No headings in this chapter</div>';
    return;
  }

  tocPopup.innerHTML = headings
    .map((h, i) => `<a href="#" class="toc-link toc-h${h.level}" data-toc-index="${i}">${h.text}</a>`)
    .join('');

  tocPopup.querySelectorAll('.toc-link').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const h = headings[Number(link.dataset.tocIndex)];
      if (h) liveEditor.scrollToPos(h.charPos);
    });
  });
}

// ── Margin chips ─────────────────────────────────────────────────────────────
// Minimum vertical gap (px) enforced between the tops of two stacked chips —
// keeps two notes anchored to the same/adjacent line from overlapping.
const MN_CHIP_MIN_GAP = 8;
// Rough line-height (px) of chip preview text at the current reader font size,
// used to convert "available space before the next chip" into a clamp count.
function mnPreviewLineHeightPx() {
  const rootSize = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--reader-font-size')
  ) || 17;
  // .mn-chip-preview font-size is 0.75 * reader size, with line-height 1.4
  return rootSize * 0.75 * 1.4;
}

function positionChips() {
  const mainText  = document.getElementById('main-text');
  const marginCol = document.getElementById('margin-col');
  if (!mainText || !marginCol) return;

  const mainMain  = document.getElementById('main');
  const scrollTop = mainMain ? mainMain.scrollTop : 0;
  const marginTop = marginCol.getBoundingClientRect().top + scrollTop;

  marginCol.innerHTML = '';

  const numRowH = 14; // ~.mn-chip-num row height incl. margin, constant regardless of font size
  const lineH   = mnPreviewLineHeightPx();

  // Gather layout info first (natural top + connector target + how many
  // lines this note's content could fill if given unlimited room) before
  // touching the DOM, so we can resolve the whole cluster in one pass.
  const items = [];
  const hasMetrics = liveEditor && typeof liveEditor.getNoteMetrics === 'function';
  currentNotes.forEach(note => {
    // Still grab the live DOM anchor when it happens to be rendered — used
    // for the click-passthrough binding and active-marker highlight always,
    // and as a positioning fallback below if needed.
    const anchor = mainText.querySelector(`.mn-anchor[data-note-id="${note.id}"]`);

    // Position from CM6's height map (works even if this note is currently
    // scrolled out of the rendered viewport), not from the `.mn-anchor` DOM
    // node — CM6 only mounts DOM for lines near the viewport, so a
    // DOM-only lookup silently drops any note below/above what's currently
    // drawn until the user scrolls near it (or the page is refreshed and
    // happens to draw that range). See editor-src/main.js#getNoteMetrics.
    //
    // Fallback: if the mounted editor bundle predates getNoteMetrics (stale
    // build — see AppCode/package.json's build:editor script), use the old
    // DOM-rect approach so notes that ARE currently rendered still show up,
    // rather than silently rendering nothing.
    let metrics = null;
    if (hasMetrics && note.charPos != null) {
      metrics = liveEditor.getNoteMetrics(note.charPos);
    }
    if (!metrics) {
      if (!anchor) return;
      const aRect = anchor.getBoundingClientRect();
      metrics = { top: aRect.top, height: aRect.height };
    }

    const naturalTop = metrics.top + scrollTop - marginTop;

    // Rough estimate of how many lines the full note would need to render
    // without clamping — used both as an upper bound and as a "weight" when
    // splitting shared space between competing notes below.
    const approxCharsPerLine = 32; // tuned to .mn-chip-preview's width/font
    const desiredLines = Math.max(1, Math.ceil(note.content.length / approxCharsPerLine));

    items.push({
      note,
      anchor,
      naturalTop,
      connectorTop: metrics.height / 2,
      desiredLines,
    });
  });

  // Sort top-to-bottom so collision resolution only ever pushes chips *down*,
  // preserving reading order in the margin.
  items.sort((a, b) => a.naturalTop - b.naturalTop);

  // ── Group into clusters ────────────────────────────────────────────────
  // A cluster is a run of consecutive notes whose *minimum* footprints
  // (one line each) would overlap if placed at their natural positions.
  // Notes with generous natural spacing between them form their own
  // single-item cluster and are left alone.
  const minFootprint = numRowH + lineH; // smallest a chip can ever be (1 line)
  const clusters = [];
  let current = [items[0]].filter(Boolean);
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const cur  = items[i];
    if (cur.naturalTop - prev.naturalTop < minFootprint) {
      current.push(cur);
    } else {
      clusters.push(current);
      current = [cur];
    }
  }
  if (current.length) clusters.push(current);

  // ── Resolve each cluster ──────────────────────────────────────────────
  // Instead of only glancing at the *next* chip, we now look at the whole
  // run of colliding notes together: the total room the cluster spans
  // (from the first note's natural top to the next cluster's natural top,
  // or a generous cap for the last cluster) is split across every note in
  // the cluster in proportion to how much content each one actually has,
  // so a short note next to a long one doesn't hog space it doesn't need,
  // and a long note isn't clamped to 1 line just because a short neighbor
  // happens to sit nearby.
  clusters.forEach((cluster, ci) => {
    const clusterStart = cluster[0].naturalTop;
    const nextClusterStart = (ci + 1 < clusters.length)
      ? clusters[ci + 1][0].naturalTop
      : clusterStart + Math.max(400, cluster.length * 120);

    const totalSpan = Math.max(
      nextClusterStart - clusterStart,
      cluster.length * minFootprint // never less than everyone's 1-line minimum
    );

    if (cluster.length === 1) {
      // No collision at all — sits at its natural spot, gets everything up
      // to the next cluster (or note if within the same near-miss range).
      const only = cluster[0];
      only.top = only.naturalTop;
      const availablePx = Math.max(0, totalSpan - numRowH - MN_CHIP_MIN_GAP);
      only.maxLines = clampLines(availablePx / lineH, only.desiredLines);
      return;
    }

    // Multi-note cluster: give each note at least 1 line, then divide the
    // leftover space (in whole line-units) across the cluster.
    //
    // A straight one-shot proportional split isn't quite right: if a note's
    // proportional share exceeds what its own content actually needs, that
    // excess should go back into the pot for everyone else, rather than
    // being wasted as blank space in that note's chip. So this waterfills
    // iteratively — each round, give every still-growing note an equal(ish)
    // slice of the remaining pot, weighted by desired length; any note that
    // hits its content ceiling in a round drops out and its leftover share
    // is redistributed in the next round.
    const n = cluster.length;
    const guaranteedPerNote = numRowH + lineH; // 1 line floor
    let leftoverLines = Math.max(
      0,
      (totalSpan - n * guaranteedPerNote - (n - 1) * MN_CHIP_MIN_GAP) / lineH
    );

    cluster.forEach(item => { item.allocLines = 1; }); // everyone starts with their 1-line floor
    let growable = cluster.filter(item => item.desiredLines > item.allocLines);

    let guard = 0;
    while (leftoverLines > 0.001 && growable.length && guard < 50) {
      guard++;
      const weightTotal = growable.reduce((s, it) => s + (it.desiredLines - it.allocLines), 0);
      let spentThisRound = 0;
      growable.forEach(item => {
        const weight = (item.desiredLines - item.allocLines) / weightTotal;
        const grant = Math.min(leftoverLines * weight, item.desiredLines - item.allocLines);
        item.allocLines += grant;
        spentThisRound += grant;
      });
      leftoverLines -= spentThisRound;
      growable = growable.filter(item => item.desiredLines > item.allocLines + 0.01);
    }

    let cursor = clusterStart;
    cluster.forEach(item => {
      item.top = cursor;
      item.maxLines = clampLines(item.allocLines, item.desiredLines);
      // Advance by the height actually granted (post-cap), not a pre-cap
      // estimate — otherwise a note capped down to fewer lines than its
      // "fair share" still pushes everyone after it down as if it used the
      // full share, wasting margin space for no reason.
      cursor += numRowH + (item.maxLines * lineH) + MN_CHIP_MIN_GAP;
    });
  });

  function clampLines(rawLines, desiredLines) {
    let n = Math.floor(rawLines);
    if (n < 1) n = 1;
    if (n > 12) n = 12;          // sane ceiling so a huge gap doesn't dump the whole note
    if (n > desiredLines) n = Math.max(1, desiredLines); // don't reserve more than the note needs
    return n;
  }

  items.forEach(item => {
    const { note, anchor, top, connectorTop, maxLines } = item;

    const chip = document.createElement('div');
    chip.className = 'mn-chip';
    chip.dataset.noteId = note.id;
    if (note.type) chip.dataset.noteType = note.type;
    chip.style.top = top + 'px';

    // When collision-avoidance pushed this chip down from its natural
    // (anchor-aligned) position, don't try to draw a line back up to the
    // anchor at all — on the same reading line, two competing notes read
    // clearly enough from stacking order and indentation alone. Just nudge
    // the shifted chip in with extra left padding (a tab-like indent), so
    // it visually reads as "the second note belonging to this run" rather
    // than a new unrelated note starting fresh at the margin edge.
    const shiftPx = top - item.naturalTop;
    if (shiftPx > 0.5) chip.dataset.shifted = 'true';
    const connectorHtml = `<div class="mn-connector" style="top:${connectorTop}px;"></div>`;

    chip.innerHTML = `
      <div class="mn-chip-inner">
        <span class="mn-chip-num">${note.id}</span>
        <span class="mn-chip-preview" style="-webkit-line-clamp:${maxLines};">${note.content}</span>
      </div>
      ${connectorHtml}
    `;

    chip.addEventListener('click', () => openPopup(note, chip, anchor));
    // Bind the inline superscript too — covers both desktop hover and mobile tap.
    // This is the only binding site; the old second sweep below was adding duplicates.
    // `anchor` may be null here if this note's line isn't currently rendered
    // by CM6 (see the getNoteMetrics comment above) — nothing to bind in that case.
    const marker = anchor ? anchor.querySelector('.mn-marker') : null;
    if (marker) marker.addEventListener('click', () => openPopup(note, chip, anchor));

    marginCol.appendChild(chip);
  });
}


// ── Popup ────────────────────────────────────────────────────────────────────
const popup    = document.getElementById('mn-popup');
const popupBody= document.getElementById('popup-body');

function openPopup(note, chip, anchor) {
  if (activeChip)   activeChip.classList.remove('active-chip');
  if (activeMarker) activeMarker.classList.remove('active');

  const isMobile = window.innerWidth <= 768;

  if (!isMobile && chip) {
    const chipRect = chip.getBoundingClientRect();
    const popW = 300;
    let left = chipRect.left - popW - 14;
    if (left < 8) left = chipRect.right + 14;
    if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
    let top = chipRect.top;
    const popH = 300;
    if (top + popH > window.innerHeight - 8) top = window.innerHeight - popH - 8;
    if (top < 8) top = 8;
    popup.style.left = left + 'px';
    popup.style.top  = top  + 'px';
  }

  // Type pill labels
  const typeLabels = { query: 'Query', ref: 'Reference', todo: 'Todo', ai: 'Agent' };
  const typePill = note.type
    ? `<div class="mn-popup-type type-${note.type}">${typeLabels[note.type] || note.type}</div>`
    : '';

  popupBody.innerHTML = `${typePill}<p>${note.content.replace(/\n\n/g, '</p><p>')}</p>`;
  
  const delBtn = document.getElementById('popup-delete');
  delBtn.onclick = () => { removeNote(note.id, note.charPos); closePopup(); };

  // Reclassify row — mark current type active
  const retypeRow = document.getElementById('popup-retype');
  retypeRow.querySelectorAll('.note-type-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.retype === (note.type || ''));
    b.onclick = async () => {
      const newType = b.dataset.retype || null;
      if (newType === (note.type || null)) return;
      await retypeNote(note, newType);
      closePopup();
    };
  });

  popup.classList.add('open');
  if (chip) { chip.classList.add('active-chip'); activeChip = chip; }
  // `anchor` is only present when this note's line happens to be currently
  // rendered by CM6 — absent for offscreen notes, which is fine here since
  // this is just a highlight, not the popup's actual content/position.
  if (anchor) { anchor.querySelector('.mn-marker')?.classList.add('active'); activeMarker = anchor.querySelector('.mn-marker'); }
}

function closePopup() {
  popup.classList.remove('open');
  if (activeChip)   { activeChip.classList.remove('active-chip');   activeChip   = null; }
  if (activeMarker) { activeMarker.classList.remove('active');       activeMarker = null; }
}

document.getElementById('popup-close').addEventListener('click', closePopup);
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closePopup(); closeSheet(); } });
document.addEventListener('click', e => {
  if (!popup.contains(e.target) && !e.target.closest('.mn-chip') && !e.target.closest('.mn-anchor')) closePopup();
  if (!document.getElementById('note-sheet').contains(e.target) && !e.target.closest('#sel-tooltip')) closeSheet();
});

// ── Text selection → add note ────────────────────────────────────────────────
// Driven by the live editor's onSelectionForNote/onSelectionCleared
// callbacks (wired in mountLiveEditor above) instead of the native
// `selectionchange` event + DOM-offset walking the old static-HTML view
// mode needed. CM6 selection state already gives us doc-position offsets
// directly, so no txt-seg span lookup is needed anymore.
const selTooltip = document.getElementById('sel-tooltip');

// CRITICAL MOBILE FIX: Prevent text selection from clearing when you tap the tooltip
selTooltip.addEventListener('mousedown', e => e.preventDefault());
selTooltip.addEventListener('touchstart', e => e.preventDefault(), { passive: false });

function showSelectionTooltip(selectedText, charPos, rect) {
  if (!rect) { selTooltip.classList.remove('visible'); return; }

  // Position tooltip above the selection (CSS !important overrides this on mobile)
  const ttW  = 140; // Tooltip is a bit wider now with two buttons
  let left   = rect.left + (rect.width / 2) - (ttW / 2);
  if (left < 8) left = 8;
  if (left + ttW > window.innerWidth - 8) left = window.innerWidth - ttW - 8;

  selTooltip.style.left = left + 'px';

  // On mobile, position BELOW the text to avoid overlapping the native Copy/Paste menu
  if (window.innerWidth <= 768) {
    selTooltip.style.top = (rect.bottom + 30) + 'px';
  } else {
    // On desktop, position ABOVE the text
    selTooltip.style.top = (rect.top - 40) + 'px';
  }

  selTooltip.classList.add('visible');

  // Store what we need to write the note. charPos is the CM6 doc offset at
  // the end of the selection (== old `to`), where the [mn: ...] marker gets
  // inserted — matches where the old server-side writeNote() expected it.
  pendingPos = { charPos, contextText: selectedText.trim().slice(0, 60) };
}

// ── Note type selector ───────────────────────────────────────────────────────
document.getElementById('note-type-row').addEventListener('click', e => {
  const btn = e.target.closest('.note-type-btn');
  if (!btn) return;
  document.querySelectorAll('.note-type-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  selectedNoteType = btn.dataset.type;
});

// ── Note sheet ───────────────────────────────────────────────────────────────
const noteSheet   = document.getElementById('note-sheet');
const sheetInput  = document.getElementById('sheet-input');
const sheetCtx    = document.getElementById('sheet-context');

// ── Tooltip Actions (Supporting both Desktop Click and Mobile Touch) ────────

function handleAddNote(e) {
  if (e.type === 'touchend') e.preventDefault(); // Prevent ghost clicks
  e.stopPropagation();
  if (!pendingPos) return;

  selTooltip.classList.remove('visible');
  if (liveEditor && pendingPos) {
    liveEditor.view.dispatch({ selection: { anchor: pendingPos.charPos } });
  }

  sheetCtx.textContent = '…' + pendingPos.contextText + '…';
  sheetInput.value = '';
  selectedNoteType = '';
  document.querySelectorAll('.note-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === ''));

  const isMobile = window.innerWidth <= 768;
  if (!isMobile) {
    const ttRect = selTooltip.getBoundingClientRect();
    const shW = 320;
    let left = ttRect.left + (ttRect.width / 2) - (shW / 2);
    if (left < 8) left = 8;
    if (left + shW > window.innerWidth - 8) left = window.innerWidth - shW - 8;
    noteSheet.style.left   = left + 'px';
    noteSheet.style.top    = (ttRect.bottom + 10) + 'px';
    noteSheet.style.bottom = 'auto';
  }

  noteSheet.classList.add('open');
  setTimeout(() => sheetInput.focus(), 50);
}

// Bind tooltip action
const ttAddBtn = document.getElementById('tt-add-note');

ttAddBtn.addEventListener('click', handleAddNote);
ttAddBtn.addEventListener('touchend', handleAddNote);

document.getElementById('sheet-cancel').addEventListener('click', closeSheet);

document.getElementById('sheet-save').addEventListener('click', saveNote);
sheetInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveNote();
});

function closeSheet() {
  // Blur first: on mobile this starts the on-screen keyboard's dismiss
  // animation immediately, before the CM6 remount below tears down and
  // rebuilds the editor DOM. Without this, the input can still hold focus
  // into the remount, so the keyboard only starts closing afterward — see
  // the comment in remountAfterNoteMutation() for why that's the actual
  // source of the mobile-only scroll-jump.
  if (sheetInput) sheetInput.blur();
  noteSheet.classList.remove('open');
  selTooltip.classList.remove('visible');
  pendingPos = null;
}

// Note add/retype/delete now mutate the live CM6 doc directly (via
// liveEditor.insertNoteAt/retypeNoteById/removeNoteById) instead of calling
// the server's /api/note endpoint and then re-fetching with silentRefresh().
//
// Why: /api/note wrote straight to the file on disk, independently of the
// whole-doc debounced save (scheduleSave/flushPendingSave) that also writes
// that same file from whatever's in the editor's memory. Two independent
// writers racing on one file is exactly what caused the flaky note
// behavior — depending on timing, the debounced save could either (a) land
// after /api/note and silently wipe the note back out because the editor's
// in-memory doc never had it, or (b) land before it, in which case the note
// was on disk but the editor's own doc — and thus the UI — didn't reflect
// it until a manual refresh happened to line up right. Editing the CM6 doc
// directly means there is exactly one writer again (the debounced
// /api/raw PUT), the same one every other keystroke already goes through,
// so a note appears immediately and can never be raced out by a save.
async function saveNote() {
  const text = sheetInput.value.trim();
  if (!text || !pendingPos || !editingPath || !liveEditor) return;

  const btn = document.getElementById('sheet-save');
  btn.disabled = true;
  btn.style.opacity = '0.5';

  try {
    liveEditor.insertNoteAt(pendingPos.charPos, text, selectedNoteType || null);
    // closeSheet() blurs the input BEFORE remountAfterNoteMutation() tears
    // down/rebuilds the CM6 view — see the comments in both functions.
    // Doing this first (not after, as before) starts the mobile keyboard's
    // close animation ahead of the remount instead of racing it.
    closeSheet();
    remountAfterNoteMutation();
  } finally {
    btn.disabled = false;
    btn.style.opacity = '1';
  }
}

async function retypeNote(note, newType) {
  if (!editingPath || !liveEditor) return;
  liveEditor.retypeNoteById(note.id, newType);
  remountAfterNoteMutation();
}

async function removeNote(noteId, charPos) {
  if (!editingPath || !liveEditor) return;
  liveEditor.removeNoteById(noteId);
  remountAfterNoteMutation();
}

// ── Mobile sidebar ───────────────────────────────────────────────────────────
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}

document.getElementById('topbar-menu').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('open');
});

document.getElementById('sidebar-overlay').addEventListener('click', closeSidebar);

// ── Desktop sidebar collapse (no-distraction mode) ──────────────────────────
// Independent of the mobile drawer above — this only ever applies at
// min-width:769px via CSS, so it can't interfere with the mobile/app drawer.
(function setupDesktopSidebarCollapse() {
  const appEl       = document.querySelector('.app');
  const collapseBtn = document.getElementById('sidebar-collapse-btn');
  const expandBtn   = document.getElementById('sidebar-expand-btn');
  if (!appEl || !collapseBtn || !expandBtn) return;

  const STORAGE_KEY = 'sidebar-collapsed';

  function setCollapsed(collapsed) {
    appEl.classList.toggle('sidebar-collapsed', collapsed);
    localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
  }

  // Restore persisted state on load
  setCollapsed(localStorage.getItem(STORAGE_KEY) === '1');

  collapseBtn.addEventListener('click', () => setCollapsed(true));
  expandBtn.addEventListener('click', () => setCollapsed(false));

  // Keyboard shortcut: Ctrl/Cmd+\ toggles, desktop only (matches CSS breakpoint)
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
      if (window.innerWidth <= 768) return; // mobile drawer has its own control
      e.preventDefault();
      setCollapsed(!appEl.classList.contains('sidebar-collapsed'));
    }
  });
})();

// ── New document creation ────────────────────────────────────────────────────
// Lets the person add a chapter/front/back-matter file without leaving the
// app (previously required adding the .md file in Obsidian/the filesystem
// and coming back). Creates the file server-side, reloads the sidebar, opens
// the new chapter, and drops straight into edit mode so they can start typing.
const newdocOverlay = document.getElementById('newdoc-overlay');
const newdocInput   = document.getElementById('newdoc-input');
const newdocTitle   = document.getElementById('newdoc-title');
let pendingNewDocSection = null;

function openNewDocPrompt(sectionKey, sectionLabel) {
  pendingNewDocSection = sectionKey;
  newdocTitle.textContent = `New in ${sectionLabel}`;
  newdocInput.value = '';
  newdocOverlay.classList.add('open');
  setTimeout(() => newdocInput.focus(), 50);
}

function closeNewDocPrompt() {
  newdocOverlay.classList.remove('open');
  pendingNewDocSection = null;
}

document.getElementById('newdoc-close').addEventListener('click', closeNewDocPrompt);
document.getElementById('newdoc-cancel').addEventListener('click', closeNewDocPrompt);
newdocOverlay.addEventListener('click', e => { if (e.target === newdocOverlay) closeNewDocPrompt(); });

async function createNewDoc() {
  const title = newdocInput.value.trim();
  if (!title || !pendingNewDocSection) return;

  const createBtn = document.getElementById('newdoc-create');
  createBtn.disabled = true;
  try {
    const res = await fetch('/api/chapter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section: pendingNewDocSection, title }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Could not create document');

    closeNewDocPrompt();
    await loadManifest();          // rebuild sidebar so the new file appears
    await loadChapter(data.path);  // jump straight to it
    closeSidebar();                // in case we're on mobile with drawer open
    liveEditor?.focus();           // drop straight into the editor to start writing
  } catch (e) {
    alert('Could not create document: ' + e.message);
  } finally {
    createBtn.disabled = false;
  }
}

document.getElementById('newdoc-create').addEventListener('click', createNewDoc);
newdocInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') createNewDoc();
  if (e.key === 'Escape') closeNewDocPrompt();
});

// ── Resize reposition ────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  positionChips();
  closePopup();
});
// ── TOC Mouse Tracking (Optimized) ───────────────────────────────────────────
const tocTrigger = document.getElementById('toc-trigger');
const tocPopup   = document.getElementById('toc-popup');

function updateTOCPosition(yPos) {
  if (!tocPopup) return;
  
  // Only measure the height once per chapter load instead of on every mouse movement
  if (!cachedTOCHeight) {
    cachedTOCHeight = tocPopup.offsetHeight;
  }
  
  const winH = window.innerHeight;
  let y = yPos;
  
  // Keep the popup from clipping off the top or bottom of the screen
  if (y - (cachedTOCHeight / 2) < 15) y = (cachedTOCHeight / 2) + 15;
  if (y + (cachedTOCHeight / 2) > winH - 15) y = winH - (cachedTOCHeight / 2) - 15;
  
  tocPopup.style.top = y + 'px';
}

if (tocTrigger) {
  tocTrigger.addEventListener('mousemove', e => {
    if (!tocTicking) {
      window.requestAnimationFrame(() => {
        updateTOCPosition(e.clientY);
        tocTicking = false;
      });
      tocTicking = true;
    }
  });
  
  tocTrigger.addEventListener('touchmove', e => {
    if (e.touches.length > 0 && !tocTicking) {
      window.requestAnimationFrame(() => {
        updateTOCPosition(e.touches[0].clientY);
        tocTicking = false;
      });
      tocTicking = true;
    }
  });
}

// ── Vault Folder Picker ──────────────────────────────────────────────────────
const vaultPickerOverlay = document.getElementById('vault-picker-overlay');
const vaultPickerList    = document.getElementById('vault-picker-list');
const vaultPickerCrumb   = document.getElementById('vault-picker-crumb');
const vaultPickerSel     = document.getElementById('vault-picker-selected');
const vaultPickerConfirm = document.getElementById('vault-picker-confirm');

let _pickerChosenPath = null;

async function browseDir(dir) {
  vaultPickerList.innerHTML = '<div style="padding:1.2rem;text-align:center;font-family:var(--font-ui);font-size:0.58rem;color:var(--ink-faint);">Loading…</div>';
  try {
    const url = '/api/browse' + (dir ? '?dir=' + encodeURIComponent(dir) : '');
    const data = await fetch(url).then(r => r.json());
    if (data.error) throw new Error(data.error);

    // Crumb shows current path truncated
    vaultPickerCrumb.textContent = data.current;
    vaultPickerCrumb.title = data.current;

    let html = '';
    // Up arrow row
    if (data.parent) {
      html += `<div class="vault-picker-item up-item" data-path="${data.parent}" data-action="browse">
        <svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
        <span>.. up</span>
      </div>`;
    }
    // Directory rows
    data.dirs.forEach(d => {
      html += `<div class="vault-picker-item" data-path="${d.path}" data-action="select">
        <svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
        <span>${d.name}</span>
      </div>`;
    });
    if (data.dirs.length === 0 && !data.parent) {
      html = '<div style="padding:1.2rem;text-align:center;font-family:var(--font-ui);font-size:0.58rem;color:var(--ink-faint);">No subfolders found</div>';
    }
    vaultPickerList.innerHTML = html;

    // Wire up clicks
    vaultPickerList.querySelectorAll('.vault-picker-item').forEach(item => {
      item.addEventListener('click', () => {
        const p = item.dataset.path;
        if (item.dataset.action === 'browse') {
          browseDir(p);
          return;
        }
        // Single click = select; double-click = open into
        if (_pickerChosenPath === p) {
          browseDir(p);
          return;
        }
        // Deselect previous
        vaultPickerList.querySelectorAll('.vault-picker-item.selected')
          .forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
        _pickerChosenPath = p;
        vaultPickerSel.textContent = p;
        vaultPickerConfirm.disabled = false;
      });
    });
  } catch (err) {
    vaultPickerList.innerHTML = `<div style="padding:1.2rem;font-family:var(--font-ui);font-size:0.58rem;color:#c0392b;">${err.message}</div>`;
  }
}

function openVaultPicker() {
  _pickerChosenPath = null;
  vaultPickerSel.textContent = 'No folder selected';
  vaultPickerConfirm.disabled = true;
  vaultPickerOverlay.classList.add('open');
  // Start at current vault dir, or home
  fetch('/api/vault').then(r => r.json()).then(d => browseDir(d.vault || null)).catch(() => browseDir(null));
}

function closeVaultPicker() {
  vaultPickerOverlay.classList.remove('open');
}

document.getElementById('vault-picker-close').addEventListener('click', closeVaultPicker);
vaultPickerOverlay.addEventListener('click', e => {
  if (e.target === vaultPickerOverlay) closeVaultPicker();
});

vaultPickerConfirm.addEventListener('click', async () => {
  if (!_pickerChosenPath) return;
  vaultPickerConfirm.disabled = true;
  vaultPickerConfirm.textContent = 'Opening…';
  try {
    const res = await fetch('/api/vault', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: _pickerChosenPath }),
    });
    if (res.ok) {
      // Optional hook for the Electron desktop shell (see electron/preload.js)
      // so it can remember this vault across restarts. No-op in the browser
      // and on mobile, same pattern as the window.Capacitor checks above.
      window.manuscriptDesktop?.notifyVaultChanged?.(_pickerChosenPath);
      closeVaultPicker();
      location.reload();
    } else {
      const err = await res.json();
      vaultPickerSel.textContent = 'Error: ' + err.error;
      vaultPickerConfirm.disabled = false;
      vaultPickerConfirm.textContent = 'Open Vault';
    }
  } catch {
    vaultPickerConfirm.disabled = false;
    vaultPickerConfirm.textContent = 'Open Vault';
  }
});

// ── Folder Action ────────────────────────────────────────────────────────────
const folderAction = document.getElementById('folder-action');
if (folderAction) {
  folderAction.addEventListener('click', openVaultPicker);
}

// ── PDF export ───────────────────────────────────────────────────────────────
// Single implementation, invoked from the settings/sync panel's "Download PDF"
// button (the sidebar no longer has its own PDF button — the settings panel is
// the one place both git sync and PDF export live now).
async function exportPdf() {
  const res = await fetch('/api/export/pdf');
  if (!res.ok) {
    let message = res.statusText || ('HTTP ' + res.status);
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch { /* body wasn't JSON — fall back to statusText above */ }
    throw new Error(message);
  }

  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);

  // Extract filename from headers if possible, or fallback
  let filename = 'manuscript.pdf';
  const disposition = res.headers.get('Content-Disposition');
  if (disposition && disposition.indexOf('filename=') !== -1) {
    filename = disposition.split('filename=')[1].replace(/["']/g, '');
  }

  // Trigger invisible native download
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();

  // Cleanup
  window.URL.revokeObjectURL(url);
  document.body.removeChild(a);
}

// ── Boot ─────────────────────────────────────────────────────────────────────
loadManifest();

// ── AI Agent panel (desktop feature, also reachable under plain npm/browser
// testing) ───────────────────────────────────────────────────────────────
// Self-contained like the Settings/Sync block below — MnAI builds its own
// settings-drawer DOM (mirroring #settings-overlay/#settings-panel) and
// wires the sidebar's #agent-action button itself. No agent logic lives in
// client.js; this is just the mount call, same relationship client.js has
// with MnEditor. See AppCode/ai-src/main.js and AppCode/CONTEXT.md.
//
// This used to be gated on `window.manuscriptDesktop?.isElectron`, which
// meant the button did nothing at all when running against the plain `npm
// start` server (no isElectron, so MnAI never mounted and nothing was
// listening on #agent-action — unlike Vault/Sync, which are wired
// unconditionally a few lines up). The feature's actual Electron-only piece
// is the encrypted key bridge, and that's already handled independently:
// ai-src/storage.js falls back to plain localStorage whenever
// window.manuscriptDesktop.getAiKey isn't present, and /api/ai/chat is a
// normal server route reachable the same way regardless of what's rendering
// the page. So the only thing the isElectron check was actually gating was
// "does the button open at all" — which broke testing outside Electron for
// no corresponding safety/capability reason. Mount whenever MnAI is on the
// page; storage.js's own tiering + the settings panel's honest
// "stored unencrypted" copy (see keyStorageDescription()) keep the
// non-Electron case truthful about what it's doing.
if (window.MnAI) {
  window.MnAI.mount({
    triggerEl: document.getElementById('agent-action'),
    // Stage 4: lets ai-src/agentRunner.js reach the live editor to insert
    // notes into, without client.js needing to know anything about the
    // agent feature itself. Called fresh on every run (not memoized by
    // MnAI), since `liveEditor` is reassigned on every chapter open — see
    // agentRunner.js's module comment for why that matters.
    getEditor: () => liveEditor,
    // Stage 5: lets 'all' scope in agentRunner.js tell which manifest entry
    // is the one currently mounted live, so that chapter's notes go through
    // the live editor (spliceNotes) instead of the raw-file read/write path
    // every other chapter uses.
    getCurrentPath: () => currentPath,
  });
}

// Stage 4: the Agent settings panel inserts notes via the same
// liveEditor.insertNoteAt() the manual "add note" flow uses, but
// remountAfterNoteMutation() (needed to avoid the stale-superscript-number
// bug — see that function's comment above) is private to this file. Rather
// than exporting it onto window, ai-src/settingsPanel.js dispatches this
// event once per completed run and client.js does the remount here — same
// division of responsibility as MnAI owning its own DOM/network/status
// logic while client.js remains the only thing that touches liveEditor.
window.addEventListener('mn:notes-mutated', () => {
  remountAfterNoteMutation();
});

// ── Settings / Git Sync drawer (mobile sync plan, Section 5.2) ──────────────
// Self-contained block — deliberately not interleaved with the functions above.
(function () {
  const overlay      = document.getElementById('settings-overlay');
  const panel         = document.getElementById('settings-panel');
  const closeBtn      = document.getElementById('settings-close');
  const settingsAction = document.getElementById('settings-action');

  const remoteUrlInput   = document.getElementById('git-remote-url');
  const tokenInput        = document.getElementById('git-token');
  const tokenSection       = document.getElementById('git-token-section');
  const tokenNote          = document.getElementById('git-token-note');
  const tokenNoteText      = document.getElementById('git-token-note-text');
  const authorNameInput   = document.getElementById('git-author-name');
  const authorEmailInput  = document.getElementById('git-author-email');
  const saveConfigBtn      = document.getElementById('git-save-config');
  const cloneVaultBtn      = document.getElementById('git-clone-vault');
  const pullBtn             = document.getElementById('git-pull-btn');
  const pushBtn             = document.getElementById('git-push-btn');
  const statusText          = document.getElementById('sync-status-text');
  const initialStatusText   = statusText ? statusText.textContent : '';
  const exportPdfSettings  = document.getElementById('export-pdf-settings');

  if (!overlay) return; // markup not present — nothing to wire up

  const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  // ── Token storage (frontend-only; never sent to the server for storage) ──
  // isomorphic-git (used by every backend this frontend talks to — laptop,
  // Electron, and mobile alike) authenticates purely over HTTPS via onAuth();
  // it never touches the OS's git credential manager or SSH keys, no matter
  // how the local `git` CLI is configured on that machine. So every platform
  // needs *some* token, not just mobile — the old "laptop: rely on system git
  // credentials" assumption below was wrong and caused 401s on Electron/laptop
  // pushes and pulls. The functions below are the single integration point so
  // the rest of this file never has to know which storage backend is in play:
  //   - native (Capacitor/mobile): capacitor-secure-storage-plugin, actually encrypted.
  //   - Electron (desktop): main-process safeStorage via the preload bridge
  //     (window.manuscriptDesktop) — backed by the OS keyring (libsecret/
  //     kwallet on Linux, Keychain on macOS, DPAPI on Windows). Actually
  //     encrypted at rest, and persists across restarts, so the token
  //     doesn't need retyping every launch.
  //   - plain browser (laptop, no Electron/Capacitor bridge available):
  //     localStorage. This is NOT encrypted — it's plain-text on disk
  //     (browser profile). Good enough to avoid retyping a PAT every
  //     session, but the token-field note in Settings must be honest about
  //     this; don't upgrade that copy to imply real secure storage until it
  //     is one. Electron also falls back here if the OS has no keyring
  //     backend available (rare — e.g. libsecret missing on a minimal Linux
  //     install); tokenStorageDescription() below reflects that case too.
  const hasElectronTokenBridge = () => !!(window.manuscriptDesktop && window.manuscriptDesktop.getStoredToken);

  async function getStoredToken() {
    try {
      if (isNative() && window.Capacitor?.Plugins?.SecureStoragePlugin) {
        const { value } = await window.Capacitor.Plugins.SecureStoragePlugin.get({ key: 'git-pat' });
        return value || '';
      }
      if (hasElectronTokenBridge()) {
        return (await window.manuscriptDesktop.getStoredToken()) || '';
      }
      return window.localStorage.getItem('git-pat') || '';
    } catch { /* not set yet or plugin/storage error */ }
    return '';
  }

  async function setStoredToken(token) {
    try {
      if (isNative() && window.Capacitor?.Plugins?.SecureStoragePlugin) {
        await window.Capacitor.Plugins.SecureStoragePlugin.set({ key: 'git-pat', value: token });
        return;
      }
      if (hasElectronTokenBridge()) {
        const result = await window.manuscriptDesktop.setStoredToken(token);
        if (result && result.ok) return;
        // OS keyring unavailable — fall back to localStorage rather than
        // silently losing the token, but keep it out of sync with the
        // (now stale) encrypted-storage assumption in the UI note.
        console.warn('[settings] OS keyring unavailable, falling back to localStorage:', result && result.reason);
        window.localStorage.setItem('git-pat', token);
        return;
      }
      window.localStorage.setItem('git-pat', token);
    } catch (e) {
      console.error('[settings] failed to store token:', e.message);
    }
  }

  // Drives the honest-storage-description note under the token field. Kept
  // as a small async function (rather than a static string) because the
  // Electron case has two different real answers depending on whether the
  // OS keyring actually came up.
  async function tokenStorageDescription() {
    if (isNative()) {
      return 'Stored in this device\u2019s secure storage, encrypted.';
    }
    if (hasElectronTokenBridge()) {
      const available = await window.manuscriptDesktop.isTokenEncryptionAvailable();
      return available
        ? 'Stored encrypted in your OS keyring, and remembered across restarts.'
        : 'Your OS has no secure keyring available, so this is stored unencrypted in local storage instead.';
    }
    return 'Stored in this browser\u2019s local storage, unencrypted.';
  }

  function openSettings() {
    overlay.classList.add('open');
    // The token field is needed on every platform now (see note above) —
    // only the helper text under it changes based on storage strength.
    tokenSection.style.display = '';
    tokenNote.style.display = '';
    tokenStorageDescription().then(text => { tokenNoteText.textContent = text; });

    fetch('/api/git/config').then(r => r.json()).then(cfg => {
      remoteUrlInput.value   = cfg.remoteUrl   || '';
      authorNameInput.value  = cfg.authorName  || '';
      authorEmailInput.value = cfg.authorEmail || '';
    }).catch(() => {});

    getStoredToken().then(t => { if (t) tokenInput.value = t; });

    refreshStatus();
  }

  function closeSettings() {
    overlay.classList.remove('open');
  }

  settingsAction && settingsAction.addEventListener('click', openSettings);
  closeBtn && closeBtn.addEventListener('click', closeSettings);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeSettings(); });

  async function refreshStatus() {
    try {
      const s = await fetch('/api/git/status').then(r => r.json());
      if (s.error) {
        statusText.textContent = 'Not yet synced';
        return;
      }
      let msg = `${s.ahead} to push, ${s.behind} to pull`;
      if (s.dirty && s.dirty.length) msg += ` — ${s.dirty.length} uncommitted change${s.dirty.length === 1 ? '' : 's'}`;
      statusText.textContent = msg;
    } catch {
      statusText.textContent = 'Status unavailable';
    }
  }

  const syncPendingBadge = document.getElementById('sync-pending-badge');

  // ── Launch-time remote check ────────────────────────────────────────────
  // On open, contact GitHub once (fetch-only, no merge — see checkRemote()
  // in lib/git-sync.js) so "N to pull" is accurate from the moment the app
  // opens, rather than only updating whenever someone happens to press Pull.
  // This is what "check GitHub on launch" means here: it does NOT auto-pull
  // — pulling still requires the person to press the Pull button, since an
  // automatic pull could clobber whatever they're about to type. It only
  // answers "is there something waiting", cheaply and safely.
  //
  // Offline handling: if the fetch fails (most commonly no network — the
  // exact case this was asked to handle), fall back to whatever ahead/behind
  // was last computed locally (checkRemote() itself never destroys that;
  // status() re-reads the existing remote-tracking ref either way) and say
  // so plainly rather than showing a scary error or a silently-wrong "0 to
  // pull". Never blocks app startup — this runs after the vault/chapter is
  // already loaded and rendered.
  async function checkRemoteOnLaunch() {
    let cfg;
    try {
      cfg = await fetch('/api/git/config').then(r => r.json());
    } catch {
      return; // no server reachable at all — nothing to check
    }
    const remoteUrl = cfg && cfg.remoteUrl;
    if (!remoteUrl) return; // nothing configured yet — nothing to check

    try {
      const token = await getStoredToken();
      const res = await fetch('/api/git/check-remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remoteUrl, token }),
      });
      const data = await res.json();
      if (data.error) return; // e.g. no vault selected yet — quietly skip

      if (data.checked) {
        if (data.behind > 0 && syncPendingBadge) syncPendingBadge.style.display = '';
        // Only overwrite the status line if it's still showing its initial
        // placeholder — a real action (manual pull/push, or an error from
        // one) that happened to run first should win, not get clobbered by
        // this background check finishing later.
        if (statusText.textContent === initialStatusText) {
          let msg = `${data.ahead} to push, ${data.behind} to pull`;
          if (data.dirty && data.dirty.length) msg += ` — ${data.dirty.length} uncommitted change${data.dirty.length === 1 ? '' : 's'}`;
          statusText.textContent = msg;
        }
      } else if (data.reason === 'network') {
        // Offline: show the last-known-locally-cached counts (still
        // meaningful — just possibly stale) with an honest caveat, instead
        // of either a bare error or silently doing nothing.
        if (statusText.textContent === initialStatusText) {
          statusText.textContent = `Offline — showing last known status: ${data.ahead} to push, ${data.behind} to pull`;
        }
        if (data.behind > 0 && syncPendingBadge) syncPendingBadge.style.display = '';
      }
      // Any other failure reason (auth error, etc.): stay quiet on launch —
      // the person will see the real error if/when they open Settings and
      // press Pull themselves, same as today. A launch-time check shouldn't
      // surface a scarier error than pressing the button would.
    } catch {
      // Network layer itself threw (e.g. fetch to our own /api failed) —
      // nothing useful to show; stay silent rather than guess.
    }
  }

  saveConfigBtn && saveConfigBtn.addEventListener('click', async () => {
    saveConfigBtn.disabled = true;
    try {
      await fetch('/api/git/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remoteUrl:   remoteUrlInput.value.trim(),
          authorName:  authorNameInput.value.trim(),
          authorEmail: authorEmailInput.value.trim(),
        }),
      });
      await setStoredToken(tokenInput.value);
      statusText.textContent = 'Settings saved.';
    } catch (e) {
      statusText.textContent = 'Could not save settings: ' + e.message;
    } finally {
      saveConfigBtn.disabled = false;
    }
  });

  cloneVaultBtn && cloneVaultBtn.addEventListener('click', async () => {
    const remoteUrl = remoteUrlInput.value.trim();
    if (!remoteUrl) { statusText.textContent = 'Enter a remote repository URL first.'; return; }
    cloneVaultBtn.disabled = true;
    statusText.textContent = 'Cloning…';
    try {
      const token = await getStoredToken();
      const res = await fetch('/api/git/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remoteUrl, token }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Clone failed');
      statusText.textContent = 'Cloned. Loading vault…';
      closeSettings();
      loadManifest();
    } catch (e) {
      statusText.textContent = 'Clone failed: ' + e.message;
    } finally {
      cloneVaultBtn.disabled = false;
    }
  });

  pullBtn && pullBtn.addEventListener('click', () => doSync('pull'));
  pushBtn && pushBtn.addEventListener('click', () => doSync('push'));

  async function doSync(kind, { silent = false } = {}) {
    const remoteUrl = remoteUrlInput ? remoteUrlInput.value.trim() : '';
    if (!remoteUrl) {
      if (!silent) statusText.textContent = 'No remote configured yet.';
      return;
    }
    if (!silent) {
      statusText.textContent = kind === 'pull' ? 'Pulling…' : 'Pushing…';
      pullBtn.disabled = true;
      pushBtn.disabled = true;
    }
    try {
      const token = await getStoredToken();
      const res = await fetch(`/api/git/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remoteUrl, token }),
      });
      const data = await res.json();
      let resultMsg = null;
      if (data.ok) {
        resultMsg = kind === 'pull' ? 'Pulled successfully.' : 'Pushed successfully.';
        if (kind === 'pull') {
          // A pull can add/remove/rename/reorder files (front/chapters/back),
          // so the sidebar itself needs rebuilding, not just the open
          // chapter's text — this previously only called silentRefresh(),
          // which never touches the manifest, so new/renamed chapters from
          // a pulled commit didn't show up until the whole app was
          // restarted (restart re-runs loadManifest() on boot, which is why
          // that "fixed" it). refreshManifestSidebar() rebuilds the sidebar
          // without loadManifest()'s boot-time "jump to saved progress or
          // first chapter" behavior, so it won't yank the person away from
          // whatever they're currently reading. Await it so the sidebar is
          // in its final state before the status message below is shown.
          await refreshManifestSidebar();
          // force: true — a completed pull is new ground truth for the
          // currently open file, not a maybe-stale WS ping. Without force,
          // this could still silently no-op if a debounced local save
          // happened to still be pending (saveTimer) or the fetched content
          // happened to match _lastRenderedRaw, neither of which should be
          // able to swallow a pull the person explicitly asked for.
          if (currentPath) await silentRefresh({ force: true });
          if (syncPendingBadge) syncPendingBadge.style.display = 'none';
        }
      } else if (data.reason === 'diverged') {
        resultMsg = 'Push rejected — pull/resolve on laptop.';
      } else if (data.reason === 'conflict') {
        resultMsg = `Conflict in: ${(data.files || []).join(', ')} — resolve on laptop.`;
      } else if (data.reason === 'network') {
        resultMsg = 'No network — try again later.';
      } else {
        resultMsg = 'Sync error: ' + (data.message || data.error || 'unknown');
      }
      // Refresh the ahead/behind counts first, then overlay the specific result
      // message on top — refreshStatus() must never clobber a conflict/error the
      // person needs to actually read.
      await refreshStatus();
      if (!silent) statusText.textContent = resultMsg;
    } catch (e) {
      if (!silent) statusText.textContent = 'Network error: ' + e.message;
    } finally {
      if (!silent) {
        pullBtn.disabled = false;
        pushBtn.disabled = false;
      }
    }
  }

  exportPdfSettings && exportPdfSettings.addEventListener('click', async () => {
    const label = document.getElementById('export-pdf-settings-label');
    const originalText = label ? label.textContent : '';

    exportPdfSettings.disabled = true;
    if (label) label.textContent = 'Wait...';

    try {
      await exportPdf();
    } catch (e) {
      statusText.textContent = 'Could not export PDF: ' + e.message;
    } finally {
      exportPdfSettings.disabled = false;
      if (label) label.textContent = originalText;
    }
  });

  // ── Reconciling with the existing "Vault" sidebar button (Section 5.3) ──────
  // On phone, the local-filesystem folder browser doesn't apply — the vault is
  // fixed to the git clone location. Hide it and let the sync icon take its slot.
  if (isNative()) {
    const folderActionEl = document.getElementById('folder-action');
    if (folderActionEl) folderActionEl.style.display = 'none';
  }

  // ── "Open app → try sync" (Section 1.5 / 5.2) ────────────────────────────────
  // Silent pull on load if running inside Capacitor and a vault is already
  // configured. This actually pulls (merges), not just checks — mobile is the
  // one platform where that's been judged safe to do automatically, since a
  // phone is rarely mid-edit the instant the app opens. Errors used to be
  // swallowed entirely, including network errors — meaning "no network" was
  // handled by doing nothing and saying nothing, which isn't the same as
  // handling it. Now a network failure specifically gets a visible, calm
  // status line instead of silence; other errors (auth, conflict) still
  // surface naturally the next time the person opens Settings, same as before.
  async function attemptSilentPullIfConfigured() {
    if (!isNative()) return;
    try {
      const cfg = await fetch('/api/git/config').then(r => r.json());
      if (cfg.remoteUrl) {
        remoteUrlInput && (remoteUrlInput.value = cfg.remoteUrl);
        const token = await getStoredToken();
        const res = await fetch('/api/git/pull', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ remoteUrl: cfg.remoteUrl, token }),
        });
        const data = await res.json();
        if (data.ok) {
          if (currentPath) await silentRefresh({ force: true });
          if (syncPendingBadge) syncPendingBadge.style.display = 'none';
          await refreshStatus();
        } else if (data.reason === 'network' && statusText.textContent === initialStatusText) {
          statusText.textContent = 'Offline — couldn\u2019t check for updates.';
        }
        // Other failure reasons (auth/conflict/etc.) stay quiet here, same
        // as before — they'll surface normally if the person opens Settings.
      }
    } catch { /* our own /api unreachable — offline is a normal state */ }
  }
  attemptSilentPullIfConfigured();

  // ── Launch-time remote check (laptop / Electron desktop) ────────────────
  // Mobile already does a real silent pull above; a second check-only call
  // here would just be a redundant network round-trip against the same
  // remote. Everywhere else, nothing has checked GitHub yet at this point —
  // this is what makes "N to pull" accurate the moment the app opens rather
  // than only after someone presses Pull once. See checkRemoteOnLaunch()
  // above for exactly what this does and does not do (check-only, no merge;
  // offline-safe).
  if (!isNative()) checkRemoteOnLaunch();

  // Also attempt a silent pull on resume-from-background (Section 5.2, mobile only).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      attemptSilentPullIfConfigured();
    } else if (document.visibilityState === 'hidden') {
      // Flush progress immediately when the app is backgrounded/closed.
      // The scroll listener alone (800ms debounce) misses the common case
      // of "open a chapter, read without scrolling, switch apps" — nothing
      // ever fires in that window, so the last-read position silently
      // reverts to whatever was saved previously (or never saved at all).
      if (currentPath) {
        const main = document.getElementById('main');
        fetch('/api/progress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: currentPath, scrollTop: main ? main.scrollTop : 0 }),
          keepalive: true, // request must survive the page/worker tearing down
        }).catch(() => {});
      }
    }
  });
})();

// ==========================================
// SEAMLESS FONT SIZE ADJUSTER
// ==========================================
(function() {
    function setupFontSizeSlider() {
        const slider = document.getElementById('font-size-slider');
        if (!slider) return;

        // Retrieve saved choice or default to 17px
        const savedSize = localStorage.getItem('reader-font-size') || '17';
        slider.value = savedSize;
        
        // Apply variable to the root HTML tag so it persists across chapter loads
        const applyFontSize = (size) => {
            document.documentElement.style.setProperty('--reader-font-size', `${size}px`);
            // Changing the font size reflows every paragraph's height, which
            // moves every .mn-anchor in the text — margin chips must be
            // recomputed or they drift out of alignment with their line.
            // Wait a frame so the browser has applied the new font-size and
            // reflowed layout before we re-measure anchor positions.
            requestAnimationFrame(() => {
                if (typeof positionChips === 'function') positionChips();
            });
        };

        // Set on load
        applyFontSize(savedSize);

        // Listen for adjustments
        slider.addEventListener('input', (e) => {
            const size = e.target.value;
            applyFontSize(size);
            localStorage.setItem('reader-font-size', size);
        });
    }

    // Try executing immediately
    setupFontSizeSlider();

    // Fallback if elements aren't parsed by the browser yet
    if (document.readyState === 'loading') {
        document.addEventListener('readystatechange', () => {
            if (document.readyState === 'interactive') {
                setupFontSizeSlider();
            }
        });
    }
})();

// ── Native status bar color (Android) ───────────────────────────────────────
// Match the OS status bar (clock/battery/signal strip above the WebView) to
// the app's own paper background instead of leaving it at Android's default
// dark/system color, so the very top of the screen reads as one continuous
// surface with the in-page .topbar beneath it, same idea as the desktop
// title bar. capacitor.config.json sets the same color/style at native
// startup already; calling the plugin here too covers any runtime theme
// changes and matches the existing window.Capacitor.Plugins.* access
// pattern already used above for SecureStoragePlugin.
(function syncNativeStatusBar() {
    const onNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    const StatusBar = window.Capacitor?.Plugins?.StatusBar;
    if (!onNative || !StatusBar) return;

    StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
    StatusBar.setBackgroundColor({ color: '#f4f2ee' }).catch(() => {});
    // "Light" style = dark icons/text, correct for our light paper background.
    StatusBar.setStyle({ style: 'LIGHT' }).catch(() => {});
})();