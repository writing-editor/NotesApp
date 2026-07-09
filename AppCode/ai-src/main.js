// ai-src/main.js — entry point, exposes window.MnAI (mirrors editor-src/main.js's
// window.MnEditor). client.js calls MnAI.mount() once at boot, desktop-gated;
// everything this feature does lives under this directory + lib/ai-proxy.js
// (Stage 3) + electron/ai-keystore.js (Stage 2). See AppCode/CONTEXT.md.
//
// Stage 4: mount() now also accepts `getEditor`, a zero-arg function
// returning client.js's *current* `liveEditor` (or null). Passed straight
// through to buildSettingsPanel(), which calls agentRunner.runAgent() from
// the Run/Cancel buttons.
//
// Stage 5: mount() also accepts `getCurrentPath`, a zero-arg function
// returning client.js's *current* chapter path (or null) — same
// call-fresh-every-time reasoning as getEditor. Used by 'all' scope to
// identify which manifest entry is the one actually mounted live.

import { buildSettingsPanel } from './settingsPanel.js';
import { migrateLegacySystemPrompt } from './storage.js';

function mount({ triggerEl, getEditor, getCurrentPath } = {}) {
  const panel = buildSettingsPanel({ triggerEl, getEditor, getCurrentPath });
  // Fire-and-forget: one-time upgrade of an old flat systemPrompt string
  // into a vault-level agents/Custom.md file. Runs here, once
  // per mount, rather than inside settingsPanel.open()'s hot path — it's
  // a no-op after the first successful run, and doesn't need to block the
  // panel from opening if it hasn't finished yet.
  migrateLegacySystemPrompt();
  return {
    openSettings: panel.open,
    closeSettings: panel.close,
  };
}

export { mount };