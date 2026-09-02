/**
 * The installed app's update path.
 *
 * This exists because promoting V2 to the root document made it the thing
 * people INSTALL, and an installed app is a different animal from a tab. A
 * tab is opened fresh; a standalone iOS app is resumed, and iOS can keep one
 * suspended for days. Without a deliberate check, a home-screen icon sits on
 * whatever build it was installed with and nothing ever says so — which is
 * the worst possible state to test a camera in, because every fix appears to
 * have failed.
 *
 * V1 solved this in src/main.ts. This is not a copy of that code: it is the
 * same three-part contract restated for a module that owns nothing else.
 *
 *   1. REGISTER, so there is a worker to update at all.
 *   2. CHECK ON RESUME, throttled, because a standalone app comes back to the
 *      foreground far more often than it launches.
 *   3. NEVER THROW. Offline is the normal case for a camera app carried
 *      outdoors, and an update check that surfaces as an error would report a
 *      fault where there is none.
 *
 * The worker itself is network-first for navigations and modules (see sw.js),
 * so a cache can never pin the build — this only makes sure the NEXT resume
 * notices.
 */

/** Resuming repeatedly inside a minute is one return, not several checks. */
const CHECK_INTERVAL_MS = 60_000;

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  // Registration waits for load: a camera app's first job is the camera, and
  // the worker install would otherwise compete with getUserMedia for the one
  // thing that matters in the first second.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // A refused registration (private browsing, an unsupported context) is
      // not a fault worth reporting: everything except offline still works.
    });
  });
  watchForUpdatesOnResume();
}

function watchForUpdatesOnResume(): void {
  let lastCheck = 0;
  const check = (): void => {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - lastCheck < CHECK_INTERVAL_MS) return;
    lastCheck = now;
    void navigator.serviceWorker.getRegistration()
      .then((registration) => registration?.update())
      .catch(() => {
        // Offline, or the registration is gone. Neither is worth reporting:
        // the app keeps working from cache either way.
      });
  };
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
}
