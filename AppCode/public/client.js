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
    if (editingPara) return; // don't interrupt an active edit
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

  data.sections.forEach(section => {
    const label = document.createElement('div');
    label.className = 'nav-section-label';
    label.textContent = section.label;
    nav.appendChild(label);

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
      <div class="chapter-label">Draft${wordCount}</div>
      <h1>${title}</h1>
    </header>
    <article class="main-text" id="main-text">${data.bodyHtml}</article>
    <aside class="margin-col" id="margin-col"></aside>
  `;

  positionChips();
  buildScrollbarTOC();
  setupProgressSave();
  setupInlineEditing();
}

// ── Silent refresh — swap content without scroll jump or blink ───────────────
// Used for all in-chapter updates: note add/delete/retype, inline edit save,
// WS file-change signals. Never touches the scroll position.
async function silentRefresh() {
  if (!currentPath || editingPara) return;

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

// ── Inline paragraph editing ─────────────────────────────────────────────────
function setupInlineEditing() {
  // Intentionally empty — edit mode is entered via the ✎ Edit button
  // in the selection tooltip (handleEditPara), not via dblclick.
  // The tooltip + pendingPos flow must remain uninterrupted for note-adding to work.
}

async function enterEditMode(para, cursorOffset) {
  if (editingPara && editingPara !== para) await exitEditMode(true);

  const blockStart = parseInt(para.dataset.block, 10);

  // Fetch raw source of this block
  const res  = await fetch(`/api/block?path=${encodeURIComponent(currentPath)}&start=${blockStart}`);
  if (!res.ok) return;
  const data = await res.json();

  editingPara  = para;
  editingStart = data.start;
  editingEnd   = data.end;
  editingSaved = false;

  // Snapshot the rendered HTML so cancel can restore it without a network round-trip
  para._preEditHtml = para.innerHTML;

  // Replace rendered HTML with live-preview editable content
  para.contentEditable = 'true';
  para.spellcheck      = true;
  renderEditContent(para, data.raw);

  // Place cursor at click position (best effort — fall back to end)
  para.focus();
  if (cursorOffset !== undefined && cursorOffset !== null) {
    restoreCaretPosition(para, cursorOffset);
  } else {
    placeCursorAtEnd(para);
  }

  // Keyboard handler
  para.addEventListener('keydown', onEditKeydown);
  para.addEventListener('input',   onEditInput);
  para.addEventListener('blur',    onEditBlur, { once: true });
}

async function exitEditMode(save) {
  if (!editingPara) return;
  const para = editingPara;

  para.removeEventListener('keydown', onEditKeydown);
  para.removeEventListener('input',   onEditInput);
  para.classList.remove('dirty');

  // Capture editing coords before we clear state, since the PUT still needs them
  const savedStart = editingStart;
  const savedEnd   = editingEnd;
  const wasSaved   = editingSaved;

  // Clear state immediately — any re-entrant calls see a clean slate
  editingPara  = null;
  editingStart = null;
  editingEnd   = null;
  editingSaved = false;

  if (save && !wasSaved) {
    editingSaved = true;
    const text = extractRawFromEditable(para);
    if (text.trim()) {
      await fetch('/api/block', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          path:  currentPath,
          start: savedStart,
          end:   savedEnd,
          text,
        }),
      }).catch(() => {});
      // Invalidate the html cache so silentRefresh doesn't skip the re-render,
      // then refresh in place — no scroll jump, no blink.
      _lastRenderedHtml = '';
      await silentRefresh();
    }
    return;
  }
  // Cancel path (save=false): no file changed, no reload — just restore
  // the paragraph to its pre-edit rendered HTML without a full chapter fetch.
  para.contentEditable = 'false';
  para.innerHTML = para._preEditHtml || para.innerHTML;
}

function onEditKeydown(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    exitEditMode(true);
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    exitEditMode(false);
  }
}

function onEditInput() {
  if (!editingPara) return;
  // Add subtle dirty shadow on first keystroke — cleared on save/cancel
  editingPara.classList.add('dirty');
  // Re-render syntax highlights without disrupting cursor
  const raw    = extractRawFromEditable(editingPara);
  const saved  = saveCaretPosition(editingPara);
  renderEditContent(editingPara, raw);
  restoreCaretPosition(editingPara, saved);
}

function onEditBlur() {
  // Delay longer than a click event cycle so that if the user clicked a
  // toolbar button (save, cancel, note-sheet buttons), that click handler
  // runs first and can call exitEditMode() directly — preventing a double-save.
  setTimeout(() => {
    if (editingPara && !editingSaved) exitEditMode(true);
  }, 200);
}

// ── Live syntax rendering inside contenteditable ─────────────────────────────
//
// We keep it simple: strip the mn-anchor spans out (they're read-only anchors,
// not editable), then highlight **bold** and *italic* syntax tokens inline
// so the writer can see what they're doing without raw noise.

function renderEditContent(para, raw) {
  // Strip [mn...] markers from the editable view — they're handled separately
  // Replace them with a non-editable anchor badge so the writer sees them
  let display = raw;

  // Highlight **bold** → wrap syntax chars + word
  display = display.replace(/(\*\*)(.+?)(\*\*)/g,
    (_, o, word, c) =>
      `<span class="md-bold-syntax">${esc(o)}</span><span class="md-bold">${esc(word)}</span><span class="md-bold-syntax">${esc(c)}</span>`
  );
  // Highlight *italic* (single star, not double)
  display = display.replace(/(?<!\*)(\*)(?!\*)(.+?)(?<!\*)(\*)(?!\*)/g,
    (_, o, word, c) =>
      `<span class="md-em-syntax">${esc(o)}</span><span class="md-em">${esc(word)}</span><span class="md-em-syntax">${esc(c)}</span>`
  );
  // [mn...] markers show as a small non-editable badge
  display = display.replace(/\[mn(?:\.\w+)?\s*:[\s\S]*?\]/g,
    m => `<span contenteditable="false" class="mn-marker" style="font-size:0.6em;vertical-align:super;color:var(--accent);user-select:none;">${esc(m)}</span>`
  );

  para.innerHTML = display;
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Pull the plain text back out of the contenteditable, restoring the raw
// markdown (the syntax spans contain the literal * chars already as text)
function extractRawFromEditable(para) {
  // Walk the DOM and collect text — the md-* spans contain the literal
  // asterisk characters, mn-marker spans should be preserved as-is
  let out = '';
  para.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.classList.contains('mn-marker') && node.contentEditable === 'false') {
        // Recover original [mn...] syntax stored in the badge text
        out += node.textContent;
      } else {
        out += node.textContent;
      }
    }
  });
  return out;
}

// ── Caret save/restore ───────────────────────────────────────────────────────
// We need to preserve cursor position across innerHTML rewrites during live
// syntax highlighting. We do this by counting text-node characters.

function saveCaretPosition(el) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const pre   = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

function restoreCaretPosition(el, charOffset) {
  if (charOffset === null) return;
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  let   chars = 0;
  let   found = false;

  function walk(node) {
    if (found) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const next = chars + node.textContent.length;
      if (charOffset <= next) {
        range.setStart(node, charOffset - chars);
        range.collapse(true);
        found = true;
      }
      chars = next;
    } else {
      node.childNodes.forEach(walk);
    }
  }

  walk(el);
  if (!found) {
    range.selectNodeContents(el);
    range.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCursorAtEnd(el) {
  const sel   = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
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
function positionChips() {
  const mainText  = document.getElementById('main-text');
  const marginCol = document.getElementById('margin-col');
  if (!mainText || !marginCol) return;

  const mainMain  = document.getElementById('main');
  const scrollTop = mainMain ? mainMain.scrollTop : 0;
  const marginTop = marginCol.getBoundingClientRect().top + scrollTop;

  marginCol.innerHTML = '';

  currentNotes.forEach(note => {
    const anchor = mainText.querySelector(`.mn-anchor[data-note-id="${note.id}"]`);
    if (!anchor) return;

    const aRect  = anchor.getBoundingClientRect();
    const topPx  = aRect.top + scrollTop - marginTop;

    const chip = document.createElement('div');
    chip.className = 'mn-chip';
    chip.dataset.noteId = note.id;
    if (note.type) chip.dataset.noteType = note.type;
    chip.style.top = topPx + 'px';

    const connectorTop = aRect.height / 2;
    chip.innerHTML = `
      <div class="mn-chip-inner">
        <span class="mn-chip-num">${note.id}</span>
        <span class="mn-chip-preview">${note.content}</span>
      </div>
      <div class="mn-connector" style="top:${connectorTop}px"></div>
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
  if (editingPara) return; // don't show note tooltip while editing a paragraph
  
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

async function handleEditPara(e) {
  if (e.type === 'touchend') e.preventDefault(); // Prevent ghost clicks
  e.stopPropagation();
  if (!pendingPos || !currentPath) return;
  
  const sel = window.getSelection();
  const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  let para = range ? range.startContainer.parentElement.closest('p[data-block]') : null;
  
  // Calculate precise cursor offset inside the raw Markdown text
  const blockStart = para ? parseInt(para.dataset.block, 10) : 0;
  const cursorOffset = pendingPos.charPos - blockStart;

  selTooltip.classList.remove('visible');
  sel?.removeAllRanges();

  if (para) {
    await enterEditMode(para, cursorOffset);
  }
}

// Bind both events
const ttAddBtn = document.getElementById('tt-add-note');
const ttEditBtn = document.getElementById('tt-edit-para');

ttAddBtn.addEventListener('click', handleAddNote);
ttAddBtn.addEventListener('touchend', handleAddNote);

ttEditBtn.addEventListener('click', handleEditPara);
ttEditBtn.addEventListener('touchend', handleEditPara);

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
      fetch('/api/debug/whoami').then(r=>r.json()).then(d=>{statusText.textContent = JSON.stringify(d);});
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
    }
  });
})();