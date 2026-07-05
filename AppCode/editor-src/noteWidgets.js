// Renders [mn: text] / [mn.type: text] markers as the same superscript
// anchor markup the old server-side parseMd() produced
// (span.mn-anchor > sup.mn-marker), so existing CSS in styles.css and the
// margin-column logic (keyed off data-note-id) keep working unchanged.
//
// The marker text stays live/editable: when the cursor is inside a
// marker's range, the raw `[mn: ...]` text is shown instead of the widget,
// exactly like the live-preview marks in livePreview.js.
import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

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
    sup.textContent = String(this.id);
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

function activeRanges(view) {
  return view.state.selection.ranges.map((r) => [r.from, r.to]);
}

function overlaps(aFrom, aTo, bFrom, bTo) {
  return aFrom <= bTo && bFrom <= aTo;
}

function buildDecorations(view) {
  const builder = new RangeSetBuilder();
  const markers = findNoteMarkers(view.state.doc);
  const sel = activeRanges(view);

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

export const noteMarkerWidgets = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);