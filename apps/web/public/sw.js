const CACHE_VERSION = 'sos-shell-v2';
const CORE_SHELL = ['/', '/report/', '/relay/', '/manifest.webmanifest', '/sos-icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(CORE_SHELL)).catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
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
  // Boundary de seguridad: Cache Storage solo puede contener shell público.
  // Nunca se cachean API, crypto-config, receipts, OTP, identidad, evidencia ni endpoints de mando.
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
          if (url.pathname.startsWith('/report')) return (await caches.match('/report/')) || (await caches.match('/'));
          if (url.pathname.startsWith('/relay')) return (await caches.match('/relay/')) || (await caches.match('/'));
          return (await caches.match(request)) || (await caches.match('/')) || new Response('Sin conexión.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
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
  // El SW no accede al plaintext ni implementa crypto por su cuenta. Solicita a una
  // ventana activa que ejecute el mismo pipeline SecureEnvelope versionado.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => clients.forEach((client) => client.postMessage({ type: 'SOS_SYNC_REQUEST' }))),
  );
});
