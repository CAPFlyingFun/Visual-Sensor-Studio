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
  // It steps aside only while delivery is genuinely producing analysed
  // frames — not merely while callbacks are arriving, which was the flaw that
  // let the net stay switched off through a total stall.
  assert.match(mainSource, /function fallbackVisionLoop\(/);
  assert.match(mainSource, /const deliveryIsWorking = deliveryDriven/);
  assert.match(mainSource, /if \(deliveryIsWorking\) return;/);
});

test('a high frame rate is never requested with an exact constraint', () => {
  // On WebKit an unsatisfiable `exact` fails the whole getUserMedia call, so
  // asking for exact 240 would take the camera down instead of falling back.
  assert.match(cameraSource, /function frameRateConstraint\(/);
  // ideal+max, never exact — and Auto Max asks for the advertised ceiling
  // rather than a fixed 240, since over-asking degrades delivery on real
  // hardware rather than being politely ignored.
  assert.match(cameraSource, /return \{ ideal: target, max: target \};/);
  assert.match(cameraSource, /return \{ ideal: value, max: value \};/);
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
  // Keyed off when a frame was last ANALYSED, not when one was last attempted:
  // an attempt that produced nothing is exactly the stall this guards against.
  assert.match(mainSource, /timestamp - lastAnalysedAt > 2000/);
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

test('the rAF safety net cannot be switched off by discarded callbacks', () => {
  // Before the delivery loop existed, analysis ran on every animation frame
  // and only an inactive camera could stop it — which is why the vision modes
  // were reliable in v0.3.3. The delivery loop made processing conditional on
  // a chain (callback arrives, frame judged new, governor allows, capture
  // succeeds), and the net keyed off "a callback arrived". Callbacks kept
  // arriving and being discarded, so the net was permanently switched off
  // while nothing was processed at all.
  assert.match(mainSource, /lastDeliveryAnalysedAt/);
  const loop = mainSource.slice(mainSource.indexOf('function fallbackVisionLoop('));
  const body = loop.slice(0, loop.indexOf('\n}'));
  assert.match(body, /timestamp - lastDeliveryAnalysedAt < 500/);
  assert.doesNotMatch(body, /lastDeliveredAt/, 'an arriving callback is not evidence of progress');
});

test('the safety net does not switch itself off after its own frames', () => {
  // Keying off the shared lastAnalysedAt made the loop see its own work as
  // proof that delivery was healthy, so it ran once every 500 ms — two frames
  // a second — instead of taking over at the governed rate.
  assert.match(mainSource, /analyseDeliveredFrame\(timestamp, 'fallback'\)/);
  assert.match(mainSource, /analyseDeliveredFrame\(frame\.now, 'delivery'\)/);
  assert.match(mainSource, /if \(source === 'delivery'\) lastDeliveryAnalysedAt = now;/);
});

test('only a genuinely rendered frame counts as analysis', () => {
  // A failed capture must leave the safety net armed rather than satisfied.
  assert.match(mainSource, /function processVisionFrame\(timestamp: number\): boolean/);
  assert.match(mainSource, /if \(!frame\) return false;/);
  assert.match(mainSource, /if \(processVisionFrame\(now\)\) \{/);
});

test('Auto Max asks for the advertised ceiling, not a hopeful 240', () => {
  // Device measurement on a track advertising 1-60: requesting 240 delivered
  // 38.3 fps while 120 delivered 51.6 and 60 delivered 50. Asking for a rate
  // the hardware cannot reach is not free — it destabilises delivery.
  assert.match(cameraSource, /AUTO_FRAME_RATE_FALLBACK = 60;/);
  assert.match(cameraSource, /frameRateCapability\.max\s*\n?\s*:\s*0;/);
  const constraint = cameraSource.slice(cameraSource.indexOf('function frameRateConstraint('));
  const body = constraint.slice(0, constraint.indexOf('\n  }'));
  assert.doesNotMatch(body, /ideal: 240/, 'Auto Max must not blindly request 240');
  // Capabilities are only readable once the track exists, so it re-applies.
  assert.match(cameraSource, /requestedFrameRate === 'auto'\s*\n\s*&& frameRateCapability/);
});

test('every compiled module is served network-first', () => {
  // An enumerated list went stale the moment new modules were added, so a
  // fresh main.js could run against a cached older module — which surfaced as
  // a diagnostics row rendering empty because the field did not exist there.
  assert.match(swSource, /url\.pathname\.includes\('\/app\/'\)/);
  assert.doesNotMatch(swSource, /endsWith\('\/app\/vision\/optical-flow\.js'\)/);
});

test('a missing diagnostic value renders as a placeholder, not an empty box', () => {
  // Assigning undefined to textContent yields an empty element rather than a
  // visible error, so a field gone missing looks like a blank readout.
  assert.match(mainSource, /value === undefined \|\| value === null \? '—' : value/);
});

test('the full-screen viewer re-presents the pipeline rather than duplicating it', () => {
  for (const id of ['cameraViewer', 'viewerCanvas', 'viewerModes', 'viewerZoom', 'viewerShutterButton', 'viewerCloseButton']) {
    assert.match(htmlSource, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(mainSource, /function paintViewer\(/);
  // It must draw the existing output, never capture or analyse its own frames.
  const paint = mainSource.slice(mainSource.indexOf('function paintViewer('));
  const body = paint.slice(0, paint.indexOf('\n}'));
  assert.doesNotMatch(body, /captureFrame|processVisionFrame|getUserMedia/);
  assert.match(body, /viewerContext\.drawImage/);
});

test('manual controls are hidden unless the track advertises them', () => {
  // A control for a capability WebKit does not expose is a button that does
  // nothing, so it is hidden rather than shown disabled.
  assert.match(mainSource, /function syncManualControls\(/);
  assert.match(mainSource, /fields\.torch\?\.state === 'supported'/);
  assert.match(mainSource, /wbWrap\.hidden = wbOptions\.length === 0;/);
  assert.match(mainSource, /focusWrap\.hidden = !hasRange;/);
  // A refused control must say so rather than silently doing nothing.
  assert.match(mainSource, /The torch was refused by the camera/);
});

test('saved frames stay on the device', () => {
  assert.match(mainSource, /async function captureStill\(/);
  assert.match(mainSource, /It stays on this device/);
  assert.doesNotMatch(mainSource, /fetch\([^)]*toBlob|upload/i);
});

test('stills are rendered at camera resolution, not analysis resolution', () => {
  // The on-screen canvas holds the ANALYSIS frame, sized to a pixel budget for
  // real-time processing — 144x256 on a portrait phone. Copying it threw away
  // almost everything the sensor captured, so a saved ceiling fan came out at
  // 144x256. The filter is re-run at the video's native resolution instead.
  assert.match(mainSource, /function grabFullFrame\(/);
  assert.match(mainSource, /function renderStill\(/);
  assert.match(mainSource, /stillContext\.drawImage\(video/);
  const capture = mainSource.slice(mainSource.indexOf('async function captureStill('));
  const body = capture.slice(0, capture.indexOf('\nfunction finishStill'));
  assert.doesNotMatch(body, /drawImage\(usingCanvas \? visionCanvas : video/);
  assert.match(body, /grabFullFrame\(\)/);
});

test('a full-resolution still reproduces a digital crop but not a camera zoom', () => {
  // Camera zoom already happened in the sensor; only a digital crop has to be
  // applied again, exactly as the live capture path does it.
  const grab = mainSource.slice(mainSource.indexOf('function grabFullFrame('));
  const body = grab.slice(0, grab.indexOf('\n}'));
  assert.match(body, /zoomState\.kind === 'digital'/);
  assert.match(body, /const cropX = \(sourceWidth - cropWidth\) \/ 2;/);
});

test('temporal modes capture two frames so the still is a real comparison', () => {
  assert.match(mainSource, /function nextFrame\(/);
  // Every mode whose picture depends on a PAIR of frames has to grab two, or
  // the saved still is a comparison against nothing.
  const capture = mainSource.slice(mainSource.indexOf('async function captureStill'));
  for (const mode of ['motion', 'difference', 'flow']) {
    assert.match(capture, new RegExp(`visionMode === '${mode}'`), `${mode} must grab two frames`);
  }
});

test('a full-size still enlarges the measurement rather than remaking it', () => {
  // Cell size, patch radius and search range all scale with the image, so
  // re-running the flow at full resolution paints the sampling grid as huge
  // flat rectangles — which is exactly what a saved Speed frame looked like.
  assert.match(mainSource, /upscaleSpeedField\(/);
  const still = mainSource.slice(mainSource.indexOf("case 'speed': {"));
  assert.doesNotMatch(still.slice(0, still.indexOf("case 'night'")), /computeBlockFlow/,
    'the speed still must not recompute flow at full resolution');
});

test('a stacked night exposure is saved at its own resolution and said so', () => {
  // The exposure is accumulated at analysis resolution over many frames, so
  // there is no full-resolution version of it. Re-rendering a single frame at
  // full size would be a different picture, not the same one larger.
  assert.match(mainSource, /const stackedNight = visionMode === 'night' && !integrator\.isEmpty;/);
  assert.match(mainSource, /stacked exposure/);
});

test('capture resolution is selectable and the frame-rate trade is reported', () => {
  assert.match(htmlSource, /id=["']captureResolution["']/);
  for (const height of ['720', '1080', '1440', '2160']) {
    assert.match(htmlSource, new RegExp(`value="${height}"`), `missing ${height} option`);
  }
  assert.match(cameraSource, /async setCaptureHeight\(height\)/);
  // ideal, never exact: a resolution the device cannot provide must negotiate
  // down rather than fail the request.
  const setter = cameraSource.slice(cameraSource.indexOf('async setCaptureHeight('));
  const body = setter.slice(0, setter.indexOf('\n    },'));
  assert.match(body, /height: \{ ideal: requestedHeight \}/);
  assert.doesNotMatch(body, /exact:/);
  assert.doesNotMatch(body, /getUserMedia/);
  assert.match(mainSource, /Higher resolutions usually cost frame rate/);
});

test('the full-screen canvas scales to the stage rather than its bitmap size', () => {
  // In a filter mode the viewer canvas takes its bitmap from the analysis
  // frame — 144x256 on a portrait phone — so `width: auto` drew a postage
  // stamp in the middle of a black screen. It must scale to the stage.
  const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const rule = styles.slice(styles.indexOf('.viewer-stage canvas {'));
  const body = rule.slice(0, rule.indexOf('}'));
  assert.match(body, /width:\s*100%/);
  assert.match(body, /height:\s*100%/);
  assert.match(body, /object-fit:\s*contain/);
  assert.doesNotMatch(body, /width:\s*auto/);
});

test('viewer controls float over the preview instead of squeezing it', () => {
  const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const stage = styles.slice(styles.indexOf('.viewer-stage {'));
  assert.match(stage.slice(0, stage.indexOf('}')), /position:\s*absolute/);
  const controls = styles.slice(styles.indexOf('.viewer-controls {'));
  assert.match(controls.slice(0, controls.indexOf('}')), /position:\s*absolute/);
});

test('fit and fill are both offered, and the preview is described honestly', () => {
  assert.match(htmlSource, /id=["']viewerFitButton["']/);
  const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.viewer\[data-fit="fill"\] \.viewer-stage canvas \{ object-fit: cover; \}/);
  // A filter preview really is an upscale of the analysis frame, and the app
  // says so rather than letting it look like lost resolution.
  assert.match(htmlSource, /upscaled from the analysis frame, saved stills are full resolution/);
});

test('each camera the device exposes can be selected directly', () => {
  // An iPhone lists the ultrawide separately from the virtual "Dual Wide"
  // device. Asking the virtual device for zoom 0.5 does not reliably switch
  // lenses — it can scale the wide sensor instead, which cannot add field of
  // view and looks soft at high resolution.
  assert.match(cameraSource, /async selectDevice\(deviceId\)/);
  assert.match(cameraSource, /deviceId: \{ exact: requestedDeviceId \}/);
  assert.match(mainSource, /async function renderLensPicker\(/);
  assert.match(htmlSource, /id=["']lensRow["']/);
  // Fewer than two cameras means nothing to choose between; labels also only
  // exist after a permission grant.
  assert.match(mainSource, /if \(devices\.length < 2\)/);
  assert.match(mainSource, /devices\.filter\(\(device\) => device\.label\)/);
});

test('a pinned camera that vanishes cannot leave the app with none', () => {
  // The device-pinned profiles are followed by the same request without the
  // pin, so an unplugged or renamed camera degrades instead of failing.
  const profiles = cameraSource.slice(cameraSource.indexOf('function buildProfiles('));
  const body = profiles.slice(0, profiles.indexOf('\n  }'));
  // Scoped to the ideal-facing chain: the strict-facing profiles above it are
  // a different fallback ladder and carry no device pin at all.
  const chain = body.slice(body.indexOf('{ ideal: facing }'));
  const pinned = chain.indexOf('}, device)');
  const unpinned = chain.indexOf('}, {})');
  assert.ok(pinned >= 0, 'the pinned request should still be there');
  assert.ok(unpinned > pinned, 'an unpinned fallback must follow the pinned requests');
  assert.match(body, /\{ audio: false, video: true \}/);
});

test('an explicit side change binds the facing and drops the device pin', () => {
  // `ideal` facing is a hint, and a hint the running camera already satisfies
  // leaves the same device selected — a Switch Camera button that does nothing.
  // A pinned deviceId names one physical camera, so carrying it into a request
  // for the other side pins the request back to the camera being left.
  assert.match(cameraSource, /if \(strictFacing\) \{/);
  assert.match(cameraSource, /withRate\(\{ exact: facing \}/);
  assert.match(cameraSource, /await start\(next, null\);/);
  const build = cameraSource.slice(cameraSource.indexOf('function buildProfiles('));
  const body = build.slice(0, build.indexOf('\n  }'));
  assert.ok(body.indexOf('{ exact: facing }') < body.indexOf('{ ideal: facing }'),
    'the exact request must be tried before the ideal fallback');
});

test('the recorded facing comes from the track, not from the request', () => {
  // A constraint is a request, not a result. Believing the request lets the app
  // show one camera while reporting the other, and then the NEXT toggle picks
  // the wrong direction too.
  assert.match(cameraSource, /function readActualFacing\(\)/);
  assert.match(cameraSource, /videoTrack\.getSettings\(\)\.facingMode/);
  assert.match(cameraSource, /readActualFacing\(\);\s*\n\s*stage = 'live';/);
});

test('the camera toggle says which side it will go to', () => {
  assert.match(mainSource, /'Use Rear Camera' : 'Use Front Camera'/);
  assert.match(mainSource, /only one \$\{facing === 'environment' \? 'rear' : 'front'\} camera/);
});

test('a zoom that changes capture geometry is reported', () => {
  // A virtual multi-lens device can answer a zoom request by scaling one
  // sensor rather than switching lenses, and the track keeps reporting the
  // same resolution while the image softens.
  assert.match(mainSource, /Zoom changed the capture size to/);
  assert.match(mainSource, /afterWidth !== beforeWidth/);
});

test('the motion modes are present and never claim to be thermal', () => {
  // A palette borrowed from thermography on a camera with no infrared
  // sensitivity is a lie unless the label says what it actually maps.
  for (const mode of ['speed', 'motiontrails']) {
    assert.match(htmlSource, new RegExp(`data-vision-mode=["']${mode}["']`), `missing ${mode} button`);
  }
  assert.match(mainSource, /speed: 'Motion Ironbow • image speed, not temperature'/);
  assert.match(mainSource, /motiontrails: 'Motion trails • hue = speed, fade = age'/);
  assert.match(htmlSource, /Speed, not temperature/);
  assert.match(htmlSource, /no infrared sensitivity and measures no temperature/);
  assert.doesNotMatch(htmlSource, /\bFLIR\b/);
});

test('the speed legend is filled from the same ramp the pixels use', () => {
  // A legend typed out in CSS stops describing the picture the first time the
  // ramp is touched, and nothing fails when it does.
  assert.match(htmlSource, /id=["']speedLegend["']/);
  assert.match(mainSource, /ironbowColor\(Number\(swatch\.dataset\.speed/);
  assert.match(mainSource, /UNRESOLVED_COLOR\.join/);
});

test('the motion panel reports measured, inferred and unknown separately', () => {
  assert.match(mainSource, /% measured/);
  assert.match(mainSource, /% inferred/);
  assert.match(mainSource, /% unknown/);
});

test('trail controls only appear for the mode that uses them', () => {
  assert.match(mainSource, /#motionExposure, #motionKeepFastest, #motionFadeTrails/);
  for (const id of ['motionExposure', 'motionSensitivity', 'motionKeepFastest',
    'motionFadeTrails', 'motionClearButton', 'motionPeakSpeed', 'motionFullScale']) {
    assert.match(htmlSource, new RegExp(`id=["']${id}["']`), `missing #${id}`);
    assert.match(mainSource, new RegExp(`'${id}'`), `#${id} not referenced by main.ts`);
  }
});

test('an accumulated motion trail is saved at its own resolution', () => {
  // Same case as a night stack: the picture is built over many frames at
  // analysis resolution, so re-rendering one instant at full size would save a
  // different — and empty — picture.
  assert.match(mainSource, /const accumulatedTrail = visionMode === 'motiontrails'/);
  assert.match(mainSource, /motion trail/);
});

test('switching modes clears motion state that belongs to another scene', () => {
  assert.match(mainSource, /motionTrails\.reset\(\);\s*\n\s*speedField\.reset\(\);/);
});

test('the observation snapshot carries its own caveats', () => {
  // A record that travels without them is a record that will eventually be
  // read without them.
  assert.match(mainSource, /limits: \[/);
  assert.match(mainSource, /image speed, not temperature/);
  assert.match(mainSource, /No object identification of any kind is performed/);
});

test('a snapshot saves the numbers, not just the picture', () => {
  // Two trails look identical whether one covered five seconds or sixty, so
  // the image alone is unreadable later.
  assert.match(mainSource, /function buildSnapshot\(\): ObservationSnapshot/);
  assert.match(mainSource, /application\/json/);
  assert.match(mainSource, /drawObservationOverlay\(output, snapshotOverlayLines\(snapshot\)\)/);
  for (const field of ['trailWindowSeconds', 'measuredPercent', 'inferredPercent',
    'unknownPercent', 'fullScaleWidthsPerSecond', 'processingFps']) {
    assert.match(mainSource, new RegExp(field), `snapshot is missing ${field}`);
  }
});

test('freezing holds the trail without stopping the camera', () => {
  assert.match(mainSource, /visionMode === 'motiontrails' && !trailFrozen/);
  assert.match(mainSource, /function setTrailFrozen\(frozen: boolean\)/);
  assert.match(htmlSource, /id=["']motionFreezeButton["']/);
});

test('an event trigger clears the trail so it holds that one event', () => {
  assert.match(mainSource, /if \(update\.started\) \{/);
  assert.match(mainSource, /motionTrails\.reset\(\);\s*\n\s*setTrailFrozen\(false\);/);
  assert.match(mainSource, /setTrailFrozen\(true\);/);
  assert.match(htmlSource, /id=["']motionEventTrigger["']/);
});

test('angular speed is never shown without the field of view it assumed', () => {
  // WebKit exposes no lens geometry, so a degrees-per-second figure with no
  // stated FOV behind it would be a number with no meaning.
  assert.match(mainSource, /'needs a FOV'/);
  assert.match(mainSource, /assumes \$\{settings\.motionFovDegrees\}°/);
  assert.match(mainSource, /assumedHorizontalFovDegrees/);
});

test('the full-screen viewer has a findable camera swap', () => {
  // The control was wired the whole time behind a bare reset arrow, which reads
  // as "undo" rather than "other camera", so it could not be found.
  assert.match(htmlSource, /id=["']viewerSwitchButton["']/);
  assert.match(mainSource, /on\('viewerSwitchButton', 'click'/);
  assert.doesNotMatch(htmlSource, /viewerSwitchButton[^>]*>⟲/);
  assert.match(htmlSource, /id=["']viewerSwitchLabel["']/);
});

test('both camera toggles name the same destination', () => {
  // Two controls for one action disagreeing about which side is live is worse
  // than having only one of them.
  const sync = mainSource.slice(mainSource.indexOf('function syncCameraSwitchLabel'));
  const body = sync.slice(0, sync.indexOf('\n}'));
  assert.match(body, /switchCameraButton/);
  assert.match(body, /viewerSwitchButton/);
  assert.match(body, /viewerSwitchLabel/);
  assert.match(body, /const destination = onFront \? 'rear' : 'front'/);
});

test('auto-start never claims to hold a permission', () => {
  // A page cannot hold, extend or renew a browser permission — that grant
  // belongs to Safari and to iOS. It remembers the intent and acts on it only
  // when the grant is already in place, and the copy has to say so.
  assert.match(htmlSource, /cannot hold or extend a browser permission/);
  assert.match(mainSource, /readPermission\('camera'\)/);
  assert.match(mainSource, /readPermission\('geolocation'\)/);
  for (const id of ['autoStartCamera', 'autoStartGps', 'autoStartMotion', 'autoStartStatus']) {
    assert.match(htmlSource, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
});

test('iOS motion is always treated as needing a gesture', () => {
  // requestPermission() throws outside a user gesture no matter what was
  // granted before, so a stored grant changes nothing for it.
  assert.match(mainSource, /requiresGesture:[\s\S]{0,160}requestPermission/);
});

test('the app restores exactly the sensors it suspended', () => {
  // The pause was the app's decision, not the user's, so leaving a sensor they
  // had running switched off would be the app silently disabling it.
  assert.match(mainSource, /const suspended = \{ gps: false, motion: false \}/);
  assert.match(mainSource, /suspended\.gps = gps\.active/);
  assert.match(mainSource, /suspended\.motion = motion\.active/);
  assert.match(mainSource, /if \(suspended\.gps && !gps\.active\) startGps\(\)/);
  // And it must re-attach listeners rather than re-request permission.
  const resume = mainSource.slice(mainSource.indexOf('function resumeSensors'));
  const body = resume.slice(0, resume.indexOf('\n}'));
  assert.match(body, /motion\.start\(onMotionSample\)/);
  // The CALL, not the word: the comment above it explains why it is absent.
  assert.doesNotMatch(body, /motion\.requestPermission\(/);
  assert.doesNotMatch(body, /enableMotion\(/);
});

test('backgrounding releases the sensors the camera engine does not', () => {
  assert.match(mainSource, /document\.addEventListener\('visibilitychange'[\s\S]{0,200}suspendSensors\(\)/);
  assert.match(mainSource, /window\.addEventListener\('pagehide', suspendSensors\)/);
  assert.match(mainSource, /document\.addEventListener\('freeze', suspendSensors\)/);
});

test('the steady gate is described as suppression, never as stabilisation', () => {
  // It cannot remove camera movement from the picture: once the phone has
  // turned, the pixels have already moved. Claiming otherwise would be selling
  // image stabilisation that does not exist.
  assert.match(htmlSource, /It is a gate, not\s*\n?\s*stabilisation/);
  assert.match(mainSource, /does NOT stabilise the image and cannot/);
  assert.doesNotMatch(htmlSource, /image stabili[sz]ation\b(?![^<]*does not)/i);
});

test('the gate suppresses events without discarding a trail already painted', () => {
  // A pass already recorded is a real observation; throwing it away because the
  // phone was picked up afterwards would lose the thing that was watched for.
  assert.match(mainSource, /const gated = settings\.steadyGate && !!latestMotion && !deviceSteady/);
  assert.match(mainSource, /if \(settings\.motionEventTrigger && !gated\)/);
  assert.match(mainSource, /!trailFrozen && !gated/);
  const gate = mainSource.slice(mainSource.indexOf('const gated ='));
  assert.doesNotMatch(gate.slice(0, 400), /motionTrails\.reset/);
});

test('a calibration is a deliberate act with a stated length', () => {
  assert.match(mainSource, /const CALIBRATION_MS = 10_000/);
  assert.match(htmlSource, /id=["']calibrateButton["']/);
  assert.match(htmlSource, /id=["']clearCalibrationButton["']/);
  assert.match(mainSource, /MIN_CALIBRATION_SAMPLES|Too few samples to trust/);
});


test('speed is estimated per pixel, not per block', () => {
  // A block search resolved about sixteen samples across a 256-pixel frame,
  // which read as a grid — worst on the front camera, where fewer cells carry
  // enough texture to match at all. Difference always looked sharper for
  // exactly this reason: it was per-pixel and Speed was not.
  assert.match(mainSource, /const wantsFlow = visionMode === 'flow';/);
  const call = mainSource.slice(mainSource.indexOf('latestSpeed = speedField.update('));
  const args = call.slice(0, call.indexOf(');'));
  assert.match(args, /buffers\.difference/);
  assert.match(args, /buffers\.gray/);
  assert.doesNotMatch(args, /latestFlow/, 'the speed field must not take a block-flow field');
});

test('a clipped speed is reported as a floor, not as a reading', () => {
  // The linearisation degrades past a few pixels, so fast motion is understated.
  // Hiding that would turn a clipped estimate into a confident slow number.
  assert.match(mainSource, /saturatedFraction/);
  assert.match(mainSource, /faster than this method resolves/);
  assert.match(htmlSource, /id=["']motionSaturated["']/);
});

test('calibration is reachable without opening Settings', () => {
  for (const id of ['motionCalibrateButton', 'motionSteadyToggle', 'motionCalibrationHint']) {
    assert.match(htmlSource, new RegExp(`id=["']${id}["']`), `missing #${id}`);
    assert.match(mainSource, new RegExp(`'${id}'`), `#${id} not referenced by main.ts`);
  }
  // Both copies of the control have to move together, or one of them lies.
  assert.match(mainSource, /function setCalibrateLabel\(label: string\)/);
  const label = mainSource.slice(mainSource.indexOf('function setCalibrateLabel'));
  const body = label.slice(0, label.indexOf('\n}'));
  assert.match(body, /'calibrateButton'/);
  assert.match(body, /'motionCalibrateButton'/);
});

test('a rotated parallax pair is refused rather than turned into a distance', () => {
  // Rotation shifts every pixel regardless of how far away it is, so a rotated
  // pair reads as "everything is close". Reporting a distance from that would
  // be worse than reporting nothing.
  assert.match(mainSource, /rotationDegrees > MAX_BASELINE_ROTATION_DEGREES/);
  assert.match(mainSource, /mostly rotation rather than parallax/);
});

test('parallax distinguishes not-measured from measured-as-zero', () => {
  assert.match(mainSource, /lastBaseline = motion\.active \? baseline\.estimate : null/);
  assert.match(mainSource, /enable motion sensors to measure the baseline/);
  assert.match(mainSource, /parallaxBaseline: lastBaseline \?/);
});

test('a triangulated depth never travels without its uncertainty', () => {
  // A distance quoted bare invites being read as a measurement.
  assert.match(mainSource, /depthUncertaintyMetres\(depth, estimate\)/);
  assert.match(mainSource, /±\$\{error\.toFixed\(2\)\} m/);
  assert.match(mainSource, /not rectified, so treat this as an estimate/);
  assert.match(mainSource, /assuming \$\{settings\.motionFovDegrees\}° horizontal field of view/);
});

test('the baseline stops being integrated once the pair is captured', () => {
  const analyze = mainSource.slice(mainSource.indexOf('function analyzeParallax'));
  assert.match(analyze.slice(0, 2500), /baseline\.stop\(\)/);
  assert.match(mainSource, /baseline\.start\(\)/);
});

test('the time layers are present and say what they do', () => {
  for (const mode of ['amplify', 'background', 'chrono', 'slitscan']) {
    assert.match(htmlSource, new RegExp(`data-vision-mode=["']${mode}["']`), `missing ${mode}`);
  }
  // Amplification magnifies noise along with movement, and a mode that hid
  // that would have people reading sensor grain as a discovery.
  assert.match(mainSource, /small movement magnified, noise with it/);
  assert.match(mainSource, /noise is amplified too/);
  assert.match(mainSource, /red oldest, blue newest, grey means still/);
  assert.match(mainSource, /left to right is time/);
});

test('a background is learned before it is subtracted', () => {
  // Subtracting a model built from two frames flags the entire scene.
  assert.match(mainSource, /Learning the scene…/);
  const layers = readFileSync(new URL('../src/vision/layers.ts', import.meta.url), 'utf8');
  assert.match(layers, /BACKGROUND_WARMUP/);
  assert.match(layers, /this\.frames >= BACKGROUND_WARMUP && delta > threshold/);
});

test('every time layer restarts when the mode changes', () => {
  // An accumulation gathered while pointing somewhere else is not this mode's
  // picture.
  for (const fn of ['amplifier.reset()', 'backgroundModel.reset()',
    'chronochrome.reset()', 'slitScan.reset()']) {
    assert.ok(mainSource.includes(fn), `${fn} must run on a mode change`);
  }
});

test('a layer control is never shown for a layer it cannot affect', () => {
  assert.match(mainSource, /byId\('layerControls'\)\.hidden = visible === 0/);
  assert.match(mainSource, /showing\[input\.id\] !== mode/);
});

test('terrain says exactly what leaves the device', () => {
  // The only network request the app makes, and the first thing derived from
  // location to leave at all. A vague claim here would be the worst kind.
  assert.match(htmlSource, /only part of the app that uses the network/);
  assert.match(htmlSource, /never a latitude,\s*\n?\s*a longitude, an accuracy or an identifier/);
  const loader = readFileSync(new URL('../src/terrain/loader.ts', import.meta.url), 'utf8');
  assert.match(loader, /credentials: 'omit'/);
  assert.match(loader, /referrerPolicy: 'no-referrer'/);
  // The URL may carry only zoom and tile indices. Scoped to the function that
  // builds it — the file's prose necessarily mentions latitude and longitude to
  // explain what is NOT sent.
  const build = loader.slice(loader.indexOf('export function tileUrl'));
  const body = build.slice(0, build.indexOf('\n}'));
  assert.match(body, /\$\{TILE_HOST\}\/\$\{z\}\/\$\{x\}\/\$\{y\}\.png/);
  assert.doesNotMatch(body, /lat|lon|accuracy|id/i);
  // And nothing else in the file may construct a request URL at all.
  assert.equal((loader.match(/fetchImpl\(/g) ?? []).length, 1);
  assert.match(loader, /fetchImpl\(tileUrl\(tile\.z, tile\.x, tile\.y\)/);
});

test('a location can be entered by hand so GPS is never consulted', () => {
  assert.match(htmlSource, /id=["']terrainLat["']/);
  assert.match(htmlSource, /id=["']terrainLon["']/);
  assert.match(htmlSource, /GPS is never consulted at all/);
  assert.match(mainSource, /the location you entered/);
});

test('a tile that never answers cannot stall the whole load', () => {
  const loader = readFileSync(new URL('../src/terrain/loader.ts', import.meta.url), 'utf8');
  assert.match(loader, /TILE_TIMEOUT_MS/);
  assert.match(loader, /new AbortController\(\)/);
  assert.match(loader, /signal: abort\.signal/);
  assert.match(loader, /clearTimeout\(timer\)/);
});

test('a missing tile is a hole in the map, not a failed load', () => {
  // Ocean tiles genuinely do not exist in this dataset, so rejecting the whole
  // load over a 404 would mean no map at any coastline.
  const loader = readFileSync(new URL('../src/terrain/loader.ts', import.meta.url), 'utf8');
  assert.match(loader, /progress\.failed\+\+/);
  assert.match(mainSource, /open ocean genuinely has no tiles/);
});

test('terrain resolution is stated rather than implied by the render', () => {
  // A 512-pixel map drawn from 30 m data invites being read as 30 cm data.
  assert.match(mainSource, /roughly 30 m resolution — good for a hillside, not for a kerb/);
  assert.match(htmlSource, /id=["']terrainResolution["']/);
});

test('terrain is placed in the same space the GPS track uses', () => {
  // A mesh in its own coordinates sits beside the track rather than under it,
  // and the error is invisible until the path floats off the hillside.
  const mesh = readFileSync(new URL('../src/terrain/mesh.ts', import.meta.url), 'utf8');
  assert.match(mesh, /gpsToLocalMeters/);
  assert.match(mesh, /x east, y up, z NEGATIVE north/);
  // The mesh is built around the TRACK's origin where one exists.
  assert.match(mainSource, /const trackOrigin = gps\.track\[0\]/);
});

test('the vertical datum is the elevation at the origin, not the field centre', () => {
  // A tile window is quantised to tile boundaries, so those are different
  // places — the centre put the datum 1450 m below a summit.
  const mesh = readFileSync(new URL('../src/terrain/mesh.ts', import.meta.url), 'utf8');
  assert.match(mesh, /projectToField\(field, originLon, originLat\)/);
  assert.doesNotMatch(mesh, /originPixel = \{[\s\S]{0,80}field\.width - 1\) \/ 2/);
});

test('the position marker is scaled to the terrain it sits on', () => {
  // A 2.7-unit phone against kilometres of ground is one pixel, which defeats
  // the point of showing where you are on it.
  const scene = readFileSync(new URL('../src/visualization/scene.ts', import.meta.url), 'utf8');
  assert.match(scene, /phoneGroup\.scale\.setScalar\(markerScale\)/);
  assert.match(scene, /this\.beacon = new THREE\.Line/);
  assert.match(scene, /fog: false/);
  // And it goes back to desk scale when terrain is removed.
  assert.match(scene, /phoneGroup\.scale\.setScalar\(this\.phoneBaseScale\)/);
});

test('the app never claims a surface the 3D view could not draw', () => {
  // The fallback bridge exists for a blocked CDN or an old WebGL stack.
  assert.match(mainSource, /readonly available: boolean/);
  assert.match(mainSource, /available: false/);
  assert.match(mainSource, /if \(!fusion\.available\)/);
  assert.match(mainSource, /The 3D view could not load, so there is nowhere to put the/);
});

test('terrain reports the area actually fetched, not the area requested', () => {
  // A tile window rounds out to whole tiles, so the two differ and the 2D and
  // 3D readouts would otherwise disagree with each other.
  assert.match(mainSource, /rounded out to whole tiles/);
  assert.match(mainSource, /coveredMiles/);
});

test('GPS altitude and terrain elevation are shown as different things', () => {
  // They disagree for real reasons — ellipsoid against geoid, and GPS vertical
  // error is several times its horizontal error. Quietly picking one hides it.
  assert.match(mainSource, /they use different vertical references/);
  assert.match(htmlSource, /id=["']terrainDatumGap["']/);
});
