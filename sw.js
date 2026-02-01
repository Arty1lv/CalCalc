const CACHE_NAME = 'tinywife-v6';
const ASSETS = [
  './',
  './index.html',
  './style.css?v=17.21',
  './script.js?v=17.33',
  './sharingService.js?v=17.33',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/lz-string/1.5.0/lz-string.min.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Use cache.addAll but catch individual failures if any
      return Promise.all(
        ASSETS.map(url => {
          return cache.add(url).catch(err => console.error('Failed to cache:', url, err));
        })
      );
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cachedResponse = await cache.match(event.request);

      const networkFetch = fetch(event.request).then((networkResponse) => {
        // Cache basic (same-origin) and cors (CDN) responses
        if (networkResponse && networkResponse.status === 200 && (networkResponse.type === 'basic' || networkResponse.type === 'cors')) {
          cache.put(event.request, networkResponse.clone());
        }
        return networkResponse;
      }).catch(() => {
        // Fallback or just let it fail if no cache
      });

      return cachedResponse || networkFetch;
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notificationId = event.notification.tag; // We use tag as ID

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      if (clientList.length > 0) {
        let client = clientList[0];
        for (let i = 0; i < clientList.length; i++) {
          if (clientList[i].focused) {
            client = clientList[i];
          }
        }
        client.focus();
        client.postMessage({ 
          type: 'NOTIFICATION_CLICKED', 
          notificationId: notificationId 
        });
        return;
      }
      return clients.openWindow('./').then(newClient => {
        if (newClient) newClient.postMessage({ 
          type: 'NOTIFICATION_CLICKED', 
          notificationId: notificationId 
        });
      });
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'DISMISS_NOTIFICATION') {
    const tag = event.data.tag;
    event.waitUntil(
      self.registration.getNotifications({ tag: tag }).then(notifications => {
        notifications.forEach(n => n.close());
      })
    );
  }
});
