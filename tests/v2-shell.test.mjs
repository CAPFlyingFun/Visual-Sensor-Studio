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
  assert.match(appTs, /previewBoxShortSide: measureViewfinder\(\)\.shortSide/,
    'and it feeds the geometry authority, through the one inputs helper');
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

test('the first prime of a Night stack is not counted as a restart', () => {
  // Joshua's four device runs, 2026-09-03, all read "stack 15 (1 restart)"
  // with 15 accepted and 0 rejected — a restart that never happened. The
  // accumulator's FIRST prime shares the flag a real restart sets, so it was
  // being tallied as one. The giveaway is in his own numbers: a genuine
  // restart leaves stackCount BELOW acceptedFrames, and his were equal.
  assert.match(appTs,
    /restarts: nightCounters\.restarts\s*\n\s*\+ \(nightNeedsRestart && nightCounters\.acceptedFrames > 0 \? 1 : 0\),/,
    'a restart counts only where frames had already been folded in');
});

test('the log names the resolution SETTING beside what it actually stacked', () => {
  // Joshua, 2026-09-03: "link the resolution to what the setting is like 720,
  // 1080, 4K, MAX... let me test one at each of the settings before we build
  // the night." Four separate numbers, recorded where each is decided.
  assert.match(appTs, /tierLabel: tierById\(streamTier\)\?\.label \?\? streamTier,/);
  assert.match(appTs, /streamWidth: source\?\.width \?\? 0,/, 'what the camera granted');
  assert.match(appTs, /stackedWidth: nightSize\.width,/, 'what Night really accumulated');
  assert.match(appTs, /sensorWidth: capability\?\.width \?\? 0,/, 'the sensor maximum a MAX photo needs');
  // Frozen once, with the size, rather than re-read per frame — the same
  // "decided at the start" rule the accumulator's own size follows.
  const start = appTs.indexOf("nightSize = frameSize(geometry.photo.width");
  const stacking = appTs.indexOf("nightPhase = 'stacking';", start);
  assert.ok(start > 0 && stacking > start);
  assert.match(appTs.slice(start, stacking), /tierLabel:/, 'recorded when stacking begins');
});

test('Night stacks at the size the TIER chose, not the size the screen is', () => {
  // Joshua, 2026-09-03, after running one capture at every tier: "I want the
  // output to match the settings so if it's 2K, it will be a 2K output image
  // not smaller... Not all 924x1232 for anything above 720 since not all
  // devices or camera will be the same, but the sizes and aspect ratios can
  // and should be, and match."
  //
  // His four runs read stacked 924×1232 at 1080, 2K AND MAX — the preview
  // row is fitted to the viewfinder's own device pixels, so it reported his
  // screen rather than his setting, and would report a different arbitrary
  // number on any other phone. The PHOTO row is the negotiated stream, so
  // the tier decides the output.
  assert.match(appTs, /nightSize = frameSize\(geometry\.photo\.width, geometry\.photo\.height\);/);
  assert.ok(!/nightSize = frameSize\(geometry\.preview/.test(appTs),
    'the preview row is the viewfinder\'s size, never the capture\'s');

  // The SAME row capture/photo.ts hands the renderer for an ordinary still,
  // so a Night result and a normal photo cannot disagree about what the
  // chosen tier means.
  const photoTs = readFileSync(new URL('../src/v2/capture/photo.ts', import.meta.url), 'utf8');
  assert.match(photoTs, /renderer\.render\(filterId, \{ width: photo\.width, height: photo\.height \}\)/);
});

test('Night measures its own result, then lifts it, then saves what it lifted', () => {
  // Joshua, 2026-09-03: "wiring it up so I can see if the images it takes
  // line up and actually make a darker scene brighter and/or enhance
  // daylight similar to HDR." Two jobs, one measurement, nothing by taste.
  const renderTs = readFileSync(new URL('../src/v2/render/gl-renderer.ts', import.meta.url), 'utf8');

  // MEASURED, through the same census the histogram panel already uses —
  // not a second exposure implementation.
  assert.match(appTs, /function measureNightResult\(\): ExposureReading \| null \{/);
  assert.match(appTs, /buildExposure\(context\.getImageData\(/,
    'the reading comes from vision/exposure.ts, one definition of the census');
  assert.match(appTs, /context\.drawImage\(renderer\.targetCanvas,/,
    'it measures the STACK, not the frame arriving now');

  // Never darkens, and a well-exposed frame is left alone. The gain is the
  // SMALLER of what the picture asks for and what the light collected pays
  // for — a gain of N being arithmetically the sum of N frames.
  assert.match(appTs, /const collected = Math\.max\(1, frames\);/);
  assert.match(appTs,
    /const wanted = NIGHT_TARGET_MEAN \/ Math\.max\(reading\.mean, NIGHT_MEAN_FLOOR\);/);
  assert.match(appTs, /const gain = Math\.max\(1, Math\.min\(collected, wanted\)\);/,
    'the frame count is the ceiling, and the measurement binds first in daylight');
  assert.match(appTs, /nightRecoveryFor\(reading, nightCounters\.stackCount\)/,
    'counted from what is IN the accumulator, so a restart cannot claim lost light');
  assert.ok(!/NIGHT_MAX_GAIN/.test(appTs),
    'the arbitrary ceiling of 6 is gone — the frame count replaced it');
  assert.match(appTs, /const lift = 1 \+ Math\.min\(0\.6, reading\.crushed \* 3\);/,
    'the shadow open is driven by the CRUSHED share, so daylight gets it too');

  // The curve cannot clip or wash out: white point = gain means 1.0 -> 1.0
  // at every gain, and gain 1.0 makes the whole curve an identity. It lives
  // in the REGISTRY with every other fragment shader — Rule 4 is enforced
  // structurally, and putting it beside the renderer broke that test.
  const registryTs = readFileSync(new URL('../src/v2/filters/registry.ts', import.meta.url), 'utf8');
  assert.match(registryTs, /float w = max\(uGain, 1\.0\);/);
  assert.match(registryTs, /c = c \* \(1\.0 \+ c \/ \(w \* w\)\) \/ \(1\.0 \+ c\);/);
  assert.match(renderTs, /NIGHT_RECOVERY_FRAGMENT/, 'the renderer imports it rather than restating it');

  // RAW first (so there is something to measure), then the lift it asked for.
  const done = appTs.indexOf('if (elapsed >= NIGHT_TARGET_MS) {');
  const block = appTs.slice(done, done + 1400);
  const raw = block.indexOf('renderer.renderNightResult(nightSize);');
  const measured = block.indexOf('measureNightResult()');
  const lifted = block.indexOf('renderer.renderNightResult(nightSize, recovery);');
  assert.ok(raw > -1 && measured > raw && lifted > measured,
    'raw draw, then measure, then draw again through the measured lift');

  // The SAVE takes the canvas as it stands. Re-rendering would save the one
  // frame arriving now and discard the four seconds of stacking.
  assert.match(appTs, /\{ preRendered: true, label: 'night' \}/);
  const photoTs = readFileSync(new URL('../src/v2/capture/photo.ts', import.meta.url), 'utf8');
  assert.match(photoTs, /if \(!options\.preRendered\) \{/);
  // And the preview stays frozen while the canvas is being encoded.
  const savePoint = appTs.indexOf("nightPhase = 'complete';\n    nightSaved");
  assert.ok(savePoint > -1 && appTs.indexOf('void saveNightPhoto(nightSize);') > savePoint,
    'the phase freezes renderPreview BEFORE the encode starts');
});

test('the filters sit directly under the viewfinder, with their own panels', () => {
  // Joshua, 2026-09-03: "move the filters just under the view, so you don't
  // have to scroll down all the way near the bottom to activate them." They
  // were the eighth section down.
  const route = v2Html.indexOf('id="v2CameraRoute"');
  const strip = v2Html.indexOf('id="v2FilterStrip"');
  const firstOther = Math.min(
    ...['Camera Stream', 'Camera controls', 'Exposure &amp; focus', 'Frame averaging',
      'Shoot when steady', 'Import a photo']
      .map((title) => v2Html.indexOf(`<h2>${title}</h2>`))
      .filter((at) => at > -1));
  assert.ok(strip > route, 'the strip is inside the camera route');
  assert.ok(strip < firstOther,
    'nothing else may come between the viewfinder and the filters');

  // The colour picker and the lens workbench are opened by BUTTONS in that
  // section, so they travel with it. Leaving them behind would put a button
  // at the top of the page and the panel it reveals near the bottom — a
  // worse scroll than the one this move removes.
  const picker = v2Html.indexOf('id="v2PickerCard"');
  const workbench = v2Html.indexOf('id="v2LensWorkbench"');
  assert.ok(picker > strip && picker < firstOther, 'the picker panel followed its button');
  assert.ok(workbench > strip && workbench < firstOther, 'the lens workbench followed its button');
});

test('the precision probe is diagnostics only, and cannot kill boot', () => {
  // Change 1 of the Night redesign (Joshua, 2026-09-04): measure what this
  // phone can hold BEFORE redesigning Night around a format it may not have.
  assert.match(v2Html, /id="v2PrecisionProbe"/);
  assert.match(v2Html, /id="v2PrecisionProbeOut"/);

  // A DYNAMIC import. A statically imported module that the PWA serves a stale
  // copy of fails the whole module graph before a line runs — that is exactly
  // what took the app down on 2026-09-03. Loaded inside the handler, a stale
  // copy fails where it can be caught.
  assert.match(appTs, /await import\('\.\/render\/gpu-precision\.js'\)/);
  const handler = appTs.slice(appTs.indexOf('function buildPrecisionProbe()'),
    appTs.indexOf('function buildPrecisionProbe()') + 1400);
  assert.match(handler, /\} catch \(error\) \{/, 'and the failure is reported, not thrown');
  assert.match(handler, /document\.getElementById\('v2PrecisionProbe'\)/,
    'looked up without byId, so missing markup costs only the probe');

  // THE PROBE ITSELF still changes no capture constant. The accumulator's
  // FORMAT is now a separate change and has its own pins below; the cadence
  // and the duration are what this one must not have touched.
  const nightStack = readFileSync(new URL('../src/v2/vision/night-stack.ts', import.meta.url), 'utf8');
  assert.match(nightStack, /export const NIGHT_TARGET_MS = 4000;/, 'a four-second integration');
});

test('Night allocates the best format it can RENDER TO, and falls back to RGBA8', () => {
  const renderTs = readFileSync(new URL('../src/v2/render/gl-renderer.ts', import.meta.url), 'utf8');
  const alloc = renderTs.slice(renderTs.indexOf('private allocateNightStack('),
    renderTs.indexOf('nightAccumulatorFormat()'));
  assert.ok(alloc.length > 0, 'the allocation is its own named step, not inline');

  // AN EXTENSION STRING IS NOT A GRANT. An implementation may advertise
  // half-float and still refuse to render to it, so the pair is allocated,
  // attached and CHECKED before it is believed.
  assert.match(alloc, /OES_texture_half_float/, 'asks for the half-float type');
  assert.match(alloc, /EXT_color_buffer_half_float/, 'and for the right to render to it');
  assert.match(alloc, /checkFramebufferStatus\(gl\.FRAMEBUFFER\) === gl\.FRAMEBUFFER_COMPLETE/,
    'the framebuffer is proved complete rather than assumed');
  assert.match(alloc, /while \(gl\.getError\(\) !== gl\.NO_ERROR\)/,
    'the error queue is drained first, so a stale error cannot reject a working format');
  assert.match(alloc, /if \(gl\.getError\(\) !== gl\.NO_ERROR\) return false;/,
    'and read after, because OUT_OF_MEMORY is reported there rather than thrown');

  // THE FALLBACK SURVIVES. A device that cannot hold the float pair still
  // gets the accumulator it always had, rather than a failed capture.
  assert.match(alloc, /attempt\(gl\.UNSIGNED_BYTE\);/, 'RGBA8 remains the fallback');
  assert.match(alloc, /this\.nightFormat = 'RGBA8';/, 'and the fallback is recorded, not silent');

  // NEAREST, or a half-float texture is INCOMPLETE wherever the linear
  // extension is missing and the whole stack samples as black.
  const create = renderTs.slice(renderTs.indexOf('if (!this.nightTextures) {'),
    renderTs.indexOf('if (!this.nightFramebuffer)'));
  assert.match(create, /gl\.TEXTURE_MIN_FILTER, gl\.NEAREST/, 'night textures sample NEAREST');
  assert.match(create, /gl\.TEXTURE_MAG_FILTER, gl\.NEAREST/);

  // A lost context invalidates the measurement along with the textures.
  const reset = renderTs.slice(renderTs.indexOf('this.nightTextures = null;'),
    renderTs.indexOf('this.nightTextures = null;') + 700);
  assert.match(reset, /this\.nightFormat = 'RGBA8';/,
    'the format claim is forgotten with the context that produced it');

  // AND IT IS REPORTED, so a silent fallback cannot read as a stacking bug.
  const appSrc = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');
  assert.match(appSrc, /accumulatorFormat: renderer\.nightAccumulatorFormat\?\.\(\) \?\? ''/,
    'the log records what was measured, and an optional call survives a stale renderer');
  const nightStackSrc = readFileSync(
    new URL('../src/v2/vision/night-stack.ts', import.meta.url), 'utf8');
  assert.match(nightStackSrc, /accumulator \$\{counters\.accumulatorFormat\}/,
    'and it reaches the copyable log');
});

test('the four Night sizes are reported apart, and exposure is advertised only', () => {
  // "Do not collapse all of those into the word 'resolution'" (Joshua).
  for (const id of ['v2NightDiagSource', 'v2NightDiagAccumulator',
    'v2NightDiagPreview', 'v2NightDiagPhoto']) {
    assert.match(v2Html, new RegExp(`id="${id}"`), `${id} is its own row`);
  }
  assert.match(appTs, /function renderNightDiagnostics\(\): void \{/);
  // Each row comes from its own authority, not from one number reused.
  assert.match(appTs, /setText\('v2NightDiagPreview', size\(geometry\?\.preview\)\)/);
  assert.match(appTs, /setText\('v2NightDiagPhoto', `\$\{size\(geometry\?\.photo\)\}/);

  // Exposure/ISO are READ, never requested — a capability is not a grant, and
  // requesting one mutates the camera, which is a separate change.
  assert.match(appTs, /advertised only, not requested/);
  const block = appTs.slice(appTs.indexOf('function renderNightDiagnostics'),
    appTs.indexOf('function renderNightDiagnostics') + 2200);
  assert.ok(!/applyConstraints|verifyApply/.test(block),
    'the diagnostics block never applies a constraint');
});

test('an imported VIDEO plays through the filters and saves as a new clip', () => {
  // Joshua asked for "picture or video" and then, once photos shipped, "am I
  // able to import video now?" — this is the video half.
  assert.match(v2Html, /id="v2ImportFile"[^>]*accept="image\/\*,video\/\*"/);
  assert.match(v2Html, /<video id="v2ImportVideo" playsinline muted loop hidden>/);
  assert.match(v2Html, /id="v2ImportPlay"/);

  // A CLIP IS A REAL SEQUENCE, so it gets the full treatment a camera frame
  // gets: the analysis size is passed (so Speed/Trails advance their state
  // pass) and it leaves a previous frame behind for temporal filters.
  assert.match(appTs, /renderer\.render\(activeFilter, size, resolved\.analysis\)/);
  assert.match(appTs, /renderer\.snapshotHistory\(resolved\.analysis\);/);
  // And so those filters are NOT refused for a clip, only for a still.
  assert.match(appTs, /function importRefusal\(filterId: string, isClip = false\): string \{/);
  assert.match(appTs, /if \(!isClip && \(filter\.state \|\| filter\.temporal\)\) \{/);

  // ONE WRITER FOR THE CANVAS. There is one context, one frame texture and
  // one target canvas, so the camera stands down while a clip plays rather
  // than the two overwriting each other thirty times a second.
  assert.match(appTs, /if \(importPlaying\) return;/);

  // The export uses its OWN recorder, so an import can never be mistaken for
  // a live recording by the state every readout reads.
  assert.match(appTs, /const importRecorder = new ClipRecorder\(\);/);
  assert.match(appTs, /importRecorder\.start\(renderer\.targetCanvas\.captureStream\(\),/);
  assert.match(appTs, /`import-\$\{readState\(\)\.activeFilter\}`\);/,
    'the file says import, so it is not mistaken for a camera clip');
  // Sized by the ONE geometry authority, so the encoder ceiling applies to an
  // import exactly as it does to a camera recording.
  assert.match(appTs, /resolveGeometry\(size, geometryInputs\(\)\)\.recordInput/);
  // The limits are stated rather than discovered.
  assert.match(appTs, /silent/i);
  assert.match(appTs, /in real time/i);
});

test('the geometry inputs have ONE definition, shared by camera and import', () => {
  // They were inline in refreshGeometry until the import needed to resolve
  // rows for a file rather than for the stream. Two copies would have let an
  // import be measured by different rules than the camera (Rule 6).
  assert.match(appTs, /function geometryInputs\(\): GeometryInputs \{/);
  assert.match(appTs, /geometry: source \? resolveGeometry\(source, geometryInputs\(\)\) : null/);
  assert.equal((appTs.match(/previewBoxShortSide: measureViewfinder\(\)\.shortSide/g) ?? []).length, 1,
    'one place decides what the geometry authority is asked');
});

test('an imported photo goes through the SAME filters and saves as a new file', () => {
  // Joshua, 2026-09-03: "add where you can upload and picture or video and
  // apply filters and save as new."
  assert.match(v2Html, /id="v2ImportFile"[^>]*accept="image\/\*,video\/\*"/,
    'the one picker takes both kinds');
  assert.match(v2Html, /id="v2ImportPick"/);
  assert.match(v2Html, /id="v2ImportSave"/);
  assert.match(v2Html, /id="v2ImportCanvas"/);

  // ONE shader path: the import renders through renderer.render() with the
  // ACTIVE filter, never a second import-only implementation (Rule 4).
  assert.match(appTs, /renderer\.uploadStill\(image\) \|\| !renderer\.render\(activeFilter, size\)/);
  // At the picture's OWN size — an import is not quietly downscaled.
  assert.match(appTs, /const size = frameSize\(image\.naturalWidth, image\.naturalHeight\);/);
  // And saved through the one save path, not a second encoder.
  assert.match(appTs, /label: `import-\$\{readState\(\)\.activeFilter\}`/);

  // A sequence filter is refused BY ITS CAPABILITY METADATA, not by a list of
  // names (Rule 10) — a single still is not a sequence, and applying one
  // would composite the camera's leftover memory over the imported picture.
  // ...and only for a STILL. A clip is a real sequence, so the same filters
  // are right there and are not refused — the refusal is about the material.
  assert.match(appTs, /if \(!isClip && \(filter\.state \|\| filter\.temporal\)\) \{/);
  // The refusal takes the picture off screen rather than leaving the previous
  // filter's render up under a note about a different one.
  assert.match(appTs, /canvas\.hidden = true;\n    byId\('v2ImportSave'\)\.hidden = true;/);
});

test('an import cannot disturb the live camera pipeline', () => {
  // The whole reason this is safe to do while the camera runs. An import
  // render passes no stateSize and no frame count, so advanceAverage() bails
  // (it needs frames > 1), the state pass is skipped, and snapshotHistory()
  // is never reached — the live Stabilization accumulation, Speed/Trails
  // memory and frame history are all left exactly as they were.
  const renderTs = readFileSync(new URL('../src/v2/render/gl-renderer.ts', import.meta.url), 'utf8');
  assert.match(renderTs, /if \(!gl \|\| !\(frames > 1\) \|\| size\.width <= 0/,
    'averaging needs more than one frame, so a lone import render cannot advance it');
  assert.match(renderTs, /filter\.state && stateSize \? this\.advanceState\(filter, stateSize\) : null/,
    'no stateSize means no state pass');
  // The import call site really does pass neither.
  assert.match(appTs, /renderer\.render\(activeFilter, size\)\)/,
    'the import render takes a size and nothing else');
  // snapshotHistory stays the delivery loop's business alone.
  const importBlock = appTs.slice(appTs.indexOf('function renderImport()'),
    appTs.indexOf('function renderImport()') + 1600);
  assert.ok(!/snapshotHistory/.test(importBlock));
});

test('the Night log appends across runs and can be copied', () => {
  // Joshua, on the phone, after the countdown worked: "the lowest I saw hand
  // holding was about 95%... add a log that I can copy with a button to run
  // like 3-5 times to get a good estimation before continuing."
  assert.match(v2Html, /id="v2NightLog"/);
  assert.match(v2Html, /id="v2NightLogCopy"/);
  assert.match(v2Html, /id="v2NightLogClear"/);
  assert.match(appTs, /let nightLog: NightLogEntry\[\] = \[\];/,
    'appended state, not a single overwritten reading like nightCounters');
  assert.match(appTs, /nightLog = \[\.\.\.nightLog, \{/, 'appends — never replaces prior runs');
  assert.match(appTs, /pushNightLogEntry\(true\);/, 'a finished stack logs itself');

  // A cancel logs only once something was measured; a countdown cancel does not.
  const stopBody = appTs.slice(appTs.indexOf('function stopNightTest(): void {'),
    appTs.indexOf('function stopNightTest(): void {') + 700);
  assert.match(stopBody, /if \(nightPhase === 'arming' \|\| nightPhase === 'stacking'\) pushNightLogEntry\(false\);/);

  assert.match(appTs, /nightLog\.map\(describeNightLogEntry\)\.join\('\\n'\)/);
  assert.match(appTs, /navigator\.clipboard/);
});

test('the Night log can never take the app down with it, however the PWA updates', () => {
  // THE 2026-09-03 REGRESSION, pinned. An installed PWA can boot a fresh
  // app.js against a cached older index.html, or against a cached older
  // sibling module. Both were reproduced in a real browser: byId() throws on
  // markup that is not there, and a missing named export fails the whole
  // module graph before a line runs. Either left every control unwired while
  // the page still looked complete — "No buttons work… it's all locked up,
  // but everything is there."
  //
  // 1. The log's markup is reached WITHOUT byId's throw.
  assert.match(appTs, /function nightLogElement<T extends HTMLElement>\(id: string\): T \| null \{/);
  assert.match(appTs, /return document\.getElementById\(id\) as T \| null;/);
  for (const id of ['v2NightLogCopy', 'v2NightLogClear', 'v2NightLog']) {
    assert.ok(!new RegExp(`byId(<[^>]*>)?\\('${id}'\\)`).test(appTs),
      `#${id} must never be reached through byId() — it throws, and one throw here unwires the app`);
  }
  assert.match(appTs, /nightLogElement\('v2NightLogCopy'\)\?\.addEventListener/,
    'the listener is optional-chained, so a missing button costs only the button');

  // 2. The feature adds NO new named export to a shared module, so a stale
  //    copy of one cannot fail the import graph. The entry type and its
  //    formatter live in app.ts itself.
  assert.match(appTs, /^interface NightLogEntry \{/m, 'the entry type is local to app.ts');
  assert.match(appTs, /^function describeNightLogEntry\(entry: NightLogEntry\): string \{/m,
    'and so is its formatter');
  const nightStack = readFileSync(new URL('../src/v2/vision/night-stack.ts', import.meta.url), 'utf8');
  assert.ok(!/describeNightLogEntry|NightLogEntry/.test(nightStack),
    'night-stack.ts gains no new export for the log — that is what broke the phone');
  // It still REUSES the counters formatter the shipped build already has.
  assert.match(appTs, /\+ describeNightCounters\(entry\.counters\);/);
});

test('Night takes every delivered frame, but only a genuinely NEW one', () => {
  const appSrc = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');

  // THE CEILING, not a sampling period. Joshua, 2026-09-04: "instead of
  // sampling every 0.25s, do it every frame up to 30 frames per second".
  const nightStackSrc = readFileSync(
    new URL('../src/v2/vision/night-stack.ts', import.meta.url), 'utf8');
  assert.match(nightStackSrc, /export const NIGHT_TICK_MS = 30;/,
    'the gate is a ~30fps ceiling, not a quarter-second period');

  // A REPEATED CALLBACK MUST NOT BE STACKED. requestVideoFrameCallback can
  // fire at the display's rate, so folding one in twice would add no light
  // while advancing 1/n and diluting the frames that are real.
  assert.match(appSrc, /const freshFrame = meter\.recordDelivered\(frame\);/,
    'the meter\'s own new-frame verdict is read rather than discarded');
  assert.match(appSrc, /if \(freshFrame\) updateNightStack\(frame\.now\);/,
    'and Night only ticks on a genuinely new decoded image');

  // The tick still rides the camera's delivery callback, never a timer.
  assert.match(appSrc, /camera\.startFrameDelivery\(\(frame\) => \{/);
  assert.ok(!/setInterval\([^)]*updateNightStack/.test(appSrc),
    'no second clock races the camera');

  // AND NOTHING ELSE MOVED: same duration, same countdown, same accumulator.
  assert.match(nightStackSrc, /export const NIGHT_TARGET_MS = 4000;/, 'a four-second integration');
  assert.match(nightStackSrc, /export const NIGHT_COUNTDOWN_MS = 3000;/, 'countdown untouched');
  const renderTs = readFileSync(new URL('../src/v2/render/gl-renderer.ts', import.meta.url), 'utf8');
  assert.match(renderTs, /this\.nightFormat = 'RGBA16F';/, 'still the float accumulator');
});

test('the colour trim is measured after the gain, and set on every draw', () => {
  const appTs = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');

  // MEASURED WHERE IT RESOLVES. The raw stack sits at about half of one 8-bit
  // step, so a colour ratio taken from it would be noise reporting on noise.
  assert.match(appTs, /function sampleNightChannels\(\): \[number, number, number\] \| null \{/);
  const order = appTs.indexOf('const channels = sampleNightChannels();');
  const gained = appTs.indexOf('renderer.renderNightResult(nightSize, recovery);');
  assert.ok(gained > 0 && order > gained,
    'the channels are sampled from the GAINED canvas, not the raw one');

  // IT RAMPS TO AN EXACT IDENTITY, so a scene bright enough for its colour to
  // be evidence keeps it.
  assert.match(appTs, /const NIGHT_COLOUR_TRUST = 0\.05;/);
  assert.match(appTs, /if \(strength <= 0 \|\| average <= 0\) return \[1, 1, 1\];/,
    'no correction at all once the colour can be trusted');
  assert.match(appTs, /1 \+ strength \* \(average \/ c - 1\)/,
    'equalised toward the AVERAGE, so correcting colour cannot darken the picture');

  // THE UNIFORM IS ALWAYS SET. The recovery program outlives a capture, so an
  // unset uniform would carry a previous stack's trim into this one.
  const renderTs = readFileSync(new URL('../src/v2/render/gl-renderer.ts', import.meta.url), 'utf8');
  assert.match(renderTs, /const balance = recovery\.balance \?\? \[1, 1, 1\];/);
  assert.match(renderTs, /gl\.uniform3f\(gl\.getUniformLocation\(program, 'uBalance'\)/);

  // Rule 4: the shader lives in the registry with every other fragment.
  const registryTs = readFileSync(new URL('../src/v2/filters/registry.ts', import.meta.url), 'utf8');
  assert.match(registryTs, /uniform vec3 uBalance;/);
  assert.match(registryTs, /clamp\(c \* uBalance, 0\.0, 1\.0\)/,
    'a channel pulled up toward the average can pass 1.0');
});

test('MAX can be recorded at MAX by choice, and the envelope stops pretending', () => {
  const appTs = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');

  // THE OPTION EXISTS AND IS REACHABLE. Joshua, 2026-09-04: "don't assume my
  // phone can't as I am able to record at MAX at around 30fps."
  assert.match(v2Html, /id="v2ForceMaxRecord"/, 'the choice has a control');
  assert.match(appTs, /document\.getElementById\('v2ForceMaxRecord'\)/,
    'looked up without byId, so missing markup costs only the checkbox');

  // IT SKIPS THE CHECK ENTIRELY rather than raising a number, so RECORD IN
  // follows the chosen tier exactly as a photo does.
  assert.match(appTs, /encoderMacroblocks: readState\(\)\.forceMaxRecord \? null : \{/,
    'null is the geometry\'s own "no envelope", not a second policy');

  // ON BY DEFAULT, and only an explicit 'no' turns the ceiling back on. The
  // envelope generalises one codec's limit, measured on one device, to every
  // camera the app will meet; shrinking every recording everywhere to
  // pre-empt a failure that announces itself anyway is the worse trade.
  assert.match(appTs, /localStorage\.getItem\(FORCE_MAX_STORE_KEY\) !== 'no'/,
    'anything but a stored "no" records at MAX');
  const stored = appTs.slice(appTs.indexOf('function storedForceMaxRecord'),
    appTs.indexOf('updateState({ forceMaxRecord: storedForceMaxRecord() });'));
  assert.match(stored, /\} catch \{\s*return true;/,
    'and unreadable storage must not quietly reinstate the ceiling');
  const stateTs = readFileSync(new URL('../src/v2/state.ts', import.meta.url), 'utf8');
  assert.match(stateTs, /forceMaxRecord: true/,
    'the boot state agrees with the stored default, so nothing flips on first paint');

  // AND IT IS REMEMBERED — a decision about this device, not this session.
  assert.match(appTs, /const FORCE_MAX_STORE_KEY = 'vss\.v2\.forceMaxRecord\.v1';/);
  assert.match(appTs, /function storedForceMaxRecord\(\): boolean \{/);
  assert.match(appTs, /updateState\(\{ forceMaxRecord: storedForceMaxRecord\(\) \}\);/,
    'restored at boot, so the choice survives a relaunch');

  // THE READOUT MUST NOT SHOW A LIMIT IT IS NOT APPLYING.
  assert.match(appTs, /NOT APPLIED: recording at MAX by choice/,
    'an unapplied envelope says so rather than reading as the active ceiling');

  // WHAT MAKES THIS SAFE TO OFFER: the clip's real size is read back out of
  // the finished file, so an encoder that cannot hold the frame announces
  // itself instead of being predicted away. That instrument must stay.
  const recordTs = readFileSync(new URL('../src/v2/capture/record.ts', import.meta.url), 'utf8');
  assert.match(recordTs, /function measureEncodedSize\(blob: Blob\)/,
    'the file is still the witness, whatever the envelope said beforehand');
});

test('a shared file carries a MIME the system can map, not the recorder\'s full string', () => {
  const appTs = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');

  // WHY: MediaRecorder reports what it negotiated, parameters and all — so
  // asking for HEVC gets back "video/mp4;codecs=hvc1". iOS maps a file's MIME
  // to a UTI to decide which targets accept it, and a parameterised type has
  // no UTI, so Photos is never offered. The clip records perfectly and then
  // has nowhere to go, which is exactly the report this came from.
  assert.match(appTs, /function shareMimeType\(reported: string, fallback: string\): string \{/);
  assert.match(appTs, /const base = \(reported \|\| ''\)\.split\(';'\)\[0\]\.trim\(\);/,
    'the codec parameters are dropped for the File');

  // BOTH share paths use it — the camera clip and the imported one.
  const shares = [...appTs.matchAll(/new File\(\[result\.blob\][\s\S]{0,140}?\}\)/g)].map((m) => m[0]);
  assert.ok(shares.length >= 2, `both share paths build a File, found ${shares.length}`);
  for (const call of shares) {
    assert.match(call, /shareMimeType\(/,
      `every shared File gets a mappable type, got: ${call.replace(/\s+/g, ' ')}`);
  }

  // AND THE READOUT KEEPS THE FULL STRING. The parameterised type is the
  // measurement — it is how we know whether HEVC was actually used — so it
  // must not be sanitised out of the place that reports it.
  assert.match(appTs, /\$\{result\.mimeType \|\| 'container unreported'\}/,
    'the clip readout still states exactly what the recorder negotiated');

  // A REFUSED SHARE IS NOT SILENT. Hiding the button with no explanation
  // reads as "the app cannot save"; the file is in Files either way.
  const offer = appTs.slice(appTs.indexOf('function offerShare('),
    appTs.indexOf('function offerShare(') + 1600);
  assert.match(offer, /button\.hidden = true;\s*\n\s*if \(reportTo\) \{/,
    'a device that will not share the file says so');
  assert.match(offer, /saved to Files instead/, 'and says where the file actually is');
  // APPENDED, never substituted: the line already carries size, duration and
  // rate, and an explanation that ate them would trade one missing answer
  // for several.
  assert.match(offer, /setText\(reportTo, current \? `\$\{current\} · \$\{note\}` : note\)/,
    'the measurements the line already carries are kept');
  assert.match(offer, /if \(!current\.includes\('cannot be shared here'\)\)/,
    'and it is not appended twice');
});

test('the encoder probe releases the camera and puts it back', () => {
  const appTs = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');
  const probe = appTs.slice(appTs.indexOf("byId('v2EncoderProbe').addEventListener"),
    appTs.indexOf("byId('v2EncoderProbe').addEventListener") + 4200);

  // The probe allocates a full-size canvas and an encoder per trial while the
  // camera, the frame texture and the display canvas hold their own buffers.
  // WebKit reclaimed the camera to survive it — twice, on device.
  assert.match(probe, /const cameraWasLive = readState\(\)\.camera\?\.state === 'live';/,
    'it remembers whether there was a camera to put back');
  assert.match(probe, /camera\.stop\(\);/, 'and releases it before the trials');

  // RESTORED THROUGH THE APP'S OWN START PATH, so the tier, geometry and
  // delivery meter come back as a normal start leaves them.
  assert.match(probe, /void startCamera\(\)/, 'restored through the ordinary start');
  assert.match(probe, /\}\)\.finally\(\(\) => \{[\s\S]*?restoreCamera\(\);/,
    'in a finally, so a failed probe still gives the camera back');

  // A camera that was NOT live must not be started by running a probe.
  assert.match(probe, /if \(!cameraWasLive\) return;/,
    'a probe never turns a camera on that the user had off');
});

test('a zoom preset is an instant jump, and the glide is gone', () => {
  const appTs = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');

  // Joshua, 2026-09-04, on the timed glide: "can delete this old section as
  // it doesn't work." It planned a trajectory through applyConstraints and
  // then missed it, because how fast the camera retires a request is not
  // ours to set — every missed deadline read as a step. Smooth zoom is the
  // stick; a preset is now what it always was before v0.64.0, an exact jump.
  assert.match(appTs, /stopZoomStick\(\);\s*\n\s*void camera\.setZoom\(stop\);/,
    'a preset applies at once, and stops the stick so two hands do not steer');

  for (const ghost of ['rampZoomTo', 'cancelZoomRamp', 'buildZoomRamp',
    'ZOOM_RAMP_STORE_KEY', 'zoomRampSeconds']) {
    assert.ok(!appTs.includes(ghost), `${ghost} is gone from the app`);
  }
  assert.ok(!v2Html.includes('v2ZoomRamp'), 'and its markup is gone from the page');

  // The in-flight guard is NOT part of the glide — the stick needs it, and
  // it is the reason a slow applyConstraints coarsens the motion instead of
  // queueing work the camera cannot retire.
  assert.match(appTs, /let zoomApplyInFlight = false;/);
});

test('the zoom stick is a RATE control, at the units Joshua specified', () => {
  const appTs = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');
  assert.match(v2Html, /id="v2ZoomStick"/, 'the stick exists');
  assert.match(v2Html, /min="-1" max="1" step="0\.01" value="0"/,
    'centred, and pushes both ways');

  // "the max is 1 zoom per second with half a stick at x0.5 per second"
  assert.match(appTs, /const ZOOM_STICK_MAX_PER_SECOND = 1;/);
  assert.match(appTs, /zoom\.value \+ zoomStickRate \* ZOOM_STICK_MAX_PER_SECOND \* dt/,
    'deflection times the max rate times REAL elapsed time');

  // Integrating measured dt is what makes a slow applyConstraints degrade to
  // a coarser motion rather than a stutter against a planned trajectory.
  assert.match(appTs, /const dt = zoomStickLast > 0 \? Math\.min\(0\.25, \(now - zoomStickLast\) \/ 1000\) : 0;/,
    'a long frame gap cannot teleport the zoom');

  // It must stay inside the camera's own range, and never re-ask for a value
  // it already holds — that is how a camera gets slow.
  assert.match(appTs, /Math\.min\(zoom\.max, Math\.max\(zoom\.min,/);
  assert.match(appTs, /if \(Math\.abs\(next - zoom\.value\) > 0\.0005 && !zoomApplyInFlight\)/);

  // SPRINGS BACK however the finger leaves it.
  for (const event of ['pointerup', 'pointercancel', 'pointerleave', 'touchend', 'touchcancel']) {
    assert.ok(appTs.includes(`'${event}'`), `${event} releases the stick`);
  }
  assert.match(appTs, /stick\.addEventListener\('blur', release\);/);

  // And the stick only appears where there is a range to travel.
  assert.match(appTs, /stick\.hidden = !zoom \|\| zoom\.kind === 'none' \|\| !\(zoom\.max > zoom\.min\);/);
});

test('how fast the camera really accepts zoom changes is measured, not assumed', () => {
  const appTs = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');
  // "The zoom isn't smooth" is a feeling; this is the number underneath it.
  // applyConstraints is asynchronous, so however finely a ramp is computed
  // the camera moves only as often as it retires a request.
  assert.match(appTs, /zoomAppliesPerSecond = \(zoomApplyCount \* 1000\) \/ elapsed;/);
  assert.match(appTs, /Camera accepts ~\$\{zoomAppliesPerSecond\.toFixed\(0\)\} zoom changes\/s\./,
    'and it reaches the readout');
  assert.match(appTs, /document\.getElementById\('v2ZoomRateNote'\)/,
    'which outlived the glide slider it used to ride on');
  assert.match(v2Html, /id="v2ZoomRateNote"/, 'and has somewhere on the page to land');
  assert.match(appTs, /if \(elapsed >= 1000\)/, 'averaged over a real second, not one sample');
});
