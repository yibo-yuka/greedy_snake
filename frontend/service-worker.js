/**
 * Greedy Snake PWA — Service Worker
 * Strategy: Cache-first for static assets (offline play),
 *            Network-first for API calls (leaderboard).
 */

'use strict';

const CACHE_VER   = 'v1.2.0';
const CACHE_NAME  = `greedy-snake-${CACHE_VER}`;

const PRECACHE_URLS = [
  './',
  './index.html',
  './css/style.css',
  './js/config.js',
  './js/game.js',
  './js/api.js',
  './manifest.json',
  './assets/icons/icon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
];

// ── Install: precache all static assets ─────────
self.addEventListener('install', (event) => {
  console.log(`[SW ${CACHE_VER}] Installing…`);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        // Use { cache: 'reload' } to bypass HTTP cache during install
        return Promise.allSettled(
          PRECACHE_URLS.map(url =>
            cache.add(new Request(url, { cache: 'reload' }))
              .catch(err => console.warn('[SW] Failed to cache:', url, err))
          )
        );
      })
      .then(() => {
        console.log(`[SW ${CACHE_VER}] Precache complete`);
        return self.skipWaiting(); // Activate immediately
      })
  );
});

// ── Activate: clean up old caches ───────────────
self.addEventListener('activate', (event) => {
  console.log(`[SW ${CACHE_VER}] Activating…`);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith('greedy-snake-') && key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      ))
      .then(() => self.clients.claim()) // Take control of all clients
  );
});

// ── Fetch: routing strategy ──────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Skip non-GET
  if (req.method !== 'GET') return;

  // Network-first for API calls (future backend)
  if (url.pathname.startsWith('/api/') || url.pathname.includes('/ws/')) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Skip cross-origin (Google Fonts, etc.) — let browser handle normally
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(req));
    return;
  }

  // Cache-first for all other same-origin requests
  event.respondWith(cacheFirst(req));
});

// ── Strategies ───────────────────────────────────

/** Cache-first: serve cached, update in background */
async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) {
    // Background update (stale-while-revalidate)
    updateCache(req);
    return cached;
  }
  return networkAndCache(req);
}

/** Network-first: try network, fall back to cache */
async function networkFirst(req) {
  try {
    const response = await fetch(req);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(req);
    return cached || new Response('{"error":"offline"}', {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/** Fetch from network and store in cache */
async function networkAndCache(req) {
  const response = await fetch(req);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(req, response.clone());
  }
  return response;
}

/** Background cache update without blocking */
function updateCache(req) {
  fetch(req).then(response => {
    if (response.ok) {
      caches.open(CACHE_NAME).then(cache => cache.put(req, response));
    }
  }).catch(() => { /* Silently ignore network errors */ });
}

// ── Message Handler ──────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: CACHE_VER });
  }
});
