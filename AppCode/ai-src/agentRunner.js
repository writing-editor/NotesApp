// ai-src/agentRunner.js — Stage 4.
//
// Wires the "Run agent" button to the already-working /api/ai/chat route
// (Stage 3, lib/ai-proxy.js) and, on success, hands the returned placements
// to noteSplice.js to actually land them in the live document. This file
// owns: reading config/key out of storage.js, resolving "scope" into actual
// chapter text, the fetch() call itself, cancel-in-flight, and the
// queued/thinking/done/error status strings. It does not touch the DOM
// directly except via the small `onStatusChange` callback the caller
// supplies — settingsPanel.js owns the actual status <small> element.
//
// Editor access (CONTEXT.md §4/§8's "open question"): resolved here as an
// extra mount()-time option threaded all the way from client.js:
//   client.js:   window.MnAI.mount({ triggerEl, getEditor: () => liveEditor })
//   main.js:     mount({ triggerEl, getEditor }) -> passed through to both
//                buildSettingsPanel() and (indirectly) runAgent()
//   agentRunner: calls the supplied getEditor() fresh at run time (not once
//                at mount time), since client.js's liveEditor is reassigned
//                every time a chapter is opened (mountLiveEditor()) — a
//                stale reference captured at mount() would go stale the
//                moment the user switches chapters after opening the Agent
//                panel once.
//
// Scope (plan.md §1/§8's Stage 4 line): only 'chapter' is implemented, since
// 'all chapters' is explicitly deferred to Stage 5 and is already disabled
// in the scope <select> (settingsPanel.js). Resolving 'chapter' scope reads
// the *live* in-memory doc via editor.getDoc(), not a re-fetch from disk —
// same reasoning as remountAfterNoteMutation() reading liveEditor.getDoc()
// elsewhere in client.js: the editor's in-memory text is the current source
// of truth, disk may still be mid-debounce.

import { getAgentConfig, getProviderKey } from './storage.js';
import { spliceNotes } from './noteSplice.js';

// Module-level so a second "Run agent" click can cancel the first run's
// in-flight fetch via AbortController — there is only ever one Agent
// settings panel/runner instance per app (mirrors liveEditor's own
// module-level singleton in client.js), so a module-level handle is
// sufficient and avoids threading an AbortController through every caller.
let inFlightController = null;

/**
 * @param {Object} opts
 * @param {() => (import('../editor-src/main.js').LiveEditor | null)} opts.getEditor
 *   Returns the *current* live editor instance, called fresh at run time
 *   (see module comment above) — not memoized.
 * @param {() => void} [opts.onAfterMutation]
 *   Forwarded to noteSplice.js — pass client.js's remountAfterNoteMutation
 *   equivalent so note superscripts refresh after a successful run.
 * @param {(status: string) => void} opts.onStatusChange
 *   Called with a short human-readable string at each stage transition:
 *   'queued' -> 'thinking' -> 'done' | 'error' | 'cancelled'. The caller
 *   (settingsPanel.js) owns turning this into the actual status text shown.
 * @returns {Promise<{ ok: boolean, inserted?: number, error?: string }>}
 */
export async function runAgent({ getEditor, onAfterMutation, onStatusChange } = {}) {
  const notify = (s) => { if (typeof onStatusChange === 'function') onStatusChange(s); };

  // Cancel any previous run before starting a new one — only one run at a
  // time makes sense against a single document.
  if (inFlightController) {
    inFlightController.abort();
    inFlightController = null;
  }

  notify('queued');

  const editor = typeof getEditor === 'function' ? getEditor() : null;
  if (!editor || typeof editor.getDoc !== 'function') {
    notify('error');
    return { ok: false, error: 'No chapter is open in the editor.' };
  }

  const config = getAgentConfig();
  const { provider, model, ollamaUrl, systemPrompt, mode } = config;

  if (mode === 'read-only') {
    // Read-only preview mode is present as a select option (settingsPanel.js)
    // but preview-without-writing is a Stage 6 polish item (plan.md's
    // "richer error states" / future review affordance), not built yet —
    // fail clearly rather than silently falling back to read-write.
    notify('error');
    return { ok: false, error: 'Read-only preview mode isn\u2019t implemented yet — switch Mode to Read-write to run.' };
  }

  // Scope is always 'chapter' for now (see module comment) — the currently
  // open chapter's live in-memory text.
  const chapterText = editor.getDoc();
  if (!chapterText || !chapterText.trim()) {
    notify('error');
    return { ok: false, error: 'The current chapter is empty — nothing to send.' };
  }

  const apiKey = provider === 'ollama' ? '' : await getProviderKey(provider);
  if (provider !== 'ollama' && !apiKey) {
    notify('error');
    return { ok: false, error: `No API key saved for ${provider}. Add one in Connection and Save first.` };
  }

  const controller = new AbortController();
  inFlightController = controller;

  notify('thinking');

  let response;
  try {
    response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ provider, model, apiKey, ollamaUrl, systemPrompt, chapterText }),
    });
  } catch (e) {
    if (controller.signal.aborted) {
      notify('cancelled');
      return { ok: false, error: 'Run cancelled.' };
    }
    notify('error');
    return { ok: false, error: e.message || 'Network request failed.' };
  } finally {
    if (inFlightController === controller) inFlightController = null;
  }

  let result;
  try {
    result = await response.json();
  } catch (e) {
    notify('error');
    return { ok: false, error: 'Server returned an invalid response.' };
  }

  if (!result || result.ok !== true) {
    notify('error');
    return { ok: false, error: (result && result.error) || `Request failed (${response.status})` };
  }

  const inserted = spliceNotes({
    editor,
    placements: result.placements,
    onAfterMutation,
  });

  notify('done');
  return { ok: true, inserted };
}

/**
 * Cancels the current in-flight run, if any. Safe to call when nothing is
 * running. Used by the settings panel's Cancel affordance (Stage 4 line in
 * plan.md: "Cancel-in-flight").
 */
export function cancelAgent() {
  if (inFlightController) {
    inFlightController.abort();
    inFlightController = null;
  }
}
