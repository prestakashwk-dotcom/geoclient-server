// sw.js - Service Worker: recibe notificaciones push aunque el panel esté cerrado
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = { title: 'GeoClient', body: 'Nueva alerta', url: '/admin.html#alerts' };
  try { data = Object.assign(data, event.data ? event.data.json() : {}); } catch (_) {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag || 'geoclient-alert',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      requireInteraction: true,
      vibrate: [200, 100, 200, 100, 400],
      data: { url: data.url || '/admin.html#alerts' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/admin.html#alerts';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes('/admin.html') && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
