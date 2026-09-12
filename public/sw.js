const CACHE_STATIC = 'chat-static-v4';
const CACHE_STICKERS = 'chat-stickers-v1';

const STATIC_ASSETS = [
  '/app.js',
  '/style.css',
  '/games.js',
  '/photo-editor.js',
  '/call.js',
  '/weather.js',
  '/icon.svg',
  '/doraemon.svg',
  '/sun.png',
  '/pajero.jpeg',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_STATIC);
      await cache.addAll(STATIC_ASSETS);
    } catch (_) {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k !== CACHE_STATIC && k !== CACHE_STICKERS)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;
  if (url.search) return;

  if (url.pathname.startsWith('/stickers/')) {
    if (url.pathname === '/stickers/manifest' || url.pathname === '/stickers/index.json') return;
    event.respondWith(cacheFirst(req, CACHE_STICKERS));
    return;
  }

  if (STATIC_ASSETS.indexOf(url.pathname) !== -1) {
    event.respondWith(staleWhileRevalidate(req, CACHE_STATIC));
  }
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const resp = await fetch(req);
    if (resp && resp.ok) cache.put(req, resp.clone());
    return resp;
  } catch (_) {
    return hit || Response.error();
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const fetching = fetch(req)
    .then((resp) => {
      if (resp && resp.ok) cache.put(req, resp.clone());
      return resp;
    })
    .catch(() => hit);
  return hit || fetching;
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  const title = data.title || 'Berita terkini';
  const isCall = typeof data.tag === 'string' && data.tag.startsWith('call-');
  const options = {
    body: data.body || '',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: data.tag || 'chat-message',
    renotify: true,
    requireInteraction: isCall,
    data: { url: data.url || '/' },
    vibrate: isCall ? [400, 200, 400, 200, 400] : [200, 100, 200],
  };
  event.waitUntil((async () => {
    if (!isCall) {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const active = wins.some((w) => w.visibilityState === 'visible' && w.focused);
      if (active) return;
    }
    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        try {
          const url = new URL(w.url);
          if (url.pathname === targetUrl && 'focus' in w) return w.focus();
        } catch (_) {}
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
