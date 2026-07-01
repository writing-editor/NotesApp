// AppCode/mobile-sw.js
import FS from '@isomorphic-git/lightning-fs';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';

// Initialize Virtual File System
const fs = new FS('manuscript-fs');
const pfs = fs.promises;
const GIT_ROOT = '/MyWritings';
const VAULT = `${GIT_ROOT}/book`;

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
    // 1. Git Clone (First time setup)
    if (path === '/api/git/clone' && method === 'POST') {
      const { remoteUrl, token } = await req.json();
      await pfs.mkdir(GIT_ROOT).catch(() => {}); // Ensure root exists
      
      await git.clone({
        fs, http, dir: GIT_ROOT, url: remoteUrl,
        corsProxy: 'https://cors.isomorphic-git.org', // Capacitor bypasses CORS, but git requires this string
        onAuth: () => ({ username: token, password: 'x-oauth-basic' }),
        singleBranch: true, depth: 1
      });
      return jsonResponse({ ok: true, vault: VAULT });
    }

    // 2. Fetch Manifest
    if (path === '/api/manifest' && method === 'GET') {
      const manifest = { title: 'Manuscript', author: '', description: '', sections: [] };
      
      const readSection = async (subdir) => {
        try {
          const files = await pfs.readdir(`${VAULT}/${subdir}`);
          return files.filter(f => f.endsWith('.md') && !f.startsWith('_')).map(f => ({
            label: f.replace(/^\d+-/, '').replace(/\.md$/, '').replace(/-/g, ' '),
            path: `${subdir}/${f}`
          }));
        } catch { return []; }
      };

      manifest.sections.push({ label: 'Front Matter', files: await readSection('front') });
      manifest.sections.push({ label: 'Chapters', files: await readSection('chapters') });
      return jsonResponse(manifest);
    }

    // 3. Read Chapter
    if (path === '/api/chapter' && method === 'GET') {
      const relPath = url.searchParams.get('path');
      const raw = await pfs.readFile(`${VAULT}/${relPath}`, 'utf8');
      
      // Simple parse for mobile (you can import marked/parseMd here if needed)
      return jsonResponse({ bodyHtml: `<p>${raw}</p>`, notes: [], path: relPath, words: raw.split(' ').length, chars: raw.length });
    }

    // 4. Save Block Edit
    if (path === '/api/block' && method === 'PUT') {
      const { path: relPath, start, end, text } = await req.json();
      const fullPath = `${VAULT}/${relPath}`;
      const raw = await pfs.readFile(fullPath, 'utf8');
      
      const updated = raw.slice(0, start) + text.trimEnd() + raw.slice(end);
      await pfs.writeFile(fullPath, updated, 'utf8');
      
      // Auto-commit
      await git.add({ fs, dir: GIT_ROOT, filepath: `book/${relPath}` });
      await git.commit({ fs, dir: GIT_ROOT, author: { name: 'Mobile' }, message: 'Edit paragraph' });

      // Notify UI via BroadcastChannel instead of WebSockets
      new BroadcastChannel('manuscript-events').postMessage({ type: 'file-changed', path: relPath });
      
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: 'Route not implemented on mobile yet' }, 404);
  } catch (error) {
    return jsonResponse({ error: error.message }, 500);
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}