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

// ── Per-provider key slots ──────────────────────────────────────────────
//
// Two saved keys per provider ("A"/"B" internally, shown as user-editable
// labels — e.g. "Work"/"Personal") so switching between two accounts on the
// same provider doesn't mean retyping/repasting a key every time. Which
// slot is *active* is picked manually in the settings panel — no automatic
// fallback on error; a bad model name or a transient outage shouldn't be
// mistaken for "this key is bad" and silently swap it out from under a run.
//
// Storage placement per slot mirrors the single-key logic exactly (native
// SecureStoragePlugin / Electron safeStorage+keyring / localStorage), just
// keyed by `ai-key-${provider}-${slot}` instead of `ai-key-${provider}`.
// Slot *labels* and which slot is active are not secrets, so they live in
// the per-vault agent config (storage.js's DEFAULT_CONFIG.keySlots below),
// same tier as model/agent/scope/mode.

export const KEY_SLOTS = ['A', 'B'];

export async function getProviderKey(provider, slot = 'A') {
  const storageKey = `ai-key-${provider}-${slot}`;
  try {
    if (isNative() && window.Capacitor?.Plugins?.SecureStoragePlugin) {
      const { value } = await window.Capacitor.Plugins.SecureStoragePlugin.get({ key: storageKey });
      return value || '';
    }
    if (hasElectronKeyBridge()) {
      return (await window.manuscriptDesktop.getAiKey(`${provider}-${slot}`)) || '';
    }
    return window.localStorage.getItem(storageKey) || '';
  } catch { /* not set yet or plugin/storage error */ }
  return '';
}

export async function setProviderKey(provider, key, slot = 'A') {
  const storageKey = `ai-key-${provider}-${slot}`;
  try {
    if (isNative() && window.Capacitor?.Plugins?.SecureStoragePlugin) {
      await window.Capacitor.Plugins.SecureStoragePlugin.set({ key: storageKey, value: key });
      return;
    }
    if (hasElectronKeyBridge()) {
      const result = await window.manuscriptDesktop.setAiKey(`${provider}-${slot}`, key);
      if (result && result.ok) return;
      // OS keyring unavailable — fall back to localStorage rather than
      // silently losing the key, same as the git PAT's fallback.
      console.warn('[ai-settings] OS keyring unavailable, falling back to localStorage:', result && result.reason);
      window.localStorage.setItem(storageKey, key);
      return;
    }
    window.localStorage.setItem(storageKey, key);
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
//
// Was plain localStorage keyed by CONFIG_KEY below. Moved to a per-vault
// file (VAULT/_agent-config.json, served through /api/agent-config —
// see server.js, same shape as the existing /api/progress) because
// localStorage on desktop is scoped per-origin, and origin = host:port for
// this app's local Electron server. Historically the server picked a fresh
// random port on every launch (fixed now — see electron/main.js's
// resolveServerPort(), which pins and reuses the last port), but relying on
// port-stability alone means a lingering old server process, a port
// collision, or a future regression there would silently reset every
// setting except the API key (which never went through localStorage at all
// — see the 3-tier key storage above). Storing this in the vault instead
// makes it immune to that whole class of bug, and as a side effect makes
// agent settings per-vault: a fiction manuscript and a technical vault can
// reasonably want different providers/agent profiles anyway.
//
// localStorage is kept as a *fallback only*, for the brief window before any
// vault has been selected (fresh install, no VAULT yet) — see
// getAgentConfig()/setAgentConfig() below for exactly when each tier is
// used. Once a vault exists, the vault file is the sole source of truth.

const CONFIG_KEY = 'ai-agent-config';

const DEFAULT_CONFIG = {
  provider: 'claude',
  // Per-provider model memory — replaces the old flat `model`
  // field. Not a secret, so plain localStorage, same tier as everything
  // else in this blob; only the *key* goes through the 3-tier storage above.
  models: {
    claude: '',
    openai: '',
    gemini: '',
    ollama: '',
  },
  // MRU history of models typed per provider, most-recent-first, deduped,
  // capped at MRU_LIMIT — separate from `models` above (which is just "the
  // current value"), so the model field can suggest past entries via a
  // <datalist> without needing a second round-trip anywhere.
  modelHistory: {
    claude: [],
    openai: [],
    gemini: [],
    ollama: [],
  },
  ollamaUrl: '',
  ollamaUrlHistory: [],
  // Two named key slots per provider ("A"/"B") — see the "Per-provider key
  // slots" block above. `label` is what the settings panel shows instead of
  // the raw slot letter (e.g. "Work"); `active` is which slot's key
  // getProviderKey()/getAgentConfig() callers should use right now. Neither
  // field is a secret — the keys themselves live in the 3-tier storage
  // above, addressed by `${provider}-${slot}`; this is just bookkeeping
  // about which slot is which and which one is "on".
  keySlots: {
    claude: { active: 'A', labels: { A: '', B: '' } },
    openai: { active: 'A', labels: { A: '', B: '' } },
    gemini: { active: 'A', labels: { A: '', B: '' } },
  },
  // Agent profile — a reference to a file's `key` (see
  // server.js's /api/agents), not the prompt text itself. Replaces the old
  // flat `systemPrompt` string; empty means "nothing selected yet."
  agentKey: '',
  scope: 'chapter',
  mode: 'read-write',
};

const MRU_LIMIT = 6;

// Pushes `value` to the front of `list`, dedupes (case-sensitive — a model
// name or URL's casing matters), drops empties, and caps at MRU_LIMIT.
// Pure — returns a new array, doesn't mutate `list`, so callers can pass
// configCache's own array straight in without aliasing surprises.
function pushMru(list, value) {
  const trimmed = (value || '').trim();
  if (!trimmed) return Array.isArray(list) ? list : [];
  const rest = (Array.isArray(list) ? list : []).filter(v => v !== trimmed);
  return [trimmed, ...rest].slice(0, MRU_LIMIT);
}

// In-memory cache so callers that expect getAgentConfig()-style synchronous
// reads (there are several in settingsPanel.js) get the last-fetched value
// immediately, while a fetch to the vault file happens in the background
// via refreshAgentConfigCache(). Seeded with the defaults so nothing is ever
// undefined before the first refresh completes.
let configCache = structuredCloneConfig(DEFAULT_CONFIG);
let configCacheLoaded = false;

async function fetchVaultConfig() {
  try {
    const res = await fetch('/api/agent-config');
    if (!res.ok) return null; // e.g. 400 "no vault selected"
    const data = await res.json();
    return data && Object.keys(data).length > 0 ? data : null;
  } catch {
    return null; // server unreachable
  }
}

async function writeVaultConfig(next) {
  try {
    const res = await fetch('/api/agent-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// One-time normalization from the old flat `model` field to the new
// per-provider `models` map (migration for existing installs).
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

// One-time migration from the old flat `systemPrompt` string to a
// file-based agent reference.
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

function mergeWithDefaults(parsed) {
  if (!parsed) return structuredCloneConfig(DEFAULT_CONFIG);
  const migrated = migrateFlatModel(parsed);
  const keySlotsDefaults = DEFAULT_CONFIG.keySlots;
  const mergedKeySlots = {};
  for (const provider of Object.keys(keySlotsDefaults)) {
    const incoming = (migrated.keySlots || {})[provider] || {};
    mergedKeySlots[provider] = {
      active: incoming.active || keySlotsDefaults[provider].active,
      labels: { ...keySlotsDefaults[provider].labels, ...(incoming.labels || {}) },
    };
  }
  return {
    ...DEFAULT_CONFIG,
    ...migrated,
    models: { ...DEFAULT_CONFIG.models, ...(migrated.models || {}) },
    modelHistory: { ...DEFAULT_CONFIG.modelHistory, ...(migrated.modelHistory || {}) },
    ollamaUrlHistory: Array.isArray(migrated.ollamaUrlHistory) ? migrated.ollamaUrlHistory : DEFAULT_CONFIG.ollamaUrlHistory,
    keySlots: mergedKeySlots,
  };
}

function structuredCloneConfig(cfg) {
  return {
    ...cfg,
    models: { ...cfg.models },
    modelHistory: { ...cfg.modelHistory, claude: [...cfg.modelHistory.claude], openai: [...cfg.modelHistory.openai], gemini: [...cfg.modelHistory.gemini], ollama: [...cfg.modelHistory.ollama] },
    ollamaUrlHistory: [...cfg.ollamaUrlHistory],
    keySlots: {
      claude: { ...cfg.keySlots.claude, labels: { ...cfg.keySlots.claude.labels } },
      openai: { ...cfg.keySlots.openai, labels: { ...cfg.keySlots.openai.labels } },
      gemini: { ...cfg.keySlots.gemini, labels: { ...cfg.keySlots.gemini.labels } },
    },
  };
}

// Call once at mount time (before the settings panel is ever opened), same
// slot as migrateLegacySystemPrompt() — populates configCache from the
// vault file if one exists, falling back to plain defaults otherwise (fresh
// install, or no vault selected yet). getAgentConfig() itself stays
// synchronous (reads configCache only) so every existing call site in
// settingsPanel.js keeps working unchanged; this is what fills the cache
// before those calls happen.
export async function refreshAgentConfigCache() {
  const fromVault = await fetchVaultConfig();
  if (fromVault) {
    configCache = mergeWithDefaults(fromVault);
    configCacheLoaded = true;
    return configCache;
  }

  configCache = mergeWithDefaults(null);
  configCacheLoaded = true;
  return configCache;
}

// Synchronous by design — every existing call site (settingsPanel.js's
// open(), provider-change handler, save()) expects an immediate value.
// Returns whatever's in configCache, which refreshAgentConfigCache() (called
// at mount, and again after every vault switch) keeps current. Before the
// very first refresh completes this is just DEFAULT_CONFIG, same as the old
// "nothing in localStorage yet" case used to return.
export function getAgentConfig() {
  return configCache;
}

// True once refreshAgentConfigCache() has resolved at least once (from the
// vault, localStorage, or plain defaults — any of those counts as "loaded").
// settingsPanel.js's open() uses this to decide whether it can trust
// getAgentConfig()'s synchronous value immediately or should await one more
// refresh first — relevant right after a vault switch, where main.js kicks
// off refreshAgentConfigCache() but the drawer could in principle be opened
// before that promise settles.
export function isAgentConfigLoaded() {
  return configCacheLoaded;
}

export async function setAgentConfig(partial) {
  // Shallow-merge everything except the nested maps, which merge one level
  // deeper so saving under one provider (or one key slot) doesn't clobber
  // another provider's/slot's remembered value.
  const mergedKeySlots = { ...configCache.keySlots };
  if (partial.keySlots) {
    for (const provider of Object.keys(partial.keySlots)) {
      mergedKeySlots[provider] = {
        ...configCache.keySlots[provider],
        ...partial.keySlots[provider],
        labels: { ...configCache.keySlots[provider]?.labels, ...(partial.keySlots[provider].labels || {}) },
      };
    }
  }
  const next = {
    ...configCache,
    ...partial,
    models: { ...configCache.models, ...(partial.models || {}) },
    modelHistory: { ...configCache.modelHistory, ...(partial.modelHistory || {}) },
    ollamaUrlHistory: partial.ollamaUrlHistory || configCache.ollamaUrlHistory,
    keySlots: mergedKeySlots,
  };
  configCache = next; // update the cache immediately so a subsequent
                       // getAgentConfig() (e.g. save()'s own re-read) sees
                       // it even if the write below is still in flight.
  const wrote = await writeVaultConfig(next);
  if (!wrote) {
    // No vault selected yet, or server unreachable — same situations
    // migrateLegacySystemPrompt() already tolerates elsewhere in this file.
    // Fall back to localStorage rather than losing the save outright; the
    // next refreshAgentConfigCache() (e.g. after a vault is picked) will
    // carry it forward into the vault file via the migration path above.
    try {
      window.localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
    } catch (e) {
      console.error('[ai-settings] failed to store agent config:', e.message);
    }
  }
  return next;
}

// Convenience used by settingsPanel.js's save(): folds "save this provider's
// model" and "remember it in that provider's MRU history" into one call, so
// the panel doesn't have to hand-build the modelHistory patch itself. Same
// for the Ollama URL. Both are plain functions (not exported standalone
// history-pushers) because the only sensible time to push into history is
// "the moment it's saved" — there's no separate use case for pushing
// without saving, or saving without remembering it for next time.
export async function saveModelForProvider(provider, value) {
  return setAgentConfig({
    models: { [provider]: value },
    modelHistory: { [provider]: pushMru(configCache.modelHistory[provider], value) },
  });
}

export async function saveOllamaUrl(value) {
  return setAgentConfig({
    ollamaUrl: value,
    ollamaUrlHistory: pushMru(configCache.ollamaUrlHistory, value),
  });
}

// Sets which key slot ("A" or "B") is active for a provider — manual only,
// no auto-fallback (see the "Per-provider key slots" comment up top for why).
export async function setActiveKeySlot(provider, slot) {
  return setAgentConfig({ keySlots: { [provider]: { active: slot } } });
}

// Renames a key slot's display label (e.g. "Work" / "Personal") without
// touching the key itself or which slot is active.
export async function setKeySlotLabel(provider, slot, label) {
  return setAgentConfig({ keySlots: { [provider]: { labels: { [slot]: label } } } });
}