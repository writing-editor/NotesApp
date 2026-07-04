// ── State ────────────────────────────────────────────────────────────────────
let currentPath      = null;
let currentNotes     = [];
let pendingPos       = null;
let activeChip       = null;
let activeMarker     = null;
let selectedNoteType = '';
let editingPara      = null;
let editingStart     = null;
let editingEnd       = null;
let editingSaved     = false;
let _progressTimer   = null;
let _lastRenderedHtml = ''; // used to skip WS reloads that match what we already rendered
let cachedTOCHeight  = 0;
let tocTicking       = false;

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
    if (editingPara || docModeActive) return; // don't interrupt an active edit
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
async function loadManifest() {
  let data;
  try {
    const res = await fetch('/api/manifest');
    if (!res.ok) {
      // If server returns 400, it means no vault is set
      if (res.status === 400) throw new Error('NO_VAULT');
      throw new Error('HTTP ' + res.status);
    }
    data = await res.json();
  } catch (e) {
    if (e.message === 'NO_VAULT') {
      document.getElementById('page-wrap').innerHTML =
        `<div class="state-msg">No vault selected.<br><small>Click the <b>Open Vault</b> button in the sidebar to set your book folder.</small></div>`;
    } else {
      document.getElementById('page-wrap').innerHTML =
        `<div class="state-msg" style="color:#c0392b;">Could not load manifest: ${e.message}</div>`;
    }
    return;
  }

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

  // Build flat list of all valid paths from this manifest
  const allPaths = data.sections.flatMap(s => s.files.map(f => f.path));

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

  try {
    const res = await fetch('/api/chapter?path=' + encodeURIComponent(relPath));
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      wrap.innerHTML = `<div class="state-msg" style="color:#c0392b;">Error loading chapter: ${err.error || res.status}<br><small>${relPath}</small></div>`;
      return;
    }
    const data   = await res.json();
    currentNotes = data.notes || [];
    _lastRenderedHtml = data.bodyHtml;
    renderChapter(data);
  } catch (e) {
    wrap.innerHTML = `<div class="state-msg" style="color:#c0392b;">Network error: ${e.message}</div>`;
  }
}

function renderChapter(data) {
  const wrap = document.getElementById('page-wrap');

  // Derive title from first h1 in bodyHtml
  const titleMatch = data.bodyHtml.match(/<h1[^>]*>(.*?)<\/h1>/i);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '') : '';

  const wordCount = data.words
    ? `<span style="font-family:var(--font-ui);font-size:0.55rem;color:var(--ink-faint);letter-spacing:0.08em;margin-left:1.2rem;">${data.words.toLocaleString()} words</span>`
    : '';

  wrap.innerHTML = `
    <header class="chapter-header">
      <div class="chapter-label">
        Draft${wordCount}
        <button class="edit-mode-toggle" id="edit-mode-toggle" title="Toggle edit mode (Ctrl+E)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
          <span>Edit</span>
        </button>
      </div>
      <h1>${title}</h1>
    </header>
    <article class="main-text" id="main-text">${data.bodyHtml}</article>
    <aside class="margin-col" id="margin-col"></aside>
    <div class="editor-wrap" id="editor-wrap" style="display:none;">
      <div class="editor-toolbar">
        <span class="editor-toolbar-hint">Editing · click away or Ctrl/Cmd+Enter to save · Esc to discard · Ctrl/Cmd+B bold · Ctrl/Cmd+I italic</span>
      </div>
      <div class="editor-mount" id="editor-mount"></div>
    </div>
  `;

  positionChips();
  buildScrollbarTOC();
  setupProgressSave();
  setupInlineEditing();
  setupEditModeToggle();
}

// ── Silent refresh — swap content without scroll jump or blink ───────────────
// Used for all in-chapter updates: note add/delete/retype, inline edit save,
// WS file-change signals. Never touches the scroll position.
async function silentRefresh() {
  if (!currentPath || editingPara || docModeActive) return;

  try {
    const res = await fetch('/api/chapter?path=' + encodeURIComponent(currentPath));
    if (!res.ok) return;
    const data = await res.json();

    // Skip if content is identical to what we already rendered (prevents
    // double-render when we trigger a WS event from our own write).
    if (data.bodyHtml === _lastRenderedHtml) return;

    const mainText  = document.getElementById('main-text');
    const marginCol = document.getElementById('margin-col');
    if (!mainText || !marginCol) return;

    // Capture scroll before any DOM mutation
    const main      = document.getElementById('main');
    const savedScroll = main ? main.scrollTop : 0;

    // Swap the two inner regions only — header stays, no "Loading…" flash
    currentNotes    = data.notes || [];
    _lastRenderedHtml = data.bodyHtml;
    mainText.innerHTML  = data.bodyHtml;
    marginCol.innerHTML = '';

    // Restore scroll synchronously before the browser paints
    if (main) main.scrollTop = savedScroll;

    positionChips();
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

// ── Whole-chapter edit mode (CodeMirror) ─────────────────────────────────────
// Replaces the old "edit one paragraph via tooltip" flow. View mode still
// renders exactly the same server HTML as before; edit mode swaps the whole
// #main-text region for a CodeMirror instance over the raw markdown file,
// and saving writes the whole file back via /api/raw.
let cmEditor = null;
let docModeActive = false;

function setupEditModeToggle() {
  const toggleBtn = document.getElementById('edit-mode-toggle');
  if (!toggleBtn) return;
  toggleBtn.addEventListener('click', () => {
    docModeActive ? exitDocEditMode(true) : enterDocEditMode();
  });
}

// Global shortcut: Ctrl/Cmd+E toggles edit mode for the current chapter
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
    if (!currentPath) return;
    e.preventDefault();
    docModeActive ? exitDocEditMode(true) : enterDocEditMode();
  }
});

async function enterDocEditMode() {
  if (!currentPath || docModeActive) return;
  if (!window.MnEditor) { console.error('Editor bundle not loaded'); return; }

  // If an old single-paragraph edit was somehow active, let it save/close first
  if (editingPara) await exitEditMode(true);

  const res = await fetch('/api/raw?path=' + encodeURIComponent(currentPath));
  if (!res.ok) return;
  const { raw } = await res.json();

  const mainText     = document.getElementById('main-text');
  const editorWrap    = document.getElementById('editor-wrap');
  const mount         = document.getElementById('editor-mount');
  const toggleBtn      = document.getElementById('edit-mode-toggle');
  const topbarToggle    = document.getElementById('topbar-edit-toggle');
  const mobileEditBar   = document.getElementById('mobile-edit-bar');
  if (!mainText || !editorWrap || !mount) return;

  mainText.style.display  = 'none';
  editorWrap.style.display = 'block';
  toggleBtn.classList.add('active');
  toggleBtn.querySelector('span').textContent = 'Viewing…';
  if (topbarToggle) topbarToggle.classList.add('active');
  if (mobileEditBar) mobileEditBar.classList.add('open');
  docModeActive = true;

  // Selection-driven note tooltip doesn't apply while editing raw markdown
  selTooltip.classList.remove('visible');

  cmEditor = window.MnEditor.createMarkdownEditor({
    doc: raw,
    parent: mount,
    onSave: () => exitDocEditMode(true),
    onCancel: () => exitDocEditMode(false),
  });
  cmEditor.focus();

  // Click-away-to-save: clicking anywhere outside the editor (sidebar, nav,
  // margin, another chapter, etc.) saves and exits — mirrors the old
  // per-paragraph onEditBlur behavior, since on a long document scrolling
  // back up to tap "Save" isn't realistic. Escape (wired in the CodeMirror
  // bundle's keymap) discards instead.
  document.addEventListener('mousedown', onDocEditClickAway, { capture: true });
}

function onDocEditClickAway(e) {
  if (!docModeActive) return;
  const editorWrap = document.getElementById('editor-wrap');
  if (!editorWrap) return;
  // Clicks inside the editor itself, or on its own save/cancel buttons,
  // don't count as "away" — CodeMirror needs normal click-to-place-cursor.
  if (editorWrap.contains(e.target)) return;
  // Clicking the Edit/Viewing toggle button itself is handled by its own
  // click listener (which calls exitDocEditMode(true) already) — ignore
  // here to avoid a double save. Same for the mobile topbar toggle and the
  // mobile check/x save-bar, which have their own explicit handlers below.
  if (e.target.closest('#edit-mode-toggle')) return;
  if (e.target.closest('#topbar-edit-toggle')) return;
  if (e.target.closest('#mobile-edit-bar')) return;
  exitDocEditMode(true);
}

async function exitDocEditMode(save) {
  if (!docModeActive || !cmEditor) return;

  document.removeEventListener('mousedown', onDocEditClickAway, { capture: true });

  const text = cmEditor.getDoc();
  const editorWrap    = document.getElementById('editor-wrap');
  const mainText      = document.getElementById('main-text');
  const toggleBtn      = document.getElementById('edit-mode-toggle');
  const topbarToggle    = document.getElementById('topbar-edit-toggle');
  const mobileEditBar   = document.getElementById('mobile-edit-bar');

  cmEditor.destroy();
  cmEditor = null;
  docModeActive = false;

  if (editorWrap) editorWrap.style.display = 'none';
  if (mainText)   mainText.style.display = '';
  if (toggleBtn) {
    toggleBtn.classList.remove('active');
    toggleBtn.querySelector('span').textContent = 'Edit';
  }
  if (topbarToggle) topbarToggle.classList.remove('active');
  if (mobileEditBar) mobileEditBar.classList.remove('open');

  if (save) {
    await fetch('/api/raw', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: currentPath, text }),
    }).catch(() => {});
    // Force a re-render from the freshly saved file — same pattern as
    // exitEditMode's save path: invalidate the cache, then silentRefresh.
    _lastRenderedHtml = '';
    await silentRefresh();
  }
}

// Mobile topbar edit toggle — same enter/exit functions as desktop
document.getElementById('topbar-edit-toggle')?.addEventListener('click', () => {
  docModeActive ? exitDocEditMode(true) : enterDocEditMode();
});

// Mobile check/x save-bar — icon-only equivalents of desktop's
// click-away/Ctrl+Enter/Escape, since mobile has neither.
document.getElementById('mobile-edit-save')?.addEventListener('click', () => exitDocEditMode(true));
document.getElementById('mobile-edit-cancel')?.addEventListener('click', () => exitDocEditMode(false));

// ── Inline paragraph editing ─────────────────────────────────────────────────
function setupInlineEditing() {
  // Intentionally empty. Editing now happens exclusively through the
  // whole-chapter CodeMirror edit mode (enterDocEditMode/exitDocEditMode).
}

// Kept as a no-op guard: editingPara should never be set anymore now that
// paragraph-by-paragraph contentEditable editing has been replaced by the
// whole-document CodeMirror edit mode, but a few call sites (WS handler,
// silentRefresh) still check `editingPara` defensively, and
// enterDocEditMode() calls this before opening the CodeMirror view in case
// older client state was somehow mid-edit.
async function exitEditMode(save) {
  editingPara  = null;
  editingStart = null;
  editingEnd   = null;
  editingSaved = false;
}

function buildScrollbarTOC() {
  const mainText = document.getElementById('main-text');
  const tocPopup = document.getElementById('toc-popup');
  if (!mainText || !tocPopup) return;

  cachedTOCHeight = 0;

  const headings = mainText.querySelectorAll('h1, h2, h3');
  if (headings.length === 0) {
    tocPopup.innerHTML = '<div class="toc-link toc-h3">No headings in this chapter</div>';
    return;
  }

  let html = ''; // No title, just seamless content
  
  headings.forEach((h, i) => {
    const id = 'heading-' + i;
    h.id = id; 
    const level = h.tagName.toLowerCase(); 
    html += `<a href="#${id}" class="toc-link toc-${level}">${h.textContent}</a>`;
  });

  tocPopup.innerHTML = html;

  tocPopup.querySelectorAll('.toc-link').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const targetEl = document.querySelector(link.getAttribute('href'));
      if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  currentNotes.forEach(note => {
    const anchor = mainText.querySelector(`.mn-anchor[data-note-id="${note.id}"]`);
    if (!anchor) return;

    const aRect      = anchor.getBoundingClientRect();
    const naturalTop = aRect.top + scrollTop - marginTop;

    // Rough estimate of how many lines the full note would need to render
    // without clamping — used both as an upper bound and as a "weight" when
    // splitting shared space between competing notes below.
    const approxCharsPerLine = 32; // tuned to .mn-chip-preview's width/font
    const desiredLines = Math.max(1, Math.ceil(note.content.length / approxCharsPerLine));

    items.push({
      note,
      anchor,
      naturalTop,
      connectorTop: aRect.height / 2,
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
    const marker = anchor.querySelector('.mn-marker');
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
  const typeLabels = { query: 'Query', ref: 'Reference', todo: 'Todo' };
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
const selTooltip = document.getElementById('sel-tooltip');
// Listen to native selection changes, debounced to avoid flickering
document.addEventListener('selectionchange', () => {
  clearTimeout(window._selTimeout);
  window._selTimeout = setTimeout(handleSelectionEnd, 250);
});

// CRITICAL MOBILE FIX: Prevent text selection from clearing when you tap the tooltip
selTooltip.addEventListener('mousedown', e => e.preventDefault());
selTooltip.addEventListener('touchstart', e => e.preventDefault(), { passive: false });

function handleSelectionEnd() {
  if (editingPara || docModeActive) return; // don't show note tooltip while editing
  
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) {
    selTooltip.classList.remove('visible');
    return;
  }

  // Ensure selection is inside main-text
  const mainText = document.getElementById('main-text');
  if (!mainText) return;
  const range = sel.getRangeAt(0);
  if (!mainText.contains(range.commonAncestorContainer)) {
    selTooltip.classList.remove('visible');
    return;
  }

  // Position tooltip above the selection (CSS !important overrides this on mobile)
  const rect = range.getBoundingClientRect();
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

  // Store what we need to write the note
  pendingPos = resolveSelectionPosition(range, sel.toString());
}

function resolveSelectionPosition(range, selectedText) {
  // Walk up from the anchor node to find the nearest txt-seg span
  let node = range.startContainer;
  let seg  = null;

  while (node && node !== document.getElementById('main-text')) {
    if (node.classList && node.classList.contains('txt-seg')) { seg = node; break; }
    node = node.parentElement;
  }

  if (!seg) return null;

  const blockOffset = parseInt(seg.dataset.block, 10); // char offset of block in file
  const segOffset   = parseInt(seg.dataset.off,   10); // char offset of segment in block
  // range.startOffset is char offset within the text node inside the seg span
  const localOffset = range.startOffset;

  const charPos    = blockOffset + segOffset + localOffset;
  const contextText = selectedText.trim().slice(0, 60);

  return { charPos, contextText };
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
  window.getSelection()?.removeAllRanges();

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
  noteSheet.classList.remove('open');
  selTooltip.classList.remove('visible');
  pendingPos = null;
}

async function saveNote() {
  const text = sheetInput.value.trim();
  if (!text || !pendingPos || !currentPath) return;

  const btn = document.getElementById('sheet-save');
  btn.disabled = true;
  btn.style.opacity = '0.5';

  try {
    const res = await fetch('/api/note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path:      currentPath,
        charPos:   pendingPos.charPos,
        noteText:  text,
        noteType:  selectedNoteType || null,
      }),
    });

    if (res.ok) {
      closeSheet();
      await silentRefresh();
    } else {
      const err = await res.json();
      alert('Error saving note: ' + err.error);
    }
  } finally {
    btn.disabled = false;
    btn.style.opacity = '1';
  }
}

async function retypeNote(note, newType) {
  if (!currentPath) return;
  // Delete the old marker, then rewrite it with new type at same position
  // We use a dedicated PATCH endpoint for this
  await fetch('/api/note', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path:    currentPath,
      noteId:  note.id,
      charPos: note.charPos,
      newType: newType,
    }),
  });
  await silentRefresh();
}

async function removeNote(noteId, charPos) {
  if (!currentPath) return;
  await fetch('/api/note', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: currentPath, noteId, charPos }),
  });
  await silentRefresh();
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
    await enterDocEditMode();      // drop straight into edit mode to start writing
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
  const authorNameInput   = document.getElementById('git-author-name');
  const authorEmailInput  = document.getElementById('git-author-email');
  const saveConfigBtn      = document.getElementById('git-save-config');
  const cloneVaultBtn      = document.getElementById('git-clone-vault');
  const pullBtn             = document.getElementById('git-pull-btn');
  const pushBtn             = document.getElementById('git-push-btn');
  const statusText          = document.getElementById('sync-status-text');
  const exportPdfSettings  = document.getElementById('export-pdf-settings');

  if (!overlay) return; // markup not present — nothing to wire up

  const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  // ── Secure token storage (frontend-only; never sent to the server for storage) ──
  // On the phone, this should call the Capacitor secure-storage plugin
  // (e.g. capacitor-secure-storage-plugin) — NOT @capacitor/preferences, which is
  // not encrypted. That plugin call is added when the Capacitor project (Section 6)
  // is wired up; these two functions are the single integration point so the rest
  // of this file never has to know which storage backend is in play.
  // ── Secure token storage (frontend-only; never sent to the server for storage) ──
  async function getStoredToken() {
    if (!isNative()) return ''; // laptop: rely on system git credentials
    try {
      if (window.Capacitor?.Plugins?.SecureStoragePlugin) {
        const { value } = await window.Capacitor.Plugins.SecureStoragePlugin.get({ key: 'git-pat' });
        return value || '';
      }
    } catch { /* not set yet or plugin error */ }
    return '';
  }

  async function setStoredToken(token) {
    if (!isNative()) return;
    try {
      if (window.Capacitor?.Plugins?.SecureStoragePlugin) {
        await window.Capacitor.Plugins.SecureStoragePlugin.set({ key: 'git-pat', value: token });
      }
    } catch (e) {
      console.error('[settings] failed to store token securely:', e.message);
    }
  }

  function openSettings() {
    overlay.classList.add('open');
    // Token field / note only make sense in their respective contexts (Section 3.4).
    if (isNative()) {
      tokenSection.style.display = '';
      tokenNote.style.display = 'none';
    } else {
      tokenSection.style.display = 'none';
      tokenNote.style.display = '';
    }

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
        if (kind === 'pull' && currentPath) silentRefresh();
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
  // configured. Errors are swallowed — this must never block the initial render.
  async function attemptSilentPullIfConfigured() {
    if (!isNative()) return;
    try {
      const cfg = await fetch('/api/git/config').then(r => r.json());
      if (cfg.remoteUrl) {
        remoteUrlInput && (remoteUrlInput.value = cfg.remoteUrl);
        await doSync('pull', { silent: true });
      }
    } catch { /* swallow — offline is a normal state */ }
  }
  attemptSilentPullIfConfigured();

  // Also attempt a silent pull on resume-from-background (Section 5.2).
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