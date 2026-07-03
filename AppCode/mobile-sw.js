// AppCode/mobile-sw.js
//
// Full mobile port of server.js — every route runs against LightningFS
// instead of the real filesystem, and git operations use isomorphic-git's
// browser HTTP client. This file is the complete backend replacement for
// the mobile app; nothing here should need re-porting later except:
//   - PDF export (impossible in-browser; explicitly 501s, matches laptop's
//     own guard for the embedded Android Node runtime)
//   - /api/browse and /api/open-vault (native filesystem browser / "reveal
//     in Finder" — meaningless concepts inside a Service Worker sandbox,
//     intentionally omitted)

import FS from '@isomorphic-git/lightning-fs';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import { marked } from 'marked';

// ── Virtual File System ─────────────────────────────────────────────────
const fs = new FS('manuscript-fs');
const pfs = fs.promises;
const GIT_ROOT = '/MyWritings';
const VAULT = `${GIT_ROOT}/book`;
const GIT_CONFIG_FILE = `${GIT_ROOT}/../git-config.json`; // sibling to GIT_ROOT, never inside VAULT
const BOOK_PREFIX = 'book/';

// NOTE ON PATHS: req.json() / URLSearchParams already decode percent-encoding.
// decodeURIComponent() is still applied defensively below wherever a path
// comes off a querystring, since a filename with a space (e.g.
// "01-chapter one.md") arrives urlencoded from fetch() and LightningFS needs
// the literal bytes, not the escaped form.

// ── Service Worker asset caching ────────────────────────────────────────
const CACHE_NAME = 'manuscript-mobile-v1';
const STATIC_ASSETS = ['/', '/index.html', '/styles.css', '/client.js', '/mn-editor.bundle.js'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(STATIC_ASSETS)));
});
self.addEventListener('activate', (e) => self.clients.claim());

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(handleApiRequest(event.request, url));
    return;
  }
  event.respondWith(
    caches.match(event.request).then((res) => res || fetch(event.request))
  );
});

// ── Router ───────────────────────────────────────────────────────────────
async function handleApiRequest(req, url) {
  const method = req.method;
  const path = url.pathname;

  try {
    // ── Debug ──────────────────────────────────────────────────────────
    if (path === '/api/debug/whoami' && method === 'GET') {
      const tree = await walk(GIT_ROOT).catch((e) => ({ error: e.message }));
      return jsonResponse({ engine: 'mobile-sw-lightningfs', gitRoot: GIT_ROOT, vault: VAULT, tree });
    }

    // ── Git: clone (first-time setup) ─────────────────────────────────
    if (path === '/api/git/clone' && method === 'POST') {
      const { remoteUrl, token } = await req.json();
      if (!remoteUrl) return jsonResponse({ error: 'remoteUrl required' }, 400);

      await pfs.mkdir(GIT_ROOT).catch(() => {});

      await git.clone({
        fs, http, dir: GIT_ROOT, url: remoteUrl,
        corsProxy: 'https://cors.isomorphic-git.org', // CapacitorHttp does not intercept Service Worker fetches
        onAuth: () => ({ username: token, password: 'x-oauth-basic' }),
        singleBranch: true, depth: 1,
      });

      let bookExists = false;
      try { bookExists = (await pfs.stat(VAULT)).isDirectory(); } catch { /* not found */ }
      if (!bookExists) {
        return jsonResponse({ error: 'Cloned repository has no book/ folder at its root', gitRoot: GIT_ROOT }, 500);
      }

      await writeGitConfig({ remoteUrl }); // token intentionally never persisted

      const tree = await walk(GIT_ROOT).catch((e) => ({ error: e.message }));
      return jsonResponse({ ok: true, vault: VAULT, tree });
    }

    // ── Git: status ────────────────────────────────────────────────────
    if (path === '/api/git/status' && method === 'GET') {
      return jsonResponse(await gitStatus());
    }

    // ── Git: commit pending changes ──────────────────────────────────
    if (path === '/api/git/commit' && method === 'POST') {
      const body = await safeJson(req);
      const cfg = await readGitConfig();
      const result = await commitAll(cfg.authorName, cfg.authorEmail, body.message);
      return jsonResponse(result);
    }

    // ── Git: pull ──────────────────────────────────────────────────────
    if (path === '/api/git/pull' && method === 'POST') {
      const { remoteUrl, token } = await safeJson(req);
      const cfg = await readGitConfig();
      const url_ = remoteUrl || cfg.remoteUrl;
      if (!url_) return jsonResponse({ error: 'remoteUrl required' }, 400);
      const result = await gitPull(url_, token, cfg.authorName, cfg.authorEmail);
      return jsonResponse(result);
    }

    // ── Git: push ──────────────────────────────────────────────────────
    if (path === '/api/git/push' && method === 'POST') {
      const { remoteUrl, token, message } = await safeJson(req);
      const cfg = await readGitConfig();
      const url_ = remoteUrl || cfg.remoteUrl;
      if (!url_) return jsonResponse({ error: 'remoteUrl required' }, 400);
      const result = await gitPush(url_, token, cfg.authorName, cfg.authorEmail, message);
      return jsonResponse(result);
    }

    // ── Git: config (non-secret, persisted) ───────────────────────────
    if (path === '/api/git/config' && method === 'GET') {
      return jsonResponse(await readGitConfig());
    }
    if (path === '/api/git/config' && method === 'POST') {
      const { remoteUrl, authorName, authorEmail } = await req.json();
      await writeGitConfig({ remoteUrl, authorName, authorEmail });
      return jsonResponse({ ok: true });
    }

    // ── Manifest ───────────────────────────────────────────────────────
    if (path === '/api/manifest' && method === 'GET') {
      return jsonResponse(await buildManifest());
    }

    // ── Read chapter (full parse, with note spans) ────────────────────
    if (path === '/api/chapter' && method === 'GET') {
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

      try {
        const { bodyHtml, notes } = parseMd(raw);
        const { words, chars } = countWords(raw);
        return jsonResponse({ bodyHtml, notes, path: relPath, words, chars });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Read raw block (for inline edit) ──────────────────────────────
    if (path === '/api/block' && method === 'GET') {
      const relParam = url.searchParams.get('path');
      const startParam = url.searchParams.get('start');
      if (!relParam || startParam === null) return jsonResponse({ error: 'path, start required' }, 400);
      const relPath = decodeURIComponent(relParam).replace(/\\/g, '/');
      const full = `${VAULT}/${relPath}`;

      let raw;
      try {
        raw = await pfs.readFile(full, 'utf8');
      } catch {
        return jsonResponse({ error: 'not found' }, 404);
      }

      const startChar = parseInt(startParam, 10);
      let end = startChar;
      while (end < raw.length) {
        const nl = raw.indexOf('\n', end);
        if (nl === -1) { end = raw.length; break; }
        const afterNl = nl + 1;
        if (afterNl >= raw.length || raw[afterNl] === '\n' || raw[afterNl] === '\r') { end = nl; break; }
        end = afterNl;
      }

      const blockRaw = raw.slice(startChar, end);
      return jsonResponse({ raw: blockRaw, start: startChar, end });
    }

    // ── Save edited block ──────────────────────────────────────────────
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

      // No autoCommit — staged only; committed in bulk on Push.
      new BroadcastChannel('manuscript-events').postMessage({ type: 'file-changed', path: normPath });
      return jsonResponse({ ok: true });
    }

    // ── Whole-file raw markdown (CodeMirror full-chapter edit mode) ─────
    // Mirrors server.js's /api/raw exactly, backed by LightningFS instead
    // of the real filesystem. Previously missing here entirely, which is
    // why edit mode silently failed to open on mobile/mobile-web.
    if (path === '/api/raw' && method === 'GET') {
      const relParam = url.searchParams.get('path');
      if (!relParam) return jsonResponse({ error: 'path required' }, 400);
      const relPath = decodeURIComponent(relParam).replace(/\\/g, '/');
      const full = `${VAULT}/${relPath}`;
      try {
        const raw = await pfs.readFile(full, 'utf8');
        return jsonResponse({ raw });
      } catch {
        return jsonResponse({ error: 'not found' }, 404);
      }
    }

    if (path === '/api/raw' && method === 'PUT') {
      const { path: relPath, text } = await req.json();
      if (!relPath || text === undefined) return jsonResponse({ error: 'path, text required' }, 400);
      const normPath = relPath.replace(/\\/g, '/');
      const full = `${VAULT}/${normPath}`;
      try {
        await pfs.readFile(full, 'utf8'); // confirm it exists, matches server.js 404 behavior
      } catch {
        return jsonResponse({ error: 'not found' }, 404);
      }
      try {
        const updated = text.endsWith('\n') ? text : text + '\n';
        await pfs.writeFile(full, updated, 'utf8');
        // NOTE: no autoCommit here — edits are staged on save and only
        // committed in bulk when the user presses Push (see commitAll call
        // inside push()). Committing on every keystroke/save polluted the
        // git history with one commit per edit session.
        new BroadcastChannel('manuscript-events').postMessage({ type: 'file-changed', path: normPath });
        return jsonResponse({ ok: true });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Create a new document from the UI ───────────────────────────────
    // Mirrors server.js's POST /api/chapter exactly, backed by LightningFS.
    // Previously missing here entirely — "New document" on mobile/mobile-web
    // had no route to hit and surfaced as "not implemented".
    if (path === '/api/chapter' && method === 'POST') {
      const { section, title } = await req.json() || {};
      const allowedSections = ['front', 'chapters', 'back'];
      if (!allowedSections.includes(section)) {
        return jsonResponse({ error: 'section must be one of front, chapters, back' }, 400);
      }
      const cleanTitle = (title || 'Untitled').trim().slice(0, 120);
      if (!cleanTitle) return jsonResponse({ error: 'title required' }, 400);

      const dir = `${VAULT}/${section}`;
      try {
        await pfs.mkdir(dir).catch(() => {}); // LightningFS mkdir has no {recursive:true}; ignore "already exists"

        const slug = cleanTitle
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '')
          .trim()
          .replace(/\s+/g, '-') || 'untitled';

        let existing = [];
        try { existing = await pfs.readdir(dir); } catch { /* dir just created, empty */ }
        const mdFiles = existing.filter((f) => f.endsWith('.md'));
        const maxPrefix = mdFiles.reduce((max, f) => {
          const m = f.match(/^(\d+)-/);
          return m ? Math.max(max, parseInt(m[1], 10)) : max;
        }, 0);
        const prefix = String(maxPrefix + 1).padStart(2, '0');

        let filename = `${prefix}-${slug}.md`;
        let full = `${dir}/${filename}`;
        let n = 2;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          try {
            await pfs.stat(full);
            filename = `${prefix}-${slug}-${n}.md`;
            full = `${dir}/${filename}`;
            n++;
          } catch {
            break; // stat threw — path free
          }
        }

        const initialContent = `# ${cleanTitle}\n\n`;
        await pfs.writeFile(full, initialContent, 'utf8');

        const relPath = `${section}/${filename}`;
        // No autoCommit — same reasoning as /api/raw PUT above; new files
        // are staged and picked up by the next Push's commitAll.
        return jsonResponse({ ok: true, path: relPath, label: cleanTitle });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Add a note ──────────────────────────────────────────────────────
    if (path === '/api/note' && method === 'POST') {
      const { path: relPath, charPos, noteText, noteType } = await req.json();
      if (!relPath || charPos === undefined || !noteText) {
        return jsonResponse({ error: 'path, charPos, noteText required' }, 400);
      }
      const normPath = relPath.replace(/\\/g, '/');
      const full = `${VAULT}/${normPath}`;

      try {
        await writeNote(full, charPos, noteText, noteType || null);
        // No autoCommit — staged only; committed in bulk on Push.
        return jsonResponse({ ok: true });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Delete a note ────────────────────────────────────────────────────
    if (path === '/api/note' && method === 'DELETE') {
      const { path: relPath, noteId, charPos } = await req.json();
      if (!relPath || !noteId) return jsonResponse({ error: 'path, noteId required' }, 400);
      const normPath = relPath.replace(/\\/g, '/');
      const full = `${VAULT}/${normPath}`;

      try {
        await deleteNote(full, noteId, charPos);
        // No autoCommit — staged only; committed in bulk on Push.
        return jsonResponse({ ok: true });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Retype a note ────────────────────────────────────────────────────
    if (path === '/api/note' && method === 'PATCH') {
      const { path: relPath, noteId, charPos, newType } = await req.json();
      if (!relPath || !noteId) return jsonResponse({ error: 'path, noteId required' }, 400);
      const normPath = relPath.replace(/\\/g, '/');
      const full = `${VAULT}/${normPath}`;

      try {
        const raw = await pfs.readFile(full, 'utf8');
        const MN_RE_PATCH = /\[mn(?:\.(\w+))?\s*:\s*([\s\S]*?)\]/g;
        let best = null, m;
        while ((m = MN_RE_PATCH.exec(raw)) !== null) {
          if (best === null || Math.abs(m.index - charPos) < Math.abs(best.index - charPos)) {
            best = { index: m.index, full: m[0], content: m[2] };
          }
        }
        if (!best) return jsonResponse({ error: 'note not found' }, 404);

        const tag = newType ? `mn.${newType}` : 'mn';
        const newMarker = `[${tag}: ${best.content}]`;
        const updated = raw.slice(0, best.index) + newMarker + raw.slice(best.index + best.full.length);
        await pfs.writeFile(full, updated, 'utf8');

        // No autoCommit — staged only; committed in bulk on Push.
        return jsonResponse({ ok: true });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Reading progress ────────────────────────────────────────────────
    if (path === '/api/progress' && method === 'GET') {
      try {
        const raw = await pfs.readFile(`${VAULT}/_progress.json`, 'utf8');
        return jsonResponse(JSON.parse(raw));
      } catch {
        return jsonResponse({});
      }
    }
    if (path === '/api/progress' && method === 'POST') {
      const { path: relPath, scrollTop } = await req.json();
      if (!relPath) return jsonResponse({ error: 'path required' }, 400);
      try {
        const data = { path: relPath, scrollTop: scrollTop || 0, savedAt: Date.now() };
        await pfs.writeFile(`${VAULT}/_progress.json`, JSON.stringify(data), 'utf8');
        return jsonResponse({ ok: true });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── PDF export — impossible in-browser, matches laptop's own guard ──
    if (path === '/api/export/pdf' && method === 'GET') {
      return jsonResponse(
        { error: "PDF export isn't available on mobile — open this vault on your laptop to export." },
        501
      );
    }

    return jsonResponse({ error: 'Route not implemented on mobile', path, method }, 404);
  } catch (error) {
    console.error('[mobile-sw] error handling', method, path, error);
    return jsonResponse({ error: error.message }, 500);
  }
}

// ── Manifest builder (mirrors server.js buildManifest/readMeta) ─────────
async function buildManifest() {
  const meta = { title: 'Manuscript', author: '', description: '' };
  try {
    const raw = await pfs.readFile(`${VAULT}/_meta.md`, 'utf8');
    const yamlMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (yamlMatch) {
      const block = yamlMatch[1];
      const get = (key) => {
        const m = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
        return m ? m[1].trim() : '';
      };
      meta.title = get('title') || meta.title;
      meta.author = get('author') || '';
      meta.description = get('description') || '';
    } else {
      const lines = raw.split('\n');
      meta.title = lines[0].replace(/^#+\s*/, '').trim() || meta.title;
      meta.author = (lines.find((l) => l.startsWith('author:')) || '').replace('author:', '').trim();
      meta.description = (lines.find((l) => l.startsWith('description:')) || '').replace('description:', '').trim();
    }
  } catch { /* no _meta.md yet — defaults stand */ }

  const readSection = async (subdir) => {
    try {
      const files = await pfs.readdir(`${VAULT}/${subdir}`);
      return files
        .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
        .sort()
        .map((f) => ({
          label: f.replace(/^\d+-/, '').replace(/\.md$/, '').replace(/-/g, ' '),
          path: `${subdir}/${f}`, // logical path; caller must encodeURIComponent when building a fetch URL
        }));
    } catch {
      return [];
    }
  };

  const sections = [
    { label: 'Front Matter', files: await readSection('front') },
    { label: 'Chapters', files: await readSection('chapters') },
    { label: 'Back Matter', files: await readSection('back') },
  ].filter((s) => s.files.length > 0);

  return { ...meta, sections };
}

// ── Markdown parser — ported verbatim from AppCode/lib/parse.js ─────────
const MN_RE = /\[mn(?:\.(\w+))?\s*:\s*([\s\S]*?)\]/g;

function inlineMarkdown(str) {
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/gs, '<em>$1</em>')
    .replace(/~~(.+?)~~/gs, '<del>$1</del>')
    .replace(/_(.+?)_/gs, '<em>$1</em>');
}

const NOTE_TYPE_CLASS = { query: 'mn-type-query', ref: 'mn-type-ref', todo: 'mn-type-todo' };

function isListBlock(text) {
  return /^(\s*[-*]|\s*\d+\.)\s/.test(text);
}

function parseMd(raw) {
  const notes = [];
  let noteIndex = 0;

  const withPlaceholders = raw.replace(MN_RE, (full, type, content, offset) => {
    noteIndex++;
    const id = noteIndex;
    notes.push({ id, content: content.trim(), type: type || null, charPos: offset });
    const marker = `\x00MN${id}\x00`;
    return marker.padEnd(full.length, '\x01');
  });

  const blocks = [];
  let current = [];
  let charPos = 0;

  withPlaceholders.split('\n').forEach((line) => {
    if (line.trim() === '') {
      if (current.length) {
        blocks.push({ lines: current, startChar: charPos - current.reduce((a, l) => a + l.length + 1, 0) });
        current = [];
      }
      charPos += line.length + 1;
    } else {
      current.push(line);
      charPos += line.length + 1;
    }
  });
  if (current.length) {
    blocks.push({ lines: current, startChar: charPos - current.reduce((a, l) => a + l.length + 1, 0) });
  }

  let bodyHtml = '';

  blocks.forEach((block) => {
    const blockText = block.lines.join('\n');
    const isHeading = /^#{1,6}\s/.test(blockText);
    const isList = isListBlock(blockText);
    const isBlockquote = /^>\s/.test(blockText);
    const isCodeFence = /^```/.test(blockText);

    if (isHeading || isList || isBlockquote || isCodeFence) {
      const restored = blockText.replace(/\x00MN(\d+)\x00/g, (_, id) => {
        const note = notes.find((n) => n.id === Number(id));
        const typeClass = note?.type ? ` ${NOTE_TYPE_CLASS[note.type] || ''}` : '';
        return `<span class="mn-anchor${typeClass}" data-note-id="${id}"><sup class="mn-marker">${id}</sup></span>`;
      });
      bodyHtml += marked.parse(restored) + '\n';
      return;
    }

    const parts = blockText.split(/(\x00MN\d+\x00\x01*)/);
    let segIdx = 0;
    let segOff = 0;
    let inner = '';

    parts.forEach((part) => {
      const mnMatch = part.match(/^\x00MN(\d+)\x00\x01*$/);
      if (mnMatch) {
        const id = mnMatch[1];
        const note = notes.find((n) => n.id === Number(id));
        const typeClass = note?.type ? ` ${NOTE_TYPE_CLASS[note.type] || ''}` : '';
        inner += `<span class="mn-anchor${typeClass}" data-note-id="${id}"><sup class="mn-marker">${id}</sup></span>`;
        segOff += part.length;
      } else if (part.length > 0) {
        inner += `<span class="txt-seg" data-block="${block.startChar}" data-off="${segOff}" data-seg="${segIdx}">${inlineMarkdown(part)}</span>`;
        segOff += part.length;
        segIdx++;
      }
    });

    bodyHtml += `<p data-block="${block.startChar}">${inner}</p>\n`;
  });

  return { bodyHtml, notes };
}

function countWords(raw) {
  const stripped = raw.replace(MN_RE, '').replace(/^#{1,6}\s+/gm, '').trim();
  const words = stripped.split(/\s+/).filter(Boolean).length;
  const chars = stripped.replace(/\s/g, '').length;
  return { words, chars };
}

// ── Note write-back — ported verbatim from server.js ─────────────────────
async function writeNote(filePath, charPos, noteText, noteType) {
  const raw = await pfs.readFile(filePath, 'utf8');
  const tag = noteType ? `mn.${noteType}` : 'mn';
  const marker = `[${tag}: ${noteText}]`;
  const updated = raw.slice(0, charPos) + marker + raw.slice(charPos);
  await pfs.writeFile(filePath, updated, 'utf8');
}

async function deleteNote(filePath, noteId, charPos) {
  const raw = await pfs.readFile(filePath, 'utf8');
  let updated;

  if (charPos !== undefined && charPos !== null) {
    const MN_RE_POS = /\[mn(?:\.\w+)?\s*:[\s\S]*?\]/g;
    let best = null, m;
    while ((m = MN_RE_POS.exec(raw)) !== null) {
      if (best === null || Math.abs(m.index - charPos) < Math.abs(best.index - charPos)) best = m;
    }
    updated = best ? raw.slice(0, best.index) + raw.slice(best.index + best[0].length) : raw;
  } else {
    let count = 0;
    updated = raw.replace(/\[mn(?:\.\w+)?\s*:[\s\S]*?\]/g, (full) => {
      count++;
      return count === noteId ? '' : full;
    });
  }

  await pfs.writeFile(filePath, updated, 'utf8');
}

// ── Git config persistence ────────────────────────────────────────────────
async function readGitConfig() {
  try {
    return JSON.parse(await pfs.readFile(GIT_CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function writeGitConfig(partial) {
  const existing = await readGitConfig();
  const merged = { ...existing, ...partial };
  Object.keys(merged).forEach((k) => merged[k] === undefined && delete merged[k]);
  await pfs.writeFile(GIT_CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

// ── Git operations — ported from lib/git-sync.js, adapted for browser http ──
async function isGitRepo() {
  try {
    return (await pfs.stat(`${GIT_ROOT}/.git`)).isDirectory();
  } catch {
    return false;
  }
}

function authCallback(token) {
  return () => ({ username: token, password: 'x-oauth-basic' });
}

function toRepoPath(vaultRelativePath) {
  return BOOK_PREFIX + vaultRelativePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

async function autoCommit(vaultRelativePath, message) {
  if (!(await isGitRepo())) return; // no repo yet — never break editing
  const cfg = await readGitConfig();
  const filepath = toRepoPath(vaultRelativePath);
  await git.add({ fs, dir: GIT_ROOT, filepath });
  await git.commit({
    fs, dir: GIT_ROOT,
    author: { name: cfg.authorName || 'Manuscript', email: cfg.authorEmail || 'manuscript@localhost' },
    message,
  });
}

async function commitAll(authorName, authorEmail, message) {
  if (!(await isGitRepo())) return { ok: false, reason: 'error', message: 'not a git repository' };
  const matrix = await git.statusMatrix({ fs, dir: GIT_ROOT });
  // _progress.json is per-device scroll-position telemetry, rewritten on
  // every scroll — it must never be staged/committed, or every Push would
  // carry a noise commit even when the user made no actual edits.
  const changed = matrix.filter(([filepath, head, workdir, stage]) =>
    (head !== workdir || workdir !== stage) && !filepath.endsWith('_progress.json')
  );
  for (const [filepath] of changed) {
    await git.add({ fs, dir: GIT_ROOT, filepath });
  }
  if (changed.length === 0) return { ok: true, committed: false, message: 'nothing to commit' };
  const oid = await git.commit({
    fs, dir: GIT_ROOT,
    author: { name: authorName || 'Manuscript', email: authorEmail || 'manuscript@localhost' },
    message: message || 'Manual commit from Manuscript',
  });
  return { ok: true, committed: true, oid };
}

async function gitStatus() {
  if (!(await isGitRepo())) {
    return { ahead: 0, behind: 0, dirty: [], conflicted: [], error: 'not a git repository' };
  }
  const matrix = await git.statusMatrix({ fs, dir: GIT_ROOT });
  const dirty = matrix
    .filter(([, head, workdir, stage]) => head !== workdir || workdir !== stage)
    .map(([filepath]) => filepath);

  let ahead = 0, behind = 0;
  try {
    const branch = await git.currentBranch({ fs, dir: GIT_ROOT, fullname: false });
    if (branch) {
      const localOid = await git.resolveRef({ fs, dir: GIT_ROOT, ref: branch }).catch(() => null);
      const remoteOid = await git.resolveRef({ fs, dir: GIT_ROOT, ref: `refs/remotes/origin/${branch}` }).catch(() => null);
      if (localOid && remoteOid && localOid !== remoteOid) {
        const localLog = await git.log({ fs, dir: GIT_ROOT, ref: branch }).catch(() => []);
        const remoteLog = await git.log({ fs, dir: GIT_ROOT, ref: `refs/remotes/origin/${branch}` }).catch(() => []);
        const remoteOids = new Set(remoteLog.map((c) => c.oid));
        const localOids = new Set(localLog.map((c) => c.oid));
        ahead = localLog.filter((c) => !remoteOids.has(c.oid)).length;
        behind = remoteLog.filter((c) => !localOids.has(c.oid)).length;
      }
    }
  } catch { /* no remote yet — ahead/behind stay 0 */ }

  return { ahead, behind, dirty, conflicted: [] };
}

async function gitPull(remoteUrl, token, authorName, authorEmail) {
  try {
    await git.pull({
      fs, http, dir: GIT_ROOT, url: remoteUrl,
      corsProxy: 'https://cors.isomorphic-git.org',
      onAuth: authCallback(token),
      author: { name: authorName || 'Manuscript', email: authorEmail || 'manuscript@localhost' },
      singleBranch: true,
    });
    return { ok: true };
  } catch (e) {
    if (e && (e.code === 'MergeNotSupportedError' || /conflict/i.test(e.message || ''))) {
      return { ok: false, reason: 'conflict', message: e.message, files: e.data && e.data.filepaths };
    }
    if (/network|fetch|ENOTFOUND|ECONNREFUSED/i.test(e.message || '')) {
      return { ok: false, reason: 'network', message: e.message };
    }
    return { ok: false, reason: 'error', message: e.message };
  }
}

async function gitPush(remoteUrl, token, authorName, authorEmail, commitMessage) {
  try {
    await commitAll(authorName, authorEmail, commitMessage);
    const result = await git.push({
      fs, http, dir: GIT_ROOT, url: remoteUrl,
      corsProxy: 'https://cors.isomorphic-git.org',
      onAuth: authCallback(token),
    });
    if (result && result.ok === false) {
      return { ok: false, reason: 'diverged', message: 'push rejected — pull/resolve first' };
    }
    return { ok: true };
  } catch (e) {
    if (/not.*fast.?forward|rejected/i.test(e.message || '')) {
      return { ok: false, reason: 'diverged', message: 'push rejected — pull/resolve first' };
    }
    if (/network|fetch|ENOTFOUND|ECONNREFUSED/i.test(e.message || '')) {
      return { ok: false, reason: 'network', message: e.message };
    }
    return { ok: false, reason: 'error', message: e.message };
  }
}

// ── Misc helpers ───────────────────────────────────────────────────────────
async function safeJson(req) {
  try { return await req.json(); } catch { return {}; }
}

async function walk(dir, depth = 0) {
  if (depth > 6) return '...(truncated)';
  let entries;
  try { entries = await pfs.readdir(dir); } catch { return null; }
  const out = {};
  for (const entry of entries) {
    const full = `${dir}/${entry}`;
    const stat = await pfs.stat(full);
    out[entry] = stat.isDirectory() ? await walk(full, depth + 1) : 'file';
  }
  return out;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}