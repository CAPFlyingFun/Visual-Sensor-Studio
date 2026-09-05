import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deviceOrientationToQuaternion } from '../.test-build/core/math.js';
import {
  DEFAULT_NOISE_FLOOR_RADIANS, EDGE_BUDGET_SHARE, MAX_SMALL_ANGLE_RADIANS,
  StackAligner, alignmentUv, decideFrame, describeShift, isRealMovement,
  nominalFocalPixels, predictShift, rotationSince
} from '../.test-build/v2/vision/alignment.js';

/*
 * Night's first half: how far the picture moved, in pixels, from the phone's
 * own orientation. Built and tested BEFORE any stack exists, because a stack
 * without alignment is just a blur — this app proved that on itself when
 * unaligned frame averaging became the Dizzy effect.
 */

const at = (alpha, beta, gamma) => deviceOrientationToQuaternion(alpha, beta, gamma, 0);

/*
 * HELD UPRIGHT — beta 90 is the phone stood on end, screen to the face, rear
 * camera looking out at the room. Poses matter here in a way they did not
 * look like they would: a rotation only means "pan" or "tilt" relative to
 * where the lens is pointing, so a test written in the wrong pose measures
 * the wrong thing while looking entirely reasonable.
 *
 *   turn  +, the phone swings LEFT about the vertical  (yaw)
 *   tilt  +, its top goes back so the lens rises       (pitch)
 */
const upright = (turn = 0, tilt = 0) => at(turn, 90 + tilt, 0);

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
  const before = upright();
  const after = upright(0.1);
  const delta = rotationSince(before, after);
  assert.ok(Math.abs(delta.total - 0.1 * Math.PI / 180) < 1e-6,
    `a tenth of a degree of turn, got ${delta.total * 180 / Math.PI}°`);
  const shift = predictShift(delta, 2800);
  assert.ok(Math.abs(shift.distance - 4.9) < 0.3,
    `~4.9 px at f=2800, got ${shift.distance}`);
  assert.equal(shift.smallAngle, true);
});

test('displacement scales with the focal length, and says nothing without one', () => {
  const delta = rotationSince(upright(), upright(1));
  const near = predictShift(delta, 1400);
  const far = predictShift(delta, 2800);
  assert.ok(Math.abs(far.distance - near.distance * 2) < 0.01,
    'twice the focal length, twice the displacement');
  // With no focal length there is nothing to say, and saying zero pixels is
  // the honest answer rather than a number in invented units. A stand-in is
  // available (nominalFocalPixels) but it is chosen by the CALLER, so a
  // missing focal length can never quietly become an assumed one down here.
  const unknown = predictShift(delta, 0);
  assert.equal(unknown.distance, 0);
  assert.equal(predictShift(delta, Number.NaN).distance, 0);
});

test('the rotation is measured in the CAMERA\'s axes, not the world\'s', () => {
  // The bug this test exists for. `current x reference-inverse` and
  // `reference-inverse x current` are the same rotation about different axes,
  // and they agree exactly when the phone is held upright — the one pose a
  // test is most likely to be written in.
  //
  // Lay the phone flat on a table and spin it one degree. The lens is looking
  // at the table: that spin turns the picture in its own plane and pans
  // NOTHING. The world-axis reading calls it a one-degree pan and would send
  // the aligner sliding the frame sideways to undo a movement that never
  // happened.
  const flat = rotationSince(at(0, 0, 0), at(1, 0, 0));
  assert.ok(Math.abs(flat.roll) > 0.9 * flat.total,
    `spinning a flat phone rolls the picture, got yaw ${flat.yaw}, roll ${flat.roll}`);
  assert.ok(Math.abs(flat.yaw) < 0.05 * flat.total, 'and pans it hardly at all');
  const shift = predictShift(flat, 2800);
  assert.ok(shift.distance < 1, `no pan means no pixels to undo, got ${shift.distance}`);

  // The same one degree, with the phone held up looking at the room, IS a pan.
  const held = rotationSince(upright(), upright(1));
  assert.ok(Math.abs(held.yaw) > 0.9 * held.total, 'held up, the same turn pans');
  assert.ok(predictShift(held, 2800).distance > 40, 'and that is real pixels');
});

test('yaw moves the picture across, pitch moves it down the frame', () => {
  // Signs derived rather than guessed, and stated in the picture's own axes:
  // +dx towards the right-hand edge, +dy towards the bottom one. Backwards
  // here would not merely fail to align — it would move each frame the wrong
  // way and DOUBLE the error it was there to remove.
  const focal = 2800;

  // Swing the phone LEFT: the room slides RIGHT across the frame.
  const left = predictShift(rotationSince(upright(), upright(1)), focal);
  assert.ok(Math.abs(left.dx) > Math.abs(left.dy) * 10, 'a pan is horizontal');
  assert.ok(left.dx > 0, `turning left sends the scene right, got dx ${left.dx}`);

  // Swing it RIGHT: the room slides LEFT, the same distance.
  const right = predictShift(rotationSince(upright(), upright(-1)), focal);
  assert.ok(right.dx < 0, `turning right sends the scene left, got dx ${right.dx}`);
  assert.ok(Math.abs(Math.abs(left.dx) - Math.abs(right.dx)) < 0.01);

  // Tilt the lens UP: the room slides DOWN the frame, which is +dy because dy
  // is measured down the picture — the direction texture rows run.
  const up = predictShift(rotationSince(upright(), upright(0, 1)), focal);
  assert.ok(Math.abs(up.dy) > Math.abs(up.dx) * 10, 'a tilt is vertical');
  assert.ok(up.dy > 0, `pointing the lens up sends the scene down, got dy ${up.dy}`);
  const down = predictShift(rotationSince(upright(), upright(0, -1)), focal);
  assert.ok(down.dy < 0, 'and pointing it down sends the scene up');
});

test('a quaternion and its negative are the same rotation, and report the same way', () => {
  // The trap Euler angles fall into and quaternions only half escape: q and
  // -q describe an identical rotation. Read carelessly they give opposite
  // axes, so a resting phone would appear to swing back and forth.
  const before = upright();
  const after = upright(2, 1);
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
  const jitter = rotationSince(upright(), upright(0.01, 0.01));
  assert.ok(jitter.total < DEFAULT_NOISE_FLOOR_RADIANS,
    `hundredths of a degree sit under the floor, got ${jitter.total}`);
  assert.equal(isRealMovement(jitter), false);
  // A real nudge is real.
  assert.equal(isRealMovement(rotationSince(upright(), upright(0.5))), true);
  // A calibrated floor overrides the default in both directions.
  assert.equal(isRealMovement(jitter, 0), true, 'a zero floor trusts everything');
  assert.equal(isRealMovement(rotationSince(upright(), upright(0.5)), 1), false);
});

test('a frame is stacked, still, or rejected — and the reason says which', () => {
  const focal = 2800;
  const margin = 120;

  // STILL: inside the floor. The shift is zeroed, not merely small — a
  // resting phone must produce a still stack, not a stack of corrections.
  const still = decideFrame(rotationSince(upright(), upright(0.01)), focal, margin);
  assert.equal(still.verdict, 'still');
  assert.equal(still.shift.dx, 0);
  assert.equal(still.shift.distance, 0);
  assert.match(still.reason, /did not move/);

  // STACKED: real movement the crop margin can absorb.
  const small = decideFrame(rotationSince(upright(), upright(1)), focal, margin);
  assert.equal(small.verdict, 'stacked');
  assert.ok(small.shift.distance > 0 && small.shift.distance < margin);
  assert.match(small.reason, /warped back inside the margin/);

  // REJECTED past the margin: warping it would drag in edges that were never
  // photographed, so it is dropped rather than stacked with a fake border.
  const far = decideFrame(rotationSince(upright(), upright(4)), focal, margin);
  assert.equal(far.verdict, 'rejected');
  assert.match(far.reason, /never photographed/);

  // REJECTED for leaving the small-angle regime, which is a different fault:
  // the prediction itself stops being fair, whatever the margin is.
  const wild = decideFrame(rotationSince(upright(), upright(45)), focal, 1e9);
  assert.equal(wild.verdict, 'rejected');
  assert.match(wild.reason, /small-angle prediction/);
  assert.equal(wild.shift.smallAngle, false);
  assert.ok(MAX_SMALL_ANGLE_RADIANS < 45 * Math.PI / 180);
});

test('the readout states its own uncertainty', () => {
  const delta = rotationSince(upright(), upright(0.5, 0.2));
  const text = describeShift(predictShift(delta, 2800), delta);
  assert.match(text, /yaw -?\d+\.\d+° · pitch -?\d+\.\d+° · roll -?\d+\.\d+°/);
  assert.match(text, /px/);
  assert.ok(!/guess/.test(text), 'a small angle is a measurement');
  // Beyond the small-angle regime it says so rather than reporting a number
  // that looks exactly as confident.
  const big = rotationSince(upright(), upright(30));
  assert.match(describeShift(predictShift(big, 2800), big), /a guess, not a measurement/);
});

test('the assumed focal length is a stated stand-in, and scales with the frame', () => {
  // No browser reports a field of view and V2 has no visual fit yet, so this
  // stands in — declared, marked assumed everywhere it is shown, and shaped
  // like frame-average.ts's NOMINAL_FPS rather than like a setting.
  //
  // Roughly a 70° horizontal field, which is where a phone's main camera
  // lives. What matters as much as the value: it is proportional to the frame
  // width, so the UV offset it feeds — a pixel shift divided by that same
  // width — comes out the same whatever size the frame is rendered at.
  assert.ok(Math.abs(nominalFocalPixels(1920) - 1371) < 5,
    `~1371 px at 1920 wide, got ${nominalFocalPixels(1920)}`);
  const small = nominalFocalPixels(960);
  const large = nominalFocalPixels(3840);
  assert.ok(Math.abs(large - small * 4) < 0.01, 'proportional to the frame width');
  const delta = rotationSince(upright(), upright(1));
  const a = predictShift(delta, small);
  const b = predictShift(delta, large);
  assert.ok(Math.abs(a.dx / 960 - b.dx / 3840) < 1e-9,
    'so the same turn is the same UV offset at any render size');
  // Nothing to go on is still nothing to go on.
  assert.equal(nominalFocalPixels(0), 0);
  assert.equal(nominalFocalPixels(-10), 0);
});

test('the UV offset divides, and declines rather than guesses', () => {
  const shift = predictShift(rotationSince(upright(), upright(1)), 2800);
  const uv = alignmentUv(shift, 1400, 700, 'environment');
  assert.ok(uv, 'a rear-camera frame of a known size converts');
  assert.ok(Math.abs(uv[0] - shift.dx / 1400) < 1e-12, 'dx over the width');
  assert.ok(Math.abs(uv[1] - shift.dy / 700) < 1e-12, 'dy over the height, no sign flip');

  // THE FRONT CAMERA IS DECLINED, not guessed at. It looks the other way
  // along its own axis, so dx's sign flips — and which way round the browser
  // hands over an unmirrored front frame is a thing to measure on a device.
  // A wrong sign would move each frame the wrong way and double the error.
  assert.equal(alignmentUv(shift, 1400, 700, 'user'), null);
  assert.equal(alignmentUv(shift, 1400, 700, ''), null);
  // And so is anything without a real frame to divide by.
  assert.equal(alignmentUv(shift, 0, 700, 'environment'), null);
  assert.equal(alignmentUv(shift, 1400, 0, 'environment'), null);
  // Past the small-angle regime the pixel number is a guess, so it is not
  // allowed to become a silent warp.
  const wild = predictShift(rotationSince(upright(), upright(45)), 2800);
  assert.equal(wild.smallAngle, false);
  assert.equal(alignmentUv(wild, 1400, 700, 'environment'), null);
});

test('the aligner anchors, holds, and lets go when the view has moved on', () => {
  const aligner = new StackAligner();
  const inputs = {
    focalPixels: nominalFocalPixels(1000),
    frameWidth: 1000,
    frameHeight: 1000,
    facing: 'environment'
  };
  // The edge budget, in pixels at this frame size — the number that decides
  // how far an accumulation may drift before it is worth restarting.
  const budgetPx = 1000 * EDGE_BUDGET_SHARE;

  // The first frame IS the anchor: stacked at zero offset by definition, and
  // it restarts the accumulation because there is nothing before it.
  const first = aligner.track(upright(), inputs);
  assert.equal(first.verdict, 'stacked');
  assert.equal(first.restart, true);
  assert.deepEqual(first.align, [0, 0]);
  assert.match(first.reason, /Anchor frame/);
  assert.equal(aligner.stackedCount, 1);

  // A resting phone is STILL, and a still phone gets no correction at all —
  // not a small one. Chasing sensor noise would warp every frame by a pixel
  // or two of nonsense.
  const resting = aligner.track(upright(0.005), inputs);
  assert.equal(resting.verdict, 'still');
  assert.deepEqual(resting.align, [0, 0]);
  assert.equal(resting.restart, false);
  assert.equal(aligner.stillCount, 1);

  // A real drift inside the budget is warped back and KEPT — this is the
  // whole point: the average goes on removing noise through a small wobble
  // instead of smearing through it.
  const drifted = aligner.track(upright(0.3), inputs);
  assert.equal(drifted.verdict, 'stacked');
  assert.equal(drifted.restart, false);
  assert.ok(Math.abs(drifted.align[0]) > 0, 'and it really is offset');
  assert.ok(drifted.shift.distance < budgetPx);
  assert.equal(aligner.stackedCount, 3);

  // Past the budget the anchor describes a rectangle the camera is no longer
  // looking at. Blending the two would be the smear this feature exists to
  // remove, so the accumulation restarts and the anchor moves with it.
  const away = aligner.track(upright(6), inputs);
  assert.equal(away.verdict, 'rejected');
  assert.equal(away.restart, true);
  assert.deepEqual(away.align, [0, 0], 'a restart adopts the frame whole');
  assert.equal(aligner.rejectedCount, 1);
  assert.equal(aligner.stackedCount, 1, 'and the count starts again');

  // The new anchor is where the phone actually is, so the SAME small drift
  // that was fine before is fine again — the rejection was about distance
  // from the anchor, not about the phone having misbehaved.
  assert.equal(aligner.track(upright(6.3), inputs).verdict, 'stacked');
});

test('a front-facing frame is tracked but never warped', () => {
  // The verdicts still mean something — the phone did move — but the offset
  // stays zero, so a front-camera average behaves exactly as it did before
  // any of this existed rather than being warped by an unverified sign.
  const aligner = new StackAligner();
  const inputs = {
    focalPixels: nominalFocalPixels(1000),
    frameWidth: 1000, frameHeight: 1000, facing: 'user'
  };
  aligner.track(upright(), inputs);
  const moved = aligner.track(upright(0.3), inputs);
  assert.equal(moved.verdict, 'stacked');
  assert.ok(moved.shift.distance > 0, 'the movement is still measured');
  assert.deepEqual(moved.align, [0, 0], 'and deliberately not acted on');
});

test('reset forgets the anchor entirely', () => {
  // Averaging turned off, or the gyro gone away: the anchor no longer
  // describes anything, and a stale one would warp the first frame of the
  // next accumulation towards an orientation from minutes ago.
  const aligner = new StackAligner();
  const inputs = {
    focalPixels: nominalFocalPixels(1000),
    frameWidth: 1000, frameHeight: 1000, facing: 'environment'
  };
  aligner.track(upright(), inputs);
  aligner.track(upright(0.3), inputs);
  assert.equal(aligner.anchored, true);
  aligner.reset();
  assert.equal(aligner.anchored, false);
  assert.equal(aligner.stackedCount, 0);
  const again = aligner.track(upright(20), inputs);
  assert.equal(again.restart, true, 'the next frame is a fresh anchor');
  assert.deepEqual(again.align, [0, 0]);
});

/*
 * ZOOM MULTIPLIES THE FOCAL LENGTH, and leaving it out was a real bug.
 *
 * Focal length in pixels IS the magnification — it is what turns a rotation
 * into a pixel displacement. At 10x the same small turn sweeps the image ten
 * times further, but the frame is still the same width, so an estimate taken
 * from the width alone does not move when the lens does.
 *
 * Measured consequence (Joshua, 2026-09-04, at 10.0x with Stabilization on 2
 * frames): the correction under-shot by the zoom factor, so averaging two
 * frames of an unaligned hand-held view SMEARED them, and the picture came
 * back blurrier with stabilisation than without.
 */
test('focal pixels scale with zoom, because zoom is magnification', () => {
  const wide = nominalFocalPixels(3024);
  assert.ok(wide > 0);

  // Ten times the zoom, ten times the displacement for the same rotation.
  assert.ok(Math.abs(nominalFocalPixels(3024, 10) - wide * 10) < 1e-9,
    'a 10x view moves ten times as far for the same turn');
  assert.ok(Math.abs(nominalFocalPixels(3024, 2.5) - wide * 2.5) < 1e-9);

  // 1 IS THE IDENTITY, so every 1x reading is exactly what it always was and
  // an older caller that passes no zoom is unchanged.
  assert.equal(nominalFocalPixels(3024, 1), wide);
  assert.equal(nominalFocalPixels(3024), wide);

  // A nonsense reading must not silently zero the prediction — that would
  // disable alignment entirely rather than degrade it.
  for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(nominalFocalPixels(3024, bad), wide,
      `zoom ${String(bad)} falls back to 1x rather than breaking the aligner`);
  }
  // And no width is still no prediction, whatever the zoom.
  assert.equal(nominalFocalPixels(0, 10), 0);
});

test('every consumer of focal pixels is given the zoom', () => {
  const appTs = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');
  // Three consumers: live stabilisation, the steady-hand gate, and Night.
  // The gate judges a hold in PIXELS OF SHAKE, so it was far too lenient at
  // zoom for exactly the same reason.
  const calls = [...appTs.matchAll(/nominalFocalPixels\([^)]*\)/g)].map((m) => m[0]);
  assert.ok(calls.length >= 3, `expected every call site, found ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /zoomMagnification\(\)/,
      `every focal estimate carries the zoom, got: ${call}`);
  }
  // ONLY CAMERA ZOOM, and this assertion used to say the opposite: "a digital
  // crop magnifies exactly as a camera zoom does, so both count". That is true
  // of a crop in general and false of THIS app's. Camera zoom happens in the
  // ISP before a frame reaches us, so the texture really is magnified. Digital
  // zoom here is a CSS transform on the video element
  // (camera-bootstrap.js, applyDigitalZoomPreview), and a CSS transform does
  // not touch texImage2D — the texture the renderer uploads is unmagnified.
  //
  // Counting it would be the exact mirror of the bug this whole test exists
  // for: instead of predicting a tenth of the true shift, the aligner would
  // predict several times too much and Stabilization would smear a picture it
  // was asked to steady.
  assert.match(appTs, /zoom && zoom\.kind === 'camera' && zoom\.value > 0 \? zoom\.value : 1/);
  assert.match(appTs, /CSS transform does not touch texImage2D/,
    'and the reason is written where the next person will change it');
});
