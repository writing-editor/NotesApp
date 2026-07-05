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
        clickHandler,
        selectionWatcher,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          autocapitalize: 'sentences',
          autocorrect: 'on',
          spellcheck: 'true',
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
    getNotes: () => findNoteMarkers(view.state.doc).map((m) => ({ id: m.id, type: m.type, content: m.content })),
    /** Inserts `[mn: text]` (or `[mn.type: text]`) right after `to`. */
    insertNoteAt: (to, noteText, noteType) => {
      const tag = noteType ? `mn.${noteType}` : 'mn';
      const marker = `[${tag}: ${noteText}]`;
      view.dispatch({
        changes: { from: to, to, insert: marker },
        selection: { anchor: to + marker.length },
      });
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