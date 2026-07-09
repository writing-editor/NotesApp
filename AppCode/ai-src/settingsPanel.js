// ai-src/settingsPanel.js
//
// Builds the AI agent's settings drawer DOM and open/close behaviour.
// Deliberately mirrors the markup/class names of the existing
// #settings-overlay / #settings-panel Sync drawer (AppCode/public/index.html,
// styled in AppCode/public/styles.css) so this gets the same look for free —
// but it is its own overlay/panel pair with its own ids, not a re-skin of the
// Sync drawer's actual DOM nodes. See AppCode/CONTEXT.md §"Settings drawer
// shell" for the exact reference markup this was copied from.
//
// Stage 1 built the DOM, open/close, and the two sections (Connection,
// Agent behaviour) with disabled/inert fields. Stage 2 wired Save/load:
// per-provider API keys and the Ollama base URL through the 3-tier storage
// in storage.js (mirroring the git PAT convention exactly — see
// CONTEXT.md §5), plus the non-secret agent-behaviour text/scope/mode
// through plain localStorage. Stage 3 built the backend proxy this drawer
// now calls into. Stage 4 enables "Run agent" for real: wired to
// agentRunner.js's runAgent()/cancelAgent(), a "Cancel" button that only
// shows while a run is in flight, and a run-status line driven by
// agentRunner's queued/thinking/done/error/cancelled callbacks. Stage 6
// (this pass) adds: a spinner on the Run button while a run is in flight
// (in addition to the existing status line, which is easy to miss); a
// preview list + "Apply" action for read-only-mode runs; a per-kind error
// message instead of one generic string; and an "Undo last run" action.

import { getProviderKey, setProviderKey, keyStorageDescription, getAgentConfig, setAgentConfig } from './storage.js';
import { runAgent, cancelAgent, applyPreview, undoLastRun, canUndoLastRun } from './agentRunner.js';

// Stage 4: maps agentRunner's status strings to the text shown in the
// run-status line. Kept as a small lookup rather than inline ternaries so
// the wording is easy to revisit in Stage 6 polish without hunting through
// the button handler.
const STATUS_TEXT = {
  queued: 'Queued\u2026',
  thinking: 'Thinking\u2026',
  done: 'Done.',
  error: 'Error \u2014 see message above.',
  cancelled: 'Cancelled.',
};

// Stage 6 "richer error states": agentRunner.js now tags a failed run with
// a `kind`, so instead of always showing the same generic message, this
// gives each distinguishable failure its own actionable text. Falls back to
// the raw `error` string for anything not in this map (e.g. a provider's
// own error message, which is already specific).
const ERROR_KIND_TEXT = {
  'no-key':          'No API key saved for this provider \u2014 add one in Connection above and Save.',
  'no-agent':        'No agent profile selected \u2014 choose one in Agent behaviour above and Save.',
  'no-editor':       'No chapter is open in the editor.',
  'offline':         'Couldn\u2019t reach the server \u2014 check your connection and try again.',
  'empty':           null, // message from agentRunner is already specific enough
  'nothing-usable':  'The model didn\u2019t return anything usable \u2014 try again, or try a different agent profile.',
  'server':          null, // message from agentRunner/provider is already specific
  'cancelled':       'Run cancelled.',
};

const PROVIDERS = [
  { value: 'claude',  label: 'Claude (Anthropic)' },
  { value: 'openai',  label: 'OpenAI' },
  { value: 'gemini',  label: 'Gemini (Google)' },
  { value: 'ollama',  label: 'Ollama (local)' },
];

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child) node.appendChild(child);
  }
  return node;
}

/**
 * @param {Object} opts
 * @param {HTMLElement} [opts.triggerEl]  The sidebar-footer button (#agent-action)
 *   that should open this drawer directly — there is no intermediate chat
 *   window in this design, so the trigger opens Settings, full stop.
 * @param {() => (object|null)} [opts.getEditor]  Stage 4: returns client.js's
 *   current live editor instance, threaded through from MnAI.mount(). Passed
 *   to agentRunner.runAgent() fresh on every Run click.
 * @param {() => (string|null)} [opts.getCurrentPath]  Stage 5: returns
 *   client.js's current chapter path, threaded through from MnAI.mount().
 *   Passed to agentRunner.runAgent() so 'all' scope knows which manifest
 *   entry is the one actually mounted in the live editor.
 * @returns {{ open: () => void, close: () => void, root: HTMLElement }}
 */
export function buildSettingsPanel({ triggerEl, getEditor, getCurrentPath } = {}) {
  // ── Overlay / panel shell (same class names as #settings-overlay/#settings-panel) ──
  const overlay = el('div', { class: 'settings-overlay ai-settings-overlay', id: 'ai-settings-overlay' });
  const panel   = el('div', { class: 'settings-panel', id: 'ai-settings-panel' });

  const head = el('div', { class: 'settings-head' }, [
    el('span', { class: 'settings-title', text: 'AI Agent' }),
    el('button', { class: 'settings-close', id: 'ai-settings-close', text: '\u2715' }),
  ]);

  const body = el('div', { class: 'settings-body' });

  // ── Section 1: Connection ──────────────────────────────────────────────
  const connectionSection = el('div', { class: 'settings-section' }, [
    el('label', { text: 'Provider' }),
  ]);
  const providerSelect = el('select', { id: 'ai-provider-select' });
  PROVIDERS.forEach(p => {
    providerSelect.appendChild(el('option', { value: p.value, text: p.label }));
  });
  connectionSection.appendChild(providerSelect);

  const modelSection = el('div', { class: 'settings-section' }, [
    el('label', { text: 'Model' }),
    el('input', { type: 'text', id: 'ai-model-input', placeholder: 'e.g. claude-sonnet-5' }),
  ]);

  const keySection = el('div', { class: 'settings-section', id: 'ai-key-section' }, [
    el('label', { text: 'API key' }),
    el('input', { type: 'password', id: 'ai-key-input', placeholder: 'sk-...' }),
  ]);

  const keyNote = el('div', { class: 'settings-section', id: 'ai-key-note' }, [
    el('small', {
      id: 'ai-key-note-text',
      text: 'Loading storage info\u2026',
    }),
  ]);

  // Ollama has no key, just a base URL — shown/hidden based on provider,
  // wiring for that toggle also lands with the rest of Stage 2's storage
  // logic, but the field exists now so the layout doesn't shift later.
  const ollamaUrlSection = el('div', {
    class: 'settings-section',
    id: 'ai-ollama-url-section',
    style: 'display:none;',
  }, [
    el('label', { text: 'Ollama base URL' }),
    el('input', { type: 'text', id: 'ai-ollama-url-input', placeholder: 'http://localhost:11434' }),
  ]);

  // ── Section 2: Agent behaviour ─────────────────────────────────────────
  // Stage 6 §2: the old free-text system-prompt box is replaced with a
  // dropdown of agent *files* — bundled defaults plus per-vault overrides
  // in the vault's agents/ folder (see server.js's /api/agents). Picking
  // one is a leap of faith without seeing what it says, so a read-only
  // preview of the file's first few lines sits right under the dropdown.
  const behaviourHeading = el('div', { class: 'settings-section' }, [
    el('label', { text: 'Agent behaviour' }),
    el('small', {
      text: 'Pick an agent profile — its file\u2019s contents become the system prompt for this run.',
    }),
  ]);

  const promptSection = el('div', { class: 'settings-section' }, [
    el('select', { id: 'ai-agent-select' }),
    el('small', { id: 'ai-agent-preview', class: 'ai-agent-preview', text: 'Loading agents\u2026' }),
  ]);

  const scopeSection = el('div', { class: 'settings-section settings-row' }, [
    el('div', {}, [
      el('label', { text: 'Scope' }),
      (() => {
        const sel = el('select', { id: 'ai-scope-select' });
        sel.appendChild(el('option', { value: 'chapter', text: 'Current chapter' }));
        sel.appendChild(el('option', { value: 'all', text: 'All chapters' }));
        // Stage 5: enabled — agentRunner.js now branches on this
        // (runAllChaptersScope()) instead of always reading the live
        // editor's doc. Was a disabled placeholder through Stage 4.
        return sel;
      })(),
      // Stage 5: "Current chapter" is otherwise a bit of a black box — this
      // makes explicit which chapter a run will actually see, tracked live
      // off client.js's loadChapter() via the mn:chapter-changed event
      // rather than read once at panel-build time (which would go stale
      // the moment the reader switched chapters without reopening the
      // drawer).
      el('small', { id: 'ai-scope-tracking', text: 'Tracking: no chapter open yet' }),
    ]),
    el('div', {}, [
      el('label', { text: 'Mode' }),
      (() => {
        const sel = el('select', { id: 'ai-mode-select' });
        sel.appendChild(el('option', { value: 'read-write', text: 'Read-write (insert notes)' }));
        sel.appendChild(el('option', { value: 'read-only', text: 'Read-only (preview only)' }));
        return sel;
      })(),
    ]),
  ]);

  const actions = el('div', { class: 'settings-actions' }, [
    el('button', { class: 'settings-btn settings-btn-primary', id: 'ai-save-config', text: 'Save' }),
    // Stage 4: enabled now that agentRunner.js/noteSplice.js exist. Stage 6:
    // the button's label is now driven by setRunning() below so a spinner
    // can appear alongside "Running\u2026" without a separate element to
    // manage visibility for.
    el('button', { class: 'settings-btn', id: 'ai-run-agent' }, [
      el('span', { id: 'ai-run-agent-spinner', class: 'ai-btn-spinner', style: 'display:none;' }),
      el('span', { id: 'ai-run-agent-label', text: 'Run agent' }),
    ]),
    // Stage 4: hidden until a run is actually in flight (see toggling in
    // setRunning() below) — no point showing "Cancel" when there's nothing
    // to cancel.
    el('button', { class: 'settings-btn', id: 'ai-cancel-agent', style: 'display:none;', text: 'Cancel' }),
    // Stage 6 per-run undo: hidden unless a completed run's notes are still
    // undoable (see refreshUndoVisibility() below) — canUndoLastRun() is the
    // single source of truth so this can never show up out of sync with
    // whether agentRunner.js actually has something to undo.
    el('button', { class: 'settings-btn', id: 'ai-undo-run', style: 'display:none;', text: 'Undo last run' }),
  ]);

  const runStatus = el('div', { class: 'settings-section', id: 'ai-run-status' }, [
    el('small', { id: 'ai-run-status-text', text: 'Not run yet.' }),
  ]);

  // Stage 6 read-only/preview mode: a run in Mode = "Read-only" surfaces
  // its resolved placements here instead of writing them — one row per
  // proposed note, with a single "Apply all" action that hands the same
  // placements to agentRunner.applyPreview() to actually splice them in.
  // Hidden whenever there's nothing to preview (see renderPreview() below).
  const previewSection = el('div', { class: 'settings-section', id: 'ai-preview-section', style: 'display:none;' }, [
    el('label', { text: 'Preview \u2014 nothing has been written yet' }),
    el('div', { id: 'ai-preview-list', class: 'ai-preview-list' }),
    el('div', { class: 'settings-actions', style: 'margin-top:0.5rem;' }, [
      el('button', { class: 'settings-btn settings-btn-primary', id: 'ai-preview-apply', text: 'Apply all' }),
      el('button', { class: 'settings-btn', id: 'ai-preview-discard', text: 'Discard' }),
    ]),
  ]);

  body.append(
    connectionSection, modelSection, keySection, keyNote, ollamaUrlSection,
    behaviourHeading, promptSection, scopeSection,
    actions, runStatus, previewSection,
  );

  const modelInput      = modelSection.querySelector('#ai-model-input');
  const keyInput        = keySection.querySelector('#ai-key-input');
  const keyNoteText     = keyNote.querySelector('#ai-key-note-text');
  const ollamaUrlInput  = ollamaUrlSection.querySelector('#ai-ollama-url-input');
  const agentSelect     = promptSection.querySelector('#ai-agent-select');
  const agentPreview    = promptSection.querySelector('#ai-agent-preview');
  const scopeSelect     = scopeSection.querySelector('#ai-scope-select');
  const scopeTracking   = scopeSection.querySelector('#ai-scope-tracking');
  const modeSelect      = scopeSection.querySelector('#ai-mode-select');
  const saveBtn         = actions.querySelector('#ai-save-config');
  const runBtn          = actions.querySelector('#ai-run-agent');
  const runBtnSpinner   = actions.querySelector('#ai-run-agent-spinner');
  const runBtnLabel     = actions.querySelector('#ai-run-agent-label');
  const cancelBtn       = actions.querySelector('#ai-cancel-agent');
  const undoBtn         = actions.querySelector('#ai-undo-run');
  const runStatusText   = runStatus.querySelector('#ai-run-status-text');
  const previewList     = previewSection.querySelector('#ai-preview-list');
  const previewApplyBtn = previewSection.querySelector('#ai-preview-apply');
  const previewDiscardBtn = previewSection.querySelector('#ai-preview-discard');

  // Stage 6: holds whatever the most recent read-only run returned, so
  // "Apply all" has something to act on without re-running the model.
  // Cleared on discard, on a successful apply, and whenever a new run
  // starts. Shape matches runAgent()'s preview return: either
  // `{ placements }` ('chapter' scope) or `{ previewByFile }` ('all' scope).
  let pendingPreview = null;

  // Stage 5: kept as module-scoped-to-this-closure state (not read fresh off
  // the DOM) because the label needs to update even while the drawer is
  // closed — a chapter switch while the panel is shut shouldn't show stale
  // info the next time it opens.
  let currentChapterLabel = null;

  function renderScopeTracking() {
    if (scopeSelect.value === 'all') {
      scopeTracking.textContent = 'Applies to every chapter in the vault (front matter, chapters, back matter).';
      return;
    }
    scopeTracking.textContent = currentChapterLabel
      ? `Tracking: ${currentChapterLabel}`
      : 'Tracking: no chapter open yet';
  }

  window.addEventListener('mn:chapter-changed', (e) => {
    currentChapterLabel = e.detail?.label || e.detail?.path || null;
    renderScopeTracking();
  });
  scopeSelect.addEventListener('change', renderScopeTracking);

  // Stage 6 §2: cache of the last-fetched /api/agents list, keyed by
  // `key`, so switching the dropdown's selection can update the preview
  // instantly without a second round-trip per option.
  let agentsByKey = new Map();

  async function loadAgentsList(selectedKey) {
    agentSelect.innerHTML = '';
    agentPreview.textContent = 'Loading agents\u2026';
    try {
      const res = await fetch('/api/agents');
      const data = await res.json().catch(() => ({}));
      const agents = (data && data.agents) || [];
      agentsByKey = new Map(agents.map(a => [a.key, a]));

      if (agents.length === 0) {
        agentSelect.appendChild(el('option', { value: '', text: 'No agents found' }));
        agentPreview.textContent = 'No agent profiles found — add one to your vault\u2019s agents/ folder.';
        return;
      }

      agents.forEach(a => {
        const label = a.source === 'vault' ? `${a.label} (vault)` : a.label;
        agentSelect.appendChild(el('option', { value: a.key, text: label }));
      });

      // Prefer the previously-selected key if it still exists; otherwise
      // fall back to the first entry rather than leaving nothing chosen.
      agentSelect.value = agentsByKey.has(selectedKey) ? selectedKey : agents[0].key;
      renderAgentPreview();
    } catch (e) {
      agentSelect.appendChild(el('option', { value: '', text: 'Could not load agents' }));
      agentPreview.textContent = `Could not reach the server: ${e.message}`;
    }
  }

  function renderAgentPreview() {
    const agent = agentsByKey.get(agentSelect.value);
    agentPreview.textContent = agent && agent.preview
      ? agent.preview
      : (agent ? '(empty file)' : '');
  }

  agentSelect.addEventListener('change', renderAgentPreview);

  // Applies the provider->field-visibility toggle (key field vs. Ollama URL
  // field) without re-triggering a load — used both by the change listener
  // and by open()'s initial population, so the two never drift apart.
  function applyProviderVisibility() {
    const isOllama = providerSelect.value === 'ollama';
    keySection.style.display = isOllama ? 'none' : '';
    keyNote.style.display = isOllama ? 'none' : '';
    ollamaUrlSection.style.display = isOllama ? '' : 'none';
  }

  providerSelect.addEventListener('change', async () => {
    applyProviderVisibility();
    // Per-provider model memory — switching providers restores
    // that provider's own last-used model, same as the key restore right
    // below it.
    const config = getAgentConfig();
    modelInput.value = config.models[providerSelect.value] || '';
    if (providerSelect.value !== 'ollama') {
      keyInput.value = await getProviderKey(providerSelect.value);
      keyNoteText.textContent = await keyStorageDescription();
    }
  });

  async function open() {
    overlay.classList.add('open');

    const config = getAgentConfig();
    providerSelect.value = config.provider;
    modelInput.value = config.models[config.provider] || '';
    ollamaUrlInput.value = config.ollamaUrl;
    scopeSelect.value = config.scope;
    modeSelect.value = config.mode;

    applyProviderVisibility();
    renderScopeTracking();
    refreshUndoVisibility();
    await loadAgentsList(config.agentKey);

    if (config.provider !== 'ollama') {
      keyInput.value = await getProviderKey(config.provider);
      keyNoteText.textContent = await keyStorageDescription();
    }
  }

  function close() {
    overlay.classList.remove('open');
  }

  async function save() {
    const provider = providerSelect.value;
    const isOllama = provider === 'ollama';

    if (!isOllama) {
      await setProviderKey(provider, keyInput.value);
    }

    const config = getAgentConfig();
    setAgentConfig({
      provider,
      // Per-provider model memory — write into this
      // provider's slot in the map, leaving every other provider's
      // remembered model untouched.
      models: { ...config.models, [provider]: modelInput.value },
      ollamaUrl: ollamaUrlInput.value,
      agentKey: agentSelect.value,
      scope: scopeSelect.value,
      mode: modeSelect.value,
    });

    runStatusText.textContent = 'Settings saved.';
  }

  // Toggles Run/Cancel visibility and disables Save while a run is in
  // flight (saving config mid-run could otherwise change provider/prompt
  // out from under a request that already started with the old values).
  // Stage 6: also toggles the spinner + label inside the Run button itself
  // — the status <small> below is easy to miss, especially on "All
  // chapters" scope where a run can take a while, so the button now shows
  // its own busy state too.
  function setRunning(isRunning) {
    runBtn.style.display = isRunning ? 'none' : '';
    cancelBtn.style.display = isRunning ? '' : 'none';
    saveBtn.disabled = isRunning;
    runBtnSpinner.style.display = isRunning ? '' : 'none';
    runBtnLabel.textContent = isRunning ? 'Running\u2026' : 'Run agent';
  }

  // Stage 6: shows/hides "Undo last run" based on agentRunner's own record
  // of whether there's still something to undo — called after every run
  // completes, after a successful undo, and on open() so reopening the
  // drawer reflects reality rather than whatever it last remembered.
  function refreshUndoVisibility() {
    undoBtn.style.display = canUndoLastRun() ? '' : 'none';
  }

  function notifyRunStatus(status) {
    runStatusText.textContent = STATUS_TEXT[status] || status;
  }

  // Stage 6 "richer error states": builds the message shown for a failed
  // run. ERROR_KIND_TEXT gives an actionable message for the kinds that
  // benefit from one; anything else (or a kind mapped to `null`) falls back
  // to whatever agentRunner/the provider itself said, which is already
  // specific enough on its own.
  function describeError(result) {
    const mapped = ERROR_KIND_TEXT[result.kind];
    if (mapped) return mapped;
    return result.error || 'Something went wrong.';
  }

  async function handleRun() {
    // A new run supersedes any pending preview from a previous one — the
    // old preview's placements were resolved against a snapshot of the
    // chapter that may no longer be current.
    hidePreview();
    setRunning(true);
    runStatusText.textContent = STATUS_TEXT.queued;

    const result = await runAgent({
      getEditor,
      getCurrentPath,
      onAfterMutation: () => {
        // Mirrors client.js's own remountAfterNoteMutation() call sites
        // (saveNote/retypeNote/removeNote) — the manual "add note" flow
        // always follows insertNoteAt with a remount to avoid the
        // stale-superscript bug. client.js doesn't export that function
        // directly, so this dispatches a DOM event client.js listens for
        // (see the boot block right after MnAI.mount() in client.js) and
        // calls remountAfterNoteMutation() from there instead.
        window.dispatchEvent(new CustomEvent('mn:notes-mutated'));
      },
      onStatusChange: notifyRunStatus,
    });

    setRunning(false);
    refreshUndoVisibility();

    if (!result.ok) {
      const key = result.kind === 'cancelled' ? 'cancelled' : 'error';
      const base = `${STATUS_TEXT[key]} ${describeError(result)}`.trim();
      runStatusText.textContent = result.detail ? `${base} ${result.detail}` : base;
      return;
    }

    // Stage 6 read-only/preview mode: nothing was written — show the
    // preview list (if there's anything to show) instead of a "done"
    // message about notes being added.
    if (result.preview) {
      renderPreview(result);
      return;
    }

    const base = result.inserted > 0
      ? `Done \u2014 ${result.inserted} note${result.inserted === 1 ? '' : 's'} added.`
      : 'Done \u2014 the agent found nothing worth noting.';
    // Stage 5: 'all' scope reports which chapters (if any) it skipped, e.g.
    // an empty chapter or one that failed mid-run — appended rather than
    // replacing `base` so a successful partial run still reads as success.
    runStatusText.textContent = result.detail ? `${base} ${result.detail}` : base;
  }

  // ── Stage 6: read-only/preview mode rendering ──────────────────────────
  // Populates the preview section from a 'chapter'-scope run
  // (`{ placements }`) or an 'all'-scope run (`{ previewByFile }`), and
  // stashes whichever shape it was given in `pendingPreview` so
  // handlePreviewApply() can act on it without re-running the model.
  function renderPreview(result) {
    previewList.innerHTML = '';

    const perFile = Array.isArray(result.previewByFile)
      ? result.previewByFile
      : (Array.isArray(result.placements) && result.placements.length > 0
        ? [{ path: null, label: null, placements: result.placements }]
        : []);

    if (perFile.length === 0) {
      previewSection.style.display = 'none';
      pendingPreview = null;
      runStatusText.textContent = result.detail
        ? `The agent found nothing worth noting. ${result.detail}`
        : 'The agent found nothing worth noting. Nothing to preview.';
      return;
    }

    pendingPreview = result;
    previewSection.style.display = '';

    let totalCount = 0;
    perFile.forEach(({ path, label, placements }) => {
      if (label) {
        previewList.appendChild(el('div', { class: 'ai-preview-file-label', text: label }));
      }
      placements.forEach((p) => {
        totalCount++;
        previewList.appendChild(el('div', { class: 'ai-preview-item' }, [
          el('span', { class: 'ai-preview-item-pos', text: `@${p.charPos}` }),
          el('span', { class: 'ai-preview-item-content', text: p.content }),
        ]));
      });
    });

    runStatusText.textContent = joinPreviewStatus(totalCount, result.detail);
  }

  function joinPreviewStatus(count, detail) {
    const base = `Preview \u2014 ${count} note${count === 1 ? '' : 's'} proposed, nothing written yet.`;
    return detail ? `${base} ${detail}` : base;
  }

  function hidePreview() {
    previewSection.style.display = 'none';
    previewList.innerHTML = '';
    pendingPreview = null;
  }

  async function handlePreviewApply() {
    if (!pendingPreview) return;
    previewApplyBtn.disabled = true;
    previewDiscardBtn.disabled = true;

    const onAfterMutation = () => window.dispatchEvent(new CustomEvent('mn:notes-mutated'));

    let totalInserted = 0;
    let failed = false;

    if (Array.isArray(pendingPreview.previewByFile)) {
      for (const { path, placements } of pendingPreview.previewByFile) {
        const isLive = typeof getCurrentPath === 'function' && getCurrentPath() === path;
        const res = await applyPreview({
          getEditor,
          placements,
          path: isLive ? null : path,
          onAfterMutation,
        });
        if (!res.ok) { failed = true; continue; }
        totalInserted += res.inserted || 0;
      }
    } else if (Array.isArray(pendingPreview.placements)) {
      const res = await applyPreview({ getEditor, placements: pendingPreview.placements, onAfterMutation });
      if (!res.ok) {
        failed = true;
      } else {
        totalInserted += res.inserted || 0;
      }
    }

    hidePreview();
    previewApplyBtn.disabled = false;
    previewDiscardBtn.disabled = false;
    refreshUndoVisibility();

    runStatusText.textContent = failed
      ? `Applied ${totalInserted} note(s), but some chapters failed to save \u2014 check they weren\u2019t moved or locked.`
      : `Done \u2014 ${totalInserted} note${totalInserted === 1 ? '' : 's'} added.`;
  }

  function handlePreviewDiscard() {
    hidePreview();
    runStatusText.textContent = 'Preview discarded \u2014 nothing was written.';
  }

  async function handleUndo() {
    undoBtn.disabled = true;
    const result = await undoLastRun({
      getEditor,
      isCurrentPath: (path) => typeof getCurrentPath === 'function' && getCurrentPath() === path,
      onAfterMutation: () => window.dispatchEvent(new CustomEvent('mn:notes-mutated')),
    });
    undoBtn.disabled = false;
    refreshUndoVisibility();

    if (!result.ok && !result.removed) {
      runStatusText.textContent = result.error || 'Nothing to undo.';
      return;
    }
    runStatusText.textContent = result.ok
      ? `Undone \u2014 removed ${result.removed} note${result.removed === 1 ? '' : 's'}.`
      : `Removed ${result.removed} note(s), but: ${result.error}`;
  }

  panel.append(head, body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  head.querySelector('#ai-settings-close').addEventListener('click', close);
  triggerEl?.addEventListener('click', open);
  saveBtn.addEventListener('click', () => { save(); });
  runBtn.addEventListener('click', () => { handleRun(); });
  cancelBtn.addEventListener('click', () => { cancelAgent(); });
  undoBtn.addEventListener('click', () => { handleUndo(); });
  previewApplyBtn.addEventListener('click', () => { handlePreviewApply(); });
  previewDiscardBtn.addEventListener('click', () => { handlePreviewDiscard(); });

  return { open, close, root: overlay };
}