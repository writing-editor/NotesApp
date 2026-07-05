// Renders [mn: text] / [mn.type: text] markers as the same superscript
// anchor markup the old server-side parseMd() produced
// (span.mn-anchor > sup.mn-marker), so existing CSS in styles.css and the
// margin-column logic (keyed off data-note-id) keep working unchanged.
//
// The marker text stays live/editable: when the cursor is inside a
// marker's range, the raw `[mn: ...]` text is shown instead of the widget,
// exactly like the live-preview marks in livePreview.js.
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { StateField, RangeSetBuilder } from '@codemirror/state';

// Same regex and same sequential (1-based, order-of-appearance) numbering
// scheme as lib/parse.js / mobile-sw.js's parseMd, so note ids stay
// consistent with what the backend's /api/note (PATCH/DELETE by nth
// occurrence) expects.
export const MN_RE = /\[mn(?:\.(\w+))?\s*:\s*([\s\S]*?)\]/g;

const NOTE_TYPE_CLASS = {
  query: 'mn-type-query',
  ref: 'mn-type-ref',
  todo: 'mn-type-todo',
};

class NoteAnchorWidget extends WidgetType {
  constructor(id, type, content) {
    super();
    this.id = id;
    this.type = type;
    this.content = content;
  }
  eq(other) {
    return other.id === this.id && other.type === this.type && other.content === this.content;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'mn-anchor' + (this.type ? ` ${NOTE_TYPE_CLASS[this.type] || ''}` : '');
    span.dataset.noteId = String(this.id);
    const sup = document.createElement('sup');
    sup.className = 'mn-marker';
    // No textContent here — the visible number comes from a CSS counter
    // (see styles.css's `.mn-marker::before`), which recomputes purely
    // from DOM order on every layout pass. That's deliberate: CM6 doesn't
    // reliably redraw every marker below an edit the instant note count
    // changes, so a number baked in here via JS can go stale until the
    // user interacts with that specific line. `data-note-id` (above) still
    // carries this widget's real id for margin-chip binding/lookup.
    span.appendChild(sup);
    return span;
  }
  ignoreEvent() {
    return false; // let clicks through so client.js can open/highlight the note
  }
}

// Finds every [mn...] marker in the whole doc (not just the viewport —
// numbering must be globally sequential to match the backend's
// nth-occurrence scheme), returning {from, to, id, type, content}.
export function findNoteMarkers(doc) {
  const text = doc.toString();
  const markers = [];
  let id = 0;
  let match;
  MN_RE.lastIndex = 0;
  while ((match = MN_RE.exec(text))) {
    id++;
    markers.push({
      from: match.index,
      to: match.index + match[0].length,
      id,
      type: match[1] || null,
      content: match[2].trim(),
    });
  }
  return markers;
}

function activeRanges(state) {
  return state.selection.ranges.map((r) => [r.from, r.to]);
}

// Whether selection range [aFrom,aTo] genuinely overlaps marker range
// [bFrom,bTo] — i.e. shares interior space, not just a touching edge.
// A zero-width caret sitting exactly at a marker's `from` or `to` boundary
// (e.g. right after insertNoteAt places the cursor "before" a freshly
// inserted marker) must NOT count as touching it, or the marker would show
// its raw `[mn: ...]` text instead of collapsing to the widget immediately
// — the opposite of what insertNoteAt is documented to do. Strict
// inequalities on both sides give that: a caret exactly on either boundary
// no longer overlaps, while a caret or selection genuinely inside the
// marker still does.
function overlaps(aFrom, aTo, bFrom, bTo) {
  return aFrom < bTo && bFrom < aTo;
}

function buildDecorations(state) {
  const builder = new RangeSetBuilder();
  const markers = findNoteMarkers(state.doc);
  const sel = activeRanges(state);

  for (const m of markers) {
    const isActive = sel.some(([f, t]) => overlaps(f, t, m.from, m.to));
    if (isActive) continue; // show raw markdown so it can be edited
    builder.add(
      m.from,
      m.to,
      Decoration.replace({
        widget: new NoteAnchorWidget(m.id, m.type, m.content),
      })
    );
  }
  return builder.finish();
}

// A StateField, not a ViewPlugin. Widget decorations here previously came
// from a ViewPlugin that recomputed reactively as part of the view-update
// cycle — but that left a real bug: after inserting a note, every marker
// below it (whose id/position shifted) could keep showing its old,
// pre-shift number until something *else* forced a second view update on
// that specific line (moving the cursor there, scrolling, a refresh). A
// StateField's value is computed as part of the state transaction itself,
// before the view decides what to draw, which is the same mechanism CM6's
// own built-in decorations (search highlighting, lint markers, etc.) use
// specifically because it can't drift out of sync with a single view's
// redraw scheduling the way a ViewPlugin's reactive recompute can.
export const noteMarkerWidgets = StateField.define({
  create(state) {
    return buildDecorations(state);
  },
  update(decorations, tr) {
    if (tr.docChanged || tr.selection) {
      return buildDecorations(tr.state);
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});