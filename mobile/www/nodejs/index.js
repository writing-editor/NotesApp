// mobile/www/nodejs/index.js
//
// Entry point executed by the Capacitor-NodeJS plugin. This is a thin wrapper,
// not a reimplementation — the real server logic lives entirely in server.js,
// lib/git-sync.js, and lib/typst.js, which are copied into this same folder by
// mobile/scripts/sync-server-files.js and never hand-edited here.

const { getDataPath } = require('bridge');
const path = require('path');
const fs   = require('fs');

// Determine where the cloned repo (MyWritings/ equivalent) should live — inside
// the app's private, persistent data directory, never inside this nodejs/
// project folder (which gets overwritten on app updates — Section 1.2 point 3).
const dataPath = getDataPath();
const repoRoot = path.join(dataPath, 'MyWritings');

// VAULT is confirmed (Section 2.1/2.4) to always be GIT_ROOT/book.
const vaultPath = path.join(repoRoot, 'book');

// Default PORT — matches capacitor.config.json's server.url so the WebView's
// same-origin fetch/WebSocket code in client.js works completely unmodified.
process.env.PORT = process.env.PORT || '8723';

// Expose the resolved git repo root to server.js's git routes (Section 4.2),
// since GIT_ROOT and VAULT are distinct values on this platform.
process.env.GIT_ROOT = repoRoot;

// If a vault clone already exists from a previous session, boot directly into
// it. If not, server.js's existing CLI-arg-or-null VAULT logic handles the
// "no vault selected" state exactly as it does on first launch of the desktop
// version — the user will use the Settings panel's "Clone Vault" flow.
process.argv[2] = fs.existsSync(vaultPath) ? vaultPath : undefined;

require('./server.js');