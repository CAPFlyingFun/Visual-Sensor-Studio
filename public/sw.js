const CACHE = 'visual-sensor-studio-v0.1.1';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
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
  './app/vision/frame-processing.js',
  './app/vision/parallax.js',
  './app/visualization/scene.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
  );
  self.clients.claim();
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
    const networkFirst = event.request.mode === 'navigate'
      || url.pathname.endsWith('/index.html')
      || url.pathname.endsWith('/styles.css')
      || url.pathname.endsWith('/app/main.js')
      || url.pathname.endsWith('/app/sensors/camera.js');

    if (networkFirst) {
      event.respondWith(
        fetch(event.request).then((response) => {
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
