import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const adapterSource = readFileSync(new URL('../src/sensors/camera.ts', import.meta.url), 'utf8');
const htmlSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const cameraPath = new URL('../public/camera-bootstrap.js', import.meta.url);
const cameraSource = existsSync(cameraPath) ? readFileSync(cameraPath, 'utf8') : '';

test('camera bootstrap does not statically depend on the Three.js scene', () => {
  assert.doesNotMatch(mainSource, /^import\s+\{\s*FusionScene\s*\}\s+from\s+['"]\.\/visualization\/scene\.js['"];?$/m);
  assert.match(mainSource, /import\(['"]\.\/visualization\/scene\.js['"]\)/);
});

test('plain camera engine loads before the TypeScript application', () => {
  assert.ok(cameraSource.length > 0, 'public/camera-bootstrap.js must exist');
  const cameraScript = htmlSource.indexOf('camera-bootstrap.js');
  const appScript = htmlSource.indexOf('app/main.js');
  assert.ok(cameraScript >= 0, 'camera bootstrap script must be referenced');
  assert.ok(appScript >= 0, 'TypeScript app bundle must be referenced');
  assert.ok(cameraScript < appScript, 'camera bootstrap must load before the TypeScript app');
});

test('plain HTML camera engine owns getUserMedia while TypeScript only bridges to it', () => {
  assert.match(cameraSource, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(cameraSource, /video:\s*true/);
  assert.match(cameraSource, /setAttribute\(['"]playsinline['"]/);
  assert.match(cameraSource, /setAttribute\(['"]webkit-playsinline['"]/);
  assert.doesNotMatch(adapterSource, /getUserMedia\(/);
  assert.match(adapterSource, /VisualCamera/);
  assert.doesNotMatch(mainSource, /getUserMedia\(/);
});

test('camera UI exposes live camera controls without the removed native-photo fallback', () => {
  assert.match(htmlSource, /id=["']cameraOverlayButton["']/);
  assert.match(htmlSource, /id=["']cameraButton["']/);
  assert.doesNotMatch(htmlSource, /nativePhotoButton/);
  assert.doesNotMatch(htmlSource, /nativePhotoInput/);
  assert.doesNotMatch(cameraSource, /nativePhotoInput/);
  assert.doesNotMatch(cameraSource, /loadNativePhoto/);
});

test('standalone camera UI hands off directly to Edge instead of opening another PWA window', () => {
  assert.match(htmlSource, /id=["']cameraBrowserFallback["']/);
  assert.match(mainSource, /cameraBrowserFallback/);
  assert.match(mainSource, /microsoft-edge-https:\/\//);
  assert.doesNotMatch(mainSource, /window\.open\(url\.toString\(\),\s*['"]_blank['"]\)/);
});
test('camera liveness is proved by a decoded frame, not by a live track alone', () => {
  // The iOS failure this guards is a getUserMedia() that resolves with a track
  // reporting readyState "live" while the <video> never receives a frame.
  // readyState and videoWidth are both satisfied by that state, so neither can
  // be the liveness test on its own.
  assert.match(cameraSource, /waitForFirstFrame/);
  assert.match(cameraSource, /requestVideoFrameCallback/);
  assert.match(cameraSource, /currentTime > startTime/);
  assert.match(cameraSource, /frame\.ok/);
  assert.match(cameraSource, /noFramesError/);
});

test('backgrounding releases the camera instead of preserving a corrupt stream', () => {
  assert.match(cameraSource, /addEventListener\(['"]visibilitychange['"]/);
  assert.match(cameraSource, /addEventListener\(['"]pagehide['"]/);
  assert.match(cameraSource, /addEventListener\(['"]pageshow['"]/);
  assert.match(cameraSource, /function suspend\(/);
  assert.match(cameraSource, /suspended/);
});

test('track ended, mute and unmute are all handled', () => {
  for (const event of ['ended', 'mute', 'unmute']) {
    assert.match(cameraSource, new RegExp(`addEventListener\\(['"]${event}['"]`), `missing ${event} handler`);
  }
  assert.match(cameraSource, /MUTE_GRACE_MS/, 'a brief mute must not be treated as failure');
});

test('a hard reset tears down the media element, not just the stream', () => {
  assert.match(cameraSource, /function hardReset\(/);
  assert.match(cameraSource, /video\.srcObject = null/);
  assert.match(cameraSource, /removeAttribute\(['"]src['"]\)/);
  assert.match(cameraSource, /video\.load\(\)/);
  // playsinline/autoplay/muted must be restored before the next request.
  assert.match(cameraSource, /hardReset[\s\S]{0,400}prepareVideo\(\)/);
});

test('there is no automatic camera-request loop', () => {
  // A no-frames failure must end in a reset and a user-driven retry. Calling
  // getUserMedia again straight away can kill the previous stream's video on
  // WebKit and re-prompts in standalone mode, where grants are not persisted.
  assert.match(cameraSource, /if \(!isConstraintError\(lastErrorName\)\) break;/);
  assert.match(cameraSource, /isConstraintError/);
  assert.doesNotMatch(cameraSource, /setInterval\(/);
  assert.doesNotMatch(mainSource, /setInterval\([\s\S]{0,120}startCamera/);
});

test('the app keeps its own URL stable so WebKit cannot drop the capture grant', () => {
  // WebKit binds a capture grant to the top frame document's current URL, so
  // the cache-busting parameter is stripped once at boot, before any camera
  // request, rather than left in the address bar for the whole session.
  assert.match(mainSource, /searchParams\.has\(['"]refresh['"]\)/);
  assert.match(mainSource, /history\.replaceState/);
  // Anchor on the statements themselves, at the start of a line - matching any
  // mention would also hit these identifiers inside comments.
  const stripIndex = mainSource.search(/^\s*history\.replaceState\(/m);
  const subscribeIndex = mainSource.search(/^camera\.subscribe\(applyCameraStatus\);$/m);
  assert.ok(stripIndex >= 0, 'the refresh parameter must be stripped');
  assert.ok(subscribeIndex >= 0, 'the camera status subscription must be wired');
  assert.ok(stripIndex < subscribeIndex, 'the URL must be settled before the camera is wired up');
});

test('the processed canvas layers over the video rather than hiding it', () => {
  // A display:none <video> can stop decoding on WebKit, so a mode switch would
  // otherwise freeze the camera. The overlay canvas is stacked on top instead.
  const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(htmlSource, /id=["']visionCanvas["'][^>]*class=["'][^"']*vision-overlay/);
  assert.match(styles, /\.vision-overlay\s*\{[^}]*position:\s*absolute/);
  assert.doesNotMatch(mainSource, /video\.hidden\s*=/);
});

test('Camera Lab exposes every mode, the zoom controls and the metric readout', () => {
  for (const mode of ['camera', 'relief', 'edges', 'motion', 'flow', 'difference']) {
    assert.match(htmlSource, new RegExp(`data-vision-mode="${mode}"`), `missing ${mode} mode button`);
  }
  for (const id of [
    'zoomSlider',
    'zoomPresets',
    'zoomValue',
    'metricBrightness',
    'metricContrast',
    'metricDetail',
    'metricMotion',
    'metricFps',
    'metricZoom'
  ]) {
    assert.match(htmlSource, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
});

test('hardware zoom is used when exposed and a crop is never called optical', () => {
  assert.match(cameraSource, /getCapabilities/);
  assert.match(cameraSource, /applyConstraints/);
  assert.match(cameraSource, /zoomKind = 'camera'/);
  assert.match(cameraSource, /zoomKind = 'digital'/);
  assert.doesNotMatch(cameraSource, /optical/i);
  assert.doesNotMatch(mainSource, /optical zoom/i);
  // The label follows the mechanism actually in effect.
  assert.match(mainSource, /kind === 'camera'\) return 'Camera'/);
  assert.match(mainSource, /kind === 'digital'\) return 'Digital'/);
});

test('pinch zoom and the slider drive the same zoom state', () => {
  assert.match(mainSource, /installPinchZoom/);
  assert.match(mainSource, /pointerdown/);
  assert.match(mainSource, /pinchStartDistance/);
  // Both paths funnel through requestZoom, which clamps and syncs the slider.
  assert.match(mainSource, /requestZoom\(pinchStartZoom \* scale\)/);
  assert.match(mainSource, /on\('zoomSlider', 'input'/);
  assert.match(mainSource, /clamp\(value, zoomState\.min, zoomState\.max\)/);
});

test('the removed native photo fallback has not come back anywhere', () => {
  for (const source of [htmlSource, mainSource, adapterSource, cameraSource]) {
    assert.doesNotMatch(source, /nativePhoto/i);
    assert.doesNotMatch(source, /Native Photo/i);
    assert.doesNotMatch(source, /capture=["']environment["']/);
  }
});

test('a missing element cannot silently kill the rest of the boot wiring', () => {
  // These used to be bare `byId(...).addEventListener(...)` statements at
  // module top level. One missing id threw, and because everything below is
  // also top level the throw skipped the remaining wiring - including
  // camera.subscribe(applyCameraStatus), which is what makes the camera UI
  // respond at all. The visible symptom is a button that does nothing, with
  // no error the user can see.
  assert.match(mainSource, /function on<K extends keyof HTMLElementEventMap>/);
  assert.match(mainSource, /bootProblems\.push/);
  assert.doesNotMatch(mainSource, /byId<HTMLButtonElement>\('\w+'\)\.addEventListener/);
  assert.doesNotMatch(mainSource, /byId<HTMLSelectElement>\('\w+'\)\.addEventListener/);
  assert.doesNotMatch(mainSource, /byId<HTMLInputElement>\('\w+'\)\.addEventListener/);
  // And the problem is reported rather than swallowed.
  assert.match(mainSource, /bootProblems\.length/);
});

test('the wanted resolution reaches getUserMedia, not just applyConstraints', () => {
  // The setting said 1080p and the very first getUserMedia asked for 720:
  // the height was applied afterwards through applyConstraints, and WebKit
  // will negotiate a live track DOWN but routinely ignores a request to raise
  // it. So every session ran at 720 and every saved frame was a 720p frame.
  assert.match(adapterSource, /setPreferredCaptureHeight\(height: number\): number/);
  assert.match(cameraSource, /setPreferredCaptureHeight\(height\)/);
  const start = mainSource.slice(mainSource.indexOf('async function startCamera'));
  const preferred = start.indexOf('camera.setPreferredCaptureHeight');
  const opened = start.indexOf('await camera.start(');
  assert.ok(preferred > 0, 'the height must be asked for before the stream opens');
  assert.ok(preferred < opened, 'it must come before camera.start');
  // And it must stay synchronous: an await before getUserMedia loses the
  // tap's transient activation and WebKit stops showing the prompt.
  assert.doesNotMatch(
    start.slice(preferred, opened),
    /await/,
    'nothing may be awaited between setting the height and opening the stream'
  );
});

test('the camera reports the ceiling it advertises, not only what it gave', () => {
  // "This camera cannot do more" and "we did not ask for more" look identical
  // from a negotiated size alone, and the second one was the actual bug.
  assert.match(cameraSource, /resolutionCapability/);
  assert.match(cameraSource, /capabilityWidth: resolutionCapability/);
  assert.match(adapterSource, /capabilityWidth: number;/);
  assert.match(mainSource, /advertises up to \$\{diagnostics\.capabilityWidth\}/);
  // Absent capability reporting must read as unknown rather than as zero.
  assert.match(mainSource, /does not expose the camera/);
});

test('the resolution control does not imply it can match the Camera app', () => {
  // getUserMedia yields a video stream. The sensor's 36MP or 48MP still comes
  // from a capture path no web page can reach, and a control that looked like
  // it could would be promising something impossible.
  const help = htmlSource.slice(htmlSource.indexOf('id="captureResolution"'));
  assert.match(help, /VIDEO STREAM/);
  assert.match(help, /will not\s*\n?\s*match the Camera app/);
});

test('camera attempts are logged across reloads, including calls that never settle', () => {
  // In-memory state is wiped by any reload, so diagnostics read after a
  // restart show "idle" regardless of what failed beforehand. The log has to
  // outlive the page for a failure to still be readable afterwards.
  assert.match(cameraSource, /ATTEMPT_LOG_KEY/);
  assert.match(cameraSource, /localStorage\.setItem\(ATTEMPT_LOG_KEY/);
  assert.match(cameraSource, /function beginAttempt\(/);
  assert.match(cameraSource, /function settleAttempt\(/);
  assert.match(cameraSource, /outcome: 'pending'/);

  // The pending record must be written before the request is AWAITED,
  // otherwise a call that never settles leaves no trace at all. It is written
  // just after getUserMedia is invoked, so the storage write cannot delay the
  // permission request itself (see the gesture-ordering test below).
  const fn = cameraSource.slice(cameraSource.indexOf('async function requestStream('));
  const begin = fn.indexOf('beginAttempt(profileIndex)');
  const awaited = fn.indexOf('await pending;');
  assert.ok(begin >= 0 && awaited >= 0);
  assert.ok(begin < awaited, 'the attempt must be recorded before the request is awaited');

  // Failures must be settled before teardown so the track state at the moment
  // of failure is recorded rather than the state after releaseStream().
  const settleFail = cameraSource.indexOf("settleAttempt('failed', error);");
  const release = cameraSource.indexOf('releaseStream();', settleFail);
  assert.ok(settleFail >= 0 && release > settleFail);
});

test('the request stage is visible without opening Settings', () => {
  assert.match(htmlSource, /id=["']cameraStage["']/);
  assert.match(mainSource, /stage: \$\{status\.stage\}/);
  assert.match(htmlSource, /id=["']settingsLastAttempt["']/);
  assert.match(htmlSource, /id=["']copyDiagnosticsButton["']/);
  assert.match(mainSource, /function describeAttempt\(/);
  assert.match(mainSource, /never settled/);
});

test('getUserMedia is invoked before any storage work in the gesture', () => {
  // Nothing may sit between the user's tap and the permission request. The
  // attempt log is written from the returned promise, so the localStorage
  // round-trip happens after the call rather than in front of it.
  const fn = cameraSource.slice(cameraSource.indexOf('async function requestStream('));
  const call = fn.indexOf('navigator.mediaDevices.getUserMedia(constraints)');
  const log = fn.indexOf('beginAttempt(profileIndex)');
  assert.ok(call >= 0 && log >= 0);
  assert.ok(call < log, 'getUserMedia must be invoked before the attempt is logged');
  // And the call must not be awaited before the log write, or the ordering
  // above would be meaningless.
  assert.match(cameraSource, /const pending = navigator\.mediaDevices\.getUserMedia\(constraints\);/);
});

test('a denial that never prompted is reported as an OS-level block', () => {
  // A NotAllowedError returned in milliseconds cannot have involved a prompt
  // a human dismissed, so "allow the prompt" would be useless advice.
  assert.match(cameraSource, /lastFailureMs/);
  assert.match(cameraSource, /lastFailureMs < 400/);
  assert.match(cameraSource, /Screen Time/);
  assert.match(cameraSource, /without showing a permission prompt/);
});

test('the Permissions API state is surfaced when WebKit exposes it', () => {
  assert.match(cameraSource, /navigator\.permissions\.query\(\{ name: 'camera' \}\)/);
  assert.match(cameraSource, /not queryable/);
  assert.match(htmlSource, /id=["']settingsPermission["']/);
});
