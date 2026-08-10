const CACHE_VERSION = 'sos-shell-v1';
const CORE_SHELL = ['/', '/report/', '/manifest.webmanifest', '/sos-icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(CORE_SHELL))
      .catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function isCacheableResponse(response) {
  return response && response.ok && response.type !== 'opaque';
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Nunca cachear respuestas API ni recursos de terceros. La PWA solo conserva el shell público.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (isCacheableResponse(response)) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(async () => {
          return (
            (await caches.match(request)) ||
            (url.pathname.startsWith('/report') ? await caches.match('/report/') : undefined) ||
            (await caches.match('/')) ||
            new Response('Sin conexión. Abre nuevamente SOS Eje Cafetero cuando recuperes el shell.', {
              status: 503,
              headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            })
          );
        }),
    );
    return;
  }

  if (['script', 'style', 'font', 'image', 'manifest'].includes(request.destination)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (isCacheableResponse(response)) {
              const clone = response.clone();
              caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
            }
            return response;
          })
          .catch(() => cached);
        return cached || network;
      }),
    );
  }
});

self.addEventListener('sync', (event) => {
  if (event.tag !== 'sos-outbox') return;
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => clients.forEach((client) => client.postMessage({ type: 'SOS_SYNC_REQUEST' }))),
  );
});
