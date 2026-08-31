import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameIntegrator } from '../.test-build/vision/integration.js';
import { computeHistogram, createHistogram } from '../.test-build/vision/histogram.js';
import { applyFocusPeaking, applyLightBoost, applyPalette, applyZebra } from '../.test-build/vision/overlays.js';
import { StabilityMonitor } from '../.test-build/sensors/stability.js';

const W = 8;
const H = 4;

function frame(fill) {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const [r, g, b] = fill(i);
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

test('Clean averages frames, so noise falls away and signal stays', () => {
  const integrator = new FrameIntegrator('clean');
  // A constant 100 with alternating +/-20 noise averages back to 100.
  for (let i = 0; i < 20; i++) {
    integrator.addFrame(frame(() => [100 + (i % 2 ? 20 : -20), 100, 100]), W, H, i * 50);
  }
  const out = integrator.render();
  assert.ok(Math.abs(out[0] - 100) <= 1, `expected ~100, got ${out[0]}`);
  assert.equal(integrator.framesIntegrated, 20);
});

test('Light Trails keeps the brightest value each pixel ever showed', () => {
  const integrator = new FrameIntegrator('trails');
  // A bright dot sweeps across a dark field; every position must persist.
  for (let step = 0; step < W; step++) {
    integrator.addFrame(frame((i) => (i === step ? [255, 255, 255] : [10, 10, 10])), W, H, step * 50);
  }
  const out = integrator.render();
  for (let step = 0; step < W; step++) {
    assert.equal(out[step * 4], 255, `position ${step} must remain lit`);
  }
});

test('Brighten lifts a dim signal above its single-frame level', () => {
  const integrator = new FrameIntegrator('brighten');
  for (let i = 0; i < 30; i++) {
    integrator.addFrame(frame((p) => (p === 0 ? [12, 12, 12] : [2, 2, 2])), W, H, i * 50);
  }
  const out = integrator.render();
  assert.ok(out[0] > 200, `dim signal should emerge, got ${out[0]}`);
  assert.ok(out[0] > out[4], 'the brighter pixel must stay brighter');
});

test('memory stays constant however long the exposure runs', () => {
  const integrator = new FrameIntegrator('clean');
  for (let i = 0; i < 600; i++) integrator.addFrame(frame(() => [80, 80, 80]), W, H, i * 50);
  assert.equal(integrator.framesIntegrated, 600);
  // Rendering into a caller buffer must reuse it rather than allocate.
  const buffer = new Uint8ClampedArray(W * H * 4);
  assert.equal(integrator.render(buffer), buffer);
});

test('a target duration ends the exposure', () => {
  const integrator = new FrameIntegrator('clean', 1000);
  assert.equal(integrator.addFrame(frame(() => [50, 50, 50]), W, H, 0), true);
  assert.equal(integrator.addFrame(frame(() => [50, 50, 50]), W, H, 500), true);
  assert.equal(integrator.addFrame(frame(() => [50, 50, 50]), W, H, 1500), false);
  assert.ok(integrator.report(1500).complete);
});

test('changing mode resets the accumulator', () => {
  const integrator = new FrameIntegrator('clean');
  integrator.addFrame(frame(() => [200, 200, 200]), W, H, 0);
  integrator.setMode('trails');
  assert.equal(integrator.framesIntegrated, 0);
  assert.ok(integrator.isEmpty);
});

test('histogram counts luminance and flags clipping', () => {
  const histogram = createHistogram();
  // Half the pixels blown out, half black.
  computeHistogram(frame((i) => (i % 2 === 0 ? [255, 255, 255] : [0, 0, 0])), histogram);
  assert.equal(histogram.totalPixels, W * H);
  assert.equal(histogram.luminance[255], W * H / 2);
  assert.equal(histogram.luminance[0], W * H / 2);
  assert.ok(Math.abs(histogram.clippedFraction - 0.5) < 0.001);
  assert.ok(Math.abs(histogram.crushedFraction - 0.5) < 0.001);
});

test('histogram bins are reused rather than reallocated', () => {
  const histogram = createHistogram();
  const bins = histogram.luminance;
  computeHistogram(frame(() => [10, 10, 10]), histogram);
  computeHistogram(frame(() => [200, 200, 200]), histogram);
  assert.equal(histogram.luminance, bins, 'the same array must be reused');
  assert.equal(histogram.luminance[10], 0, 'stale counts must be cleared');
});

test('palettes only change appearance and monochrome equalises channels', () => {
  const natural = frame(() => [200, 40, 20]);
  assert.equal(applyPalette(natural, 'natural'), natural);

  const mono = applyPalette(frame(() => [200, 40, 20]), 'monochrome');
  assert.equal(mono[0], mono[1]);
  assert.equal(mono[1], mono[2]);

  // Green is a display palette, not infrared: it is dominated by the green
  // channel and carries no information the sensor did not capture.
  const green = applyPalette(frame(() => [200, 40, 20]), 'green');
  assert.ok(green[1] > green[0] && green[1] > green[2]);
});

test('light boost lifts shadows and stays in range rather than wrapping', () => {
  const boosted = applyLightBoost(frame(() => [20, 20, 20]), 2, 0.5);
  assert.ok(boosted[0] > 20, 'shadows must lift');
  const bright = applyLightBoost(frame(() => [250, 250, 250]), 4, 1);
  assert.ok(bright[0] > 200 && bright[0] <= 255, `in range, got ${bright[0]}`);
});

test('no setting can flatten the tonal range', async () => {
  // This is the failure it was written for. With a hard clip, a gain of 4 sent
  // 192 of the 256 input levels to exactly 255 — three quarters of the range
  // collapsed into one value. A picture survives that; an edge map, a frame
  // difference and a speed field do not, because all three read GRADIENTS and
  // a plateau has none. Every filter went black at high brightness.
  const { lightBoostCurve } = await import('../.test-build/vision/overlays.js');

  for (const [gain, gamma] of [[1, 1], [2, 1], [4, 1], [4, 2.2], [2.5, 0.4]]) {
    let clipped = 0;
    let previous = -1;
    for (let i = 0; i < 256; i++) {
      const out = lightBoostCurve(i / 255, gain, gamma);
      assert.ok(out >= 0 && out <= 1, `out of range at ${i}: ${out}`);
      assert.ok(out >= previous, `curve must never decrease (gain ${gain}, gamma ${gamma})`);
      previous = out;
      if (out >= 1) clipped++;
    }
    assert.ok(clipped <= 1, `gain ${gain} gamma ${gamma} flattened ${clipped} levels to white`);
  }
});

test('the default setting is exactly the identity', async () => {
  // A shoulder that engaged at rest would subtly roll off every picture the
  // app has ever shown, to fix a problem nobody had yet.
  const { lightBoostCurve } = await import('../.test-build/vision/overlays.js');
  for (const i of [0, 32, 64, 128, 192, 255]) {
    assert.ok(Math.abs(lightBoostCurve(i / 255, 1, 1) * 255 - i) < 1e-6,
      `${i} should pass through untouched`);
  }
});

test('brightening still genuinely brightens', async () => {
  // A shoulder that protected the range by refusing to brighten would be a
  // control that does nothing.
  const { lightBoostCurve } = await import('../.test-build/vision/overlays.js');
  const midtone = (gain) => Math.round(lightBoostCurve(128 / 255, gain, 1) * 255);
  assert.ok(midtone(2) > 190, `gain 2 should lift a midtone well past 128, got ${midtone(2)}`);
  assert.ok(midtone(4) > midtone(2), 'and more gain should lift it further');
});

test('zebra marks clipped pixels and leaves correct ones alone', () => {
  const dark = applyZebra(frame(() => [10, 10, 10]), W, H, 0.95);
  assert.equal(dark[0], 10, 'a correctly exposed pixel must not be marked');

  const blown = applyZebra(frame(() => [255, 255, 255]), W, H, 0.95);
  let marked = 0;
  for (let i = 0; i < W * H; i++) if (blown[i * 4 + 1] === 40) marked++;
  assert.ok(marked > 0, 'clipped pixels must be marked');
  assert.ok(marked < W * H, 'stripes must leave detail visible between them');
});

test('focus peaking highlights only strong edges', () => {
  const edges = new Uint8ClampedArray(W * H);
  edges[3] = 220;
  const out = applyFocusPeaking(frame(() => [60, 60, 60]), edges, 90);
  assert.ok(out[3 * 4 + 2] > 120, 'a strong edge must be highlighted');
  assert.equal(out[0], 60, 'a flat area must be untouched');
});

test('stability separates a resting phone from a moving one', () => {
  const monitor = new StabilityMonitor();
  let report;
  // Sensor noise on a table must still read as stable.
  for (let i = 0; i < 90; i++) {
    report = monitor.update({
      rotationRate: { alpha: 0.2, beta: -0.1, gamma: 0.15 },
      acceleration: { x: 0.01, y: -0.02, z: 0.01 }
    });
  }
  assert.ok(report.score > 0.95, `resting score ${report.score}`);
  assert.ok(report.tripod, 'a resting phone should register as tripod-stable');
  assert.ok(!report.disturbed);

  // A knock must drop the score immediately.
  report = monitor.update({
    rotationRate: { alpha: 40, beta: 30, gamma: 20 },
    acceleration: { x: 3, y: 2, z: 1 }
  });
  assert.ok(report.score < 0.3, `disturbed score ${report.score}`);
  assert.ok(report.disturbed);
  assert.ok(!report.tripod, 'tripod status must be lost at once');
});

test('trust returns slowly after a disturbance', () => {
  const monitor = new StabilityMonitor();
  monitor.update({ rotationRate: { alpha: 50, beta: 50, gamma: 50 }, acceleration: { x: 4, y: 4, z: 4 } });
  const still = { rotationRate: { alpha: 0.1, beta: 0.1, gamma: 0.1 }, acceleration: { x: 0, y: 0, z: 0 } };
  const afterFive = [0, 1, 2, 3, 4].reduce((_, __) => monitor.update(still), null);
  assert.ok(afterFive.score < 0.6, `recovery must be gradual, got ${afterFive.score}`);
  assert.ok(!afterFive.tripod, 'tripod must not come back instantly');
});

test('an exposure starting at time zero is timed correctly', () => {
  // performance.now() is legitimately near zero just after page load, so a
  // zero sentinel for "not started" would move the start to the second frame
  // and silently stretch the exposure by one frame interval.
  const integrator = new FrameIntegrator('clean', 1000);
  assert.equal(integrator.addFrame(frame(() => [50, 50, 50]), W, H, 0), true);
  assert.equal(integrator.report(0).elapsedMs, 0);
  assert.equal(integrator.addFrame(frame(() => [50, 50, 50]), W, H, 900), true);
  assert.equal(integrator.report(900).elapsedMs, 900, 'elapsed must be measured from the first frame');
  assert.equal(integrator.addFrame(frame(() => [50, 50, 50]), W, H, 1200), false);
});

// --- Handshake calibration -------------------------------------------------

test('a calibration refuses to be built from too few samples', async () => {
  // A deadzone decides what to IGNORE, so one derived from four samples of
  // noise would silently discard real movement.
  const { StabilityCalibrator } = await import('../.test-build/sensors/stability.js');
  const cal = new StabilityCalibrator();
  cal.start(0);
  for (let i = 0; i < 5; i++) cal.add(sampleAt(0.2), i * 16);
  assert.equal(cal.finish(80), null);
  assert.equal(cal.running, false, 'a refused calibration must not stay armed');
});

test('a calibration measures this device rather than assuming a constant', async () => {
  const { StabilityCalibrator } = await import('../.test-build/sensors/stability.js');
  const cal = new StabilityCalibrator();
  cal.start(0);
  // A hand with a steady tremor around 0.9 deg/sec.
  for (let i = 0; i < 60; i++) cal.add(sampleAt(0.8 + (i % 5) * 0.05), i * 16);
  const result = cal.finish(60 * 16);

  assert.ok(result, 'sixty samples is plenty');
  assert.ok(result.rotation.min < result.rotation.mean);
  assert.ok(result.rotation.mean < result.rotation.max);
  assert.ok(result.rotation.standardDeviation > 0);
  assert.equal(result.samples, 60);
  assert.ok(result.durationMs > 900 && result.durationMs < 1000);
  // The deadzone must sit at or above everything actually observed, or the
  // tremor it was measured from would trip it.
  assert.ok(result.rotationDeadzone >= result.rotation.max,
    `deadzone ${result.rotationDeadzone} must cover the observed max ${result.rotation.max}`);
});

test('a shakier hand produces a wider deadzone', async () => {
  // The entire point: the threshold belongs to this phone in this grip.
  const { StabilityCalibrator } = await import('../.test-build/sensors/stability.js');
  const measure = (spread) => {
    const cal = new StabilityCalibrator();
    cal.start(0);
    for (let i = 0; i < 60; i++) cal.add(sampleAt(1 + (i % 7) * spread), i * 16);
    return cal.finish(960).rotationDeadzone;
  };
  assert.ok(measure(0.4) > measure(0.02), 'a shakier calibration must tolerate more');
});

test('the steady gate uses the measured deadzone when there is one', async () => {
  const { isSteady } = await import('../.test-build/sensors/stability.js');
  const calibration = {
    rotation: { min: 0, mean: 1, max: 2, standardDeviation: 0.3 },
    acceleration: { min: 9.7, mean: 9.8, max: 9.9, standardDeviation: 0.05 },
    rotationDeadzone: 2.5,
    accelerationDeadzone: 0.4,
    samples: 60,
    durationMs: 1000,
    capturedAt: 0
  };
  const report = (rotation, acceleration = 9.8) => ({
    score: 1, tripod: false, disturbed: false,
    rotationMagnitude: rotation, accelerationMagnitude: acceleration
  });

  // A tremor inside the measured floor is not movement.
  assert.equal(isSteady(report(2.0), calibration), true);
  // Past it, it is.
  assert.equal(isSteady(report(3.0), calibration), false);
  // Acceleration is judged as DEVIATION from rest, not as an absolute level:
  // the platform reports it including gravity, so a still phone reads ~9.8 and
  // an absolute threshold would be measuring the planet.
  assert.equal(isSteady(report(1.0, 9.8), calibration), true, 'resting is steady');
  assert.equal(isSteady(report(1.0, 9.85), calibration), true, 'small drift is steady');
  // A shove, without any turn at all.
  assert.equal(isSteady(report(1.0, 11.2), calibration), false);
  assert.equal(isSteady(report(1.0, 8.4), calibration), false, 'a drop counts too');

  // With no calibration it falls back to the built-in guess, which is far
  // tighter, so the same 2.0 deg/sec now reads as movement.
  assert.equal(isSteady(report(2.0), null), false);
});

test('excursion rises past the deadzone and stays flat inside it', async () => {
  const { excursion } = await import('../.test-build/sensors/stability.js');
  const calibration = { rotationDeadzone: 2, accelerationDeadzone: 1 };
  const report = (rotation) => ({
    score: 1, tripod: false, disturbed: false,
    rotationMagnitude: rotation, accelerationMagnitude: 0
  });
  assert.equal(excursion(report(0.5), calibration), 0);
  assert.equal(excursion(report(2), calibration), 0);
  assert.equal(excursion(report(4), calibration), 1);
  assert.ok(excursion(report(8), calibration) > excursion(report(4), calibration));
});

function sampleAt(rotation) {
  // Split across three axes so the magnitude is the value asked for.
  const per = rotation / Math.sqrt(3);
  return {
    rotationRate: { alpha: per, beta: per, gamma: per },
    acceleration: { x: 0.02, y: 0.02, z: 0.02 }
  };
}

test('an acceleration deadzone is a deviation from rest, not an absolute level', async () => {
  // The platform reports acceleration including gravity wherever it can, so a
  // phone sitting still reads about 9.8 on every axis arrangement. A threshold
  // on the absolute magnitude would be a threshold on gravity.
  const { StabilityCalibrator, isSteady } = await import('../.test-build/sensors/stability.js');
  const cal = new StabilityCalibrator();
  cal.start(0);
  for (let i = 0; i < 60; i++) {
    const g = 9.8 + (i % 4) * 0.01;
    cal.add({
      rotationRate: { alpha: 0.5, beta: 0.5, gamma: 0.5 },
      acceleration: { x: g, y: 0, z: 0 }
    }, i * 16);
  }
  const result = cal.finish(960);

  assert.ok(result.accelerationDeadzone < 1,
    `a deviation budget, not ~9.8: got ${result.accelerationDeadzone}`);
  assert.ok(result.acceleration.mean > 9,
    'the resting level is still recorded, because the deviation is measured from it');

  const at = (magnitude) => isSteady({
    score: 1, tripod: false, disturbed: false,
    rotationMagnitude: 0.5, accelerationMagnitude: magnitude
  }, result);
  assert.equal(at(9.8), true, 'resting must read as steady');
  assert.equal(at(12), false, 'a real shove must not');
});
