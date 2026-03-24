// ============================================================
// DIGITALE SOLUTION — Service Worker PWA v5
// Offline-First : Cache statique + Network-First API + Sync Queue
// ============================================================

const SW_VERSION   = 'ds-v5';
const CACHE_STATIC = SW_VERSION + '-static';
const CACHE_API    = SW_VERSION + '-api';
const CACHE_QUEUE  = SW_VERSION + '-queue';
const API_CACHE_TTL = 5 * 60 * 1000; // 5 min

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:ital,wght@0,300;0,400;0,500;1,300&display=swap',
];

// ── INSTALL ──────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Install', SW_VERSION);
  event.waitUntil(
    caches.open(CACHE_STATIC)
      .then(cache => Promise.allSettled(
        STATIC_ASSETS.map(u => cache.add(u).catch(e => console.warn('[SW] Cache miss:', u)))
      ))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ─────────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activate', SW_VERSION);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('ds-') && k !== CACHE_STATIC && k !== CACHE_API && k !== CACHE_QUEUE)
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH ─────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // API → Network-First + cache fallback offline
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Fonts Google → Cache-First
  if (url.hostname.includes('fonts.goog') || url.hostname.includes('fonts.gstat')) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // App shell & assets locaux → Stale-While-Revalidate
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }
});

// ── STRATEGIES ───────────────────────────────────────────────

async function cacheFirst(req) {
  const cache  = await caches.open(CACHE_STATIC);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch(e) {
    return new Response('Offline', { status: 503 });
  }
}

async function staleWhileRevalidate(req) {
  const cache  = await caches.open(CACHE_STATIC);
  const cached = await cache.match(req);

  const update = fetch(req).then(res => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);

  if (cached) {
    update; // background update, don't await
    return cached;
  }

  const fresh = await update;
  if (fresh) return fresh;

  // Navigation fallback → serve index.html
  if (req.mode === 'navigate') {
    const fallback = await cache.match('/index.html') || await cache.match('/');
    if (fallback) return fallback;
  }

  return new Response(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Hors ligne</title></head><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0F0E0D;color:#F0EDE8;text-align:center"><div><div style="font-size:3rem">📡</div><h2>Mode hors ligne</h2><p>Reconnectez-vous à Internet pour continuer.</p><p style="font-size:.85rem;opacity:.5">Vos données locales sont preservees.</p></div></body></html>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(CACHE_API);
      const body  = await res.clone().json().catch(() => null);
      const h     = new Headers(res.headers);
      h.set('sw-cached-at', Date.now().toString());
      cache.put(req, new Response(JSON.stringify(body), { status: res.status, headers: h }));
    }
    return res;
  } catch(e) {
    const cache  = await caches.open(CACHE_API);
    const cached = await cache.match(req);
    if (cached) {
      const age = Date.now() - parseInt(cached.headers.get('sw-cached-at') || '0');
      if (age < API_CACHE_TTL) return cached;
    }
    return new Response(
      JSON.stringify({ success: false, offline: true, error: 'Hors ligne' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ── BACKGROUND SYNC ──────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'ds-sync-queue') {
    console.log('[SW] Background Sync triggered');
    event.waitUntil(processSyncQueue());
  }
});

async function processSyncQueue() {
  const qCache = await caches.open(CACHE_QUEUE);
  const qResp  = await qCache.match('/_queue');
  if (!qResp) {
    notifyClients({ type: 'SYNC_COMPLETE', synced: 0, pending: 0 });
    return;
  }

  let queue = [];
  try { queue = await qResp.json(); } catch(e) { return; }
  if (!queue.length) {
    notifyClients({ type: 'SYNC_COMPLETE', synced: 0, pending: 0 });
    return;
  }

  console.log('[SW] Processing', queue.length, 'queued item(s)');
  const synced = [], failed = [];

  for (const item of queue) {
    try {
      const res = await fetch(item.url, {
        method:  item.method || 'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(item.body)
      });
      if (res.ok) synced.push(item.id);
      else        failed.push(item);
    } catch(e) {
      failed.push(item);
    }
  }

  if (failed.length) {
    await qCache.put('/_queue',
      new Response(JSON.stringify(failed), { headers: { 'Content-Type': 'application/json' } })
    );
  } else {
    await qCache.delete('/_queue');
  }

  notifyClients({ type: 'SYNC_COMPLETE', synced: synced.length, pending: failed.length });
  console.log('[SW] Sync done — synced:', synced.length, 'pending:', failed.length);
}

// ── MESSAGES ─────────────────────────────────────────────────
self.addEventListener('message', event => {
  const msg = event.data || {};

  if (msg.type === 'FORCE_SYNC') {
    processSyncQueue();
  }

  if (msg.type === 'SAVE_QUEUE') {
    caches.open(CACHE_QUEUE).then(c =>
      c.put('/_queue', new Response(JSON.stringify(msg.data || []), {
        headers: { 'Content-Type': 'application/json' }
      }))
    );
  }

  if (msg.type === 'GET_QUEUE_SIZE') {
    caches.open(CACHE_QUEUE).then(async c => {
      const r = await c.match('/_queue');
      let size = 0;
      if (r) { try { size = (await r.json()).length; } catch(e) {} }
      event.source.postMessage({ type: 'QUEUE_SIZE', size });
    });
  }

  if (msg.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── NOTIFICATIONS PUSH ────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch(e) { return; }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Digitale Solution', {
      body:    data.body || '',
      icon:    '/icon-192.png',
      badge:   '/icon-192.png',
      tag:     data.tag  || 'ds',
      data:    data.url  || '/',
      vibrate: [100, 50, 100],
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data || '/'));
});

// ── HELPERS ──────────────────────────────────────────────────
async function notifyClients(msg) {
  const all = await self.clients.matchAll({ includeUncontrolled: true });
  all.forEach(c => c.postMessage(msg));
}

console.log('[SW] Digitale Solution SW', SW_VERSION, 'loaded');
