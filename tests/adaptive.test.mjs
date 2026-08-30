import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveGovernor } from '../.test-build/vision/adaptive.js';

const still = {
  motionScore: 0, fastestObjectPxPerSec: 0, objectCount: 0, flowMagnitudePx: 0,
  processingCostMs: 3, deliveredFps: 60, droppedFrames: 0
};
const fast = {
  motionScore: 0.5, fastestObjectPxPerSec: 120, objectCount: 1, flowMagnitudePx: 6,
  processingCostMs: 3, deliveredFps: 60, droppedFrames: 0
};

/** Run the governor for a period, returning the final target rate. */
function run(governor, inputs, seconds, startAt = 0, stepMs = 33) {
  let now = startAt;
  const end = startAt + seconds * 1000;
  let fps = governor.targetFps;
  while (now <= end) {
    fps = governor.update(inputs, now);
    now += stepMs;
  }
  return fps;
}

test('a still scene settles at the floor', () => {
  const governor = new AdaptiveGovernor();
  const fps = run(governor, still, 6);
  assert.ok(fps <= 10, `expected the floor, got ${fps}`);
  assert.equal(governor.state, 'idle');
});

test('object speed sets the rate from pixels travelled per frame', () => {
  const governor = new AdaptiveGovernor({ targetPixelsPerFrame: 2 });
  // 120 px/sec at 2 px per analysed frame wants ~60 fps.
  const demand = governor.demandFor({ ...still, fastestObjectPxPerSec: 120 });
  assert.ok(Math.abs(demand - 60) < 6, `expected ~60, got ${demand}`);
  // Half the speed wants half the rate.
  const slower = governor.demandFor({ ...still, fastestObjectPxPerSec: 60 });
  assert.ok(Math.abs(slower - 30) < 6, `expected ~30, got ${slower}`);
});

test('ramp up is much faster than ramp down', () => {
  const up = new AdaptiveGovernor();
  const afterHalfSecond = run(up, fast, 0.5);
  assert.ok(afterHalfSecond > 35, `expected a fast climb, got ${afterHalfSecond} after 0.5 s`);

  const down = new AdaptiveGovernor();
  run(down, fast, 3);
  const high = down.targetFps;
  assert.ok(high > 40, `expected a high rate first, got ${high}`);
  const afterStopping = run(down, still, 0.5, 3000);
  assert.ok(afterStopping < high, 'the rate must fall when motion stops');
  assert.ok(afterStopping > 20, `expected a gradual fall, got ${afterStopping} after 0.5 s`);
});

test('the rate never exceeds the measured delivered frame rate', () => {
  const governor = new AdaptiveGovernor();
  // A very fast object, but the camera only delivers 30 distinct frames.
  const fps = run(governor, { ...fast, fastestObjectPxPerSec: 900, deliveredFps: 30 }, 4);
  assert.ok(fps <= 30.5, `must not exceed delivery, got ${fps}`);
});

test('an expensive analysis caps the rate to what the device can sustain', () => {
  const governor = new AdaptiveGovernor();
  // 25 ms per analysis cannot sustain more than 40 fps, and the ceiling
  // reserves headroom below that.
  const fps = run(governor, { ...fast, fastestObjectPxPerSec: 900, processingCostMs: 25 }, 4);
  assert.ok(fps <= 29, `expected a cost-limited rate, got ${fps}`);
});

test('hysteresis keeps a borderline scene from oscillating', () => {
  const governor = new AdaptiveGovernor();
  run(governor, fast, 3);
  const samples = [];
  let now = 3000;
  for (let i = 0; i < 60; i++) {
    // Jitter the speed slightly around a steady value.
    const speed = 120 + (i % 2 === 0 ? 4 : -4);
    samples.push(governor.update({ ...fast, fastestObjectPxPerSec: speed }, now));
    now += 33;
  }
  const spread = Math.max(...samples) - Math.min(...samples);
  assert.ok(spread < 6, `rate oscillated by ${spread} fps on a steady scene`);
});

test('state reflects what the scene is doing', () => {
  const governor = new AdaptiveGovernor();
  run(governor, still, 5);
  assert.equal(governor.state, 'idle');
  run(governor, fast, 3, 5000);
  assert.ok(['tracking', 'burst'].includes(governor.state), `got ${governor.state}`);
});

test('dropped frames pull the target down', () => {
  const clean = new AdaptiveGovernor();
  const dropping = new AdaptiveGovernor();
  const a = run(clean, fast, 3);
  const b = run(dropping, { ...fast, droppedFrames: 5 }, 3);
  assert.ok(b < a, 'dropping frames must reduce the requested rate');
});
