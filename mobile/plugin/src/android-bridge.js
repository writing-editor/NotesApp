// mobile/plugin/src/android-bridge.js
//
// Replaces AppCode/mobile-sw.js on Android.
//
// WHY THIS FILE EXISTS AND ISN'T A SERVICE WORKER:
// A Service Worker cannot call a native Capacitor plugin — the Capacitor
// JS bridge only exists in the page's own JS context (window), not inside
// a Service Worker's separate global scope. Real filesystem/native-git
// access on Android *has* to happen from Kotlin via the plugin bridge, so
// the router that used to live in a Service Worker (mobile-sw.js) now runs
// as a page-context `fetch` monkey-patch instead. Net effect on client.js:
// none — it still calls `fetch('/api/...')` exactly as before and gets the
// same JSON shapes back; only what answers those calls changed.
//
// This file is the *complete* backend replacement for Android, in the same
// sense mobile-sw.js's own header comment described itself. Every route
// below mirrors AppCode/server.js and the old AppCode/mobile-sw.js
// route-for-route, same request/response shapes, so client.js needed no
// changes. Storage calls that used to hit `pfs.*` (LightningFS) now hit
// `GitFs.*` (native, real filesystem) instead — see mobile/plugin/src/index.js.
//
// See mobile/README-android-fs.md for the full before/after architecture
// picture and why this replaces isomorphic-git/LightningFS rather than
// patching around them.

import { marked } from 'marked';
import GitFs from './index.js';

const BOOK_PREFIX = 'book/'; // VAULT-relative -> GIT_ROOT-relative, same constant as lib/git-Sync.js

// ── Small wrappers around the native plugin, vault-relative paths in ────
// (GitFsPlugin itself resolves everything relative to GIT_ROOT; every call
// site below that deals in VAULT-relative paths prefixes with BOOK_PREFIX
// exactly the way lib/git-Sync.js's toRepoPath() does for git operations.)

async function readFile(vaultRelPath) {
  const res = await GitFs.readFile({ path: BOOK_PREFIX + vaultRelPath });
  return res.data;
}
async function writeFile(vaultRelPath, data) {
  await GitFs.writeFile({ path: BOOK_PREFIX + vaultRelPath, data });
}
async function deleteFile(vaultRelPath) {
  await GitFs.deleteFile({ path: BOOK_PREFIX + vaultRelPath });
}
async function existsPath(vaultRelPath) {
  const res = await GitFs.exists({ path: BOOK_PREFIX + vaultRelPath });
  return res.exists;
}
async function readdir(vaultRelPath) {
  try {
    const res = await GitFs.readdir({ path: BOOK_PREFIX + vaultRelPath });
    return res.entries || [];
  } catch {
    return [];
  }
}
async function mkdir(vaultRelPath) {
  await GitFs.mkdir({ path: BOOK_PREFIX + vaultRelPath });
}

// git-config.json lives beside GIT_ROOT's book/ folder but outside it,
// same placement lib/git-Sync.js / mobile-sw.js used (GIT_ROOT-relative,
// not VAULT-relative) — pass the raw path (no BOOK_PREFIX) for this one file.
async function readGitConfigRaw() {
  try {
    const res = await GitFs.readFile({ path: 'git-config.json' });
    return JSON.parse(res.data);
  } catch {
    return {};
  }
}
async function writeGitConfigRaw(partial) {
  const existing = await readGitConfigRaw();
  const merged = { ...existing, ...partial };
  Object.keys(merged).forEach((k) => merged[k] === undefined && delete merged[k]);
  await GitFs.writeFile({ path: 'git-config.json', data: JSON.stringify(merged, null, 2) });
  return merged;
}

// ── Router ────────────────────────────────────────────────────────────
async function handleApiRequest(req) {
  const url = new URL(req.url, self.location.origin);
  const path = url.pathname;
  const method = req.method;

  try {
    if (path === '/api/debug/whoami' && method === 'GET') {
      const info = await GitFs.getRootInfo();
      return jsonResponse(info);
    }

    // ── Git: clone ──────────────────────────────────────────────────
    if (path === '/api/git/clone' && method === 'POST') {
      const { remoteUrl, token } = await req.json();
      if (!remoteUrl) return jsonResponse({ error: 'remoteUrl required' }, 400);
      const result = await GitFs.gitClone({ remoteUrl, token });
      if (!result.ok) return jsonResponse({ error: result.error || 'clone failed' }, 500);
      const tree = await readdir('');
      return jsonResponse({ ok: true, vault: result.vault, tree });
    }

    // ── Git: status ─────────────────────────────────────────────────
    if (path === '/api/git/status' && method === 'GET') {
      return jsonResponse(await GitFs.gitStatus());
    }

    // ── Git: commit ─────────────────────────────────────────────────
    if (path === '/api/git/commit' && method === 'POST') {
      const body = await safeJson(req);
      const cfg = await readGitConfigRaw();
      const result = await GitFs.gitCommit({
        message: body.message,
        authorName: cfg.authorName,
        authorEmail: cfg.authorEmail,
      });
      return jsonResponse(result);
    }

    // ── Git: pull ───────────────────────────────────────────────────
    if (path === '/api/git/pull' && method === 'POST') {
      const { remoteUrl, token } = await safeJson(req);
      const cfg = await readGitConfigRaw();
      const url_ = remoteUrl || cfg.remoteUrl;
      if (!url_) return jsonResponse({ error: 'remoteUrl required' }, 400);
      const result = await GitFs.gitPull({
        remoteUrl: url_, token, authorName: cfg.authorName, authorEmail: cfg.authorEmail,
      });
      return jsonResponse(result);
    }

    // ── Git: push ───────────────────────────────────────────────────
    if (path === '/api/git/push' && method === 'POST') {
      const { remoteUrl, token, message } = await safeJson(req);
      const cfg = await readGitConfigRaw();
      const url_ = remoteUrl || cfg.remoteUrl;
      if (!url_) return jsonResponse({ error: 'remoteUrl required' }, 400);
      const result = await GitFs.gitPush({
        remoteUrl: url_, token, message, authorName: cfg.authorName, authorEmail: cfg.authorEmail,
      });
      return jsonResponse(result);
    }

    // ── Git: config ─────────────────────────────────────────────────
    if (path === '/api/git/config' && method === 'GET') {
      return jsonResponse(await readGitConfigRaw());
    }
    if (path === '/api/git/config' && method === 'POST') {
      const { remoteUrl, authorName, authorEmail } = await req.json();
      await writeGitConfigRaw({ remoteUrl, authorName, authorEmail });
      return jsonResponse({ ok: true });
    }

    // ── Real-folder mirror (export/import), independent of git ───────
    if (path === '/api/fs/export' && method === 'POST') {
      const result = await GitFs.pickAndExport();
      return jsonResponse(result);
    }
    if (path === '/api/fs/import' && method === 'POST') {
      const result = await GitFs.pickAndImport();
      return jsonResponse(result);
    }
    if (path === '/api/fs/info' && method === 'GET') {
      return jsonResponse(await GitFs.getRootInfo());
    }

    // ── Manifest ────────────────────────────────────────────────────
    if (path === '/api/manifest' && method === 'GET') {
      if (!(await existsPath(''))) return jsonResponse({ error: 'No vault selected' }, 400);
      return jsonResponse(await buildManifest());
    }

    // ── Read chapter (full parse, with note spans) ────────────────
    if (path === '/api/chapter' && method === 'GET') {
      const rawParam = url.searchParams.get('path');
      if (!rawParam) return jsonResponse({ error: 'path required' }, 400);
      const relPath = decodeURIComponent(rawParam).replace(/\\/g, '/');

      let raw;
      try {
        raw = await readFile(relPath);
      } catch (e) {
        return jsonResponse({ error: 'not found', detail: e.message }, 404);
      }

      try {
        const { bodyHtml, notes } = parseMd(raw);
        const { words, chars } = countWords(raw);
        return jsonResponse({ bodyHtml, notes, path: relPath, words, chars });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Whole-file raw markdown (CodeMirror full-chapter edit mode) ──
    if (path === '/api/raw' && method === 'GET') {
      const relParam = url.searchParams.get('path');
      if (!relParam) return jsonResponse({ error: 'path required' }, 400);
      const relPath = decodeURIComponent(relParam).replace(/\\/g, '/');
      try {
        const raw = await readFile(relPath);
        return jsonResponse({ raw });
      } catch {
        return jsonResponse({ error: 'not found' }, 404);
      }
    }

    if (path === '/api/raw' && method === 'PUT') {
      const { path: relPath, text } = await req.json();
      if (!relPath || text === undefined) return jsonResponse({ error: 'path, text required' }, 400);
      const normPath = relPath.replace(/\\/g, '/');
      try {
        await readFile(normPath); // confirm it exists, matches server.js 404 behavior
      } catch {
        return jsonResponse({ error: 'not found' }, 404);
      }
      try {
        const updated = text.endsWith('\n') ? text : text + '\n';
        await writeFile(normPath, updated);
        try {
          new BroadcastChannel('manuscript-events').postMessage({ type: 'file-changed', path: normPath });
        } catch { /* BroadcastChannel unsupported in some WebViews — non-fatal */ }
        return jsonResponse({ ok: true });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Create a new document from the UI ─────────────────────────
    if (path === '/api/chapter' && method === 'POST') {
      const { section, title } = (await req.json()) || {};
      const allowedSections = ['front', 'chapters', 'back'];
      if (!allowedSections.includes(section)) {
        return jsonResponse({ error: 'section must be one of front, chapters, back' }, 400);
      }
      const cleanTitle = (title || 'Untitled').trim().slice(0, 120);
      if (!cleanTitle) return jsonResponse({ error: 'title required' }, 400);

      try {
        await mkdir(section);

        const slug =
          cleanTitle.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-') ||
          'untitled';

        const existing = await readdir(section);
        const mdFiles = existing.filter((f) => f.endsWith('.md'));
        const maxPrefix = mdFiles.reduce((max, f) => {
          const m = f.match(/^(\d+)-/);
          return m ? Math.max(max, parseInt(m[1], 10)) : max;
        }, 0);
        const prefix = String(maxPrefix + 1).padStart(2, '0');

        let filename = `${prefix}-${slug}.md`;
        let relPath = `${section}/${filename}`;
        let n = 2;
        while (await existsPath(relPath)) {
          filename = `${prefix}-${slug}-${n}.md`;
          relPath = `${section}/${filename}`;
          n++;
        }

        const initialContent = `# ${cleanTitle}\n\n`;
        await writeFile(relPath, initialContent);

        return jsonResponse({ ok: true, path: relPath, label: cleanTitle });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Add a note ─────────────────────────────────────────────────
    if (path === '/api/note' && method === 'POST') {
      const { path: relPath, charPos, noteText, noteType } = await req.json();
      if (!relPath || charPos === undefined || !noteText) {
        return jsonResponse({ error: 'path, charPos, noteText required' }, 400);
      }
      const normPath = relPath.replace(/\\/g, '/');
      try {
        await writeNote(normPath, charPos, noteText, noteType || null);
        return jsonResponse({ ok: true });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Delete a note ────────────────────────────────────────────────
    if (path === '/api/note' && method === 'DELETE') {
      const { path: relPath, noteId, charPos } = await req.json();
      if (!relPath || !noteId) return jsonResponse({ error: 'path, noteId required' }, 400);
      const normPath = relPath.replace(/\\/g, '/');
      try {
        await deleteNote(normPath, noteId, charPos);
        return jsonResponse({ ok: true });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Retype a note ────────────────────────────────────────────────
    if (path === '/api/note' && method === 'PATCH') {
      const { path: relPath, noteId, charPos, newType } = await req.json();
      if (!relPath || !noteId) return jsonResponse({ error: 'path, noteId required' }, 400);
      const normPath = relPath.replace(/\\/g, '/');
      try {
        const raw = await readFile(normPath);
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
        await writeFile(normPath, updated);
        return jsonResponse({ ok: true });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Reading progress — per file, not just the single last-opened one ──
    // Shape: { lastPath, files: { "<relPath>": { scrollTop, savedAt } } }.
    // Matches AppCode/server.js's readProgressData()/routes exactly, so a
    // vault synced between laptop and phone keeps every file's own scroll
    // position in step regardless of which platform last wrote it.
    if (path === '/api/progress' && method === 'GET') {
      const data = await readProgressData();
      const qPath = url.searchParams.get('path');
      if (qPath) return jsonResponse(data.files[qPath] || {});
      return jsonResponse(data);
    }
    if (path === '/api/progress' && method === 'POST') {
      const { path: relPath, scrollTop } = await req.json();
      if (!relPath) return jsonResponse({ error: 'path required' }, 400);
      try {
        const data = await readProgressData();
        data.lastPath = relPath;
        data.files[relPath] = { scrollTop: scrollTop || 0, savedAt: Date.now() };
        await writeFile('_progress.json', JSON.stringify(data));
        return jsonResponse({ ok: true });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── PDF export — impossible on-device, matches laptop's own guard ─
    if (path === '/api/export/pdf' && method === 'GET') {
      return jsonResponse(
        { error: "PDF export isn't available on mobile — open this vault on your laptop to export." },
        501
      );
    }

    return jsonResponse({ error: 'Route not implemented on mobile', path, method }, 404);
  } catch (error) {
    console.error('[android-bridge] error handling', method, path, error);
    return jsonResponse({ error: error.message }, 500);
  }
}

// ── Reading progress storage — mirrors server.js readProgressData() ─────
// Normalises _progress.json to { lastPath, files: { path: {scrollTop,
// savedAt} } }, migrating the old single-record { path, scrollTop,
// savedAt } shape in-memory if that's what's still on disk (e.g. a vault
// last opened by an older build of this app, on any platform).
async function readProgressData() {
  let raw;
  try {
    raw = JSON.parse(await readFile('_progress.json'));
  } catch {
    return { lastPath: null, files: {} };
  }
  if (raw && typeof raw === 'object' && raw.files && typeof raw.files === 'object') {
    return { lastPath: raw.lastPath || null, files: raw.files };
  }
  if (raw && raw.path) {
    return {
      lastPath: raw.path,
      files: { [raw.path]: { scrollTop: raw.scrollTop || 0, savedAt: raw.savedAt || Date.now() } },
    };
  }
  return { lastPath: null, files: {} };
}

// ── Manifest builder (mirrors server.js buildManifest/readMeta) ────────
async function buildManifest() {
  const meta = { title: 'Manuscript', author: '', description: '' };
  try {
    const raw = await readFile('_meta.md');
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
    const files = await readdir(subdir);
    return files
      .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
      .sort()
      .map((f) => ({
        label: f.replace(/^\d+-/, '').replace(/\.md$/, '').replace(/-/g, ' '),
        path: `${subdir}/${f}`,
      }));
  };

  const sections = [
    { label: 'Front Matter', files: await readSection('front') },
    { label: 'Chapters', files: await readSection('chapters') },
    { label: 'Back Matter', files: await readSection('back') },
  ].filter((s) => s.files.length > 0);

  return { ...meta, sections };
}

// ── Markdown parser — ported verbatim from AppCode/lib/parse.js ────────
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

// ── Note write-back — ported verbatim from server.js ────────────────────
async function writeNote(relPath, charPos, noteText, noteType) {
  const raw = await readFile(relPath);
  const tag = noteType ? `mn.${noteType}` : 'mn';
  const marker = `[${tag}: ${noteText}]`;
  const updated = raw.slice(0, charPos) + marker + raw.slice(charPos);
  await writeFile(relPath, updated);
}

async function deleteNote(relPath, noteId, charPos) {
  const raw = await readFile(relPath);
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

  await writeFile(relPath, updated);
}

// ── Misc helpers ─────────────────────────────────────────────────────
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
async function safeJson(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

// ── Install: intercept every same-origin /api/* fetch in page context ──
// This is the direct replacement for mobile-sw.js's `self.addEventListener
// ('fetch', ...)`. client.js's own calls (`fetch('/api/...')`) are
// unmodified; we patch the one thing that answers them.
export function installAndroidApiBridge() {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url, window.location.origin);
    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(req);
    }
    return originalFetch(input, init);
  };
  console.log('[android-bridge] native GitFs API bridge installed (real filesystem + JGit)');
}

// index.html loads this file as a plain `<script type="module" src="...">`
// (not an import), so there's no other call site to invoke
// installAndroidApiBridge() — do it here, immediately, the moment this
// module evaluates. client.js's very first `fetch('/api/...')` call
// happens on DOMContentLoaded, after this <script> tag (inserted
// synchronously, before client.js runs any of its own boot logic) has had
// a chance to load and execute, so there's no race with the first request.
installAndroidApiBridge();