import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { NAV_ROUTES, routeById } from '../.test-build/v2/routes.js';
import { frameSize, readState, subscribe, updateState } from '../.test-build/v2/state.js';

const indexHtml = readFileSync(new URL('../public/legacy.html', import.meta.url), 'utf8');
const v2Html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const appTs = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');
const stateTs = readFileSync(new URL('../src/v2/state.ts', import.meta.url), 'utf8');

/* --- Routing ------------------------------------------------------------- */

test('the app is the root document and Version 1 redirects nowhere', () => {
  // The relationship inverted when V2 was promoted (2026-09-02). V1 used to
  // own index.html and hand ?scene=v2 visits away; now the app IS index.html
  // and V1 is a page you reach deliberately. The old redirect must be GONE
  // from V1, or opening the reference page would bounce straight back out.
  assert.ok(!indexHtml.includes("get('scene') === 'v2'"),
    'Version 1 no longer routes anywhere');
  assert.ok(!indexHtml.includes("location.replace('./v2.html'"),
    'and its redirect is removed, not merely disabled');
  assert.match(v2Html, /id="v2Viewfinder"/, 'the root document is the camera app');
  // Nothing in the app links to Version 1: that page cannot get back here, so
  // a link to it strands whoever follows it.
  assert.ok(!v2Html.includes('v2LegacyLink'), 'no one-way door out of the app');
  assert.ok(!/href="\.\/legacy\.html"/.test(v2Html), 'and no link in the chrome either');
  assert.match(indexHtml, /Back to Visual Sensor Studio/,
    'Version 1 carries a way back for anyone who arrives by address');
});

test('the root document carries the PWA layer it needs to be installed', () => {
  // Promoting this page made it the thing people INSTALL, and none of this
  // was here before: V1 owned the manifest link, the iOS meta tags and the
  // service-worker registration. Installed without them, iOS gives a browser
  // window with no offline support and — the one that matters on a phone —
  // no way to ever notice a new build.
  assert.match(v2Html, /<link rel="manifest" href="\.\/manifest\.webmanifest"/);
  assert.match(v2Html, /name="apple-mobile-web-app-capable" content="yes"/,
    'iOS ignores the manifest display mode without this');
  assert.match(v2Html, /rel="apple-touch-icon"/);
  assert.match(appTs, /registerServiceWorker\(\);/, 'the app registers the worker at boot');

  const pwaTs = readFileSync(new URL('../src/v2/pwa.ts', import.meta.url), 'utf8');
  assert.match(pwaTs, /navigator\.serviceWorker\.register\('\.\/sw\.js'\)/);
  // Resumed far more often than launched, so the check rides visibility.
  assert.match(pwaTs, /document\.addEventListener\('visibilitychange', check\)/);
  assert.match(pwaTs, /registration\?\.update\(\)/);
  assert.match(pwaTs, /now - lastCheck < CHECK_INTERVAL_MS/, 'throttled');
  assert.match(pwaTs, /\.catch\(/, 'offline must never surface as an error');
});

test('V2 is its own document sharing only the camera engine', () => {
  assert.match(v2Html, /id="cameraVideo"/, 'the engine finds #cameraVideo by id');
  const bootstrap = v2Html.indexOf('src="./camera-bootstrap.js"');
  const module = v2Html.indexOf('src="./app/v2/app.js"');
  assert.ok(bootstrap > 0 && module > bootstrap,
    'the engine must load before the V2 module that bridges to it');
  assert.ok(!/styles\.css|settings\.css|app\/main\.js/.test(v2Html),
    'V2 must not pull the legacy bundle or stylesheets in');
  // The badge became a BUILD STAMP when this page was promoted: on an
  // installed app, "did my fix reach the phone?" has no other answer.
  const versionTs = readFileSync(new URL('../src/v2/version.ts', import.meta.url), 'utf8');
  const version = /APP_VERSION = '([^']+)'/.exec(versionTs)?.[1] ?? '';
  assert.ok(version.length > 0, 'the app carries a version');
  assert.match(appTs, /setText\('v2Badge', `v\$\{APP_VERSION\}\$\{isStandalone\(\) \? ' · PWA' : ''\}`\)/,
    'the badge shows the build and whether it is the installed app');
});

test('V2 code never touches getUserMedia', () => {
  // A non-negotiable inherited from real iPhone failures: acquisition lives in
  // the persistent engine alone.
  for (const source of [appTs, stateTs]) {
    // The word may appear in a comment explaining exactly this rule; a CALL
    // may not.
    assert.ok(!/getUserMedia\s*\(/.test(source), 'V2 modules must go through CameraController');
    assert.ok(!/navigator\.mediaDevices/.test(source), 'acquisition lives in the engine alone');
  }
});

/* --- The single sticky element ------------------------------------------- */

test('only the viewfinder is sticky', () => {
  const sticky = [...v2Html.matchAll(/([.#][\w-]+)[^{}]*\{[^}]*position:\s*sticky/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(sticky)], ['.viewfinder-wrap'],
    `only .viewfinder-wrap may be sticky, found: ${sticky.join(', ')}`);
  // And the guards v1 paid to learn.
  assert.match(v2Html, /text-size-adjust: 100%/);
  assert.match(v2Html, /overflow-x: clip/);
});

/* --- The registry drives the dock ---------------------------------------- */

test('the dock is generated from NAV_ROUTES, not written twice', () => {
  assert.equal(NAV_ROUTES.length, 5);
  assert.equal(NAV_ROUTES[0].id, 'camera');
  assert.equal(NAV_ROUTES[0].implemented, true);
  assert.equal(new Set(NAV_ROUTES.map((r) => r.id)).size, 5, 'route ids must be unique');
  // More is the settings & diagnostics home (Joshua, 2026-09-01: instruments
  // off the main screen); the other three remain honest placeholders.
  assert.equal(routeById('more')?.implemented, true);
  for (const route of NAV_ROUTES.slice(1, 4)) {
    assert.equal(route.implemented, false, `${route.id} is not built yet`);
    assert.ok(route.plan.length > 0, `${route.id} needs an honest placeholder plan`);
  }
  assert.equal(routeById('camera')?.label, 'Camera');
  assert.equal(routeById('nope'), null);

  // The HTML carries an empty dock; the registry fills it. A second hard-coded
  // list of the same buttons is exactly what Rule 5 forbids.
  assert.match(v2Html, /<nav class="dock" id="v2Dock"[^>]*><\/nav>/);
  assert.match(appTs, /for \(const route of NAV_ROUTES\)/);
});

/* --- One owner for the shared numbers ------------------------------------ */

test('the state store is the one owner, and flow is one-directional', () => {
  const seen = [];
  const unsubscribe = subscribe((state) => seen.push(state.deliveredFps));
  updateState({ deliveredFps: 24.5 });
  assert.equal(readState().deliveredFps, 24.5);
  assert.deepEqual(seen, [0, 24.5], 'subscribers see the initial state, then the update');
  unsubscribe();
  updateState({ deliveredFps: 30 });
  assert.equal(seen.length, 2, 'an unsubscribed listener hears nothing');

  // SOURCE is read from the stream, never from layout. Milestone B adds ONE
  // sanctioned layout read — previewBoxShortSide(), the display fact that
  // feeds the geometry authority's PREVIEW row — and nothing else in V2 may
  // measure the display, so no second module can grow a size opinion.
  const fn = appTs.match(/function measureViewfinder\(\)[^]*?\n\}/);
  assert.ok(fn, 'the one display read lives in measureViewfinder()');
  assert.match(fn[0], /getBoundingClientRect/);
  const outside = appTs.replace(fn[0], '');
  assert.ok(!/getBoundingClientRect|innerWidth|innerHeight|devicePixelRatio/.test(outside),
    'measureViewfinder() is the only place V2 may read the display');
  assert.match(appTs, /previewBoxShortSide: viewfinder\.shortSide/,
    'and it feeds the geometry authority');
  const streamReads = appTs.match(/frameSize\(d\.videoWidth, d\.videoHeight\)/g) ?? [];
  assert.ok(streamReads.length >= 2,
    'both the status and delivery paths read SOURCE from the stream diagnostics');
});

test('frameSize keeps the convention and refuses nonsense', () => {
  assert.deepEqual(frameSize(1920, 1440), { width: 1920, height: 1440, aspect: 4 / 3 });
  const portrait = frameSize(1440, 1920);
  assert.ok(portrait.aspect < 1, 'aspect is width over height — below 1 in portrait');
  assert.equal(frameSize(0, 1080), null);
  assert.equal(frameSize(640, 0), null);
});

test('delivered FPS is measured from presented frames, not the track claim', () => {
  assert.match(appTs, /startFrameDelivery/);
  assert.match(appTs, /meter\.recordDelivered\(frame\)/);
  assert.ok(!/frameRateInfo\.reported/.test(appTs),
    'the track claim is an intention, not a measurement');
});
