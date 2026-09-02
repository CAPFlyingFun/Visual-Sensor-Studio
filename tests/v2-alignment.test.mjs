import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceOrientationToQuaternion } from '../.test-build/core/math.js';
import {
  DEFAULT_NOISE_FLOOR_RADIANS, MAX_SMALL_ANGLE_RADIANS, decideFrame, describeShift,
  isRealMovement, predictShift, rotationSince
} from '../.test-build/v2/vision/alignment.js';

/*
 * Night's first half: how far the picture moved, in pixels, from the phone's
 * own orientation. Built and tested BEFORE any stack exists, because a stack
 * without alignment is just a blur — this app proved that on itself when
 * unaligned frame averaging became the Dizzy effect.
 */

const at = (alpha, beta, gamma) => deviceOrientationToQuaternion(alpha, beta, gamma, 0);

test('no movement is no movement, exactly', () => {
  const q = at(30, 20, 10);
  const delta = rotationSince(q, q);
  assert.equal(delta.total, 0);
  assert.equal(delta.yaw, 0);
  assert.equal(delta.pitch, 0);
  assert.equal(delta.roll, 0);
  const shift = predictShift(delta, 2800);
  assert.equal(shift.distance, 0);
});

test('a tenth of a degree is five pixels — which is why this exists', () => {
  // The number the whole feature turns on. Displacement is focal × angle, and
  // at a measured ~2800 px focal length one tenth of a degree is about five
  // pixels: far below what a hand can feel, and the difference between a
  // sharp stack and a soft one.
  const before = at(0, 0, 0);
  const after = at(0.1, 0, 0);
  const delta = rotationSince(before, after);
  assert.ok(Math.abs(delta.total - 0.1 * Math.PI / 180) < 1e-6,
    `a tenth of a degree of turn, got ${delta.total * 180 / Math.PI}°`);
  const shift = predictShift(delta, 2800);
  assert.ok(Math.abs(shift.distance - 4.9) < 0.3,
    `~4.9 px at f=2800, got ${shift.distance}`);
  assert.equal(shift.smallAngle, true);
});

test('displacement scales with the MEASURED focal length, never an assumed one', () => {
  const delta = rotationSince(at(0, 0, 0), at(1, 0, 0));
  const near = predictShift(delta, 1400);
  const far = predictShift(delta, 2800);
  assert.ok(Math.abs(far.distance - near.distance * 2) < 0.01,
    'twice the focal length, twice the displacement');
  // With no focal length there is nothing to say, and saying zero pixels is
  // the honest answer rather than a number in invented units.
  const unknown = predictShift(delta, 0);
  assert.equal(unknown.distance, 0);
  assert.equal(predictShift(delta, Number.NaN).distance, 0);
});

test('yaw moves the picture across, pitch moves it up, and the signs are opposite to the turn', () => {
  // Turning the phone right sends the scene LEFT across the sensor. Getting
  // this backwards would warp every frame the wrong way and double the error
  // instead of removing it.
  const yaw = predictShift(rotationSince(at(0, 0, 0), at(1, 0, 0)), 2800);
  assert.ok(Math.abs(yaw.dx) > Math.abs(yaw.dy), 'yaw is mostly horizontal');
  const pitch = predictShift(rotationSince(at(0, 0, 0), at(0, 1, 0)), 2800);
  assert.ok(Math.abs(pitch.dy) > Math.abs(pitch.dx), 'pitch is mostly vertical');
  // Opposite turns give opposite shifts, and the same size.
  const back = predictShift(rotationSince(at(0, 0, 0), at(-1, 0, 0)), 2800);
  assert.ok(yaw.dx * back.dx < 0, 'turning the other way moves the scene the other way');
  assert.ok(Math.abs(Math.abs(yaw.dx) - Math.abs(back.dx)) < 0.01);
});

test('a quaternion and its negative are the same rotation, and report the same way', () => {
  // The trap Euler angles fall into and quaternions only half escape: q and
  // -q describe an identical rotation. Read carelessly they give opposite
  // axes, so a resting phone would appear to swing back and forth.
  const before = at(0, 0, 0);
  const after = at(2, 1, 0);
  const normal = rotationSince(before, after);
  const flipped = rotationSince(
    { x: -before.x, y: -before.y, z: -before.z, w: -before.w }, after);
  assert.ok(Math.abs(normal.yaw - flipped.yaw) < 1e-9, 'yaw agrees');
  assert.ok(Math.abs(normal.pitch - flipped.pitch) < 1e-9, 'pitch agrees');
  assert.ok(Math.abs(normal.total - flipped.total) < 1e-9, 'and so does the total');
});

test('sensor jitter is not movement', () => {
  // A resting phone reports orientation that wanders by hundredths of a
  // degree. Chasing it would warp every frame by a pixel or two of nonsense.
  const jitter = rotationSince(at(0, 0, 0), at(0.01, 0.01, 0));
  assert.ok(jitter.total < DEFAULT_NOISE_FLOOR_RADIANS,
    `hundredths of a degree sit under the floor, got ${jitter.total}`);
  assert.equal(isRealMovement(jitter), false);
  // A real nudge is real.
  assert.equal(isRealMovement(rotationSince(at(0, 0, 0), at(0.5, 0, 0))), true);
  // A calibrated floor overrides the default in both directions.
  assert.equal(isRealMovement(jitter, 0), true, 'a zero floor trusts everything');
  assert.equal(isRealMovement(rotationSince(at(0, 0, 0), at(0.5, 0, 0)), 1), false);
});

test('a frame is stacked, still, or rejected — and the reason says which', () => {
  const focal = 2800;
  const margin = 120;

  // STILL: inside the floor. The shift is zeroed, not merely small — a
  // resting phone must produce a still stack, not a stack of corrections.
  const still = decideFrame(rotationSince(at(0, 0, 0), at(0.01, 0, 0)), focal, margin);
  assert.equal(still.verdict, 'still');
  assert.equal(still.shift.dx, 0);
  assert.equal(still.shift.distance, 0);
  assert.match(still.reason, /did not move/);

  // STACKED: real movement the crop margin can absorb.
  const small = decideFrame(rotationSince(at(0, 0, 0), at(1, 0, 0)), focal, margin);
  assert.equal(small.verdict, 'stacked');
  assert.ok(small.shift.distance > 0 && small.shift.distance < margin);
  assert.match(small.reason, /warped back inside the margin/);

  // REJECTED past the margin: warping it would drag in edges that were never
  // photographed, so it is dropped rather than stacked with a fake border.
  const far = decideFrame(rotationSince(at(0, 0, 0), at(4, 0, 0)), focal, margin);
  assert.equal(far.verdict, 'rejected');
  assert.match(far.reason, /never photographed/);

  // REJECTED for leaving the small-angle regime, which is a different fault:
  // the prediction itself stops being fair, whatever the margin is.
  const wild = decideFrame(rotationSince(at(0, 0, 0), at(45, 0, 0)), focal, 1e9);
  assert.equal(wild.verdict, 'rejected');
  assert.match(wild.reason, /small-angle prediction/);
  assert.equal(wild.shift.smallAngle, false);
  assert.ok(MAX_SMALL_ANGLE_RADIANS < 45 * Math.PI / 180);
});

test('the readout states its own uncertainty', () => {
  const delta = rotationSince(at(0, 0, 0), at(0.5, 0.2, 0));
  const text = describeShift(predictShift(delta, 2800), delta);
  assert.match(text, /yaw -?\d+\.\d+° · pitch -?\d+\.\d+° · roll -?\d+\.\d+°/);
  assert.match(text, /px/);
  assert.ok(!/guess/.test(text), 'a small angle is a measurement');
  // Beyond the small-angle regime it says so rather than reporting a number
  // that looks exactly as confident.
  const big = rotationSince(at(0, 0, 0), at(30, 0, 0));
  assert.match(describeShift(predictShift(big, 2800), big), /a guess, not a measurement/);
});
