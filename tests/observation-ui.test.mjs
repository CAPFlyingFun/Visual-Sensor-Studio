import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const htmlSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const cameraSource = readFileSync(new URL('../public/camera-bootstrap.js', import.meta.url), 'utf8');
const swSource = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

test('analysis is driven by delivered frames, not by the display clock', () => {
  // The old loop was requestAnimationFrame + a wall-clock throttle, so it was
  // capped by the screen's refresh and could not tell a new video frame from
  // the same one presented again.
  assert.match(mainSource, /function onFrameDelivered\(/);
  assert.match(mainSource, /camera\.startFrameDelivery\(onFrameDelivered\)/);
  assert.match(cameraSource, /video\.requestVideoFrameCallback\(tick\)/);
  // A repeated frame must not be analysed.
  assert.match(mainSource, /const isNew = frameRateMeter\.recordDelivered\(frame\);/);
  assert.match(mainSource, /if \(!isNew\) return;/);
});

test('the rAF fallback cannot double-process once real delivery is running', () => {
  assert.match(mainSource, /function fallbackVisionLoop\(/);
  assert.match(mainSource, /if \(deliveryDriven && timestamp - lastDeliveredAt < 1000\) return;/);
});

test('a high frame rate is never requested with an exact constraint', () => {
  // On WebKit an unsatisfiable `exact` fails the whole getUserMedia call, so
  // asking for exact 240 would take the camera down instead of falling back.
  assert.match(cameraSource, /function frameRateConstraint\(/);
  assert.match(cameraSource, /ideal: 240, max: 240/);
  assert.doesNotMatch(cameraSource, /exact:\s*240/);
  assert.doesNotMatch(cameraSource, /frameRate:\s*\{\s*exact:/);
  // The last profile drops the rate request entirely, so an unsupported rate
  // can never be the reason the camera fails to start.
  assert.match(cameraSource, /\{ audio: false, video: true \}/);
});

test('changing frame rate renegotiates the live track without a new getUserMedia', () => {
  const setFrameRate = cameraSource.slice(cameraSource.indexOf('async setFrameRate('));
  const body = setFrameRate.slice(0, setFrameRate.indexOf('\n    },'));
  assert.match(body, /applyConstraints/);
  assert.doesNotMatch(body, /getUserMedia/, 'a rate change must not re-prompt for permission');
});

test('the benchmark runs on the live track and restores the previous rate', () => {
  const bench = cameraSource.slice(cameraSource.indexOf('async benchmarkFrameRates('));
  const body = bench.slice(0, bench.indexOf('\n    get frameRateInfo'));
  assert.doesNotMatch(body, /getUserMedia/, 'benchmarking must not re-prompt or drop the stream');
  assert.match(body, /await this\.setFrameRate\(previous\)/, 'the original rate must be restored');
  // Verdicts must come from measured delivery, not from what the track claims.
  assert.match(body, /measureDelivery/);
  for (const verdict of ['accepted', 'negotiated', 'unsupported', 'unstable']) {
    assert.match(body, new RegExp(`'${verdict}'`), `missing verdict ${verdict}`);
  }
});

test('measured delivery ignores repeated frames', () => {
  const measure = cameraSource.slice(cameraSource.indexOf('function measureDelivery('));
  assert.match(measure, /mediaTime === lastMediaTime/);
  assert.match(measure, /repeated\+\+/);
  // The rate must come from unique frames only.
  assert.match(measure, /\(\(unique - 1\) \* 1000\) \/ span/);
});

test('capability reporting separates unsupported from not exposed', () => {
  // These are different facts: one is the browser saying no, the other is the
  // browser saying nothing. Collapsing them would invent a claim.
  assert.match(cameraSource, /state: 'not exposed'/);
  assert.match(cameraSource, /state: 'unsupported'/);
  assert.match(cameraSource, /state: 'supported'/);
  assert.match(mainSource, /Not exposed/);
});

test('Camera Lab exposes the observation controls', () => {
  for (const id of [
    'cameraFrameRate', 'runBenchmarkButton', 'benchmarkResults', 'capabilityTable',
    'benchCapability', 'benchReported', 'benchMeasured', 'benchProcessing',
    'benchAvgMs', 'benchPeakMs', 'benchSkipped', 'benchAnalysis',
    'trackingToggle', 'zebraToggle', 'focusPeakToggle', 'trailPreference',
    'histogramCanvas', 'nightPanel', 'nightStackMode', 'nightIntegration',
    'nightPalette', 'nightGain', 'nightGamma', 'nightIntegrationState',
    'nightFrames', 'nightStability', 'metricDelivered', 'metricAnalysis',
    'metricAdaptive', 'metricObjects', 'metricFastest', 'metricDropped'
  ]) {
    assert.match(htmlSource, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(htmlSource, /data-vision-mode="night"/);
  for (const seconds of ['0.5', '1', '2', '4', '8', '15', '30']) {
    assert.match(htmlSource, new RegExp(`value="${seconds}"`), `missing ${seconds}s integration option`);
  }
});

test('Adaptive is offered and is the default processing mode', () => {
  assert.match(htmlSource, /<option value="adaptive">Adaptive<\/option>/);
  assert.match(mainSource, /visionRatePreference: 'adaptive'/);
});

test('night mode is never described as infrared', () => {
  for (const source of [htmlSource, mainSource]) {
    assert.doesNotMatch(source, /infrared night vision/i);
    assert.doesNotMatch(source, /night vision goggles/i);
  }
  // It must say what it actually is.
  assert.match(htmlSource, /Computational, not infrared/);
  assert.match(mainSource, /computational low-light, not infrared/);
});

test('object speeds stay in pixels and are never relabelled as physical units', () => {
  // Converting to m/s needs subject distance and lens geometry the app has no
  // access to, so the unit must remain px/sec everywhere it is shown.
  assert.match(mainSource, /px\/s/);
  assert.doesNotMatch(mainSource, /\bmph\b/i);
  assert.doesNotMatch(mainSource, /km\/h/i);
  assert.doesNotMatch(mainSource, /metres per second|meters per second/i);
});

test('tracking consumes analysis output rather than the camera directly', () => {
  // Tracking must sit downstream of the frame source so a future native
  // provider needs no changes here.
  assert.match(mainSource, /tracker\.update\(buffers\.difference/);
  const trackingSource = readFileSync(new URL('../src/vision/tracking.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(trackingSource, /getUserMedia|HTMLVideoElement|MediaStream/);
});

test('the new modules ship in the service worker shell', () => {
  for (const file of [
    'frame-rate.js', 'adaptive.js', 'tracking.js', 'integration.js',
    'histogram.js', 'overlays.js'
  ]) {
    assert.match(swSource, new RegExp(`vision/${file}`), `missing ${file} in the cache list`);
  }
  assert.match(swSource, /sensors\/stability\.js/);
});

test('expensive analysis is skipped when no mode needs it', () => {
  assert.match(mainSource, /function needsMotionAnalysis\(/);
  assert.match(mainSource, /if \(hadPrevious && wantsMotion\)/);
});

test('the digital zoom floor is a single constant and cannot be set below 1', () => {
  // Digital zoom is a centre crop and there is no cropping outward: below 1x
  // there is no more sensor to read. A real 0.5x needs the ultrawide, which is
  // a different physical camera, so it cannot be produced by widening this
  // range. The initial value must match what reset produces, or the engine
  // advertises a range it will never actually offer.
  assert.match(cameraSource, /const DIGITAL_ZOOM_MIN = 1;/);
  assert.doesNotMatch(cameraSource, /zoomMin = 0?\.5/);
  const assignments = [...cameraSource.matchAll(/zoomMin = ([^;]+);/g)].map((m) => m[1].trim());
  for (const value of assignments) {
    assert.ok(
      value === 'DIGITAL_ZOOM_MIN' || value === 'min',
      `zoomMin assigned a literal (${value}); it must come from the constant or from reported capabilities`
    );
  }
});

test('hardware zoom uses whatever minimum the track reports', () => {
  // If a device ever advertises a zoom capability with a min below 1, that
  // value must be honoured rather than clamped to the digital floor.
  const read = cameraSource.slice(cameraSource.indexOf('function readZoomCapabilities('));
  assert.match(read, /zoomMin = min;/);
  assert.match(read, /zoomKind = 'camera';/);
});

test('video inputs are enumerated so lens availability is measured, not assumed', () => {
  assert.match(cameraSource, /async videoInputs\(\)/);
  assert.match(cameraSource, /enumerateDevices/);
  assert.match(mainSource, /async function renderVideoInputs\(/);
  assert.match(htmlSource, /id=["']videoInputs["']/);
  // Labels are withheld until a grant, so an unlabelled list must not be
  // reported as though the device has no other cameras.
  assert.match(mainSource, /Needs permission/);
});

test('the benchmark samples the running delivery loop instead of a second one', () => {
  // Two concurrent requestVideoFrameCallback loops on the same element
  // measured fine in Chromium but returned zero frames for the second one on
  // WebKit, so the benchmark reported "measured 0 fps" for every rate on a
  // device whose camera was plainly working. One loop, one source of truth.
  const measure = cameraSource.slice(cameraSource.indexOf('function measureDelivery('));
  const body = measure.slice(0, measure.indexOf('\n  async function requestStream'));
  assert.match(body, /if \(deliveryListener\) \{/, 'a running loop must be sampled, not duplicated');
  const sampled = body.slice(0, body.indexOf('return new Promise((resolve) => {\n      if (typeof video.requestVideoFrameCallback'));
  assert.doesNotMatch(sampled, /requestVideoFrameCallback/, 'the sampling path must not register another callback');
  assert.match(body, /delivery\.unique - startUnique/);
});

test('a failed measurement is never reported as an unstable camera', () => {
  // Counting no frames is a fault in the measurement, not a verdict on the
  // device. Saying "unstable" would be a claim the data does not support.
  assert.match(cameraSource, /verdict = 'not measured';/);
  assert.match(cameraSource, /!measured\.measurable \|\| measured\.unique === 0/);
  assert.match(mainSource, /measurement failure, not a fault in the camera/);
});

test('a capability with no reported range is not rendered as "undefined"', () => {
  assert.match(mainSource, /Supported · no range reported/);
  assert.match(mainSource, /field\.value !== undefined/);
  assert.doesNotMatch(mainSource, /Supported · \$\{String\(field\.value\)\}`;\s*\}\s*$/m);
});

test('frame delivery is a standing subscription the engine re-arms itself', () => {
  // Every start() begins with releaseStream(), which stops delivery. Callers
  // had to remember to restart it and switchCamera() did not, so switching
  // cameras killed frame delivery permanently while the camera itself carried
  // on looking completely fine.
  assert.match(cameraSource, /persistentDeliveryListener/);
  assert.match(cameraSource, /if \(persistentDeliveryListener\) startFrameDelivery\(persistentDeliveryListener\);/);

  // The re-arm must sit on the success path of start(), after the stream is up.
  const rearm = cameraSource.indexOf('if (persistentDeliveryListener) startFrameDelivery(persistentDeliveryListener);');
  const liveState = cameraSource.indexOf("stage = 'live';", rearm);
  assert.ok(rearm >= 0 && liveState > rearm, 're-arm must happen before the live state is announced');
});

test('the overlay canvas is never shown before it holds a frame', () => {
  // The canvas is opaque and sits on top of the video, so revealing it before
  // anything is drawn covers a working preview with a black rectangle.
  assert.match(mainSource, /let overlayPainted = false;/);
  assert.match(mainSource, /overlayPainted = true;\s*\n\s*if \(visionCanvas\.hidden\) visionCanvas\.hidden = false;/);
  // A mode change invalidates the canvas and must re-hide it.
  assert.match(mainSource, /overlayPainted = false;\s*\n\s*visionCanvas\.hidden = true;\s*\n\s*latestFlow = null;/);
  // Nothing may reveal the canvas outside putBuffer.
  const reveals = [...mainSource.matchAll(/visionCanvas\.hidden = false/g)];
  assert.equal(reveals.length, 1, 'only putBuffer may reveal the overlay');
});

test('a stalled pipeline uncovers the live video instead of freezing a frame', () => {
  assert.match(mainSource, /timestamp - lastVisionFrameAt > 2000/);
  assert.match(mainSource, /A stale overlay is worse than none/);
});

test('the analysis frame is bounded by a pixel budget, not a width', () => {
  // A phone held upright delivers 720x1280; a fixed 256-wide frame becomes
  // 256x455, three times the pixels a landscape frame costs, for no extra
  // information — on the orientation the device is most often in.
  assert.match(mainSource, /function analysisBudget\(\)/);
  assert.match(mainSource, /Math\.sqrt\(budget \* aspect\)/);
  assert.match(mainSource, /256 \* 144/);
});

test('capture failures and delivery state are visible in diagnostics', () => {
  // The frame source swallows capture errors and returns null, so a permanent
  // stall would otherwise leave no trace anywhere.
  assert.match(cameraSource, /captureFailures\+\+/);
  assert.match(cameraSource, /deliveryActive: Boolean\(deliveryListener\)/);
  assert.match(htmlSource, /id=["']benchDelivery["']/);
  assert.match(htmlSource, /id=["']benchCaptureFailures["']/);
});

test('the engine counters also survive a frame identity signal that never changes', () => {
  // The same de-duplication existed in two places. Fixing only the TypeScript
  // meter restored the vision modes but left the benchmark reporting zero,
  // because measureDelivery samples the engine's own counters — which were
  // still reporting "1 unique / 184 repeated" on a camera delivering 60 fps.
  assert.match(cameraSource, /function countDeliveredFrame\(/);
  assert.match(cameraSource, /DELIVERY_REPEAT_LIMIT/);
  assert.match(cameraSource, /delivery\.identityTrusted = false;/);
  // The tick must go through the shared counter, not its own inline compare.
  assert.match(cameraSource, /countDeliveredFrame\(now, mediaTime, metadata \? metadata\.presentedFrames : undefined\)/);
  // And the standalone measurement path needs the same protection.
  assert.match(cameraSource, /repeatStreak < DELIVERY_REPEAT_LIMIT/);
});

test('de-duplication can never permanently gate the pipeline', () => {
  // A repeated frame is not analysed, so any identity signal that gets stuck
  // stops all vision work. Both implementations must be able to give up on it.
  const frameRateSource = readFileSync(new URL('../src/vision/frame-rate.ts', import.meta.url), 'utf8');
  assert.match(frameRateSource, /identityTrusted = false;/);
  assert.match(frameRateSource, /REPEAT_STREAK_LIMIT/);
  assert.match(frameRateSource, /identitySignal/);
  assert.match(htmlSource, /id=["']benchIdentity["']/);
});
