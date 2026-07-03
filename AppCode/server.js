#!/usr/bin/env node

const express  = require('express');
const http     = require('http');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const chokidar = require('chokidar');
const WebSocket  = require('ws');
const { parseMd, countWords } = require('./lib/parse');
//const { generatePdf } = require('./lib/pdf');
const { generatePdf, isTypstAvailable } = require('./lib/typst');
const gitSync = require('./lib/git-Sync');

// ── Config & State ──────────────────────────────────────────────────────────
let VAULT = process.argv[2] ? path.resolve(process.argv[2]) : null;
// GIT_ROOT is the git repository root (Section 2.1/4.2 of the mobile sync plan):
// VAULT is always exactly GIT_ROOT/book, so GIT_ROOT = path.resolve(VAULT, '..').
// On the phone, process.env.GIT_ROOT is set explicitly by mobile/www/nodejs/index.js
// since it's known ahead of time there; on the laptop we derive it from VAULT.
let GIT_ROOT = process.env.GIT_ROOT ? path.resolve(process.env.GIT_ROOT)
  : (VAULT ? path.resolve(VAULT, '..') : null);
let watcher = null;

const PORT = process.env.PORT || 3000;

// Function to dynamically set and watch a new vault
function setVault(newPath) {
  const resolved = path.resolve(newPath);
  if (!fs.existsSync(resolved)) throw new Error('Directory does not exist');
  
  VAULT = resolved;
  // Recompute GIT_ROOT alongside VAULT every time it changes, per Section 4.2 —
  // do not re-derive this ad hoc in each route handler. The env var takes
  // precedence when set (phone case), otherwise assume VAULT = GIT_ROOT/book.
  GIT_ROOT = process.env.GIT_ROOT ? path.resolve(process.env.GIT_ROOT) : path.resolve(VAULT, '..');
  
  // Restart the file watcher for the new folder
  if (watcher) watcher.close();
  watcher = chokidar.watch(VAULT, { ignoreInitial: true, ignored: /(^|[\/\\])\../ })
    .on('change', fp => broadcast({ type: 'file-changed', path: fp }))
    .on('add',    fp => broadcast({ type: 'file-added',   path: fp }))
    .on('unlink', fp => broadcast({ type: 'file-removed', path: fp }));
}

// If started with a path in terminal, initialize it immediately
if (VAULT && fs.existsSync(VAULT)) {
  setVault(VAULT);
}

// Non-secret git config (remote URL, author name/email) lives alongside — not inside
// — the vault, per Section 3 point 2. Path is GIT_ROOT-relative-adjacent, computed as
// a function so it always reflects the current GIT_ROOT, matching the progressFile()
// pattern already used below for VAULT.
const gitConfigFile = () => path.join(GIT_ROOT, '..', 'git-config.json');

// Fire-and-forget auto-commit helper for Section 4.3.1. A missing/unconfigured git
// repo must never break note editing — this guard is the single gate for that.
function autoCommit(vaultRelativePath, message) {
  if (!GIT_ROOT || !gitSync.isGitRepo(GIT_ROOT)) return;
  let authorName = 'Manuscript', authorEmail = 'manuscript@localhost';
  try {
    const cfg = JSON.parse(fs.readFileSync(gitConfigFile(), 'utf8'));
    authorName  = cfg.authorName  || authorName;
    authorEmail = cfg.authorEmail || authorEmail;
  } catch { /* no config yet — use defaults */ }

  gitSync.commitFile({
    dir: GIT_ROOT,
    filepath: gitSync.toRepoPath(vaultRelativePath),
    authorName, authorEmail,
    message,
  }).catch(e => console.error('[git] auto-commit failed (non-fatal):', e.message));
}

// ── App & HTTP server ────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));


// ── WebSocket — broadcast file changes to all connected browsers ─────────────
function broadcast(msg) {
  const payload = JSON.stringify(msg);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(payload);
  });
}

// ── Manifest builder ─────────────────────────────────────────────────────────
function readMeta() {
  const metaPath = path.join(VAULT, '_meta.md');
  const meta = { title: 'Manuscript', author: '', description: '' };
  if (!fs.existsSync(metaPath)) return meta;

  const raw = fs.readFileSync(metaPath, 'utf8');

  // Support simple YAML frontmatter block OR plain first-line title
  const yamlMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (yamlMatch) {
    const block = yamlMatch[1];
    const get = key => { const m = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm')); return m ? m[1].trim() : ''; };
    meta.title       = get('title')       || meta.title;
    meta.author      = get('author')      || '';
    meta.description = get('description') || '';
  } else {
    const lines = raw.split('\n');
    meta.title  = lines[0].replace(/^#+\s*/, '').trim() || meta.title;
    meta.author = (lines.find(l => l.startsWith('author:')) || '').replace('author:', '').trim();
    meta.description = (lines.find(l => l.startsWith('description:')) || '').replace('description:', '').trim();
  }
  return meta;
}

function buildManifest() {
  const meta = readMeta();

  function readSection(subdir) {
    const dir = path.join(VAULT, subdir);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.md') && !f.startsWith('_'))
      .sort()
      .map(f => ({
        label: f.replace(/^\d+-/, '').replace(/\.md$/, '').replace(/-/g, ' '),
        path:  subdir + '/' + f,   // always forward slashes, safe for URLs
      }));
  }

  return {
    title:       meta.title,
    author:      meta.author,
    description: meta.description,
    sections: [
      { label: 'Front Matter', files: readSection('front')    },
      { label: 'Chapters',     files: readSection('chapters') },
      { label: 'Back Matter',  files: readSection('back')     },
    ].filter(s => s.files.length > 0),
  };
}



// Note write-back
// ── Note write-back ──────────────────────────────────────────────────────────

function writeNote(filePath, charPos, noteText, noteType) {
  const raw    = fs.readFileSync(filePath, 'utf8');
  const tag    = noteType ? `mn.${noteType}` : 'mn';
  const marker = `[${tag}: ${noteText}]`;
  const updated = raw.slice(0, charPos) + marker + raw.slice(charPos);
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, updated, 'utf8');
  fs.renameSync(tmp, filePath);
}

// deleteNote: find the [mn...] marker whose content matches noteId (1-based count),
// but also accepts { charPos } to target by position when available — far more robust.
function deleteNote(filePath, noteId, charPos) {
  const raw = fs.readFileSync(filePath, 'utf8');
  let updated;

  if (charPos !== undefined && charPos !== null) {
    // Position-based: find the [mn...] starting at or just after charPos
    // The marker begins right at charPos in the file after write-back
    const MN_RE_POS = /\[mn(?:\.\w+)?\s*:[\s\S]*?\]/g;
    let best = null;
    let m;
    while ((m = MN_RE_POS.exec(raw)) !== null) {
      if (best === null || Math.abs(m.index - charPos) < Math.abs(best.index - charPos)) {
        best = m;
      }
    }
    if (best) {
      updated = raw.slice(0, best.index) + raw.slice(best.index + best[0].length);
    } else {
      updated = raw; // nothing found — no-op
    }
  } else {
    // Fallback: count-based (legacy)
    let count = 0;
    updated = raw.replace(/\[mn(?:\.\w+)?\s*:[\s\S]*?\]/g, (full) => {
      count++;
      return count === noteId ? '' : full;
    });
  }

  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, updated, 'utf8');
  fs.renameSync(tmp, filePath);
}

// ── Routes ───────────────────────────────────────────────────────────────────

// ── Vault Management Routes ─────────────────────────────────────────────────
app.get('/api/vault', (req, res) => {
  res.json({ vault: VAULT });
});

app.post('/api/vault', (req, res) => {
  try {
    setVault(req.body.path);
    res.json({ ok: true, vault: VAULT });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Git sync routes (Section 4.3 of the mobile sync plan) ───────────────────
// All additive. Nothing above this changes. Every handler here operates on
// GIT_ROOT, never VAULT directly — see lib/git-sync.js header comment.

app.get('/api/git/status', async (req, res) => {
  if (!GIT_ROOT) return res.status(400).json({ error: 'No vault selected' });
  try {
    const result = await gitSync.status({ dir: GIT_ROOT });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// First-time setup on phone: clone the remote into VAULT's parent, then setVault()
// to it. Body: { remoteUrl, token }
app.post('/api/git/clone', async (req, res) => {
  const { remoteUrl, token } = req.body;
  if (!remoteUrl) return res.status(400).json({ error: 'remoteUrl required' });
  if (!GIT_ROOT) return res.status(400).json({ error: 'No target directory configured for this platform' });

  try {
    fs.mkdirSync(GIT_ROOT, { recursive: true });
    await gitSync.clone({ dir: GIT_ROOT, remoteUrl, token });

    const vaultPath = path.join(GIT_ROOT, 'book');
    if (!fs.existsSync(vaultPath)) {
      return res.status(500).json({ error: 'Cloned repository has no book/ folder at its root' });
    }
    setVault(vaultPath);
    res.json({ ok: true, vault: VAULT });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Commit any pending working-tree changes with an auto-generated or supplied message.
// Body: { message? }
app.post('/api/git/commit', async (req, res) => {
  if (!GIT_ROOT) return res.status(400).json({ error: 'No vault selected' });
  try {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(gitConfigFile(), 'utf8')); } catch { /* none yet */ }
    const result = await gitSync.commitAll({
      dir: GIT_ROOT,
      authorName: cfg.authorName,
      authorEmail: cfg.authorEmail,
      message: req.body.message,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pull from remote. Body: { remoteUrl, token }
app.post('/api/git/pull', async (req, res) => {
  if (!GIT_ROOT) return res.status(400).json({ error: 'No vault selected' });
  const { remoteUrl, token } = req.body;
  if (!remoteUrl) return res.status(400).json({ error: 'remoteUrl required' });
  try {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(gitConfigFile(), 'utf8')); } catch { /* none yet */ }
    const result = await gitSync.pull({
      dir: GIT_ROOT, remoteUrl, token,
      authorName: cfg.authorName, authorEmail: cfg.authorEmail,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Push to remote. Body: { remoteUrl, token, message? }
// Internally commits any pending changes first, then pushes.
app.post('/api/git/push', async (req, res) => {
  if (!GIT_ROOT) return res.status(400).json({ error: 'No vault selected' });
  const { remoteUrl, token, message } = req.body;
  if (!remoteUrl) return res.status(400).json({ error: 'remoteUrl required' });
  try {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(gitConfigFile(), 'utf8')); } catch { /* none yet */ }
    const result = await gitSync.push({
      dir: GIT_ROOT, remoteUrl, token,
      authorName: cfg.authorName, authorEmail: cfg.authorEmail,
      commitMessage: message,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Store/retrieve non-secret git config (remote URL, author name/email).
// Stored alongside — never inside — the vault. Token is intentionally never
// accepted or returned here; see Section 3.
app.get('/api/git/config', (req, res) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(gitConfigFile(), 'utf8'));
    res.json(cfg);
  } catch {
    res.json({});
  }
});

app.post('/api/git/config', (req, res) => {
  if (!GIT_ROOT) return res.status(400).json({ error: 'No vault selected' });
  const { remoteUrl, authorName, authorEmail } = req.body;
  try {
    fs.mkdirSync(path.dirname(gitConfigFile()), { recursive: true });
    fs.writeFileSync(gitConfigFile(), JSON.stringify({ remoteUrl, authorName, authorEmail }, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Export PDF
app.get('/api/export/pdf', async (req, res) => {
  if (!VAULT) return res.status(400).json({ error: 'No vault selected' });

  // Section 6.5: neither typst nor puppeteer is available inside the embedded
  // mobile Node runtime. Guard here, before doing any parsing/build work, so the
  // failure is immediate and the message is clear rather than a generic
  // compilation error surfacing after the fact.
  if (!isTypstAvailable()) {
    return res.status(501).json({
      error: "PDF export isn't available on mobile yet — open this vault on your laptop to export.",
    });
  }
  
  try {
    const { path: pdfPath, title } = await generatePdf(VAULT);
    
    // Send file to browser, then delete it from the server's temp folder
    res.download(pdfPath, `${title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.pdf`, (err) => {
      if (!err) fs.unlinkSync(pdfPath); 
    });
  } catch (e) {
    console.error('PDF Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Manifest

app.get('/api/manifest', (req, res) => {
  if (!VAULT) return res.status(400).json({ error: 'No vault selected' });
  res.json(buildManifest());
});

// Create a new chapter/document from the UI, so the person never has to
// leave the app (or go into Obsidian) to add a file to the manuscript.
// section: 'front' | 'chapters' | 'back' — maps directly to the vault subdir.
app.post('/api/chapter', (req, res) => {
  if (!VAULT) return res.status(400).json({ error: 'No vault selected' });
  const { section, title } = req.body || {};
  const allowedSections = ['front', 'chapters', 'back'];
  if (!allowedSections.includes(section)) {
    return res.status(400).json({ error: 'section must be one of front, chapters, back' });
  }
  const cleanTitle = (title || 'Untitled').trim().slice(0, 120);
  if (!cleanTitle) return res.status(400).json({ error: 'title required' });

  const dir = path.join(VAULT, section);
  try {
    fs.mkdirSync(dir, { recursive: true });

    // Slugify for the filename, keep spaces->dashes but preserve original
    // casing in the H1 / manifest label (label derivation strips dashes
    // back to spaces, same as buildManifest already does for existing files).
    const slug = cleanTitle
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-') || 'untitled';

    // Numeric prefix keeps ordering consistent with existing files in this
    // section (buildManifest sorts by filename), matching the convention
    // already used by "01-chapter One.md".
    const existing = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    const maxPrefix = existing.reduce((max, f) => {
      const m = f.match(/^(\d+)-/);
      return m ? Math.max(max, parseInt(m[1], 10)) : max;
    }, 0);
    const prefix = String(maxPrefix + 1).padStart(2, '0');

    let filename = `${prefix}-${slug}.md`;
    let full = path.join(dir, filename);
    // Guard against collisions (e.g. duplicate titles)
    let n = 2;
    while (fs.existsSync(full)) {
      filename = `${prefix}-${slug}-${n}.md`;
      full = path.join(dir, filename);
      n++;
    }

    const initialContent = `# ${cleanTitle}\n\n`;
    fs.writeFileSync(full, initialContent, 'utf8');

    const relPath = section + '/' + filename;
    autoCommit(relPath, `Add ${relPath}`);

    res.json({ ok: true, path: relPath, label: cleanTitle });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Render a chapter
app.get('/api/chapter', (req, res) => {
  if (!VAULT) return res.status(400).json({ error: 'No vault selected' });
  const rel  = req.query.path;
  if (!rel) return res.status(400).json({ error: 'path required' });

  // Normalise separators so both / and \ work
  const relNorm = rel.replace(/\\/g, '/');
  const full    = path.join(VAULT, relNorm);

  if (!fs.existsSync(full)) {
    console.error('[chapter] not found:', full);
    return res.status(404).json({ error: 'not found', full });
  }

  const resolved = path.resolve(full);
  if (!resolved.startsWith(path.resolve(VAULT))) {
    return res.status(403).json({ error: 'forbidden' });
  }

  try {
    const raw = fs.readFileSync(full, 'utf8');
    const { bodyHtml, notes } = parseMd(raw);
    const { words, chars }    = countWords(raw);
    res.json({ bodyHtml, notes, path: relNorm, words, chars });
  } catch (e) {
    console.error('[chapter] parse error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Fetch raw source of a single block (for inline editing)
app.get('/api/block', (req, res) => {
  if (!VAULT) return res.status(400).json({ error: 'No vault selected' });
  const { path: rel, start } = req.query;
  if (!rel || start === undefined) return res.status(400).json({ error: 'path, start required' });

  const relNorm  = rel.replace(/\\/g, '/');
  const full     = path.join(VAULT, relNorm);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(path.resolve(VAULT))) return res.status(403).json({ error: 'forbidden' });
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });

  const raw       = fs.readFileSync(full, 'utf8');
  const startChar = parseInt(start, 10);

  // Walk forward from startChar to the end of the block (next blank line or EOF)
  let end = startChar;
  while (end < raw.length) {
    const nl = raw.indexOf('\n', end);
    if (nl === -1) { end = raw.length; break; }
    // Peek at line after this newline — if it's blank (or EOF), block ends here
    const afterNl = nl + 1;
    if (afterNl >= raw.length || raw[afterNl] === '\n' || raw[afterNl] === '\r') {
      end = nl;
      break;
    }
    end = afterNl;
  }

  const blockRaw = raw.slice(startChar, end);
  res.json({ raw: blockRaw, start: startChar, end });
});

// Save edited block text back to file
app.put('/api/block', (req, res) => {
  if (!VAULT) return res.status(400).json({ error: 'No vault selected' });
  const { path: rel, start, end, text } = req.body;
  if (!rel || start === undefined || end === undefined || text === undefined) {
    return res.status(400).json({ error: 'path, start, end, text required' });
  }

  const relNorm  = rel.replace(/\\/g, '/');
  const full     = path.join(VAULT, relNorm);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(path.resolve(VAULT))) return res.status(403).json({ error: 'forbidden' });

  try {
    const raw     = fs.readFileSync(full, 'utf8');
    const updated = raw.slice(0, start) + text.trimEnd() + raw.slice(end);
    const tmp     = full + '.tmp';
    fs.writeFileSync(tmp, updated, 'utf8');
    fs.renameSync(tmp, full);
    autoCommit(relNorm, `Edit paragraph in ${relNorm}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Whole-file raw markdown — used by the full-chapter CodeMirror edit mode.
// Unlike /api/block, this reads/writes the entire file as one string, so a
// single edit session can touch multiple paragraphs without the old
// one-block-at-a-time constraint.
app.get('/api/raw', (req, res) => {
  if (!VAULT) return res.status(400).json({ error: 'No vault selected' });
  const { path: rel } = req.query;
  if (!rel) return res.status(400).json({ error: 'path required' });

  const relNorm  = rel.replace(/\\/g, '/');
  const full     = path.join(VAULT, relNorm);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(path.resolve(VAULT))) return res.status(403).json({ error: 'forbidden' });
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });

  const raw = fs.readFileSync(full, 'utf8');
  res.json({ raw });
});

app.put('/api/raw', (req, res) => {
  if (!VAULT) return res.status(400).json({ error: 'No vault selected' });
  const { path: rel, text } = req.body;
  if (!rel || text === undefined) return res.status(400).json({ error: 'path, text required' });

  const relNorm  = rel.replace(/\\/g, '/');
  const full     = path.join(VAULT, relNorm);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(path.resolve(VAULT))) return res.status(403).json({ error: 'forbidden' });
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });

  try {
    // Preserve a single trailing newline convention, same as block saves.
    const updated = text.endsWith('\n') ? text : text + '\n';
    const tmp = full + '.tmp';
    fs.writeFileSync(tmp, updated, 'utf8');
    fs.renameSync(tmp, full);
    autoCommit(relNorm, `Edit ${relNorm}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add a note
app.post('/api/note', (req, res) => {
  if (!VAULT) return res.status(400).json({ error: 'No vault selected' });
  const { path: rel, charPos, noteText, noteType } = req.body;
  if (!rel || charPos === undefined || !noteText) {
    return res.status(400).json({ error: 'path, charPos, noteText required' });
  }

  const relNorm  = rel.replace(/\\/g, '/');
  const full     = path.join(VAULT, relNorm);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(path.resolve(VAULT))) {
    return res.status(403).json({ error: 'forbidden' });
  }

  try {
    writeNote(full, charPos, noteText, noteType || null);
    autoCommit(relNorm, `Add note: "${String(noteText).slice(0, 40)}"`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a note
app.delete('/api/note', (req, res) => {
  if (!VAULT) return res.status(400).json({ error: 'No vault selected' });
  const { path: rel, noteId, charPos } = req.body;
  if (!rel || !noteId) return res.status(400).json({ error: 'path, noteId required' });

  const full     = path.join(VAULT, rel);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(path.resolve(VAULT))) {
    return res.status(403).json({ error: 'forbidden' });
  }

  try {
    deleteNote(full, noteId, charPos);
    autoCommit(rel, 'Remove note');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Retype a note (change its type tag, preserve content)
app.patch('/api/note', (req, res) => {
  if (!VAULT) return res.status(400).json({ error: 'No vault selected' });
  const { path: rel, noteId, charPos, newType } = req.body;
  if (!rel || !noteId) return res.status(400).json({ error: 'path, noteId required' });

  const full     = path.join(VAULT, rel);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(path.resolve(VAULT))) {
    return res.status(403).json({ error: 'forbidden' });
  }

  try {
    const raw = fs.readFileSync(full, 'utf8');
    // Find the target marker by position
    const MN_RE_PATCH = /\[mn(?:\.(\w+))?\s*:\s*([\s\S]*?)\]/g;
    let best = null, m;
    while ((m = MN_RE_PATCH.exec(raw)) !== null) {
      if (best === null || Math.abs(m.index - charPos) < Math.abs(best.index - charPos)) {
        best = { index: m.index, full: m[0], content: m[2] };
      }
    }
    if (!best) return res.status(404).json({ error: 'note not found' });

    const tag     = newType ? `mn.${newType}` : 'mn';
    const newMarker = `[${tag}: ${best.content}]`;
    const updated = raw.slice(0, best.index) + newMarker + raw.slice(best.index + best.full.length);

    const tmp = full + '.tmp';
    fs.writeFileSync(tmp, updated, 'utf8');
    fs.renameSync(tmp, full);
    autoCommit(rel, `Retype note to ${newType || 'note'}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reading progress
// Computed as a function so it always reflects the current VAULT, even after POST /api/vault changes it
const progressFile = () => path.join(VAULT, '_progress.json');

app.get('/api/progress', (req, res) => {
  if (!VAULT) return res.status(400).json({ error: 'No vault selected' });
  if (!fs.existsSync(progressFile())) return res.json({});
  try {
    res.json(JSON.parse(fs.readFileSync(progressFile(), 'utf8')));
  } catch { res.json({}); }
});

app.post('/api/progress', (req, res) => {
  if (!VAULT) return res.status(400).json({ error: 'No vault selected' });
  const { path: rel, scrollTop } = req.body;
  if (!rel) return res.status(400).json({ error: 'path required' });
  try {
    const data = { path: rel, scrollTop: scrollTop || 0, savedAt: Date.now() };
    fs.writeFileSync(progressFile(), JSON.stringify(data), 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Filesystem browser (for vault picker UI) ─────────────────────────────────
app.get('/api/browse', (req, res) => {
  // dir param is optional — defaults to home directory
  let dir = req.query.dir
    ? path.resolve(req.query.dir)
    : os.homedir();

  // Safety: never walk above home dir
  if (!dir.startsWith(os.homedir()) && dir !== '/') {
    dir = os.homedir();
  }

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return res.status(400).json({ error: 'Not a directory' });
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const parent = dir !== path.parse(dir).root
      ? path.dirname(dir)
      : null;

    res.json({ current: dir, parent, dirs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Open Vault Folder natively
app.get('/api/open-vault', (req, res) => {
  if (!VAULT) return res.status(400).json({ error: 'No vault selected' });
  const { exec } = require('child_process');
  
  // Detect OS and use the correct open command
  let command = '';
  if (process.platform === 'win32') command = `start "" "${VAULT}"`;
  else if (process.platform === 'darwin') command = `open "${VAULT}"`;
  else command = `xdg-open "${VAULT}"`;

  exec(command, (err) => {
    if (err) return res.status(500).json({ error: 'Failed to open folder' });
    res.json({ ok: true });
  });
});


// ── Start ─────────────────────────────────────────────────────────────────────
function getLocalIp() {
  try {
    const nets = require('os').networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) return net.address;
      }
    }
  } catch(e) {
    // Android 10+ blocks this. Ignore and return localhost.
  }
  return 'localhost';
}

// Bind to 0.0.0.0 to expose to the local WiFi network
server.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalIp();
  console.log('');
  console.log('  Manuscript server running');
  console.log(`  Vault : ${VAULT || 'Not selected'}`);
  console.log(`  Local : http://localhost:${PORT}`);
  console.log(`  WiFi  : http://${localIp}:${PORT}  <-- Access from your phone!`);
  console.log('');
});