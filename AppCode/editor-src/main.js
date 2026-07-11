// Single-surface markdown editor: live preview + inline note markers +
// margin-note bridging. Replaces the old public/mn-editor.bundle.js
// (whole-doc edit mode only, no notes) and the server-rendered static-HTML
// view mode. See AppCode/EDITOR_MIGRATION_PLAN.md for the full picture.
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, drawSelection, dropCursor } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data'; // fenced code block highlighting, optional but small

import { livePreviewMarks } from './livePreview.js';
import { noteMarkerWidgets, findNoteMarkers } from './noteWidgets.js';
import { marginBridge } from './marginSync.js';
import { paragraphGutter } from './paragraphGutter.js';

/**
 * @param {Object} opts
 * @param {HTMLElement} opts.parent      Element to mount the editor into (was #editor-mount / #main-text).
 * @param {string} opts.doc              Initial raw markdown.
 * @param {(text:string)=>void} [opts.onChange]        Fired (debounced by caller if desired) on every doc change, with the full raw markdown.
 * @param {(notes:Array<{id:number,type:?string,content:string}>)=>void} [opts.onNotesChanged]  Fired whenever the note list changes — feed straight into client.js's `currentNotes`.
 * @param {()=>void} [opts.onLayoutChanged]             Fired whenever margin chips likely need repositioning — call client.js's positionChips() from here.
 * @param {(info:{text:string, from:number, to:number, screenRect:DOMRect})=>void} [opts.onSelectionForNote]  Fired when the user has a non-empty selection that could become a note (mouseup/keyup settled). Drives the existing tooltip/note-sheet UI.
 * @param {(noteId:number)=>void} [opts.onNoteAnchorClick]  Fired when a note's inline superscript is clicked (mirrors the old .mn-marker click binding).
 */
export function createLiveEditor({
  parent,
  doc = '',
  onChange,
  onNotesChanged,
  onLayoutChanged,
  onSelectionForNote,
  onSelectionCleared,
  onNoteAnchorClick,
}) {
  let selectionSettleTimer = null;

  const clickHandler = EditorView.domEventHandlers({
    mousedown(event, view) {
      const anchor = event.target.closest?.('.mn-anchor');
      if (anchor && onNoteAnchorClick) {
        const id = Number(anchor.dataset.noteId);
        if (id) {
          onNoteAnchorClick(id);
          // Let the click also place the cursor there (don't preventDefault) —
          // matches "click puts cursor at that position" even on a note anchor.
        }
      }
    },
  });

  const selectionWatcher = EditorView.updateListener.of((update) => {
    if (update.docChanged && onChange) {
      onChange(update.state.doc.toString());
    }
    if (update.selectionSet) {
      const { from, to } = update.view.state.selection.main;
      if (from === to) {
        clearTimeout(selectionSettleTimer);
        onSelectionCleared?.();
      } else if (onSelectionForNote) {
        clearTimeout(selectionSettleTimer);
        selectionSettleTimer = setTimeout(() => {
          const text = update.state.doc.sliceString(from, to);
          const screenRect = rectForRange(update.view, from, to);
          onSelectionForNote({ text, from, to, screenRect });
        }, 200); // mirrors the old 250ms selectionchange debounce closely enough
      }
    }
  });

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        drawSelection(), // normalizes caret/selection rendering across mobile WebViews
        dropCursor(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown({ codeLanguages: languages }),
        livePreviewMarks,
        noteMarkerWidgets,
        marginBridge({ onNotesChanged, onLayoutChanged }),
        paragraphGutter,
        clickHandler,
        selectionWatcher,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          autocapitalize: 'sentences',
          autocorrect: 'on',
          spellcheck: 'true',
          lang: 'en-GB',
        }),
      ],
    }),
  });

  return {
    view,
    getDoc: () => view.state.doc.toString(),
    setDoc: (text) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    },
    getNotes: () => findNoteMarkers(view.state.doc).map((m) => ({ id: m.id, type: m.type, content: m.content, charPos: m.from })),
    /**
     * Inserts `[mn: text]` (or `[mn.type: text]`) right after `to`. The
     * cursor is placed *before* the new marker (at the original `to`), not
     * inside or immediately after it — noteWidgets.js renders raw `[mn:
     * ...]` text instead of the collapsed superscript widget whenever the
     * selection touches the marker's range (so it stays editable), and a
     * zero-width cursor sitting right at the marker's end still counts as
     * touching it. Leaving the cursor just before the marker means the note
     * renders as its usual widget immediately, matching every other note on
     * the page, instead of sitting in "raw markdown" form until the next
     * unrelated selection change moves the cursor off of it.
     */
    insertNoteAt: (to, noteText, noteType) => {
      const tag = noteType ? `mn.${noteType}` : 'mn';
      const marker = `[${tag}: ${noteText}]`;
      view.dispatch({
        changes: { from: to, to, insert: marker },
        selection: { anchor: to },
      });
    },
    /**
     * Re-tags the note with the given `id` (1-based, order-of-appearance —
     * same numbering findNoteMarkers/getNotes/onNotesChanged use) to
     * `newType`, preserving its content. Re-locates the marker's current
     * range in the live doc rather than trusting a caller-held offset, so
     * this is safe to call even if the doc has shifted since the caller
     * last read the note list (as long as the note count/order hasn't
     * changed — same assumption the old server-side by-id write made).
     * No-ops if a note with that id no longer exists.
     */
    retypeNoteById: (id, newType) => {
      const marker = findNoteMarkers(view.state.doc).find((m) => m.id === id);
      if (!marker) return false;
      const tag = newType ? `mn.${newType}` : 'mn';
      const replacement = `[${tag}: ${marker.content}]`;
      view.dispatch({ changes: { from: marker.from, to: marker.to, insert: replacement } });
      return true;
    },
    /** Deletes the note with the given `id`. No-ops if it no longer exists. */
    removeNoteById: (id) => {
      const marker = findNoteMarkers(view.state.doc).find((m) => m.id === id);
      if (!marker) return false;
      view.dispatch({ changes: { from: marker.from, to: marker.to, insert: '' } });
      return true;
    },
    /**
     * Returns this note's vertical position/height in *client* (viewport)
     * coordinates, computed from CM6's internal height map via
     * `view.lineBlockAt()` rather than by looking up the rendered
     * `.mn-anchor` DOM node. This matters because CM6 only renders DOM for
     * lines inside (or very near) the current viewport — it does NOT keep
     * every widget in the document mounted the way the old server-rendered
     * static HTML did. A note anchor that's currently scrolled out of view
     * simply has no DOM element, so any positioning logic that does
     * `document.querySelector('.mn-anchor[data-note-id=...]')` will find
     * nothing for it until that part of the document happens to scroll (or
     * get re-rendered on refresh) into the drawn range. `lineBlockAt`
     * doesn't have that limitation — CM6 maintains height estimates for the
     * whole document up front, refined as lines are actually measured — so
     * this returns a usable position even for offscreen/undrawn notes.
     */
    getNoteMetrics: (charPos) => {
      const pos = Math.max(0, Math.min(charPos, view.state.doc.length));
      const block = view.lineBlockAt(pos);
      const scrollRect = view.scrollDOM.getBoundingClientRect();
      const top = scrollRect.top - view.scrollDOM.scrollTop + block.top;
      return { top, height: block.height };
    },
    /** Moves the cursor to `charPos` and asks CM6 to scroll/render it into view (forces the widget/DOM to exist there). */
    scrollToPos: (charPos) => {
      view.dispatch({ selection: { anchor: charPos }, scrollIntoView: true });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

function rectForRange(view, from, to) {
  const start = view.coordsAtPos(from);
  const end = view.coordsAtPos(to);
  if (!start || !end) return null;
  const left = Math.min(start.left, end.left);
  const right = Math.max(start.right, end.right);
  const top = Math.min(start.top, end.top);
  const bottom = Math.max(start.bottom, end.bottom);
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}