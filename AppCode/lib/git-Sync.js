// lib/git-sync.js
//
// Thin wrapper around isomorphic-git, shared verbatim between the laptop server
// and the phone's embedded Node server (Section 4.2 of the mobile sync plan).
//
// IMPORTANT: `dir` passed into every function here must be GIT_ROOT (the folder
// containing `.git` — i.e. `MyWritings/`), never VAULT (`MyWritings/book/`).
// Callers (server.js) are responsible for prefixing any VAULT-relative file path
// with the BOOK_PREFIX constant before calling commitAll/commitFile.

const git  = require('isomorphic-git');
const http = require('isomorphic-git/http/node');
const fs   = require('fs');

const BOOK_PREFIX = 'book/';

// Turn a VAULT-relative path (e.g. "chapters/03-arrival.md") into a GIT_ROOT-relative
// path (e.g. "book/chapters/03-arrival.md"). Centralized here per Section 2.1 point 2.
function toRepoPath(vaultRelativePath) {
  const norm = vaultRelativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return BOOK_PREFIX + norm;
}

function authCallback(token) {
  return () => ({ username: token, password: 'x-oauth-basic' });
}

// Returns true if `dir` looks like a git repository root (has a .git folder).
// Used as a cheap guard so a missing/unconfigured repo never breaks note editing.
function isGitRepo(dir) {
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory()
      && fs.existsSync(require('path').join(dir, '.git'));
  } catch {
    return false;
  }
}

// Commit a single file (auto-commit path, Section 4.3.1). `filepath` must already
// be GIT_ROOT-relative (use toRepoPath() to convert from a VAULT-relative path).
async function commitFile({ dir, filepath, authorName, authorEmail, message }) {
  await git.add({ fs, dir, filepath });
  return git.commit({
    fs, dir,
    author: { name: authorName || 'Manuscript', email: authorEmail || 'manuscript@localhost' },
    message,
  });
}

// Commit the entire working tree (manual "Commit"/"Push" button path — Section 2.1
// point 3 explicitly allows this to be broader than the scoped auto-commit above).
async function commitAll({ dir, authorName, authorEmail, message }) {
  const matrix = await git.statusMatrix({ fs, dir });
  // _progress.json is per-device scroll-position telemetry, rewritten on
  // every scroll — it must never be staged/committed, or every Push would
  // carry a noise commit even when the user made no actual edits.
  const changed = matrix.filter(([filepath, head, workdir, stage]) =>
    (head !== workdir || workdir !== stage) && !filepath.endsWith('_progress.json')
  );
  for (const [filepath] of changed) {
    await git.add({ fs, dir, filepath });
  }
  if (changed.length === 0) {
    return { ok: true, committed: false, message: 'nothing to commit' };
  }
  const oid = await git.commit({
    fs, dir,
    author: { name: authorName || 'Manuscript', email: authorEmail || 'manuscript@localhost' },
    message: message || 'Manual commit from Manuscript',
  });
  return { ok: true, committed: true, oid };
}

// Returns { ahead, behind, dirty: [...filenames], conflicted: [...] }
async function status({ dir }) {
  if (!isGitRepo(dir)) {
    return { ahead: 0, behind: 0, dirty: [], conflicted: [], error: 'not a git repository' };
  }

  const matrix = await git.statusMatrix({ fs, dir });
  const dirty = [];
  const conflicted = [];

  for (const [filepath, head, workdir, stage] of matrix) {
    // isomorphic-git statusMatrix rows: [filepath, HEAD, WORKDIR, STAGE]
    // A simple heuristic for "conflicted": workdir/stage disagree in a way that isn't
    // a plain clean edit — real conflict markers are only produced by a merge attempt,
    // which surfaces separately from pull() below. Here we just report dirty files.
    if (head !== workdir || workdir !== stage) {
      dirty.push(filepath);
    }
  }

  let ahead = 0, behind = 0;
  try {
    const branch = await git.currentBranch({ fs, dir, fullname: false });
    if (branch) {
      const localOid = await git.resolveRef({ fs, dir, ref: branch }).catch(() => null);
      const remoteOid = await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${branch}` }).catch(() => null);
      if (localOid && remoteOid && localOid !== remoteOid) {
        const localLog = await git.log({ fs, dir, ref: branch }).catch(() => []);
        const remoteLog = await git.log({ fs, dir, ref: `refs/remotes/origin/${branch}` }).catch(() => []);
        const remoteOids = new Set(remoteLog.map(c => c.oid));
        const localOids = new Set(localLog.map(c => c.oid));
        ahead = localLog.filter(c => !remoteOids.has(c.oid)).length;
        behind = remoteLog.filter(c => !localOids.has(c.oid)).length;
      }
    }
  } catch (e) {
    // Non-fatal — ahead/behind stay at 0 if we can't compute them (e.g. no remote yet).
  }

  return { ahead, behind, dirty, conflicted };
}

// First-time clone. Used once per phone (Section 4.4).
async function clone({ dir, remoteUrl, token }) {
  await git.clone({
    fs, http, dir,
    url: remoteUrl,
    onAuth: authCallback(token),
    singleBranch: true,
    depth: 1,
  });
  return { ok: true };
}

// Contacts the remote and updates the local remote-tracking ref
// (refs/remotes/origin/<branch>) WITHOUT merging or touching the working
// tree — i.e. `git fetch`, not `git pull`. This exists because status()
// above only ever compares against whatever refs/remotes/origin/<branch>
// already has cached locally; it never itself talks to the network. Without
// a fetch first, "ahead/behind" is only as fresh as the last time something
// (a manual pull, or this) actually reached GitHub — which is exactly why
// the app used to show a pull as no-op-necessary right after launch even
// when the remote had moved on. Call this, then status(), to get a genuinely
// current answer. Safe to call as often as you like: it never merges,
// commits, or writes to any tracked file, so it can't create the conflict/
// diverged states that pull()/push() have to handle.
async function checkRemote({ dir, remoteUrl, token }) {
  if (!isGitRepo(dir)) {
    return { ok: false, reason: 'error', message: 'not a git repository' };
  }
  try {
    const branch = await git.currentBranch({ fs, dir, fullname: false });
    await git.fetch({
      fs, http, dir,
      url: remoteUrl,
      onAuth: authCallback(token),
      singleBranch: true,
      ref: branch || undefined,
      tags: false,
    });
    return { ok: true };
  } catch (e) {
    if (/network|fetch|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|timeout/i.test(e.message || '')) {
      return { ok: false, reason: 'network', message: e.message };
    }
    return { ok: false, reason: 'error', message: e.message };
  }
}

// Pull from remote. Does NOT attempt automatic conflict resolution — if isomorphic-git
// reports conflicts, report them back untouched (Section 4.2).
async function pull({ dir, remoteUrl, token, authorName, authorEmail }) {
  try {
    await git.pull({
      fs, http, dir,
      url: remoteUrl,
      onAuth: authCallback(token),
      author: { name: authorName || 'Manuscript', email: authorEmail || 'manuscript@localhost' },
      singleBranch: true,
    });
    return { ok: true };
  } catch (e) {
    if (e && (e.code === 'MergeNotSupportedError' || /conflict/i.test(e.message || ''))) {
      // Verified against a real overlapping-line conflict (isomorphic-git v1.27):
      // pull() throws before writing anything to the working tree — the local file
      // is left exactly as it was, NOT annotated with <<<<<<< conflict markers the
      // way a plain `git merge` on the CLI would leave it. e.data.filepaths gives
      // the list of files involved. So "resolve on laptop" in this app means "the
      // phone's local commit still holds your version; use VS Code / git CLI on
      // whichever machine is easiest to manually reconcile" — not "open this exact
      // half-merged file," since no half-merged file is produced by this call.
      return { ok: false, reason: 'conflict', message: e.message, files: e.data && e.data.filepaths };
    }
    if (/network|fetch|ENOTFOUND|ECONNREFUSED/i.test(e.message || '')) {
      return { ok: false, reason: 'network', message: e.message };
    }
    return { ok: false, reason: 'error', message: e.message };
  }
}

// Push to remote. Commits any pending working-tree changes first (per Section 4.3
// route comment), then pushes. Detects non-fast-forward rejection distinctly.
async function push({ dir, remoteUrl, token, authorName, authorEmail, commitMessage }) {
  try {
    await commitAll({ dir, authorName, authorEmail, message: commitMessage });

    const result = await git.push({
      fs, http, dir,
      url: remoteUrl,
      onAuth: authCallback(token),
    });

    if (result && result.ok === false) {
      return { ok: false, reason: 'diverged', message: 'push rejected — pull/resolve on laptop' };
    }
    return { ok: true };
  } catch (e) {
    if (/not.*fast.?forward|rejected/i.test(e.message || '')) {
      return { ok: false, reason: 'diverged', message: 'push rejected — pull/resolve on laptop' };
    }
    if (/network|fetch|ENOTFOUND|ECONNREFUSED/i.test(e.message || '')) {
      return { ok: false, reason: 'network', message: e.message };
    }
    return { ok: false, reason: 'error', message: e.message };
  }
}

module.exports = { pull, push, commitAll, commitFile, status, checkRemote, clone, isGitRepo, toRepoPath, BOOK_PREFIX };