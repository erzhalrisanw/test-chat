self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  const title = data.title || 'New message';
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
  event.waitUntil(self.registration.showNotification(title, options));
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
