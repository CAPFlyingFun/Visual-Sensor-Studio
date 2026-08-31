import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const swSource = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

test('the viewer states the stream size and the build it is running', () => {
  // The same app installed and in the browser can negotiate different camera
  // modes AND be running different builds. Telling those apart used to mean
  // digging through two menus on two containers.
  assert.match(mainSource, /viewerStats/);
  assert.match(mainSource, /diagnostics\.videoWidth}×\$\{diagnostics\.videoHeight\}/);
  assert.match(mainSource, /v\$\{APP_VERSION\}\$\{isStandalone\(\) \? ' PWA' : ''\}/);
});

test('an installed app checks for a new build when it comes back', () => {
  // A standalone app is resumed far more often than launched and iOS can keep
  // one suspended for days. The worker claims clients as soon as it activates,
  // but only once something has fetched it.
  assert.match(mainSource, /function watchForUpdatesOnResume/);
  assert.match(mainSource, /document\.addEventListener\('visibilitychange', check\)/);
  assert.match(mainSource, /registration\?\.update\(\)/);
  assert.match(mainSource, /watchForUpdatesOnResume\(\);/);
});

test('the resume check is throttled and never throws', () => {
  const fn = mainSource.slice(
    mainSource.indexOf('function watchForUpdatesOnResume'),
    mainSource.indexOf('function watchForRotation')
  );
  assert.match(fn, /now - lastCheck < 60_000/, 'resuming repeatedly is one return');
  assert.match(fn, /document\.visibilityState !== 'visible'/);
  assert.match(fn, /\.catch\(/, 'offline must not surface as an error');
});

test('a new worker takes over without waiting for every tab to close', () => {
  // Without both of these an update sits waiting behind an installed app that
  // is never fully quit, which is exactly how a PWA drifts a build behind.
  assert.match(swSource, /self\.skipWaiting\(\)/);
  assert.match(swSource, /self\.clients\.claim\(\)/);
});

test('the app shell is served network-first so a cache cannot pin the build', () => {
  const handler = swSource.slice(swSource.indexOf("addEventListener('fetch'"));
  assert.match(handler, /event\.request\.mode === 'navigate'/);
  assert.match(handler, /url\.pathname\.includes\('\/app\/'\)/);
  assert.match(handler, /camera-bootstrap\.js/);
  // Still answers from cache when the network is gone.
  assert.match(handler, /\.catch\(\(\) => caches\.match\(event\.request\)\)/);
});
