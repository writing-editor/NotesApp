// ai-src/noteSplice.js — Stage 4.
//
// Takes the placements array returned by /api/ai/chat ({ charPos, content }
// per CONTEXT.md §4/§6) and splices each one into the live CM6 document as
// an `ai`-typed note, using the SAME insertion function the manual "add
// note" flow already uses — client.js's `liveEditor.insertNoteAt(charPos,
// content, 'ai')` — never a new write path, per plan.md §1/§2.
//
// This module does not know how to get an editor instance; it's handed one
// (see agentRunner.js's `getEditor` option, threaded from client.js via
// MnAI.mount({ getEditor })). It also does not talk to the network — that's
// agentRunner.js's job. Kept as its own file/export because plan.md's
// component tree (§3) lists it as a separate piece from agentRunner.js, and
// because "apply placements to the doc" is a distinct, easily-unit-testable
// responsibility from "fetch placements from the server."
//
// ── Ordering ─────────────────────────────────────────────────────────────
// Placements are applied highest-charPos-first. Each insertNoteAt() splices
// new characters into the document at `to`; inserting earlier positions
// first would shift every later placement's charPos out from under it
// (CM6's dispatch takes a plain position, it doesn't remap other pending
// offsets for you). Applying back-to-front means every not-yet-applied
// placement's charPos is still valid against the doc *as it currently is*
// at the moment it's applied, since nothing before it has changed yet.
//
// ── Remount ──────────────────────────────────────────────────────────────
// client.js's own note mutations (saveNote/retypeNote/removeNote) always
// follow an insertNoteAt/retypeNoteById/removeNoteById call with
// `remountAfterNoteMutation()` to work around the stale-superscript-number
// bug (see client.js's comment above that function). This module doesn't
// have access to that function directly (it's private to client.js), so it
// takes an `onAfterMutation` callback and calls it exactly once after all
// placements are applied — not once per placement, since each remount tears
// down and rebuilds the CM6 view, and doing that N times for N placements
// would be wasteful and would fight the scroll-position preservation
// client.js's version already does.

/**
 * @param {Object} opts
 * @param {{ insertNoteAt: (charPos: number, content: string, noteType: string|null) => void }} opts.editor
 *   The live editor instance (client.js's `liveEditor`), threaded in by
 *   agentRunner.js via whatever `getEditor()` hook MnAI.mount() was given.
 * @param {Array<{ charPos: number, content: string }>} opts.placements
 *   Already-validated/clamped placements, as returned by /api/ai/chat's
 *   `{ ok: true, placements }` shape (lib/ai-proxy.js's resolvePlacements()
 *   has already dropped anything malformed by this point).
 * @param {() => void} [opts.onAfterMutation]
 *   Called once after all placements are inserted — pass client.js's
 *   `remountAfterNoteMutation` here (or an equivalent) so the doc's note
 *   superscripts refresh the same way manual note-add already does.
 * @returns {number} the number of notes actually inserted.
 */
export function spliceNotes({ editor, placements, onAfterMutation } = {}) {
  if (!editor || typeof editor.insertNoteAt !== 'function') {
    console.error('[ai-agent] noteSplice: no live editor instance to write into');
    return 0;
  }
  if (!Array.isArray(placements) || placements.length === 0) {
    return 0;
  }

  // Back-to-front so earlier charPos values in the list stay valid as each
  // insertion shifts everything after it — see the module comment above.
  const ordered = [...placements].sort((a, b) => b.charPos - a.charPos);

  let inserted = 0;
  for (const { charPos, content } of ordered) {
    if (typeof content !== 'string' || !content.trim()) continue;
    if (!Number.isFinite(charPos)) continue;
    try {
      editor.insertNoteAt(charPos, content, 'ai');
      inserted++;
    } catch (e) {
      // One bad placement shouldn't abort the rest of the run.
      console.error('[ai-agent] failed to insert a note at', charPos, e.message);
    }
  }

  if (inserted > 0 && typeof onAfterMutation === 'function') {
    onAfterMutation();
  }

  return inserted;
}

// ── Raw-text splice (Stage 5 — multi-chapter scope) ────────────────────────
//
// spliceNotes() above only ever writes into the *live* CM6 document, which
// holds exactly one chapter at a time (client.js's `liveEditor`). Stage 5's
// "All chapters" scope needs to write notes into chapters that aren't the
// one currently open — for those, there's no live editor instance to call
// insertNoteAt() on, so agentRunner.js instead reads/writes them as plain
// strings through the existing `/api/raw` GET/PUT routes (the same ones the
// full-chapter edit mode already uses for whole-file reads/writes — no new
// server route needed).
//
// This function builds the *same* `[mn.ai: content]` marker insertNoteAt()
// builds (kept in sync by hand — see that function's marker line — since
// duplicating the one-line format here is simpler than exporting a shared
// helper across the editor-src/ai-src boundary for a single string
// template), applied back-to-front for the same reason spliceNotes() does:
// each insertion shifts every character after it, so later positions must
// be applied before earlier ones stay valid.
//
// Deliberately a pure string function (no fetch, no DOM) so it's easy to
// unit-test and so agentRunner.js stays the only place that knows about
// `/api/raw`'s request shape.
/**
 * @param {string} rawText
 * @param {Array<{ charPos: number, content: string }>} placements
 * @returns {{ text: string, inserted: number }}
 */
export function spliceIntoRawText(rawText, placements) {
  if (typeof rawText !== 'string') return { text: rawText, inserted: 0 };
  if (!Array.isArray(placements) || placements.length === 0) {
    return { text: rawText, inserted: 0 };
  }

  const ordered = [...placements].sort((a, b) => b.charPos - a.charPos);

  let text = rawText;
  let inserted = 0;
  for (const { charPos, content } of ordered) {
    if (typeof content !== 'string' || !content.trim()) continue;
    if (!Number.isFinite(charPos)) continue;
    // Clamp defensively — ai-proxy.js's resolvePlacements() should already
    // have done this against the chapterText it was given, but that was a
    // snapshot read at fetch time; clamp again here rather than trust it
    // still fits this exact string.
    const pos = Math.max(0, Math.min(charPos, text.length));
    const marker = `[mn.ai: ${content}]`;
    text = text.slice(0, pos) + marker + text.slice(pos);
    inserted++;
  }

  return { text, inserted };
}

// ── §3 post-write invariant check ──────────────────────────────────────────
//
// After a batch of placements has been spliced in (either write path above),
// confirm the *only* change to the text is the insertion of well-formed
// `[mn.ai: ...]` markers — nothing else moved, nothing else was deleted, no
// pre-existing `[mn.*: ...]` marker (of any type) was altered. This is the
// automated backstop plan.md §3 describes: the write path is safe by
// construction today (both splice functions only ever insert), but this turns
// that from a currently-true fact about the code into a continuously
// self-checking guarantee that would catch a future regression.
//
// Method: strip every `[mn.ai: ...]` marker back out of `after`, and compare
// the result to `before` verbatim. If they're not identical, something wrote
// outside the insert-only contract. This deliberately strips *only* `ai`-type
// markers (not `[mn.*: ...]` generally) — a run that somehow also removed or
// altered an existing query/ref/todo note must NOT be masked by a blanket
// strip of every marker type, since that's exactly the corruption this check
// exists to catch.
//
// Pure string function — no DOM, no fetch — so it's usable from both the
// live-editor path (agentRunner.js, comparing editor.getDoc() before/after)
// and the raw-file path (comparing the fetched text before/after
// spliceIntoRawText()).
const AI_MARKER_RE = /\[mn\.ai\s*:\s*[\s\S]*?\]/g;

/**
 * @param {string} before  Text snapshot taken immediately before the splice.
 * @param {string} after   Text snapshot taken immediately after the splice
 *   (the live doc's getDoc(), or spliceIntoRawText()'s returned `text`).
 * @returns {{ ok: boolean, detail?: string }}
 *   ok:false means the invariant was violated — caller should treat the
 *   write as suspect (see agentRunner.js: currently logs and flags rather
 *   than attempting an automatic rollback, since by the time this runs the
 *   write has already landed either in the live doc or on disk).
 */
export function verifyInsertOnly(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string') {
    return { ok: false, detail: 'Missing before/after text to compare.' };
  }
  const stripped = after.replace(AI_MARKER_RE, '');
  if (stripped !== before) {
    return {
      ok: false,
      detail: 'Text outside the inserted notes changed — write did not match the insert-only contract.',
    };
  }
  return { ok: true };
}