/**
 * The build stamp the app shows.
 *
 * It is visible on purpose, and it earns its place on an INSTALLED app. A
 * home-screen icon is resumed rather than launched, iOS can hold one
 * suspended for days, and a service worker updates quietly — so "did my fix
 * actually reach the phone?" is otherwise unanswerable from the device. The
 * badge answers it, and says whether it is running standalone or in a tab,
 * because those two can be different builds at the same moment.
 *
 * Bump this with package.json, public/sw.js's CACHE and src/main.ts's
 * APP_VERSION; tests/pwa-parity.test.mjs holds them to the same value.
 */
export const APP_VERSION = '0.40.6';
