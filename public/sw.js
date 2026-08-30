const CACHE = 'visual-sensor-studio-v0.3.1';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './settings.css',
  './camera-bootstrap.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './app/main.js',
  './app/core/math.js',
  './app/core/types.js',
  './app/sensors/camera.js',
  './app/sensors/motion.js',
  './app/sensors/gps.js',
  './app/sensors/zoom.js',
  './app/vision/frame-processing.js',
  './app/vision/frame-source.js',
  './app/vision/optical-flow.js',
  './app/vision/parallax.js',
  './app/visualization/scene.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith('visual-sensor-studio-') && key !== CACHE)
        .map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  if (url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        const response = await fetch(event.request);
        if (response.ok) await cache.put(event.request, response.clone());
        return response;
      })
    );
    return;
  }

  if (url.origin === self.location.origin) {
    // The camera path is served network-first so a stale cached copy can never
    // be the reason the camera misbehaves. A cached copy is still kept and
    // still answers when the network is gone, so offline use is unaffected.
    const networkFirst = event.request.mode === 'navigate'
      || url.pathname.endsWith('/index.html')
      || url.pathname.endsWith('/styles.css')
      || url.pathname.endsWith('/settings.css')
      || url.pathname.endsWith('/camera-bootstrap.js')
      || url.pathname.endsWith('/manifest.webmanifest')
      || url.pathname.endsWith('/app/main.js')
      || url.pathname.endsWith('/app/sensors/camera.js')
      || url.pathname.endsWith('/app/sensors/zoom.js')
      || url.pathname.endsWith('/app/vision/frame-processing.js')
      || url.pathname.endsWith('/app/vision/frame-source.js')
      || url.pathname.endsWith('/app/vision/optical-flow.js');

    if (networkFirst) {
      event.respondWith(
        fetch(event.request, { cache: 'no-store' }).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return response;
        }).catch(() => caches.match(event.request))
      );
      return;
    }

    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }))
    );
  }
});