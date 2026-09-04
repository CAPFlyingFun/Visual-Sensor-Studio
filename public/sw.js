const CACHE = 'visual-sensor-studio-v0.53.0';

/*
 * THE SHELL IS SHORT ON PURPOSE, and it is a different list from the one V1
 * carried here.
 *
 * Two lessons are built into its shortness. First, cache.addAll REJECTS THE
 * WHOLE INSTALL if a single entry 404s, so every extra name is another way
 * for the service worker to fail to install at all — silently, on a phone,
 * where the only symptom is that nothing ever updates. Second, this file used
 * to enumerate every compiled module, that list went stale the moment new
 * ones were added, and a fresh app.js ran against a cached older module.
 *
 * So the shell holds only what must exist for a cold start, and every module
 * under /app/ is fetched network-first and cached as it is used (see the
 * fetch handler). After one online visit the app is fully offline-capable,
 * and no list can drift out of step with the build.
 *
 * tests/pwa-parity.test.mjs asserts every entry here exists on disk.
 */
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './camera-bootstrap.js',
  // The shipped lens gallery, so custom lenses work offline too.
  './lenses/index.json',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  // The one entry module. Everything it imports arrives network-first.
  './app/v2/app.js'
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