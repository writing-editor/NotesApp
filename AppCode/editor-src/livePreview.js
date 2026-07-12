// Obsidian-style "live preview": walk the markdown syntax tree and hide
// syntax marks (#, **, _, `, link brackets, etc.) unless the current
// selection touches the line they're on. This is the only part of the
// editor that depends on the markdown grammar shipped by
// @codemirror/lang-markdown / @lezer/markdown.
//
// This file has two independent halves that are easy to conflate but do
// different jobs:
//   1. `livePreviewMarks` (below) — HIDES the raw syntax characters
//      themselves (the `#`, `**`, backticks, etc.) when the cursor isn't on
//      that line. This is the part that existed before.
//   2. `markdownHighlighting` — actually makes the SURROUNDING TEXT look
//      like a heading/bold/list item/etc. (bigger font, bold weight,
//      monospace background...) regardless of cursor position. Hiding the
//      `#` alone does nothing visually to the text that follows it — that
//      styling has to come from somewhere, and this is that somewhere.
// Both are needed together for a real live-preview effect; previously only
// (1) existed, which is why marks disappeared but nothing ever looked like
// a heading.
import { syntaxTree, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Decoration, ViewPlugin } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { tags } from '@lezer/highlight';

// Node names (from @lezer/markdown's default GFM grammar) whose syntax
// marks we hide when not actively being edited.
const MARK_NODE_NAMES = new Set([
  'HeaderMark',
  'EmphasisMark',
  'CodeMark',
  'LinkMark',
  'QuoteMark',
  'StrikethroughMark',
  'URL', // hide raw URL text inside [text](URL) when not editing the link
  'ListMark', // the -, *, +, or "1." before a list item
  // Deliberately NOT TaskMarker ([ ]/[x]) — that syntax IS the checkbox's
  // visible UI, unlike # or ** which are pure noise once you know the
  // paragraph is a heading/bold. Hiding it would leave nothing to look at
  // or click.
]);

// ── Typography (half 2 above) ───────────────────────────────────────────────
// Maps @lezer/markdown's highlight tags to CSS classes. The actual visual
// rules (font-size, weight, colour, etc.) live in editor-src's dedicated
// stylesheet — public/markdown-typography.css — deliberately kept out of
// the big styles.css so it's easy to iterate on typography alone. This
// mapping only decides WHICH class each syntax construct gets; it defines
// no colours or sizes itself.
//
// @codemirror/lang-markdown already assigns these tags to every construct
// (headings get heading1..heading6, distinct per level; bold/italic get
// strong/emphasis; etc.) — this is the standard, built-in CodeMirror
// mechanism for syntax-tree-driven styling (the same one code-block syntax
// highlighting uses), not a bespoke per-feature ruleset we're maintaining
// by hand. It also means this works anywhere CodeMirror itself works,
// including mobile WebViews served from the service worker — it's pure
// CSS classes under the hood, no platform-specific behaviour.
//
// NOTE on lists: there's no `tags.list` entry here on purpose. Testing
// against the actual grammar showed `tags.list` covers the ENTIRE
// `BulletList`/`OrderedList` node — every item's full text, not just the
// bullet/number marker — so mapping it to a bold/coloured style would
// have bolded the whole list body, not the marker. List markers are
// instead styled via `.cm-md-list-mark`, applied by a dedicated line/point
// decoration below (listMarkHighlighting), which targets exactly the
// `ListMark` node's own range.
export const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, class: 'cm-md-h1' },
  { tag: tags.heading2, class: 'cm-md-h2' },
  { tag: tags.heading3, class: 'cm-md-h3' },
  { tag: tags.heading4, class: 'cm-md-h4' },
  { tag: tags.heading5, class: 'cm-md-h5' },
  { tag: tags.heading6, class: 'cm-md-h6' },
  { tag: tags.strong, class: 'cm-md-strong' },
  { tag: tags.emphasis, class: 'cm-md-em' },
  { tag: tags.strikethrough, class: 'cm-md-strike' },
  { tag: tags.monospace, class: 'cm-md-code' },
  { tag: tags.link, class: 'cm-md-link' },
  { tag: tags.url, class: 'cm-md-url' },
  { tag: tags.quote, class: 'cm-md-quote' },
  { tag: tags.atom, class: 'cm-md-task-marker' }, // GFM task checkbox: [ ] / [x]
  { tag: tags.contentSeparator, class: 'cm-md-hr' }, // --- thematic break
  { tag: tags.processingInstruction, class: 'cm-md-mark' }, // fallback for stray mark-like tokens
]);

// syntaxHighlighting() is the extension that actually walks the tree and
// applies markdownHighlightStyle's classes — export it so main.js can add
// it to the editor's extensions list alongside livePreviewMarks.
export const markdownTypography = syntaxHighlighting(markdownHighlightStyle);

const hiddenMark = Decoration.replace({});
const quoteLine = Decoration.line({ class: 'cm-md-quote-line' });

function activeLineRanges(view) {
  // Returns [from,to] line ranges (doc coords) touched by any selection
  // range, expanded to whole lines so an active line's marks all show.
  const ranges = [];
  for (const range of view.state.selection.ranges) {
    const startLine = view.state.doc.lineAt(range.from);
    const endLine = view.state.doc.lineAt(range.to);
    ranges.push([startLine.from, endLine.to]);
  }
  return ranges;
}

function isOnActiveLine(pos, activeRanges) {
  for (const [from, to] of activeRanges) {
    if (pos >= from && pos <= to) return true;
  }
  return false;
}

function buildDecorations(view) {
  const builder = new RangeSetBuilder();
  const activeRanges = activeLineRanges(view);
  const collected = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (!MARK_NODE_NAMES.has(node.name)) return;
        // URL node: only hide when it's inside a Link (not a bare autolink
        // the user is actively typing) — cheap heuristic, good enough here.
        if (node.name === 'URL' && node.node.parent?.name !== 'Link') return;
        if (isOnActiveLine(node.from, activeRanges)) return;
        if (node.from === node.to) return;
        collected.push([node.from, node.to]);
      },
    });
  }

  collected.sort((a, b) => a[0] - b[0]);
  for (const [from, to] of collected) {
    builder.add(from, to, hiddenMark);
  }
  return builder.finish();
}

export const livePreviewMarks = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

// ── Blockquote line background ──────────────────────────────────────────
// Marks every line inside a Quote node with a `.cm-md-quote-line` class so
// markdown-typography.css can style the whole line (left border, italics,
// dimmed colour) with a plain class selector — deliberately not CSS
// `:has()`, since that's only reliably supported on fairly recent
// browsers/WebViews and this app also needs to render correctly in older
// mobile WebViews served via the service worker.
// Kept as its own RangeSetBuilder/ViewPlugin (rather than foled into
// buildDecorations above) because CM6's RangeSetBuilder requires strictly
// increasing, non-overlapping insertion order — mixing line decorations in
// with the point/replace "hide this mark" decorations above would need
// careful interleaved sorting for no real benefit, since the two systems
// (hide a range vs. tag a whole line) don't otherwise interact.
function buildQuoteLineDecorations(view) {
  const builder = new RangeSetBuilder();
  const seenLines = new Set();
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'Blockquote') return;
        let lineNo = view.state.doc.lineAt(node.from).number;
        const endLineNo = view.state.doc.lineAt(node.to).number;
        for (; lineNo <= endLineNo; lineNo++) {
          if (seenLines.has(lineNo)) continue;
          seenLines.add(lineNo);
        }
      },
    });
  }
  const sortedLines = [...seenLines].sort((a, b) => a - b);
  for (const lineNo of sortedLines) {
    const line = view.state.doc.line(lineNo);
    builder.add(line.from, line.from, quoteLine);
  }
  return builder.finish();
}

export const quoteLineHighlighting = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildQuoteLineDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildQuoteLineDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

// ── List marker styling ──────────────────────────────────────────────────
// Applies `.cm-md-list-mark` to exactly the ListMark node's own range (the
// `-`, `*`, `+`, or "1." glyph) — see the long comment on
// markdownHighlightStyle above for why this isn't done via `tags.list`.
// This decoration is independent of livePreviewMarks' hide/show logic
// above (that logic only ever hides ListMark, never styles it) — when the
// mark IS visible (cursor on that line), this decoration gives it the
// bullet-glyph look; when hidden, this decoration is simply irrelevant
// since there's no text left to see.
const listMark = Decoration.mark({ class: 'cm-md-list-mark' });

function buildListMarkDecorations(view) {
  const builder = new RangeSetBuilder();
  const collected = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'ListMark') return;
        if (node.from === node.to) return;
        collected.push([node.from, node.to]);
      },
    });
  }
  collected.sort((a, b) => a[0] - b[0]);
  for (const [from, to] of collected) {
    builder.add(from, to, listMark);
  }
  return builder.finish();
}

export const listMarkHighlighting = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildListMarkDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildListMarkDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);