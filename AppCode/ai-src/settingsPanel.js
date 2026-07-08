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
// now calls into. Stage 4 (this pass) enables "Run agent" for real: wired
// to agentRunner.js's runAgent()/cancelAgent(), a "Cancel" button that only
// shows while a run is in flight, and a run-status line driven by
// agentRunner's queued/thinking/done/error/cancelled callbacks.

import { getProviderKey, setProviderKey, keyStorageDescription, getAgentConfig, setAgentConfig } from './storage.js';
import { runAgent, cancelAgent } from './agentRunner.js';

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
 * @returns {{ open: () => void, close: () => void, root: HTMLElement }}
 */
export function buildSettingsPanel({ triggerEl, getEditor } = {}) {
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
  const behaviourHeading = el('div', { class: 'settings-section' }, [
    el('label', { text: 'Agent behaviour' }),
    el('small', {
      text: 'What this agent is for, and how it should write notes. Sent as the system prompt on every run.',
    }),
  ]);

  const promptSection = el('div', { class: 'settings-section' }, [
    el('textarea', {
      id: 'ai-system-prompt',
      rows: '6',
      placeholder:
        'e.g. "Flag continuity errors and unresolved plot threads as [mn.ai] notes. '
        + 'Be terse — one sentence per note. Do not comment on prose style."',
    }),
  ]);

  const scopeSection = el('div', { class: 'settings-section settings-row' }, [
    el('div', {}, [
      el('label', { text: 'Scope' }),
      (() => {
        const sel = el('select', { id: 'ai-scope-select' });
        sel.appendChild(el('option', { value: 'chapter', text: 'Current chapter' }));
        sel.appendChild(el('option', { value: 'all', text: 'All chapters (later stage)' }));
        // Multi-chapter scope is deferred to Stage 5 per the plan — present
        // but disabled so the control doesn't have to be added later.
        sel.querySelector('option[value="all"]').disabled = true;
        return sel;
      })(),
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
    // Stage 4: enabled now that agentRunner.js/noteSplice.js exist.
    el('button', { class: 'settings-btn', id: 'ai-run-agent', text: 'Run agent' }),
    // Stage 4: hidden until a run is actually in flight (see toggling in
    // setRunning() below) — no point showing "Cancel" when there's nothing
    // to cancel.
    el('button', { class: 'settings-btn', id: 'ai-cancel-agent', style: 'display:none;', text: 'Cancel' }),
  ]);

  const runStatus = el('div', { class: 'settings-section', id: 'ai-run-status' }, [
    el('small', { id: 'ai-run-status-text', text: 'Not run yet.' }),
  ]);

  body.append(
    connectionSection, modelSection, keySection, keyNote, ollamaUrlSection,
    behaviourHeading, promptSection, scopeSection,
    actions, runStatus,
  );

  const modelInput      = modelSection.querySelector('#ai-model-input');
  const keyInput        = keySection.querySelector('#ai-key-input');
  const keyNoteText     = keyNote.querySelector('#ai-key-note-text');
  const ollamaUrlInput  = ollamaUrlSection.querySelector('#ai-ollama-url-input');
  const promptTextarea  = promptSection.querySelector('#ai-system-prompt');
  const scopeSelect     = scopeSection.querySelector('#ai-scope-select');
  const modeSelect      = scopeSection.querySelector('#ai-mode-select');
  const saveBtn         = actions.querySelector('#ai-save-config');
  const runBtn          = actions.querySelector('#ai-run-agent');
  const cancelBtn       = actions.querySelector('#ai-cancel-agent');
  const runStatusText   = runStatus.querySelector('#ai-run-status-text');

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
    if (providerSelect.value !== 'ollama') {
      keyInput.value = await getProviderKey(providerSelect.value);
      keyNoteText.textContent = await keyStorageDescription();
    }
  });

  async function open() {
    overlay.classList.add('open');

    const config = getAgentConfig();
    providerSelect.value = config.provider;
    modelInput.value = config.model;
    ollamaUrlInput.value = config.ollamaUrl;
    promptTextarea.value = config.systemPrompt;
    scopeSelect.value = config.scope;
    modeSelect.value = config.mode;

    applyProviderVisibility();

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

    setAgentConfig({
      provider,
      model: modelInput.value,
      ollamaUrl: ollamaUrlInput.value,
      systemPrompt: promptTextarea.value,
      scope: scopeSelect.value,
      mode: modeSelect.value,
    });

    runStatusText.textContent = 'Settings saved.';
  }

  // Toggles Run/Cancel visibility and disables Save while a run is in
  // flight (saving config mid-run could otherwise change provider/prompt
  // out from under a request that already started with the old values).
  function setRunning(isRunning) {
    runBtn.style.display = isRunning ? 'none' : '';
    cancelBtn.style.display = isRunning ? '' : 'none';
    saveBtn.disabled = isRunning;
  }

  async function handleRun() {
    setRunning(true);
    runStatusText.textContent = STATUS_TEXT.queued;

    const result = await runAgent({
      getEditor,
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
      onStatusChange: (status) => {
        runStatusText.textContent = STATUS_TEXT[status] || status;
      },
    });

    setRunning(false);

    if (!result.ok) {
      const key = result.error === 'Run cancelled.' ? 'cancelled' : 'error';
      runStatusText.textContent = `${STATUS_TEXT[key]} ${result.error || ''}`.trim();
      return;
    }

    runStatusText.textContent = result.inserted > 0
      ? `Done \u2014 ${result.inserted} note${result.inserted === 1 ? '' : 's'} added.`
      : 'Done \u2014 the agent found nothing worth noting.';
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

  return { open, close, root: overlay };
}