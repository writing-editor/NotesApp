// lib/paragraphs.js
//
// One shared definition of "paragraph" — a maximal run of non-blank-line
// text, bounded by one-or-more blank lines (or the start/end of the text).
// This is deliberately the ONLY place that definition lives: lib/ai-proxy.js
// uses it to number paragraphs for the model and to resolve the model's
// returned paragraphId back into a real charPos, and editor-src's margin
// gutter (added separately) uses it to render the paragraph numbers the
// person actually sees. If those two ever disagreed on where paragraph 4
// starts, "paragraph 4" in the gutter and "paragraph 4" the model anchored a
// note to would be different places — so both sides import this one
// function rather than re-implementing the split.
//
// Plain CommonJS (module.exports), zero dependencies, no Node-only APIs —
// this needs to run both server-side (required from ai-proxy.js under
// Node) and browser-side (imported into the editor-src esbuild bundle,
// which handles CJS-from-ESM interop fine). Keep it that way; don't add
// anything here that only works in one environment.
//
// Offsets returned (`start`/`end`) are against the ORIGINAL, untrimmed
// input string — callers that also want the paragraph's own trimmed text
// get it via `.text`, but charPos anchors must line up with the real
// document, so the numeric offsets always point at the first/last
// non-whitespace character of the block, not at surrounding blank lines.

'use strict';

// One-or-more blank lines (allowing trailing horizontal whitespace on the
// "blank" line itself) is a paragraph boundary. Tolerates CRLF.
const BLANK_LINE_RE = /\r?\n[ \t]*\r?\n+/g;

/**
 * @param {string} text
 * @returns {Array<{ id: string, start: number, end: number, text: string }>}
 *   `id` is "P1", "P2", ... in document order, 1-indexed. A block that's
 *   all whitespace (e.g. two consecutive blank-line runs with nothing
 *   between them) is skipped entirely rather than emitted as an empty
 *   paragraph — it has no real position to point a note at.
 */
function splitIntoParagraphs(text) {
  if (typeof text !== 'string' || !text) return [];

  const out = [];
  const re = new RegExp(BLANK_LINE_RE.source, BLANK_LINE_RE.flags);

  const pushBlock = (start, end) => {
    const raw = text.slice(start, end);
    if (!raw.trim()) return; // whitespace-only block — not a paragraph
    const leading = raw.match(/^\s*/)[0].length;
    const trailing = raw.match(/\s*$/)[0].length;
    const trimmedStart = start + leading;
    const trimmedEnd = end - trailing;
    if (trimmedStart >= trimmedEnd) return;
    out.push({
      id: `P${out.length + 1}`,
      start: trimmedStart,
      end: trimmedEnd,
      text: text.slice(trimmedStart, trimmedEnd),
    });
  };

  let lastEnd = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    pushBlock(lastEnd, match.index);
    lastEnd = match.index + match[0].length;
  }
  pushBlock(lastEnd, text.length);

  return out;
}

module.exports = { splitIntoParagraphs };