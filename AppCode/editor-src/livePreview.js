// Obsidian-style "live preview": walk the markdown syntax tree and hide
// syntax marks (#, **, _, `, link brackets, etc.) unless the current
// selection touches the line they're on. This is the only part of the
// editor that depends on the markdown grammar shipped by
// @codemirror/lang-markdown / @lezer/markdown.
import { syntaxTree } from '@codemirror/language';
import { Decoration, ViewPlugin } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

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
]);

const hiddenMark = Decoration.replace({});

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