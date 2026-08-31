const CACHE = 'visual-sensor-studio-v0.27.0';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './settings.css',
  './camera-bootstrap.js',
  './manifest.webmanifest',
  // The shipped lens gallery, so custom lenses work offline too.
  './lenses/index.json',
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
  './app/vision/frame-rate.js',
  './app/vision/adaptive.js',
  './app/vision/tracking.js',
  './app/vision/integration.js',
  './app/vision/histogram.js',
  './app/vision/overlays.js',
  './app/sensors/stability.js',
  './app/vision/parallax.js',
  './app/vision/lens.js',
  './app/vision/lens-store.js',
  './app/vision/lens-preview.js',
  './app/vision/photo-lens.js',
  './app/vision/aspect.js',
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
    // Every compiled module is network-first, not an enumerated list of them.
    // The list went stale the moment new modules were added, so a fresh
    // main.js could run against a cached older module — which showed up as a
    // diagnostics row reading empty because the field it wanted did not exist
    // in the version actually loaded. Mixed module versions are much worse
    // than a slightly larger network-first set.
    const networkFirst = event.request.mode === 'navigate'
      || url.pathname.includes('/app/')
      || url.pathname.endsWith('/index.html')
      || url.pathname.endsWith('/styles.css')
      || url.pathname.endsWith('/settings.css')
      || url.pathname.endsWith('/camera-bootstrap.js')
      || url.pathname.endsWith('/manifest.webmanifest');

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