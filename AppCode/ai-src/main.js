// ai-src/main.js — entry point, exposes window.MnAI (mirrors editor-src/main.js's
// window.MnEditor). client.js calls MnAI.mount() once at boot, desktop-gated;
// everything this feature does lives under this directory + lib/ai-proxy.js
// (Stage 3) + electron/ai-keystore.js (Stage 2). See AppCode/CONTEXT.md.
//
// Stage 4: mount() now also accepts `getEditor`, a zero-arg function
// returning client.js's *current* `liveEditor` (or null). Passed straight
// through to buildSettingsPanel(), which calls agentRunner.runAgent() from
// the Run/Cancel buttons.

import { buildSettingsPanel } from './settingsPanel.js';

function mount({ triggerEl, getEditor } = {}) {
  const panel = buildSettingsPanel({ triggerEl, getEditor });
  return {
    openSettings: panel.open,
    closeSettings: panel.close,
  };
}

export { mount };