// ── Backup mirror ─────────────────────────────────────────────────────────
// Write-only safety copy of the vault. Every time a note file is saved,
// created, or edited, the same content is copied into a sibling folder next
// to GIT_ROOT (e.g. GIT_ROOT/../MyWritings-backup/book/...), mirroring the
// vault's relative path exactly.
//
// This folder is NEVER read from by the app — it exists purely so that if
// the primary vault/app data is lost or corrupted, the user still has a
// plain, native-file-manager-visible copy of every note. It replaces the old
// per-file "download to Downloads" button, which didn't actually work
// inside the Capacitor WebView on native mobile (no OS download manager to
// hand the blob to).
//
// Backup failures must never break a save — every function here swallows
// its own errors.

const fs   = require('fs');
const path = require('path');

// Given the vault root and the current GIT_ROOT, derive the backup root.
// Mirrors GIT_ROOT's sibling position, e.g.:
//   GIT_ROOT      = /data/user/0/.../MyWritings
//   BACKUP_ROOT   = /data/user/0/.../MyWritings-backup
function backupRootFor(gitRoot) {
  if (!gitRoot) return null;
  const parent = path.dirname(gitRoot);
  const base   = path.basename(gitRoot);
  return path.join(parent, `${base}-backup`);
}

// Mirror a single file write. `fullPath` is the absolute path to the file
// that was just written inside VAULT; `vault` and `gitRoot` are the current
// VAULT/GIT_ROOT values (passed in rather than imported, so this module has
// no circular dependency on server.js).
function mirrorWrite(fullPath, vault, gitRoot) {
  try {
    if (!vault || !gitRoot) return;

    const resolvedVault = path.resolve(vault);
    const resolvedFull  = path.resolve(fullPath);
    if (!resolvedFull.startsWith(resolvedVault)) return; // safety: never mirror outside the vault

    const relFromVault = resolvedFull.slice(resolvedVault.length).replace(/^[\\/]/, '');
    const backupRoot    = backupRootFor(gitRoot);
    if (!backupRoot) return;

    // VAULT is always GIT_ROOT/book (see server.js header comment), so mirror
    // under BACKUP_ROOT/book/<relFromVault> to keep the same shape.
    const backupFull = path.join(backupRoot, 'book', relFromVault);

    fs.mkdirSync(path.dirname(backupFull), { recursive: true });

    const tmp = backupFull + '.tmp';
    fs.writeFileSync(tmp, fs.readFileSync(resolvedFull));
    fs.renameSync(tmp, backupFull);
  } catch (err) {
    // Never let a backup failure surface to the caller or block a save.
    console.error('[backup-mirror] failed to mirror', fullPath, '-', err.message);
  }
}

module.exports = { mirrorWrite, backupRootFor };