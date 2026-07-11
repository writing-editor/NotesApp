// ai-src/agentRunner.js — Stage 4, extended in Stage 6.
//
// Wires the "Run agent" button to the already-working /api/ai/chat route
// (Stage 3, lib/ai-proxy.js) and, on success, hands the returned placements
// to noteSplice.js to actually land them in the live document. This file
// owns: reading config/key out of storage.js, resolving "scope" into actual
// chapter text, the fetch() call itself, cancel-in-flight, and the
// queued/thinking/done/error status strings. It does not touch the DOM
// directly except via the small `onStatusChange` callback the caller
// supplies — settingsPanel.js owns the actual status <small> element.
//
// Stage 6 additions:
//   - Read-only/preview mode reuses §3's pre-write validation: a run in
//     'read-only' mode calls /api/ai/chat exactly like read-write does, but
//     returns the resolved placements to the caller instead of splicing —
//     settingsPanel.js renders them as a preview list with an "Apply"
//     action that calls applyPreview() below to splice afterward.
//   - Richer error states: failures now carry a `kind` tag ('no-key' |
//     'offline' | 'no-agent' | 'empty' | 'server' | 'nothing-usable' |
//     'cancelled') instead of only a generic string.
//   - Per-run undo: a completed read-write run returns `runId` plus
//     `insertedNotes` ([{ path, content, charPos }]) so undoLastRun() can
//     remove exactly what that run added.
//
// Editor access (CONTEXT.md §4/§8's "open question"): resolved here as an
// extra mount()-time option threaded all the way from client.js:
//   client.js:   window.MnAI.mount({ triggerEl, getEditor: () => liveEditor })
//   main.js:     mount({ triggerEl, getEditor }) -> passed through to both
//                buildSettingsPanel() and (indirectly) runAgent()
//   agentRunner: calls the supplied getEditor() fresh at run time (not once
//                at mount time), since client.js's liveEditor is reassigned
//                every time a chapter is opened (mountLiveEditor()) — a
//                stale reference captured at mount() would go stale the
//                moment the user switches chapters after opening the Agent
//                panel once.
//
// Scope: Stage 4 only implemented 'chapter'. Stage 5 adds
// 'all' — every file across every manifest section, one /api/ai/chat call
// per chapter (not one giant concatenated prompt — keeps each call's
// chapterText/charPos pairing exactly as simple as the single-chapter case,
// and avoids an unbounded prompt size on a large manuscript). The
// currently-open chapter (matched by path via the new `getCurrentPath`
// option) still gets its notes spliced into the *live* editor via
// spliceNotes(), same as 'chapter' scope always has, so what's on screen
// doesn't silently fall out of sync with disk; every other chapter is
// read/written as a plain string through `/api/raw` GET/PUT (see
// noteSplice.js's spliceIntoRawText()), since there's no live editor
// instance for a chapter that isn't mounted.

import { getAgentConfig, getProviderKey } from './storage.js';
import { spliceNotes, spliceIntoRawText, verifyInsertOnly } from './noteSplice.js';

// Module-level so a second "Run agent" click can cancel the first run's
// in-flight fetch via AbortController — there is only ever one Agent
// settings panel/runner instance per app (mirrors liveEditor's own
// module-level singleton in client.js), so a module-level handle is
// sufficient and avoids threading an AbortController through every caller.
let inFlightController = null;

// Stage 6 per-run undo: the most recently completed *read-write* run's
// record, or null. Only one level of undo is kept (not a stack) — the plan
// explicitly scopes this as "undo this run," not generic multi-level undo.
// Overwritten by the next run (whether or not the previous one was undone),
// and cleared once undoLastRun() succeeds so a second click can't try to
// remove the same notes twice.
//
// Shape: { runId, insertedNotes: [{ path: string|null, content: string,
//   charPos: number }] }. `path: null` means "the currently-open chapter,
// live editor" — resolved back through the same getEditor() the run itself
// used, called fresh at undo time for the same staleness reason runAgent()
// already calls it fresh rather than once at mount.
let lastRun = null;
let runCounter = 0;

/**
 * @param {Object} opts
 * @param {() => (import('../editor-src/main.js').LiveEditor | null)} opts.getEditor
 *   Returns the *current* live editor instance, called fresh at run time
 *   (see module comment above) — not memoized.
 * @param {() => (string | null)} [opts.getCurrentPath]
 *   Stage 5: returns client.js's `currentPath` (the manifest path of
 *   whichever chapter is currently open), called fresh at run time same as
 *   getEditor. Only used by 'all' scope, to tell which manifest entry
 *   corresponds to the live editor so that one chapter's notes go through
 *   spliceNotes() (live doc) instead of the raw-file read/write path every
 *   other chapter uses. Optional — if omitted, 'all' scope just treats
 *   every chapter as a raw-file write, which is still correct, just means
 *   the open chapter's on-screen view won't reflect its own new notes until
 *   it's reopened.
 * @param {() => void} [opts.onAfterMutation]
 *   Forwarded to noteSplice.js — pass client.js's remountAfterNoteMutation
 *   equivalent so note superscripts refresh after a successful run.
 * @param {(status: string) => void} opts.onStatusChange
 *   Called with a short human-readable string at each stage transition:
 *   'queued' -> 'thinking' -> 'done' | 'error' | 'cancelled', OR (Stage 5,
 *   'all' scope only) an arbitrary progress string like "Thinking… (2/5:
 *   Chapter Two)" — settingsPanel.js's STATUS_TEXT lookup already falls
 *   back to showing the raw string verbatim for any key it doesn't
 *   recognise, so no changes were needed there for this.
 * @returns {Promise<{ ok: boolean, inserted?: number, detail?: string, error?: string }>}
 */
export async function runAgent({ getEditor, getCurrentPath, onAfterMutation, onStatusChange } = {}) {
  const notify = (s) => { if (typeof onStatusChange === 'function') onStatusChange(s); };

  // Cancel any previous run before starting a new one — only one run at a
  // time makes sense against a single document.
  if (inFlightController) {
    inFlightController.abort();
    inFlightController = null;
  }

  notify('queued');

  const editor = typeof getEditor === 'function' ? getEditor() : null;
  if (!editor || typeof editor.getDoc !== 'function') {
    notify('error');
    return { ok: false, error: 'No chapter is open in the editor.', kind: 'no-editor' };
  }

  const config = getAgentConfig();
  const { provider, models, ollamaUrl, agentKey, mode, scope } = config;
  // Per-provider model memory — resolve this run's model from
  // the current provider's slot in the map, not a flat field.
  const model = models[provider] || '';

  if (!agentKey) {
    notify('error');
    return {
      ok: false,
      kind: 'no-agent',
      error: 'No agent profile selected. Choose one in Agent behaviour and Save first.',
    };
  }

  const apiKey = provider === 'ollama'
    ? ''
    // Uses whichever slot ("A"/"B") is currently active for this provider —
    // set manually in the settings panel, no automatic fallback. See
    // storage.js's "Per-provider key slots" comment for why.
    : await getProviderKey(provider, config.keySlots?.[provider]?.active || 'A');
  if (provider !== 'ollama' && !apiKey) {
    notify('error');
    return {
      ok: false,
      kind: 'no-key',
      error: `No API key saved for ${provider}. Add one in Connection and Save first.`,
    };
  }

  const controller = new AbortController();
  inFlightController = controller;

  // Stage 6 §2: the agent's own instructions live in a file now, not a
  // flat config string — resolve it once per run (not once per chapter in
  // 'all' scope; the same profile applies to every chapter in a run).
  let systemPrompt;
  try {
    const res = await fetch('/api/agents/' + encodeURIComponent(agentKey), { signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `Could not load agent "${agentKey}" (${res.status})`);
    systemPrompt = data.content || '';
  } catch (e) {
    inFlightController = null;
    const cancelled = controller.signal.aborted;
    notify(cancelled ? 'cancelled' : 'error');
    return {
      ok: false,
      kind: cancelled ? 'cancelled' : classifyNetworkError(e),
      error: cancelled ? 'Run cancelled.' : (e.message || 'Could not load the agent profile.'),
    };
  }

  const connection = { provider, model, ollamaUrl, systemPrompt, apiKey };
  const preview = mode === 'read-only';

  try {
    if (scope === 'all') {
      return await runAllChaptersScope({
        editor,
        getCurrentPath,
        connection,
        controller,
        onAfterMutation,
        notify,
        preview,
      });
    }
    if (scope === 'selection') {
      return await runSelectionScope({ editor, connection, controller, onAfterMutation, notify, preview });
    }
    return await runChapterScope({ editor, connection, controller, onAfterMutation, notify, preview });
  } finally {
    if (inFlightController === controller) inFlightController = null;
  }
}

// Best-effort classification of a thrown/rejected fetch so the UI can show
// something more useful than a raw error message. Browsers don't give a
// clean "you're offline" signal from fetch() itself — a failed connection
// and a DNS failure both surface as a generic TypeError — so this is a
// heuristic, not a guarantee; 'server' is the safe fallback for anything
// that doesn't look network-shaped.
function classifyNetworkError(e) {
  if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) return 'offline';
  const msg = (e && e.message) || '';
  if (e instanceof TypeError || /failed to fetch|network|load failed/i.test(msg)) return 'offline';
  return 'server';
}

// ── 'chapter' scope (Stage 4 behaviour, unchanged) ─────────────────────────
// Reads the *live* in-memory doc via editor.getDoc(), not a re-fetch from
// disk — same reasoning as remountAfterNoteMutation() reading
// liveEditor.getDoc() elsewhere in client.js: the editor's in-memory text
// is the current source of truth, disk may still be mid-debounce.
async function runChapterScope({ editor, connection, controller, onAfterMutation, notify, preview }) {
  const chapterText = editor.getDoc();
  if (!chapterText || !chapterText.trim()) {
    notify('error');
    return { ok: false, kind: 'empty', error: 'The current chapter is empty — nothing to send.' };
  }

  notify('thinking');

  const result = await callAiChat({ ...connection, chapterText }, controller);
  if (!result.ok) {
    notify(result.cancelled ? 'cancelled' : 'error');
    return { ok: false, kind: result.cancelled ? 'cancelled' : (result.kind || 'server'), error: result.error };
  }

  // §3 pre-write check already ran server-side (ai-proxy.js's
  // resolvePlacements) — result.rejected is how many placements it dropped
  // for landing inside an existing note's marker span. Surfaced in `detail`
  // rather than treated as an error: a rejection means the check caught
  // something, not that the run failed.
  const rejectedNote = describeRejected(result.rejected);
  // Same idea for the density cap (ai-proxy.js's capPlacementDensity) — a
  // run that got trimmed for being too dense still succeeded, it's just
  // worth telling the person some proposed notes were dropped rather than
  // silently only ever showing the capped count.
  const cappedNote = describeCapped(result.capped);

  // Stage 6: read-only mode stops here — hand the resolved placements back
  // to the caller as a preview instead of splicing. Nothing has touched the
  // doc at this point, so there's nothing to undo and no post-write check
  // to run; §3's pre-write validation (which already ran server-side inside
  // /api/ai/chat) is the only check a dry run needs.
  if (preview) {
    if (!Array.isArray(result.placements) || result.placements.length === 0) {
      notify('done');
      return { ok: true, preview: true, placements: [], inserted: 0, detail: joinDetails([rejectedNote, cappedNote]) };
    }
    notify('done');
    return {
      ok: true,
      preview: true,
      placements: result.placements,
      inserted: 0,
      detail: joinDetails([rejectedNote, cappedNote]),
    };
  }

  // Snapshot before the splice so the post-write check below has something
  // to compare against — editor.getDoc() again after insertion.
  const before = chapterText;
  const inserted = spliceNotes({
    editor,
    placements: result.placements,
    onAfterMutation,
  });
  const after = editor.getDoc();

  // §3 post-write check: confirm the only change was the ai-marker
  // insertions themselves. Logged and flagged, not rolled back automatically
  // — by this point the write has already landed in the live doc, and an
  // automatic revert risks discarding unrelated keystrokes the user made
  // during the run. See noteSplice.js's verifyInsertOnly() doc comment.
  const verification = verifyInsertOnly(before, after);
  if (!verification.ok) {
    console.error('[ai-agent] post-write invariant check failed:', verification.detail);
  }

  // Stage 6 per-run undo: record exactly what this run inserted so
  // undoLastRun() can remove it later. Only the placements that actually
  // made it into the doc (spliceNotes() may drop a malformed entry) count —
  // path: null means "whatever chapter is live in the editor at undo time,"
  // resolved fresh rather than assumed to still be this one.
  const runId = ++runCounter;
  lastRun = {
    runId,
    insertedNotes: result.placements
      .filter((p) => typeof p.content === 'string' && p.content.trim())
      .map((p) => ({ path: null, content: p.content, charPos: p.charPos })),
  };

  notify('done');
  return {
    ok: true,
    runId,
    inserted,
    canUndo: inserted > 0,
    detail: joinDetails([rejectedNote, cappedNote, verification.ok ? null : `Warning: ${verification.detail}`]),
  };
}

// Small formatting helpers shared by both scope functions — kept here rather
// than duplicated, since both need to fold a rejected-count and/or a failed
// post-write check into the same `detail` string the run-summary UI already
// reads (settingsPanel.js shows `detail` verbatim under the status line).
function describeRejected(rejected) {
  if (!rejected) return null;
  return `${rejected} placement(s) rejected — proposed position overlapped an existing note.`;
}

// Companion to describeRejected — see ai-proxy.js's capPlacementDensity for
// what this is catching: the model returning far more notes than are
// useful to read. Worded differently from "rejected" on purpose — a
// rejected placement was something wrong with the model's output, a capped
// one was fine on its own merits but there were simply too many of them.
function describeCapped(capped) {
  if (!capped) return null;
  return `${capped} note(s) trimmed to keep the chapter readable — the agent proposed more than a reasonable density.`;
}

function joinDetails(parts) {
  const nonEmpty = parts.filter(Boolean);
  return nonEmpty.length ? nonEmpty.join(' ') : undefined;
}

// Reads the live editor's current selection range. Exported so
// settingsPanel.js can check "is there a selection right now" (to enable/
// disable the Selection scope option and show a word count) without
// duplicating CodeMirror's state-shape knowledge — this is the one place in
// ai-src/ that reaches into `editor.view.state.selection` directly.
// Returns null for a collapsed selection (plain cursor, nothing highlighted)
// — "selection" here always means a real non-empty range.
export function getEditorSelection(editor) {
  if (!editor || !editor.view || !editor.view.state) return null;
  const { from, to } = editor.view.state.selection.main;
  if (from === to) return null;
  return { from, to, text: editor.view.state.doc.sliceString(from, to) };
}

// ── 'selection' scope ───────────────────────────────────────────────────────
// Sends only the highlighted text to the model, not the whole chapter — a 4B
// local model in particular loses coherence and drifts into paraphrasing
// well before it runs out of context room on a full 10k-word chapter, and a
// person reviewing one or two paragraphs at a time is a completely
// reasonable workflow on its own. The model is asked for charPos offsets
// into *that selection*, since that's the only text it was shown — sending
// absolute chapter offsets would require the model to somehow know the
// selection's position in a chapter it never saw, which it has no way to do
// reliably (or at all, since chapterText below genuinely only ever contains
// the selected slice). Once the response comes back, every returned
// charPos is shifted by `selection.from` before splicing, which is the only
// change from runChapterScope's flow — resolvePlacements() server-side
// still just clamps into `[0, chapterText.length]` exactly as it always
// has, using the *sliced* text's own length, so no server-side change was
// needed at all.
async function runSelectionScope({ editor, connection, controller, onAfterMutation, notify, preview }) {
  const selection = getEditorSelection(editor);
  if (!selection) {
    notify('error');
    return {
      ok: false,
      kind: 'no-selection',
      error: 'Nothing is selected in the editor. Highlight a paragraph or two, then run again.',
    };
  }

  const chapterText = selection.text;
  if (!chapterText || !chapterText.trim()) {
    notify('error');
    return { ok: false, kind: 'empty', error: 'The selected text is empty — nothing to send.' };
  }

  notify('thinking');

  const result = await callAiChat({ ...connection, chapterText }, controller);
  if (!result.ok) {
    notify(result.cancelled ? 'cancelled' : 'error');
    return { ok: false, kind: result.cancelled ? 'cancelled' : (result.kind || 'server'), error: result.error };
  }

  const rejectedNote = describeRejected(result.rejected);
  const cappedNote = describeCapped(result.capped);

  // Shift every placement from "offset into the selection" to "offset into
  // the whole chapter" — the one step that's actually new here. Done
  // immediately after the response so every caller below this line (preview
  // rendering, spliceNotes, undo bookkeeping) works with ordinary absolute
  // charPos values exactly like runChapterScope's, and none of them need to
  // know selection scope exists at all.
  const shiftedPlacements = (result.placements || []).map((p) => ({
    ...p,
    charPos: p.charPos + selection.from,
  }));

  if (preview) {
    if (shiftedPlacements.length === 0) {
      notify('done');
      return { ok: true, preview: true, placements: [], inserted: 0, detail: joinDetails([rejectedNote, cappedNote]) };
    }
    notify('done');
    return {
      ok: true,
      preview: true,
      placements: shiftedPlacements,
      inserted: 0,
      detail: joinDetails([rejectedNote, cappedNote]),
    };
  }

  // Snapshot the *whole* doc (not just the selection) before the splice —
  // insertNoteAt/spliceNotes operate on absolute offsets into the full
  // document, same as chapter scope, so the post-write invariant check
  // needs the full before/after text to mean anything.
  const before = editor.getDoc();
  const inserted = spliceNotes({
    editor,
    placements: shiftedPlacements,
    onAfterMutation,
  });
  const after = editor.getDoc();

  const verification = verifyInsertOnly(before, after);
  if (!verification.ok) {
    console.error('[ai-agent] post-write invariant check failed:', verification.detail);
  }

  const runId = ++runCounter;
  lastRun = {
    runId,
    insertedNotes: shiftedPlacements
      .filter((p) => typeof p.content === 'string' && p.content.trim())
      .map((p) => ({ path: null, content: p.content, charPos: p.charPos })),
  };

  notify('done');
  return {
    ok: true,
    runId,
    inserted,
    canUndo: inserted > 0,
    detail: joinDetails([rejectedNote, cappedNote, verification.ok ? null : `Warning: ${verification.detail}`]),
  };
}

// ── 'all' scope (Stage 5) ───────────────────────────────────────────────────
// One /api/ai/chat call per chapter across every manifest section (front
// matter + chapters + back matter — "All chapters" in the UI means "the
// whole manuscript," not just the Chapters section specifically, since a
// continuity-checking agent has just as much reason to flag something in a
// preface or appendix). Runs sequentially, not in parallel — simpler
// cancellation (check the abort signal between chapters) and gentler on
// whatever rate limit the provider has, at the cost of being slower for a
// large manuscript; worth revisiting in Stage 6 if that turns out to matter
// in practice.
async function runAllChaptersScope({ editor, getCurrentPath, connection, controller, onAfterMutation, notify, preview }) {
  notify('thinking');

  let manifest;
  try {
    const res = await fetch('/api/manifest', { signal: controller.signal });
    manifest = await res.json();
    if (!res.ok) return { ok: false, kind: 'server', error: manifest?.error || `Could not load manifest (${res.status})` };
  } catch (e) {
    if (controller.signal.aborted) return { ok: false, error: 'Run cancelled.', kind: 'cancelled', cancelled: true };
    return { ok: false, kind: classifyNetworkError(e), error: e.message || 'Could not load the chapter manifest.' };
  }

  const files = (manifest.sections || []).flatMap((s) => s.files || []);
  if (files.length === 0) {
    notify('error');
    return { ok: false, kind: 'empty', error: 'No chapters found in this vault.' };
  }

  const currentPath = typeof getCurrentPath === 'function' ? getCurrentPath() : null;

  let totalInserted = 0;
  let totalRejected = 0;
  let totalCapped = 0;
  let chaptersTouched = 0;
  const skipped = [];
  const warnings = [];
  // Stage 6: preview accumulates { path, label, placements } per chapter
  // instead of writing anything; undo tracking accumulates the same shape
  // read-write actually inserted, keyed by path so undo knows which file
  // (or "the live editor," path === currentPath) each note came from.
  const previewByFile = [];
  const insertedNotes = [];

  for (let i = 0; i < files.length; i++) {
    if (controller.signal.aborted) {
      notify('cancelled');
      return {
        ok: false,
        kind: 'cancelled',
        error: 'Run cancelled.',
        inserted: totalInserted,
        detail: `${totalInserted} note(s) added across ${chaptersTouched} chapter(s) before cancelling.`,
      };
    }

    const file = files[i];
    notify(`Thinking\u2026 (${i + 1}/${files.length}: ${file.label})`);

    try {
      const isOpenChapter = currentPath && file.path === currentPath;

      // Read: the live doc if this is the chapter that's actually mounted
      // (in-memory may be ahead of disk, same reasoning as 'chapter' scope),
      // otherwise a plain disk read via the existing raw-file route.
      const chapterText = isOpenChapter
        ? editor.getDoc()
        : await fetchRawChapter(file.path, controller);

      if (!chapterText || !chapterText.trim()) {
        skipped.push(`${file.label} (empty)`);
        continue;
      }

      const result = await callAiChat({ ...connection, chapterText }, controller);
      if (!result.ok) {
        if (result.cancelled) throw new Error('__cancelled__');
        skipped.push(`${file.label} (${result.error})`);
        continue;
      }

      if (result.rejected) totalRejected += result.rejected;
      if (result.capped) totalCapped += result.capped;

      if (!Array.isArray(result.placements) || result.placements.length === 0) {
        continue; // nothing worth noting in this chapter — not a failure
      }

      // Stage 6: read-only mode never writes — just collect what would have
      // been inserted, per chapter, and move on to the next one.
      if (preview) {
        previewByFile.push({ path: file.path, label: file.label, placements: result.placements });
        continue;
      }

      if (isOpenChapter) {
        const before = chapterText;
        const inserted = spliceNotes({ editor, placements: result.placements, onAfterMutation });
        const after = editor.getDoc();
        const verification = verifyInsertOnly(before, after);
        if (!verification.ok) {
          console.error('[ai-agent] post-write invariant check failed for', file.label, ':', verification.detail);
          warnings.push(file.label);
        }
        totalInserted += inserted;
        if (inserted > 0) chaptersTouched++;
        result.placements.forEach((p) => {
          if (typeof p.content === 'string' && p.content.trim()) {
            insertedNotes.push({ path: null, content: p.content, charPos: p.charPos });
          }
        });
      } else {
        const { text, inserted } = spliceIntoRawText(chapterText, result.placements);
        if (inserted > 0) {
          const verification = verifyInsertOnly(chapterText, text);
          if (!verification.ok) {
            console.error('[ai-agent] post-write invariant check failed for', file.label, ':', verification.detail);
            warnings.push(file.label);
          }
          await putRawChapter(file.path, text, controller);
          totalInserted += inserted;
          chaptersTouched++;
          result.placements.forEach((p) => {
            if (typeof p.content === 'string' && p.content.trim()) {
              insertedNotes.push({ path: file.path, content: p.content, charPos: p.charPos });
            }
          });
        }
      }
    } catch (e) {
      if (e.message === '__cancelled__' || controller.signal.aborted) {
        notify('cancelled');
        return {
          ok: false,
          kind: 'cancelled',
          error: 'Run cancelled.',
          inserted: totalInserted,
          detail: `${totalInserted} note(s) added across ${chaptersTouched} chapter(s) before cancelling.`,
        };
      }
      skipped.push(`${file.label} (${e.message})`);
    }
  }

  notify('done');

  if (preview) {
    const totalPreviewed = previewByFile.reduce((n, f) => n + f.placements.length, 0);
    const detail = joinDetails([
      skipped.length > 0 ? `Skipped ${skipped.length} chapter(s): ${skipped.join('; ')}` : null,
      describeRejected(totalRejected),
      describeCapped(totalCapped),
    ]);
    return { ok: true, preview: true, previewByFile, inserted: 0, totalPreviewed, detail };
  }

  const runId = ++runCounter;
  lastRun = { runId, insertedNotes };

  const detail = joinDetails([
    skipped.length > 0 ? `Skipped ${skipped.length} chapter(s): ${skipped.join('; ')}` : null,
    describeRejected(totalRejected),
    describeCapped(totalCapped),
    warnings.length > 0 ? `Warning: post-write check flagged ${warnings.length} chapter(s): ${warnings.join(', ')}.` : null,
  ]);
  return { ok: true, runId, inserted: totalInserted, canUndo: totalInserted > 0, detail };
}

// ── Shared helpers ──────────────────────────────────────────────────────────

async function fetchRawChapter(relPath, controller) {
  const res = await fetch('/api/raw?path=' + encodeURIComponent(relPath), { signal: controller.signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Could not read ${relPath} (${res.status})`);
  return data.raw || '';
}

async function putRawChapter(relPath, text, controller) {
  const res = await fetch('/api/raw', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({ path: relPath, text }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `Could not save ${relPath} (${res.status})`);
}

// Calls /api/ai/chat and normalizes the result to a shape both scope
// functions above can share, including turning an AbortError into a
// distinguishable `{ cancelled: true }` rather than a generic error string.
async function callAiChat({ provider, model, ollamaUrl, systemPrompt, apiKey, chapterText }, controller) {
  let response;
  try {
    response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ provider, model, apiKey, ollamaUrl, systemPrompt, chapterText }),
    });
  } catch (e) {
    if (controller.signal.aborted) return { ok: false, error: 'Run cancelled.', cancelled: true, kind: 'cancelled' };
    return { ok: false, error: e.message || 'Network request failed.', kind: classifyNetworkError(e) };
  }

  let result;
  try {
    result = await response.json();
  } catch (e) {
    return { ok: false, error: 'Server returned an invalid response.', kind: 'server' };
  }

  if (!result || result.ok !== true) {
    return {
      ok: false,
      error: (result && result.error) || `Request failed (${response.status})`,
      kind: response.status === 401 || response.status === 403 ? 'no-key' : 'server',
    };
  }

  // Stage 6 "richer error states": a request can come back structurally
  // fine (ok: true) yet still have nothing usable in it — e.g. the model
  // returned prose instead of a JSON array, or every placement it proposed
  // was malformed and got dropped by resolvePlacements(). That's not the §3
  // rejection case (which has a specific, informative cause) and it's not a
  // network/auth failure either, so it gets its own kind so the UI can say
  // "the model didn't return anything usable" instead of a generic error.
  if (!Array.isArray(result.placements)) {
    return { ok: false, error: 'The model\u2019s response could not be understood.', kind: 'nothing-usable' };
  }

  // rejected: how many placements lib/ai-proxy.js's resolvePlacements()
  // dropped for landing inside an existing note's marker span (the
  // pre-write check). capped: how many capPlacementDensity() trimmed for
  // exceeding a reasonable notes-per-word ceiling. Both forwarded here so
  // all three scope functions above can fold them into their run summaries.
  return { ok: true, placements: result.placements, rejected: result.rejected || 0, capped: result.capped || 0 };
}

/**
 * Cancels the current in-flight run, if any. Safe to call when nothing is
 * running. Used by the settings panel's Cancel button (added in Stage 4).
 */
export function cancelAgent() {
  if (inFlightController) {
    inFlightController.abort();
    inFlightController = null;
  }
}

/**
 * Stage 6: applies a preview run's placements for real — the "Apply" action
 * next to a read-only run's preview list. Takes exactly what runAgent()
 * already returned (`result.placements` for 'chapter' scope, or one entry
 * of `result.previewByFile` for 'all' scope) rather than re-running the
 * model, since the whole point of preview mode is "decide once, apply (or
 * don't) without a second round-trip."
 *
 * @param {Object} opts
 * @param {() => (object|null)} opts.getEditor  Same contract as runAgent()'s.
 * @param {Array<{ charPos: number, content: string }>} opts.placements
 * @param {string|null} [opts.path]  A manifest path if this is a chapter
 *   other than the one currently open (raw-file write via /api/raw), or
 *   null/omitted to splice into the live editor's current chapter.
 * @param {() => void} [opts.onAfterMutation]
 * @returns {Promise<{ ok: boolean, inserted?: number, error?: string, runId?: number }>}
 */
export async function applyPreview({ getEditor, placements, path, onAfterMutation } = {}) {
  if (!Array.isArray(placements) || placements.length === 0) {
    return { ok: true, inserted: 0 };
  }

  if (!path) {
    const editor = typeof getEditor === 'function' ? getEditor() : null;
    if (!editor || typeof editor.getDoc !== 'function') {
      return { ok: false, error: 'No chapter is open in the editor.' };
    }
    const before = editor.getDoc();
    const inserted = spliceNotes({ editor, placements, onAfterMutation });
    const after = editor.getDoc();
    const verification = verifyInsertOnly(before, after);
    if (!verification.ok) {
      console.error('[ai-agent] post-write invariant check failed applying preview:', verification.detail);
    }
    const runId = ++runCounter;
    lastRun = {
      runId,
      insertedNotes: placements
        .filter((p) => typeof p.content === 'string' && p.content.trim())
        .map((p) => ({ path: null, content: p.content, charPos: p.charPos })),
    };
    return { ok: true, runId, inserted, canUndo: inserted > 0 };
  }

  // A chapter other than the one currently open — read/write through
  // /api/raw, same as runAllChaptersScope() does for non-live chapters.
  try {
    const chapterText = await fetchRawChapter(path, { signal: undefined });
    const { text, inserted } = spliceIntoRawText(chapterText, placements);
    if (inserted > 0) {
      const verification = verifyInsertOnly(chapterText, text);
      if (!verification.ok) {
        console.error('[ai-agent] post-write invariant check failed applying preview for', path, ':', verification.detail);
      }
      await putRawChapter(path, text, { signal: undefined });
    }
    const runId = ++runCounter;
    lastRun = {
      runId,
      insertedNotes: placements
        .filter((p) => typeof p.content === 'string' && p.content.trim())
        .map((p) => ({ path, content: p.content, charPos: p.charPos })),
    };
    return { ok: true, runId, inserted, canUndo: inserted > 0 };
  } catch (e) {
    return { ok: false, error: e.message || `Could not apply notes to ${path}.` };
  }
}

/**
 * Stage 6 per-run undo. Removes exactly the notes the most recently
 * completed read-write (or applied-preview) run added, then clears
 * `lastRun` so a second click is a no-op rather than trying to remove
 * already-removed notes.
 *
 * Matched by **content text**, not charPos: every note this run inserted
 * shifted every character after it, and other edits (the user's own typing,
 * or a later run) may have shifted things further since — a stored charPos
 * is not trustworthy by the time undo runs. Content match isn't perfect
 * either (two notes with identical text are indistinguishable), but it's
 * the same practical tradeoff `retypeNoteById`/`removeNoteById` already
 * make by relying on the *current* marker list rather than a frozen
 * position, and it degrades safely: at worst, undo removes a different note
 * with identical wording rather than the "wrong" chapter or an unrelated
 * note type (removeNotesFromLiveEditor()/removeNotesFromRawFile() below only
 * ever match `ai`-type markers).
 *
 * @param {Object} opts
 * @param {() => (object|null)} opts.getEditor  Same contract as runAgent()'s
 *   — used to resolve the *currently* open chapter for any undo entries
 *   with `path: null`.
 * @param {(path: string) => boolean} [opts.isCurrentPath]  Given a manifest
 *   path, returns true if it's the chapter currently open in the live
 *   editor — lets undo route a non-null-path entry through the live editor
 *   too, if the user happened to reopen that same chapter since the run.
 * @param {() => void} [opts.onAfterMutation]
 * @returns {Promise<{ ok: boolean, removed?: number, error?: string }>}
 */
export async function undoLastRun({ getEditor, isCurrentPath, onAfterMutation } = {}) {
  if (!lastRun || !Array.isArray(lastRun.insertedNotes) || lastRun.insertedNotes.length === 0) {
    return { ok: false, error: 'Nothing to undo.' };
  }

  const run = lastRun;
  lastRun = null; // clear immediately — a second click shouldn't double-undo

  // Group by which file each note belongs to, so a multi-chapter ('all'
  // scope) run only opens/reads each file once regardless of how many
  // notes landed in it.
  const byPath = new Map();
  for (const note of run.insertedNotes) {
    const key = note.path || '__live__';
    if (!byPath.has(key)) byPath.set(key, []);
    byPath.get(key).push(note);
  }

  let removed = 0;
  const failed = [];

  for (const [key, notes] of byPath) {
    const isLive = key === '__live__' || (typeof isCurrentPath === 'function' && isCurrentPath(key));
    try {
      if (isLive) {
        const editor = typeof getEditor === 'function' ? getEditor() : null;
        if (!editor || typeof editor.getNotes !== 'function' || typeof editor.removeNoteById !== 'function') {
          failed.push(key === '__live__' ? 'the open chapter' : key);
          continue;
        }
        removed += removeNotesFromLiveEditor(editor, notes);
        if (typeof onAfterMutation === 'function') onAfterMutation();
      } else {
        removed += await removeNotesFromRawFile(key, notes);
      }
    } catch (e) {
      failed.push(key === '__live__' ? 'the open chapter' : key);
    }
  }

  if (failed.length > 0) {
    return {
      ok: removed > 0,
      removed,
      error: `Could not undo notes in: ${failed.join(', ')}.`,
    };
  }
  return { ok: true, removed };
}

// Removes every note in `notes` from the live editor by matching on
// (type === 'ai', content). Uses the editor's own current getNotes() list
// (not any position captured earlier) so this stays correct regardless of
// what's happened to the doc since the run finished.
function removeNotesFromLiveEditor(editor, notes) {
  let removed = 0;
  const remaining = [...notes];
  const current = editor.getNotes();
  for (const n of current) {
    if (n.type !== 'ai') continue;
    const idx = remaining.findIndex((r) => r.content === n.content);
    if (idx === -1) continue;
    remaining.splice(idx, 1);
    if (editor.removeNoteById(n.id)) removed++;
  }
  return removed;
}

// Same matching approach as removeNotesFromLiveEditor(), but for a chapter
// that isn't mounted — reads the raw text, strips the matching `[mn.ai: ...]`
// markers out directly (no live CM6 doc to call removeNoteById() against),
// and writes the result back through /api/raw.
async function removeNotesFromRawFile(path, notes) {
  const text = await fetchRawChapter(path, { signal: undefined });
  const remaining = [...notes];
  let removed = 0;

  const re = /\[mn\.ai\s*:\s*([\s\S]*?)\]/g;
  let result = '';
  let lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const content = m[1];
    const idx = remaining.findIndex((r) => r.content === content);
    if (idx !== -1) {
      remaining.splice(idx, 1);
      removed++;
      result += text.slice(lastIndex, m.index);
      lastIndex = re.lastIndex;
    }
  }
  result += text.slice(lastIndex);

  if (removed > 0) {
    await putRawChapter(path, result, { signal: undefined });
  }
  return removed;
}

/**
 * True if a run is currently available to undo. Used by settingsPanel.js to
 * show/hide the "Undo last run" action without keeping its own copy of the
 * run bookkeeping.
 */
export function canUndoLastRun() {
  return !!(lastRun && Array.isArray(lastRun.insertedNotes) && lastRun.insertedNotes.length > 0);
}