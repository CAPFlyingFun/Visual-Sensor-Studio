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

test('gyro steadying is a switch that can be refused, and says which', () => {
  // A SWITCH, not a rung on the averaging ladder. iOS hands a page motion
  // data only after a permission asked for from a real tap, and that
  // permission can be REFUSED — a ladder rung would have no way to say so and
  // would sit there looking as though it were working.
  assert.match(v2Html, /id="v2AlignToggle"/);
  assert.match(v2Html, /id="v2AlignNote"/);
  assert.match(v2Html, /id="v2AlignReading"/);
  assert.match(appTs, /motion\.requestPermission\(\)/, 'the permission is asked for');
  // The sensor stops when the LAST feature using it lets go, not when either
  // one does — turning alignment off while the shutter is armed would
  // otherwise silently kill the shutter's readings.
  assert.match(appTs, /if \(!readState\(\)\.autoShot\) stopMotion\('off'\);/);
  assert.match(appTs, /if \(!readState\(\)\.align\) stopMotion\('off'\);/);
  for (const status of ['asking', 'denied', 'unsupported']) {
    assert.ok(appTs.includes(`'${status}'`), `${status} is a state the row can be in`);
  }
  assert.match(stateTs, /motionStatus: 'off' \| 'asking' \| 'on' \| 'denied' \| 'unsupported';/,
    'off and refused are different facts');
  // ONE OWNER for the sensor (Rule 1). Two features need the gyro now, and a
  // second copy of "is the sensor on" is how one of them ends up reporting a
  // refusal as a preference.
  assert.match(appTs, /async function ensureMotion\(\): Promise<boolean>/);
  assert.equal((appTs.match(/motion\.start\(/g) ?? []).length, 1,
    'the sensor is started in exactly one place');

  // A refusal must not read as a fault of the phone, and an absent sensor
  // must not read as an absent gyroscope.
  assert.match(appTs, /Safari asks once per site/);
  assert.match(appTs, /no orientation sensor at all/);
  assert.match(appTs, /the phone certainly has a gyroscope/,
    'an unsupported browser is a browser limit, never an absent gyroscope');

  // NOT REMEMBERED across loads, deliberately: the permission belongs to a
  // gesture, so a restored "on" could only be a switch that reads on while
  // nothing is aligning.
  assert.ok(!/ALIGN_STORE_KEY/.test(appTs), 'no remembered alignment preference');

  // The focal length is a STAND-IN and every reading says so — no browser
  // reports a field of view, and V2 has no visual fit yet.
  assert.match(appTs, /from an ASSUMED focal length/);
  // And the pixel numbers are the CAMERA's, not the preview's — the same
  // turn read as a fifth of the shift when it was measured against the
  // render target, which is a different and much smaller number.
  assert.match(appTs, /const frame = source \?\? target;/);
  // And the noise floor is the default rather than a calibration of this
  // phone, which is a different claim and would be a bigger one.
  assert.match(appTs, /is the default, not a calibration of/);
  // The verdict text must not claim a calibration either — the two would
  // contradict each other in the same sentence.
  const alignmentTs = readFileSync(new URL('../src/v2/vision/alignment.ts', import.meta.url), 'utf8');
  assert.ok(!/calibrated noise floor/.test(alignmentTs),
    'nothing calls the default floor calibrated');
});

test('alignment only runs when there is something to align', () => {
  // An aligner asked for an offset while nothing is being averaged would
  // anchor itself to whatever orientation happened to be current and then
  // report a confident zero about a stack that does not exist.
  assert.match(appTs, /if \(!readState\(\)\.align \|\| !latestOrientation \|\| !\(frames > 1\)\)/);
  assert.match(appTs, /aligner\.reset\(\);/, 'and the anchor is dropped, not left stale');

  // NO READING IS NOT A READING. MotionController emits once the instant it
  // starts, before any sensor event, with null angles — which the quaternion
  // maths reads as a phone lying flat. Anchoring on that and then meeting the
  // first real orientation is a ninety-degree swing, and the accumulation was
  // thrown away for it at every single start (measured, then fixed).
  assert.match(appTs,
    /sample\.alpha === null && sample\.beta === null && sample\.gamma === null\) return;/);
});

test('the steady shutter waits on a real picture and fires exactly once', () => {
  assert.match(v2Html, /id="v2SteadyToggle"/);
  assert.match(v2Html, /id="v2SteadyReading"/);
  // The meter sits OVER the picture, because reading a percentage in a panel
  // below the viewfinder means looking away from the thing being held still.
  assert.match(v2Html, /id="v2SteadyHud"/);
  assert.match(appTs, /renderSteadyHud\(\);/);

  // ON THE DELIVERY LOOP. An armed shutter driven by a timer would fire into
  // a suspended camera; driven by frames, it can only ever act on a picture
  // that is really arriving.
  assert.match(appTs, /renderPreview\(frame\.now\);\n\s*\/\/[\s\S]*?updateSteadyShutter\(frame\.now\);/);
  assert.match(appTs, /if \(status\?\.state !== 'live'\)/);

  // ONCE: the flag goes down BEFORE the shutter is pulled, so a slow capture
  // cannot be re-entered by the next frame while it is still running.
  const fire = appTs.slice(appTs.indexOf('if (!progress.fire) return;'));
  const flagDown = fire.indexOf("updateState({ autoShot: false })");
  const pull = fire.indexOf('void takePhoto()');
  assert.ok(flagDown > 0 && pull > flagDown, 'disarmed before the shutter is pulled');

  // It pulls the ORDINARY shutter. Nothing about the photograph changes —
  // same escalation, same geometry, same file — only what decides when.
  assert.ok(!/captureAtMaxStream/.test(appTs.slice(
    appTs.indexOf('function updateSteadyShutter'), appTs.indexOf('function buildSteadyShutter'))),
    'no second capture path');

  // The photo's OWN pixels: capability where the track advertises one, since
  // that is the frame the shutter escalates to. Measuring the smear against
  // the preview would understate it by the ratio between the two.
  assert.match(appTs, /const photo = capability \?\? source;/);
});

test('Night — Test exists, and says plainly that Milestone 1 saves nothing', () => {
  assert.match(v2Html, /id="v2NightTestToggle"/);
  assert.match(v2Html, /id="v2NightTestNote"/);
  assert.match(v2Html, /id="v2NightTestReading"/);
  assert.match(appTs, /function updateNightStack\(now: number\): void \{/);
  assert.match(appTs, /function renderNightTest\(\): void \{/);
  assert.match(appTs, /renderNightTest\(\);/, 'wired into the render loop');
  assert.match(appTs, /updateNightStack\(frame\.now\);/, 'driven by the SAME delivery loop as the rest');

  // The honesty rule this milestone was scoped around: nothing here may read
  // as a photo. "NOTHING IS SAVED" appears in the idle note itself, not
  // just in a comment — a reader who never opens the source still gets it.
  assert.match(appTs, /NOTHING IS SAVED/);
});

test('Night reuses the SHARED steadiness reading rather than measuring twice', () => {
  // steadyReading is already computed every frame by updateSteadyShutter,
  // regardless of whether the ordinary Shoot When Steady feature is armed.
  // Night's gate reads that SAME value rather than calling readSteadiness a
  // second time — one measurement, three consumers (Alignment's readout,
  // Shoot When Steady, Night's own gate).
  assert.match(appTs, /nightGate\.update\(steadyReading\.steadiness, now\)/);
});

test('the ordinary shutter, recording, and the existing gyro features are untouched', () => {
  // The literal DO-NOT-TOUCH list (Joshua, 2026-09-03). These pin BEHAVIOR,
  // not just "the word doesn't appear" — each asserts the function that
  // already existed is still exactly what it was.
  const takePhotoBody = appTs.slice(appTs.indexOf('async function takePhoto()'),
    appTs.indexOf('async function takePhoto()') + 2000);
  assert.ok(!/night/i.test(takePhotoBody), 'the manual shutter has no Night branch');

  const toggleRecordingIdx = appTs.indexOf('async function toggleRecording()');
  if (toggleRecordingIdx > -1) {
    const recordBody = appTs.slice(toggleRecordingIdx, toggleRecordingIdx + 2000);
    assert.ok(!/night/i.test(recordBody), 'recording has no Night branch');
  }

  // The live frame-averaging ladder (Stabilization's own accumulator) keeps
  // its exact existing formula — Night does not touch frame-average.ts at
  // all, and app.ts's alignment/steady-shutter blocks are unmodified except
  // for the new Night block appended after them.
  assert.match(appTs, /function alignmentFor\(frames: number, target: FrameSize\):/,
    'the live alignment wiring keeps its own signature, unmoved');
  assert.match(appTs, /function updateSteadyShutter\(now: number\): void \{/,
    'the ordinary Shoot When Steady tick keeps its own function, unmoved');

  const frameAverage = readFileSync(new URL('../src/v2/render/frame-average.ts', import.meta.url), 'utf8');
  assert.match(frameAverage, /export function frameAverageWeight\(frames: number\): number \{/,
    'the live ladder\'s EMA formula is untouched');
});

test('the countdown sits BEFORE the gate, not in place of it', () => {
  // Joshua, on the phone: "make a 3s countdown before it actually starts
  // because if not using a tripod, as soon as you tap and release your
  // finger, your hands are going to move a little." The gate he explicitly
  // asked to have reused ("Shoot When Steady can be reused as the gate that
  // begins the Night stack") must still run — this only delays when it
  // starts watching.
  assert.match(appTs, /type NightPhase = 'idle' \| 'countdown' \| 'arming' \| 'stacking' \| 'complete';/);
  const countdownBlock = appTs.slice(
    appTs.indexOf("if (nightPhase === 'countdown') {"),
    appTs.indexOf("if (nightPhase === 'arming') {", appTs.indexOf("if (nightPhase === 'countdown') {")));
  assert.match(countdownBlock, /now - nightCountdownStartedAt < NIGHT_COUNTDOWN_MS/);
  // The countdown's own exit is what arms the gate — not a second, separate
  // arm call elsewhere, and not skipping the gate.
  assert.match(countdownBlock, /nightGate\.arm\(DEFAULT_STEADY_THRESHOLD\);/);
  assert.match(countdownBlock, /nightPhase = 'arming';/);

  // The permission request happens in the CLICK handler, before the
  // countdown is even entered — not deferred into the tick loop. iOS only
  // grants motion access to a call inside a real user gesture; asking later
  // risks a silent refusal.
  const clickHandler = appTs.slice(
    appTs.indexOf("byId('v2NightTestToggle').addEventListener('click'"),
    appTs.indexOf("byId('v2NightTestToggle').addEventListener('click'") + 1600);
  const ensureIdx = clickHandler.indexOf('ensureMotion()');
  const countdownIdx = clickHandler.indexOf("nightPhase = 'countdown';");
  assert.ok(ensureIdx > 0 && countdownIdx > ensureIdx,
    'ensureMotion() is awaited before the countdown starts, inside the same gesture');
});

test('the countdown readout never reads 0 or negative on screen', () => {
  assert.match(appTs, /nightCountdownSecondsLeft\(performance\.now\(\) - nightCountdownStartedAt\)/);
  assert.match(appTs, /countdown: `⏱️ Starting in \$\{secondsLeft\}…`,/);
});

test('a large 3/2/1 overlay shows in the viewfinder during the countdown, and only then', () => {
  // "A large 3/2/1 overlay in the viewfinder would be ideal" (Joshua,
  // 2026-09-03) — the button label alone was the first pass; this is the
  // follow-up he asked for by name.
  assert.match(v2Html, /id="v2NightCountdown"/);
  assert.match(appTs, /const overlay = byId\('v2NightCountdown'\);/);
  assert.match(appTs, /overlay\.hidden = nightPhase !== 'countdown';/,
    'shown ONLY during the countdown — not during arming, stacking or complete');
  assert.match(appTs, /overlay\.textContent = String\(secondsLeft\);/);
});

test('the Night log appends across runs, with a copy button and structural markup', () => {
  // Joshua, on the phone, after the countdown worked: "the lowest I saw hand
  // holding was about 95%... add a log that I can copy with a button to run
  // like 3-5 times to get a good estimation before continuing."
  assert.match(v2Html, /id="v2NightLog"/);
  assert.match(v2Html, /id="v2NightLogCopy"/);
  assert.match(v2Html, /id="v2NightLogClear"/);
  assert.match(appTs, /let nightLog: NightLogEntry\[\] = \[\];/,
    'appended state, never a single overwritten reading like nightCounters');
  assert.match(appTs, /function pushNightLogEntry\(completed: boolean\): void \{/);
  assert.match(appTs, /nightLog = \[\.\.\.nightLog, \{/, 'appends — never truncates or replaces prior runs');

  // A finished stack logs itself as it completes; a cancel logs itself only
  // once something was actually measured (arming or stacking), never for a
  // tap cancelled during the countdown with nothing to compare yet.
  assert.match(appTs, /pushNightLogEntry\(true\);/);
  const stopBody = appTs.slice(appTs.indexOf('function stopNightTest(): void {'),
    appTs.indexOf('function stopNightTest(): void {') + 600);
  assert.match(stopBody, /if \(nightPhase === 'arming' \|\| nightPhase === 'stacking'\) pushNightLogEntry\(false\);/);

  // The copy button uses the SAME clipboard idiom already established for
  // the colour picker's copy button, rather than a second implementation.
  const copyHandler = appTs.slice(appTs.indexOf("byId('v2NightLogCopy')"),
    appTs.indexOf("byId('v2NightLogCopy')") + 500);
  assert.match(copyHandler, /navigator\.clipboard/);
  assert.match(copyHandler, /writeText/);
  assert.match(copyHandler, /nightLog\.map\(describeNightLogEntry\)\.join\('\\n'\)/);
});
