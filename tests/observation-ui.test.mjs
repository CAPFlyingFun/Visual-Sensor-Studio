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
