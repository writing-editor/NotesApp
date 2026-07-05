// Bridge between the CM6 doc and client.js's existing margin-column
// renderer. Deliberately thin: client.js's positionChips() (public/client.js
// ~line 542) already does the hard work (collision avoidance, clustering,
// waterfilled line allocation) by reading `.mn-anchor[data-note-id]` out of
// #main-text and appending `.mn-chip` elements into #margin-col. Since
// noteWidgets.js renders that exact same `.mn-anchor` markup as a CM6
// widget, positionChips() keeps working completely unmodified — this
// module's only job is telling client.js *when* to re-run it (viewport /
// selection / doc changes) and what the current notes list is (id/type/
// content), replacing the old `/api/chapter` response's `notes[]` array.
import { ViewPlugin } from '@codemirror/view';
import { findNoteMarkers } from './noteWidgets.js';

function notesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].type !== b[i].type || a[i].content !== b[i].content || a[i].charPos !== b[i].charPos) {
      return false;
    }
  }
  return true;
}

export function marginBridge({ onNotesChanged, onLayoutChanged }) {
  let lastNotes = [];
  let rafHandle = null;

  function scheduleLayout() {
    if (rafHandle) return;
    rafHandle = requestAnimationFrame(() => {
      rafHandle = null;
      onLayoutChanged?.();
    });
  }

  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        lastNotes = findNoteMarkers(view.state.doc).map((m) => ({
          id: m.id,
          type: m.type,
          content: m.content,
          charPos: m.from,
        }));
        onNotesChanged?.(lastNotes);
        scheduleLayout();
      }
      update(update) {
        if (update.docChanged) {
          const notes = findNoteMarkers(update.state.doc).map((m) => ({
            id: m.id,
            type: m.type,
            content: m.content,
            charPos: m.from,
          }));
          if (!notesEqual(notes, lastNotes)) {
            lastNotes = notes;
            onNotesChanged?.(lastNotes);
          }
        }
        // Widgets can move/appear/disappear (cursor entering/leaving a
        // marker or a live-preview mark) without the doc itself changing,
        // and scrolling/geometry changes need a reposition too — so always
        // schedule a layout pass on any update, coalesced via rAF.
        if (update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged) {
          scheduleLayout();
        }
      }
    }
  );
}