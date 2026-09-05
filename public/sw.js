const CACHE = 'visual-sensor-studio-v0.83.0';

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

/*
 * AN UPDATE LANDS ON NEXT LAUNCH, NOT MID-SESSION.
 *
 * This file used to call skipWaiting() on install and clients.claim() on
 * activate, and that combination bricked the running app three times
 * (2026-09-03, v0.63.0, and again on 2026-09-04). Every time: all buttons
 * dead, camera unstartable, cleared by a full quit and never by a code
 * change. On the v0.63.0 occasion the build was loaded in a real browser and
 * was completely clean, which is what ruled the code out.
 *
 * WHAT THOSE TWO CALLS DID. skipWaiting() activates a new worker while the
 * old page is still running; clients.claim() then hands that page to it; and
 * activate deletes every older cache. So a page mid-session lost the cache
 * its modules came from and began re-fetching against a newer deploy. While
 * GitHub Pages is half-propagated it gets some modules new and keeps others
 * old — a fresh app.js against stale siblings, which is a dead app. Joshua
 * named the window himself: "must be a slight update lag."
 *
 * THE TRADE, and it is a real one. Without these, a new version waits until
 * every tab of the installed app is closed. An app that is never fully quit
 * stays a build behind. That was the reason the calls were here, and it is
 * the wrong side of the trade for this project: Joshua force-quits after
 * every push already, and a dead app costs far more than a late one.
 *
 * The message handler below is DELIBERATELY KEPT. It is the same
 * skipWaiting, but user-initiated: Settings' "update now" posts it and
 * reloads on controllerchange, so the page that gets swapped is one that is
 * about to be replaced anyway. That is the safe shape of this operation —
 * asked for, and immediately followed by a reload.
 */
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', (event) => {
  // Safe to delete older caches HERE precisely because there is no
  // clients.claim above: this worker only becomes active once no page is
  // still being served by the old one, so nothing can lose the cache it is
  // reading from.
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith('visual-sensor-studio-') && key !== CACHE)
        .map((key) => caches.delete(key))
    ))
  );
});

self.addEventListener('message', (event) => {
  // User-initiated activation, followed by a reload on the page's side.
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