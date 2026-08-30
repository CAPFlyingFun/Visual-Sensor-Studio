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

test('light boost lifts shadows and clamps rather than wrapping', () => {
  const boosted = applyLightBoost(frame(() => [20, 20, 20]), 2, 0.5);
  assert.ok(boosted[0] > 20, 'shadows must lift');
  const clamped = applyLightBoost(frame(() => [250, 250, 250]), 4, 1);
  assert.equal(clamped[0], 255, 'must clamp, not wrap');
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
