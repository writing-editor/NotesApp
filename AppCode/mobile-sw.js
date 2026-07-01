// AppCode/mobile-sw.js
import FS from '@isomorphic-git/lightning-fs';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';

// Initialize Virtual File System
const fs = new FS('manuscript-fs');
const pfs = fs.promises;
const GIT_ROOT = '/MyWritings';
const VAULT = `${GIT_ROOT}/book`;
const GIT_CONFIG_FILE = `${GIT_ROOT}/../git-config.json`; // sibling to GIT_ROOT, matches laptop pattern

// NOTE: LightningFS paths must be treated as *paths*, not URL components.
// req.json() / URLSearchParams already decode percent-encoding for us, so
// values arriving here are the real filename (including spaces). Do NOT
// re-encode/decode them again before touching pfs.* calls, or filenames
// with spaces (e.g. "01-chapter one.md") will silently fail to resolve.

// Set up Service Worker caching for UI assets
const CACHE_NAME = 'manuscript-mobile-v1';
const STATIC_ASSETS = ['/', '/index.html', '/styles.css', '/client.js'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(STATIC_ASSETS)));
});
self.addEventListener('activate', (e) => self.clients.claim());

// ── API INTERCEPTOR ───────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Intercept API calls and answer them locally!
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(handleApiRequest(event.request, url));
    return;
  }

  // Serve UI assets from cache
  event.respondWith(
    caches.match(event.request).then((res) => res || fetch(event.request))
  );
});

// ── EXPRESS SERVER REPLACEMENT ─────────────────────────────────────────
async function handleApiRequest(req, url) {
  const method = req.method;
  const path = url.pathname;

  try {
    // 0. Debug/diagnostic route — confirms THIS file is the worker actually
    // answering requests, and dumps what's really on disk. Safe to leave in;
    // remove once you've confirmed the build pipeline ships the right file.
    if (path === '/api/debug/whoami' && method === 'GET') {
      let tree = {};
      try {
        tree = await walk(GIT_ROOT);
      } catch (e) {
        tree = { error: e.message };
      }
      return jsonResponse({ engine: 'mobile-sw-lightningfs', gitRoot: GIT_ROOT, vault: VAULT, tree });
    }

    // 1. Git Clone (First time setup)
    if (path === '/api/git/clone' && method === 'POST') {
      const { remoteUrl, token } = await req.json();
      if (!remoteUrl) return jsonResponse({ error: 'remoteUrl required' }, 400);

      await pfs.mkdir(GIT_ROOT).catch(() => {}); // Ensure root exists

      await git.clone({
        fs, http, dir: GIT_ROOT, url: remoteUrl,
        corsProxy: 'https://cors.isomorphic-git.org', // still required — CapacitorHttp does NOT intercept fetches made inside a Service Worker
        onAuth: () => ({ username: token, password: 'x-oauth-basic' }),
        singleBranch: true, depth: 1,
      });

      // Verify the clone actually produced a book/ folder before declaring success.
      let bookExists = false;
      try {
        const stat = await pfs.stat(VAULT);
        bookExists = stat.isDirectory();
      } catch {
        bookExists = false;
      }
      if (!bookExists) {
        return jsonResponse({ error: 'Cloned repository has no book/ folder at its root', gitRoot: GIT_ROOT }, 500);
      }

      // Persist non-secret git config immediately so remoteUrl survives restarts.
      // Token is intentionally NOT written here — see /api/git/config below.
      await writeGitConfig({ remoteUrl });

      const tree = await walk(GIT_ROOT).catch((e) => ({ error: e.message }));
      return jsonResponse({ ok: true, vault: VAULT, tree });
    }

    // 2. Fetch Manifest
    if (path === '/api/manifest' && method === 'GET') {
      const manifest = { title: 'Manuscript', author: '', description: '', sections: [] };

      const readSection = async (subdir) => {
        try {
          const files = await pfs.readdir(`${VAULT}/${subdir}`);
          return files
            .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
            .sort()
            .map((f) => ({
              label: f.replace(/^\d+-/, '').replace(/\.md$/, '').replace(/-/g, ' '),
              path: `${subdir}/${f}`, // logical path — NOT url-encoded, callers must encode when building fetch URLs
            }));
        } catch {
          return [];
        }
      };

      manifest.sections.push({ label: 'Front Matter', files: await readSection('front') });
      manifest.sections.push({ label: 'Chapters', files: await readSection('chapters') });
      manifest.sections.push({ label: 'Back Matter', files: await readSection('back') });
      manifest.sections = manifest.sections.filter((s) => s.files.length > 0);

      // Pull title/author/description out of _meta.md if present (mirrors server.js readMeta()).
      try {
        const raw = await pfs.readFile(`${VAULT}/_meta.md`, 'utf8');
        const yamlMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (yamlMatch) {
          const block = yamlMatch[1];
          const get = (key) => {
            const m = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
            return m ? m[1].trim() : '';
          };
          manifest.title = get('title') || manifest.title;
          manifest.author = get('author') || '';
          manifest.description = get('description') || '';
        }
      } catch {
        // no _meta.md yet — defaults stand
      }

      return jsonResponse(manifest);
    }

    // 3. Read Chapter
    if (path === '/api/chapter' && method === 'GET') {
      // decodeURIComponent is required here: fetch() on the client encodes the
      // querystring, and a filename containing a space arrives as
      // "chapters/01-chapter%20one.md" — reading it literally against
      // LightningFS (which expects real bytes, not percent-escapes) fails
      // silently and looks like "the file wasn't cloned."
      const rawParam = url.searchParams.get('path');
      if (!rawParam) return jsonResponse({ error: 'path required' }, 400);
      const relPath = decodeURIComponent(rawParam).replace(/\\/g, '/');

      const full = `${VAULT}/${relPath}`;
      let raw;
      try {
        raw = await pfs.readFile(full, 'utf8');
      } catch (e) {
        return jsonResponse({ error: 'not found', full, detail: e.message }, 404);
      }

      // TODO: swap this stub for the real shared parser (lib/parse.js -> parseMd),
      // bundled into this worker via esbuild, so block-based inline editing
      // (data-block/data-off spans) keeps working on mobile. This stub only
      // exists so /api/chapter returns *something* while that port is pending.
      return jsonResponse({
        bodyHtml: `<p>${escapeHtml(raw)}</p>`,
        notes: [],
        path: relPath,
        words: raw.split(/\s+/).filter(Boolean).length,
        chars: raw.length,
      });
    }

    // 4. Save Block Edit
    if (path === '/api/block' && method === 'PUT') {
      const { path: relPath, start, end, text } = await req.json();
      if (!relPath || start === undefined || end === undefined || text === undefined) {
        return jsonResponse({ error: 'path, start, end, text required' }, 400);
      }
      const normPath = relPath.replace(/\\/g, '/');
      const fullPath = `${VAULT}/${normPath}`;
      const raw = await pfs.readFile(fullPath, 'utf8');

      const updated = raw.slice(0, start) + text.trimEnd() + raw.slice(end);
      await pfs.writeFile(fullPath, updated, 'utf8');

      // Auto-commit — must never throw and break editing if there's no repo yet.
      await autoCommit(normPath, 'Edit paragraph').catch((e) =>
        console.error('[git] auto-commit failed (non-fatal):', e.message)
      );

      // Notify UI via BroadcastChannel instead of WebSockets
      new BroadcastChannel('manuscript-events').postMessage({ type: 'file-changed', path: normPath });

      return jsonResponse({ ok: true });
    }

    // 5. Git config — persisted to LightningFS so it survives app restarts.
    // Token is deliberately never stored here (matches laptop's security model).
    if (path === '/api/git/config' && method === 'GET') {
      const cfg = await readGitConfig();
      return jsonResponse(cfg);
    }
    if (path === '/api/git/config' && method === 'POST') {
      const { remoteUrl, authorName, authorEmail } = await req.json();
      await writeGitConfig({ remoteUrl, authorName, authorEmail });
      return jsonResponse({ ok: true });
    }

    // 6. Git status
    if (path === '/api/git/status' && method === 'GET') {
      const result = await gitStatus();
      return jsonResponse(result);
    }

    return jsonResponse({ error: 'Route not implemented on mobile yet', path, method }, 404);
  } catch (error) {
    console.error('[mobile-sw] error handling', method, path, error);
    return jsonResponse({ error: error.message }, 500);
  }
}

// ── Git config persistence ────────────────────────────────────────────
async function readGitConfig() {
  try {
    const raw = await pfs.readFile(GIT_CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeGitConfig(partial) {
  const existing = await readGitConfig();
  const merged = { ...existing, ...partial };
  // Strip undefined keys so we don't overwrite a previously-saved value with undefined
  Object.keys(merged).forEach((k) => merged[k] === undefined && delete merged[k]);
  await pfs.writeFile(GIT_CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

// ── Auto-commit (mirrors lib/git-sync.js commitFile, ported for LightningFS) ──
async function isGitRepo() {
  try {
    const stat = await pfs.stat(`${GIT_ROOT}/.git`);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function autoCommit(vaultRelativePath, message) {
  if (!(await isGitRepo())) return; // no repo yet — never break editing
  const cfg = await readGitConfig();
  const filepath = `book/${vaultRelativePath.replace(/^\/+/, '')}`; // GIT_ROOT-relative, matches toRepoPath()
  await git.add({ fs, dir: GIT_ROOT, filepath });
  await git.commit({
    fs,
    dir: GIT_ROOT,
    author: {
      name: cfg.authorName || 'Manuscript',
      email: cfg.authorEmail || 'manuscript@localhost',
    },
    message,
  });
}

async function gitStatus() {
  if (!(await isGitRepo())) {
    return { ahead: 0, behind: 0, dirty: [], conflicted: [], error: 'not a git repository' };
  }
  const matrix = await git.statusMatrix({ fs, dir: GIT_ROOT });
  const dirty = matrix
    .filter(([, head, workdir, stage]) => head !== workdir || workdir !== stage)
    .map(([filepath]) => filepath);
  return { ahead: 0, behind: 0, dirty, conflicted: [] };
}

// ── Debug helper: recursively list what's actually on disk ──────────────
async function walk(dir, depth = 0) {
  if (depth > 6) return '...(truncated)';
  let entries;
  try {
    entries = await pfs.readdir(dir);
  } catch {
    return null;
  }
  const out = {};
  for (const entry of entries) {
    const full = `${dir}/${entry}`;
    const stat = await pfs.stat(full);
    out[entry] = stat.isDirectory() ? await walk(full, depth + 1) : 'file';
  }
  return out;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}