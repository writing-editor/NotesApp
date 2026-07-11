// editor-src/paragraphGutter.js
//
// Renders a paragraph number in the left gutter (the space between the
// sidebar and the reading column) next to the first line of every
// paragraph — nothing on every other line. Desktop only; hidden on mobile
// entirely by CSS (see public/styles.css's `.main-text .cm-gutters` rules,
// gated by the same 768px breakpoint the rest of the layout already
// switches on).
//
// Purpose: this is the visible half of the paragraph-numbering fix in
// lib/paragraphs.js / lib/ai-proxy.js. The AI agent no longer guesses a
// character offset — it names a paragraph id ("P4") from a numbered list
// it's shown, and that id is resolved server-side to the paragraph's real
// position. For that to be legible/debuggable to a person reading the
// manuscript, "paragraph 4" needs to mean the same thing on screen that it
// means to the model — so this gutter numbers paragraphs using the exact
// same splitIntoParagraphs() function lib/ai-proxy.js's buildPrompt() uses,
// imported from the one shared module (lib/paragraphs.js) rather than a
// second, possibly-drifting implementation of "what counts as a
// paragraph."
//
// Recomputed only on docChanged (not on every selection/viewport update —
// see lineMarkerChange below), same economy principle as marginSync.js's
// own scheduleLayout(). splitIntoParagraphs() walks the whole document
// text, which is fine at manuscript-chapter scale but there's no reason to
// re-run it on a plain cursor move.
import { gutter, GutterMarker } from '@codemirror/view';
import { StateField } from '@codemirror/state';
import * as paragraphsModule from '../lib/paragraphs.js';

const { splitIntoParagraphs } = paragraphsModule;

class ParagraphNumberMarker extends GutterMarker {
  constructor(number) {
    super();
    this.number = number;
  }
  eq(other) {
    return other.number === this.number;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-paragraph-number';
    span.textContent = String(this.number);
    return span;
  }
}

// Map of CM6 line number (1-based, state.doc.lineAt(...).number) -> the
// 1-based paragraph index that line starts — i.e. line N is in this map
// iff it's the first line of paragraph N-in-the-map's-value. Only a
// paragraph's *first* line is ever a key; wrapped/continuation lines
// within the same paragraph are deliberately absent so the gutter shows
// one number per paragraph, not one per visual line.
function computeParagraphStartLines(state) {
  const text = state.doc.toString();
  const paragraphs = splitIntoParagraphs(text);
  const map = new Map();
  for (let i = 0; i < paragraphs.length; i++) {
    const line = state.doc.lineAt(paragraphs[i].start);
    map.set(line.number, i + 1);
  }
  return map;
}

const paragraphStartLines = StateField.define({
  create(state) {
    return computeParagraphStartLines(state);
  },
  update(value, tr) {
    if (!tr.docChanged) return value;
    return computeParagraphStartLines(tr.state);
  },
});

export const paragraphGutter = [
  paragraphStartLines,
  gutter({
    class: 'cm-paragraph-gutter',
    lineMarker(view, line) {
      const starts = view.state.field(paragraphStartLines);
      const lineNumber = view.state.doc.lineAt(line.from).number;
      const num = starts.get(lineNumber);
      return num ? new ParagraphNumberMarker(num) : null;
    },
    lineMarkerChange(update) {
      return update.docChanged;
    },
    // Reserves gutter width for a plausible widest label up front, so the
    // reading column doesn't visibly shift right as note numbers climb
    // into double/triple digits over a long chapter.
    initialSpacer() {
      return new ParagraphNumberMarker('888');
    },
  }),
];