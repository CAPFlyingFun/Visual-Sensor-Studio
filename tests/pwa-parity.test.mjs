import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// V1's shell, kept because legacy.html still ships and still carries it.
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

test('an update lands on next launch and never mid-session', () => {
  // THIS ASSERTION USED TO SAY THE OPPOSITE, and the reason it was inverted
  // is worth keeping. skipWaiting() on install plus clients.claim() on
  // activate hands a RUNNING page to a new worker and deletes the cache its
  // modules came from; mid-deploy it then re-fetches some modules new and
  // keeps others old, which is a fresh app.js against stale siblings — a
  // dead app. That happened three times (2026-09-03, v0.63.0, 2026-09-04),
  // cleared every time by a full quit and never by a code change.
  //
  // The old comment here named the cost of NOT doing it: an app that is
  // never fully quit stays a build behind. That cost is real and it is the
  // better one. This is a trade, not a bug fix, and it is recorded as such.
  // Comments stripped first. This is the third time in one sitting that an
  // assertion about what code must NOT contain has been tripped by the
  // comment explaining why it must not contain it — `half`, then `sin(`, now
  // the note above saying there is no clients.claim. The rule is the same
  // every time: assert against code, never against prose.
  const code = swSource.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const install = code.slice(code.indexOf("addEventListener('install'"),
    code.indexOf("addEventListener('activate'"));
  const activate = code.slice(code.indexOf("addEventListener('activate'"),
    code.indexOf("addEventListener('message'"));
  assert.ok(!install.includes('skipWaiting'), 'install must not activate over a running page');
  assert.ok(!activate.includes('clients.claim'), 'and activate must not seize one');

  // THE USER-INITIATED PATH SURVIVES, because it is the safe shape of the
  // same operation: Settings asks for it and reloads immediately after, so
  // the page being swapped is one that is about to be replaced anyway.
  const message = code.slice(code.indexOf("addEventListener('message'"));
  assert.match(message, /SKIP_WAITING/);
  assert.match(message, /self\.skipWaiting\(\)/);

  // Deleting older caches is only safe BECAUSE nothing claims a live page:
  // this worker activates once no page is still served by the old one.
  assert.match(activate, /caches\.delete\(key\)/);
});

test('the app shell is served network-first so a cache cannot pin the build', () => {
  const handler = swSource.slice(swSource.indexOf("addEventListener('fetch'"));
  assert.match(handler, /event\.request\.mode === 'navigate'/);
  assert.match(handler, /url\.pathname\.includes\('\/app\/'\)/);
  assert.match(handler, /camera-bootstrap\.js/);
  // Still answers from cache when the network is gone.
  assert.match(handler, /\.catch\(\(\) => caches\.match\(event\.request\)\)/);
});

test('every app-shell entry exists, or the worker never installs at all', () => {
  // THE TRAP THIS GUARDS. cache.addAll rejects the WHOLE install if a single
  // entry 404s, and a service worker that fails to install fails silently:
  // the app still works, so nothing looks wrong, but no update ever arrives
  // and an installed phone sits on one build forever. Promoting V2 to the
  // root rewrote this list, and a stale name in it would have been invisible
  // until Joshua wondered why a fix never reached his home screen.
  const list = swSource.slice(swSource.indexOf('const APP_SHELL'), swSource.indexOf('];'));
  const entries = [...list.matchAll(/'(\.\/[^']*)'/g)].map((m) => m[1]);
  assert.ok(entries.length > 3, 'the shell is not empty');
  const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
  const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
  for (const entry of entries) {
    const relative = entry === './' ? 'index.html' : entry.replace('./', '');
    // public/app/ is GENERATED and gitignored — it is built after the tests
    // run, so a checkout being tested has no compiled modules in it at all.
    // A compiled name is therefore checked against the source it comes from,
    // which is the thing a typo or a rename would actually break.
    if (relative.startsWith('app/')) {
      const source = srcDir + relative.slice('app/'.length).replace(/\.js$/, '.ts');
      assert.ok(existsSync(source), `${entry} must be compiled from ${source}`);
      continue;
    }
    assert.ok(existsSync(publicDir + relative), `${entry} must exist in public/`);
  }
  // The root document is the app now, so the shell must carry ITS entry
  // module — the legacy bundle is no longer what a cold start needs.
  assert.ok(entries.includes('./app/v2/app.js'), 'the app entry module is in the shell');
  assert.ok(!entries.some((e) => e.startsWith('./app/vision/')),
    'no enumerated module list: those go stale and mix versions (see sw.js)');
});

test('one version, stamped in every place that must agree', () => {
  // Four files carry it and they drift silently: the badge would say one
  // build while the cache key said another, and the cache key is what decides
  // whether an installed phone throws its old files away.
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const version = /APP_VERSION = '([^']+)'/.exec(read('../src/v2/version.ts'))?.[1];
  assert.ok(version, 'src/v2/version.ts owns the number');
  assert.equal(JSON.parse(read('../package.json')).version, version, 'package.json agrees');
  assert.ok(swSource.includes(`visual-sensor-studio-v${version}`), 'the cache key agrees');
  assert.ok(mainSource.includes(`APP_VERSION = '${version}'`), 'Version 1 agrees');
});
