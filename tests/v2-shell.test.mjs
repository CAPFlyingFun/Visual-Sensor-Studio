import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { NAV_ROUTES, routeById } from '../.test-build/v2/routes.js';
import { frameSize, readState, subscribe, updateState } from '../.test-build/v2/state.js';

const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const v2Html = readFileSync(new URL('../public/v2.html', import.meta.url), 'utf8');
const appTs = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');
const stateTs = readFileSync(new URL('../src/v2/state.ts', import.meta.url), 'utf8');

/* --- Routing ------------------------------------------------------------- */

test('the V2 router is the first script and inert without the parameter', () => {
  // Legacy behaviour must be unchanged when scene=v2 is absent. The router's
  // only act is a guarded location.replace, and it must run before anything
  // legacy can begin to boot.
  const router = indexHtml.indexOf("get('scene') === 'v2'");
  assert.ok(router > 0, 'index.html must carry the scene=v2 check');
  const firstOtherScript = indexHtml.indexOf('<script', indexHtml.indexOf('</script>', router));
  assert.ok(indexHtml.indexOf('<script') < router, 'the router lives in a script tag');
  const beforeRouter = indexHtml.slice(0, router);
  assert.ok(!/<script[^>]*src=/.test(beforeRouter), 'no external script may load before the router');
  assert.match(indexHtml, /location\.replace\('\.\/v2\.html' \+ location\.search \+ location\.hash\)/);
  assert.ok(firstOtherScript > 0);
});

test('V2 is its own document sharing only the camera engine', () => {
  assert.match(v2Html, /id="cameraVideo"/, 'the engine finds #cameraVideo by id');
  const bootstrap = v2Html.indexOf('src="./camera-bootstrap.js"');
  const module = v2Html.indexOf('src="./app/v2/app.js"');
  assert.ok(bootstrap > 0 && module > bootstrap,
    'the engine must load before the V2 module that bridges to it');
  assert.ok(!/styles\.css|settings\.css|app\/main\.js/.test(v2Html),
    'V2 must not pull the legacy bundle or stylesheets in');
  assert.match(v2Html, /V2 · Experimental/, 'the badge that stops a cached legacy build passing as V2');
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
  for (const route of NAV_ROUTES.slice(1)) {
    assert.equal(route.implemented, false, `${route.id} is not built in Milestone A`);
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
  const fn = appTs.match(/function previewBoxShortSide\(\): number \{[^]*?\n\}/);
  assert.ok(fn, 'the one display read lives in previewBoxShortSide()');
  assert.match(fn[0], /getBoundingClientRect/);
  const outside = appTs.replace(fn[0], '');
  assert.ok(!/getBoundingClientRect|innerWidth|innerHeight|devicePixelRatio/.test(outside),
    'previewBoxShortSide() is the only place V2 may read the display');
  assert.match(appTs, /previewBoxShortSide: previewBoxShortSide\(\)/,
    'and its only consumer is the geometry authority');
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
