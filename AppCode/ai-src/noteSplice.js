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
