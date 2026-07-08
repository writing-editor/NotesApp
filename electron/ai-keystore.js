// electron/ai-keystore.js
//
// Encrypted storage for AI provider API keys (Claude/OpenAI/Gemini — Ollama
// has no key, just a base URL, handled separately as non-secret config).
// Mirrors the git PAT pattern in electron/main.js (safeStorage wrapping the
// OS keyring) with one structural difference: instead of one file per
// secret, this is a single file (`ai-keys.enc`) holding one encrypted JSON
// blob keyed by provider — see plan.md §5 / CONTEXT.md §5 for why (four
// providers, one small file, one encrypt/decrypt round-trip per read/write
// is simpler than four parallel *.enc files).
//
// Required from electron/main.js, not written inline there — unlike the
// git PAT, which predates this convention (see CONTEXT.md §5).
//
// Ollama's base URL is NOT a secret and does not go through this module —
// it's stored the same (plain, unencrypted) way as any other non-secret
// setting; see ai-src/settingsPanel.js / client.js for where that lives.

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const KEYS_PATH = path.join(app.getPath('userData'), 'ai-keys.enc');

function isEncryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

// Reads and decrypts the whole blob, returning { provider: key, ... }.
// Never throws — any failure (no file yet, corrupt blob, keyring locked)
// just means "no keys saved", same failure-shape as readStoredToken().
function readAllKeys() {
  try {
    if (!isEncryptionAvailable()) return {};
    const encrypted = fs.readFileSync(KEYS_PATH);
    const json = safeStorage.decryptString(encrypted);
    const parsed = JSON.parse(json);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

// Encrypts and writes the whole blob back out. Internal — callers use
// readKey/writeKey below, which read-modify-write through this so the
// caller never has to think about the fact it's one shared file.
function writeAllKeys(keysObj) {
  const encrypted = safeStorage.encryptString(JSON.stringify(keysObj));
  fs.mkdirSync(path.dirname(KEYS_PATH), { recursive: true });
  fs.writeFileSync(KEYS_PATH, encrypted);
}

function readKey(provider) {
  if (!provider) return '';
  const all = readAllKeys();
  return all[provider] || '';
}

function writeKey(provider, key) {
  if (!provider) return { ok: false, reason: 'no-provider' };
  try {
    if (!isEncryptionAvailable()) {
      // Same honesty convention as the git PAT: don't silently fall back
      // to plaintext here. The caller (settingsPanel.js, via main.js's IPC
      // handler) falls back to localStorage and says so in the UI, same as
      // tokenStorageDescription() does for the git PAT.
      return { ok: false, reason: 'unavailable' };
    }
    const all = readAllKeys();
    if (!key) {
      // Clearing the field clears the saved key too — same rule as
      // writeStoredToken(''), don't leave a stale value that reappears.
      delete all[provider];
    } else {
      all[provider] = key;
    }
    writeAllKeys(all);
    return { ok: true };
  } catch (e) {
    console.error('[ai-keystore] failed to store key:', e.message);
    return { ok: false, reason: 'error' };
  }
}

module.exports = {
  isEncryptionAvailable,
  readKey,
  writeKey,
};
