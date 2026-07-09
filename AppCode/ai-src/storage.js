// ai-src/storage.js
//
// Stage 2. Mirrors client.js's git-PAT storage functions (~line 1369-1422,
// see CONTEXT.md §5) exactly in shape, but provider-parameterized:
//   - native (Capacitor/mobile): SecureStoragePlugin, key names
//     'ai-key-claude' / 'ai-key-openai' / 'ai-key-gemini'.
//   - Electron (desktop): main-process safeStorage via the preload bridge
//     (window.manuscriptDesktop.getAiKey/setAiKey), one ai-keys.enc file
//     keyed by provider (electron/ai-keystore.js).
//   - plain browser: localStorage, same honesty convention as the git PAT
//     — the note text under the key field must say plainly that it's
//     unencrypted in this case, not imply otherwise.
//
// This feature is desktop-only for now (gated at the MnAI.mount() call in
// client.js), so in practice only the Electron tier is reachable today —
// but written provider-agnostic/tier-agnostic anyway since the IPC/bridge
// layer already is (CONTEXT.md §5's closing note).
//
// Ollama has no key — only a base URL, which is NOT a secret. It and the
// rest of the agent-behaviour config (system prompt, scope, mode) go
// through the separate plain-config functions at the bottom of this file,
// always localStorage, never through the encrypted tiers.

const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const hasElectronKeyBridge = () => !!(window.manuscriptDesktop && window.manuscriptDesktop.getAiKey);

export async function getProviderKey(provider) {
  try {
    if (isNative() && window.Capacitor?.Plugins?.SecureStoragePlugin) {
      const { value } = await window.Capacitor.Plugins.SecureStoragePlugin.get({ key: `ai-key-${provider}` });
      return value || '';
    }
    if (hasElectronKeyBridge()) {
      return (await window.manuscriptDesktop.getAiKey(provider)) || '';
    }
    return window.localStorage.getItem(`ai-key-${provider}`) || '';
  } catch { /* not set yet or plugin/storage error */ }
  return '';
}

export async function setProviderKey(provider, key) {
  try {
    if (isNative() && window.Capacitor?.Plugins?.SecureStoragePlugin) {
      await window.Capacitor.Plugins.SecureStoragePlugin.set({ key: `ai-key-${provider}`, value: key });
      return;
    }
    if (hasElectronKeyBridge()) {
      const result = await window.manuscriptDesktop.setAiKey(provider, key);
      if (result && result.ok) return;
      // OS keyring unavailable — fall back to localStorage rather than
      // silently losing the key, same as the git PAT's fallback.
      console.warn('[ai-settings] OS keyring unavailable, falling back to localStorage:', result && result.reason);
      window.localStorage.setItem(`ai-key-${provider}`, key);
      return;
    }
    window.localStorage.setItem(`ai-key-${provider}`, key);
  } catch (e) {
    console.error('[ai-settings] failed to store key:', e.message);
  }
}

// Drives the honest-storage-description note under the key field. Kept as
// an async function (not a static string), same reason as
// tokenStorageDescription() — the Electron case has two different real
// answers depending on whether the OS keyring actually came up.
export async function keyStorageDescription() {
  if (isNative()) {
    return 'Stored in this device\u2019s secure storage, encrypted.';
  }
  if (hasElectronKeyBridge()) {
    const available = await window.manuscriptDesktop.isAiKeyEncryptionAvailable();
    return available
      ? 'Stored encrypted in your OS keyring, and remembered across restarts.'
      : 'Your OS has no secure keyring available, so this is stored unencrypted in local storage instead.';
  }
  return 'Stored in this browser\u2019s local storage, unencrypted.';
}

// ── Non-secret agent config (Ollama URL, system prompt, scope, mode) ──────
// Plain localStorage everywhere, same tier as the Ollama base URL was
// always meant to be (plan.md §5: "not encrypted, not a secret"). No
// provider/platform branching needed.

const CONFIG_KEY = 'ai-agent-config';

const DEFAULT_CONFIG = {
  provider: 'claude',
  // Per-provider model memory (plan.md §4) — replaces the old flat `model`
  // field. Not a secret, so plain localStorage, same tier as everything
  // else in this blob; only the *key* goes through the 3-tier storage above.
  models: {
    claude: '',
    openai: '',
    gemini: '',
    ollama: '',
  },
  ollamaUrl: '',
  // Agent profile (plan.md §2) — a reference to a file's `key` (see
  // server.js's /api/agents), not the prompt text itself. Replaces the old
  // flat `systemPrompt` string; empty means "nothing selected yet."
  agentKey: '',
  scope: 'chapter',
  mode: 'read-write',
};

// One-time normalization from the old flat `model` field to the new
// per-provider `models` map (plan.md §4 "Migration for existing installs").
// Runs every time getAgentConfig() loads a parsed blob still carrying the
// old field; idempotent since the old field is deleted immediately after
// seeding, so it only ever fires once per install.
function migrateFlatModel(parsed) {
  if (!parsed || typeof parsed.model !== 'string') return parsed;
  const provider = parsed.provider || DEFAULT_CONFIG.provider;
  const models = { ...DEFAULT_CONFIG.models, ...(parsed.models || {}) };
  if (parsed.model && !models[provider]) {
    models[provider] = parsed.model;
  }
  const { model, ...rest } = parsed;
  return { ...rest, models };
}

// One-time migration from the old flat `systemPrompt` string (plan.md §2
// "Note for whoever builds this next") to a file-based agent reference.
// Unlike migrateFlatModel() above, this can't finish synchronously —
// turning the old prompt into `models[provider]` was pure localStorage
// surgery, but turning it into an agent reference means writing a real
// file (VAULT/agents/Custom.md) through the server, so nobody's saved
// prompt silently vanishes. Exported so main.js can call this once at
// mount time, before the settings panel is ever opened; getAgentConfig()
// itself stays synchronous and just ignores a lingering `systemPrompt`
// field until this has had a chance to run (harmless — it's simply not
// read by anything anymore once agentKey exists).
export async function migrateLegacySystemPrompt() {
  try {
    const raw = window.localStorage.getItem(CONFIG_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed.systemPrompt || typeof parsed.systemPrompt !== 'string' || parsed.agentKey) return;

    const res = await fetch('/api/agents/migrate-legacy-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: parsed.systemPrompt }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `migration failed (${res.status})`);
    const key = data.key || 'Custom';

    const { systemPrompt, ...rest } = parsed;
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...rest, agentKey: key }));
  } catch (e) {
    // No vault selected yet, server unreachable, etc. — non-fatal. The
    // settings panel just shows "no agent selected," same as a fresh
    // install, and this is retried the next time mount() runs.
    console.warn('[ai-settings] legacy system-prompt migration skipped:', e.message);
  }
}

export function getAgentConfig() {
  try {
    const raw = window.localStorage.getItem(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG, models: { ...DEFAULT_CONFIG.models } };
    const parsed = migrateFlatModel(JSON.parse(raw));
    const merged = {
      ...DEFAULT_CONFIG,
      ...parsed,
      models: { ...DEFAULT_CONFIG.models, ...(parsed.models || {}) },
    };
    return merged;
  } catch {
    return { ...DEFAULT_CONFIG, models: { ...DEFAULT_CONFIG.models } };
  }
}

export function setAgentConfig(partial) {
  try {
    const current = getAgentConfig();
    // Shallow-merge everything except `models`, which merges one level
    // deeper so saving under one provider doesn't clobber another
    // provider's remembered model.
    const next = {
      ...current,
      ...partial,
      models: { ...current.models, ...(partial.models || {}) },
    };
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
    return next;
  } catch (e) {
    console.error('[ai-settings] failed to store agent config:', e.message);
    return getAgentConfig();
  }
}