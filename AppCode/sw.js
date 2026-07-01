// sw.js — Manuscript Service Worker
// Strategy:
//   Static assets  → Cache-first (versioned cache, update on new deploy)
//   API reads      → Network-first with stale cache fallback
//   API writes     → Online: pass through; Offline: queue in IndexedDB, replay on reconnect

'use strict';

const CACHE_VERSION = 'manuscript-v1';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/client.js',
  // Google Fonts are cached on first fetch via the network-first handler below
];

// ── Install: pre-cache static shell ──────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: purge old cache versions ───────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_VERSION)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: route by request type ─────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) {
    // For Google Fonts and other external assets: cache-first
    event.respondWith(cacheFirst(request));
    return;
  }

  // API write mutations — queue offline
  if (url.pathname.startsWith('/api/') && isMutatingMethod(request.method)) {
    event.respondWith(handleApiWrite(request));
    return;
  }

  // API reads — network-first with cached fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Static assets — cache-first
  event.respondWith(cacheFirst(request));
});

function isMutatingMethod(method) {
  return ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method.toUpperCase());
}

// ── Cache strategies ──────────────────────────────────────────────────────────

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ error: 'offline', cached: false }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ── Offline write queue ───────────────────────────────────────────────────────
// Writes that happen while offline are queued in IndexedDB.
// When the SW comes back online it replays them in order.

const DB_NAME    = 'manuscript-queue';
const DB_VERSION = 1;
const STORE_NAME = 'writes';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function enqueueWrite(entry) {
  const db    = await openDb();
  const tx    = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  return new Promise((resolve, reject) => {
    const req = store.add(entry);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function dequeueAll() {
  const db    = await openDb();
  const tx    = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const items = req.result;
      store.clear();
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
}

async function handleApiWrite(request) {
  // Clone body before any attempt — body can only be read once
  const bodyText = await request.text();

  try {
    // Try the live network first
    const response = await fetch(new Request(request, { body: bodyText }));
    return response;
  } catch {
    // Offline — queue it for later replay
    await enqueueWrite({
      url:     request.url,
      method:  request.method,
      headers: [...request.headers.entries()],
      body:    bodyText,
      queuedAt: Date.now(),
    });

    // Return an optimistic OK so the UI doesn't show an error
    return new Response(
      JSON.stringify({ ok: true, queued: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ── Replay queue on reconnect ─────────────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'replay-writes') {
    event.waitUntil(replayQueue());
  }
});

// Also replay when the SW receives a message from the client
self.addEventListener('message', event => {
  if (event.data?.type === 'REPLAY_QUEUE') {
    replayQueue().then(() => {
      // Notify all clients that a replay happened so they can refresh
      self.clients.matchAll().then(clients =>
        clients.forEach(c => c.postMessage({ type: 'QUEUE_REPLAYED' }))
      );
    });
  }
});

async function replayQueue() {
  let items;
  try {
    items = await dequeueAll();
  } catch {
    return;
  }
  if (!items.length) return;

  for (const item of items) {
    try {
      const headers = Object.fromEntries(item.headers);
      await fetch(item.url, {
        method:  item.method,
        headers,
        body:    item.body,
      });
    } catch {
      // If replay fails (still offline), re-queue this item
      await enqueueWrite(item).catch(() => {});
      break; // stop replaying — still offline
    }
  }
}