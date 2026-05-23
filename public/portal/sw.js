// Minimal service worker — required for PWA installability.
// No caching strategy for v1 (keeps data fresh from server).
const CACHE = 'cf-portal-v1';

self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(self.clients.claim()));

// Pass all fetches through to the network.
// Add offline caching here in a future version if needed.
self.addEventListener('fetch', e => {
  e.respondWith(fetch(e.request).catch(() =>
    caches.match(e.request)
  ));
});
