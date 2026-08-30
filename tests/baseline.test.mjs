import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BaselineTracker,
  MAX_BASELINE_ROTATION_DEGREES,
  depthUncertaintyMetres,
  estimateDepthMetres,
  focalLengthPixels
} from '../.test-build/vision/baseline.js';

const HZ = 60;
const DT = 1 / HZ;
const G = { x: 0, y: 0, z: 9.81 };

/** A still hand: gravity only, plus a little sensor noise. */
function still(seed = 0) {
  return {
    acceleration: { x: Math.sin(seed) * 0.01, y: Math.cos(seed) * 0.01, z: 9.81 },
    rotationRate: { alpha: 0.1, beta: 0.1, gamma: 0.1 }
  };
}

/**
 * Drive a tracker through a sideways slide: accelerate, coast, decelerate,
 * which is what a hand actually does and what integrates to a real distance.
 */
function slide(tracker, metres, seconds) {
  const steps = Math.round(seconds / DT);
  // Triangular acceleration profile: peak a such that distance = a * (t/2)^2.
  const half = seconds / 2;
  const a = metres / (half * half);
  for (let i = 0; i < steps; i++) {
    const accelerating = i < steps / 2;
    tracker.add({
      acceleration: { x: G.x + (accelerating ? a : -a), y: G.y, z: G.z },
      rotationRate: { alpha: 0, beta: 0, gamma: 0 }
    }, DT);
  }
}

test('a still phone reports no meaningful baseline', () => {
  const tracker = new BaselineTracker();
  tracker.start();
  for (let i = 0; i < HZ; i++) tracker.add(still(i), DT);
  const estimate = tracker.estimate;

  assert.ok(estimate.displacementMetres < 0.02, `drifted ${estimate.displacementMetres} m`);
  assert.equal(estimate.usable, false, 'holding still is not a baseline');
});

test('a real sideways slide is recovered to a usable accuracy', () => {
  const tracker = new BaselineTracker();
  tracker.start();
  slide(tracker, 0.08, 1);
  const estimate = tracker.estimate;

  // Within a third of the truth is all this method can honestly claim, and it
  // is enough to turn "nearer" into "roughly this far".
  assert.ok(Math.abs(estimate.displacementMetres - 0.08) < 0.03,
    `got ${estimate.displacementMetres} m for an 8 cm slide`);
  assert.equal(estimate.usable, true);
});

test('gravity is removed rather than integrated', () => {
  // Seeding the gravity estimate from zero would make the first half second of
  // every capture a 9.8 m/s^2 acceleration that never happened — which double
  // integrates into metres of imaginary movement.
  const tracker = new BaselineTracker();
  tracker.start();
  for (let i = 0; i < HZ * 2; i++) {
    tracker.add({ acceleration: { x: 0, y: 0, z: 9.81 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 } }, DT);
  }
  assert.ok(tracker.estimate.displacementMetres < 0.01,
    `pure gravity produced ${tracker.estimate.displacementMetres} m of travel`);
});

test('a twist is rejected even when it covers ground', () => {
  // A rotated pair produces disparity everywhere, which reads as "everything is
  // close" and is entirely an artefact. That is worse than no reading.
  const tracker = new BaselineTracker();
  tracker.start();
  const steps = HZ;
  const a = 0.08 / 0.25;
  for (let i = 0; i < steps; i++) {
    tracker.add({
      acceleration: { x: G.x + (i < steps / 2 ? a : -a), y: G.y, z: G.z },
      rotationRate: { alpha: 30, beta: 0, gamma: 0 }
    }, DT);
  }
  const estimate = tracker.estimate;
  assert.ok(estimate.rotationDegrees > MAX_BASELINE_ROTATION_DEGREES);
  assert.equal(estimate.usable, false, 'a twist must not be offered as a baseline');
});

test('uncertainty grows with the square of time', () => {
  // Double integration of a biased signal does, so a long capture cannot
  // produce a usable baseline however still it was held.
  const short = new BaselineTracker();
  const long = new BaselineTracker();
  short.start();
  long.start();
  for (let i = 0; i < HZ; i++) short.add(still(i), DT);
  for (let i = 0; i < HZ * 4; i++) long.add(still(i), DT);

  const ratio = long.estimate.uncertaintyMetres / short.estimate.uncertaintyMetres;
  // Four times the duration, sixteen times the uncertainty.
  assert.ok(ratio > 12 && ratio < 20, `expected roughly 16x, got ${ratio}`);
});

test('a gap in the samples is not integrated across', () => {
  // A backgrounded page hands back a multi-second dt, and integrating that
  // invents metres of movement out of a pause.
  const tracker = new BaselineTracker();
  tracker.start();
  slide(tracker, 0.05, 0.5);
  const before = tracker.estimate.displacementMetres;
  tracker.add({ acceleration: { x: 3, y: 0, z: 9.81 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 } }, 4);
  assert.equal(tracker.estimate.displacementMetres, before, 'the gap must contribute nothing');
});

test('focal length follows from the entered field of view', () => {
  // A 90 degree horizontal field puts the focal length at half the width.
  assert.ok(Math.abs(focalLengthPixels(1000, 90) - 500) < 1e-6);
  // A narrower field is a longer lens.
  assert.ok(focalLengthPixels(1000, 60) > focalLengthPixels(1000, 90));
  // And with nothing entered there is no answer to give.
  assert.equal(focalLengthPixels(1000, 0), null);
  assert.equal(focalLengthPixels(1000, 180), null);
  assert.equal(focalLengthPixels(0, 70), null);
});

test('depth triangulates from baseline, focal length and disparity', () => {
  // A 10 cm baseline, a 500 px focal length and 25 px of shift is 2 m.
  assert.ok(Math.abs(estimateDepthMetres(25, 0.1, 500) - 2) < 1e-9);
  // Twice the shift is half the distance.
  assert.ok(Math.abs(estimateDepthMetres(50, 0.1, 500) - 1) < 1e-9);
  // Zero disparity is infinitely far, which is not a number to report.
  assert.equal(estimateDepthMetres(0, 0.1, 500), null);
  assert.equal(estimateDepthMetres(25, 0, 500), null);
});

test('a depth carries the baseline uncertainty it was built on', () => {
  // A distance quoted without it invites being read as a measurement.
  const baseline = {
    displacementMetres: 0.1, uncertaintyMetres: 0.02, rotationDegrees: 1,
    durationSeconds: 1, samples: 60, usable: true
  };
  // 20% uncertain baseline gives a 20% uncertain depth.
  assert.ok(Math.abs(depthUncertaintyMetres(2, baseline) - 0.4) < 1e-9);
  assert.equal(depthUncertaintyMetres(2, { ...baseline, displacementMetres: 0 }), Infinity);
});
