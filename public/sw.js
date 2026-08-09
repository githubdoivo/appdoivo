// Service worker: receives push and shows notifications; opens the app on click.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Notificacao', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'appdoivo';
  const options = {
    body: data.body || '',
    tag: data.tag || 'app',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      const client = clients[0];
      if (!client) return self.clients.openWindow(url);
      // Take the user straight to the result being announced, not just
      // whatever page the app happened to be left open on. navigate() is
      // the "real" way to do this, but iOS Safari often silently refuses
      // it when the PWA is already open in the foreground - postMessage
      // is the reliable fallback (the page applies the deep link itself,
      // see the message listener in app.js), so it's sent regardless of
      // whether navigate() below appears to succeed.
      client.postMessage({ type: 'deep-link', url });
      if ('navigate' in client) {
        try {
          await client.navigate(url);
        } catch {
          // Navigate can be refused in some states; postMessage above
          // already covers it, and focusing is still better than nothing.
        }
      }
      return 'focus' in client ? client.focus() : undefined;
    })
  );
});
