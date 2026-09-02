import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLUR_LIMIT_PIXELS, DEFAULT_STEADY_THRESHOLD, HOLD_MS, RELEASE_MARGIN,
  SteadyShutter, describeSteadiness, rateFrom, readSteadiness, smoothRate
} from '../.test-build/v2/vision/steadiness.js';
import { nominalFocalPixels } from '../.test-build/v2/vision/alignment.js';

/*
 * "Would be good to add an auto picture take once it gets a stable over 70%
 * hold still for best image clarity" (Joshua, 2026-09-02).
 *
 * The percentage has to MEAN something or the threshold is arbitrary, so it
 * is anchored on the pixels a photograph would smear by.
 */

// A full-size landscape still, which is the picture whose clarity is at stake.
const PHOTO_WIDTH = 4032;
const focal = nominalFocalPixels(PHOTO_WIDTH);
const frame30 = 1 / 30;
const perSecond = (degrees) => degrees * Math.PI / 180;

test('a motionless phone is perfectly steady, and nothing else is', () => {
  assert.equal(readSteadiness(0, focal, frame30).steadiness, 1);
  // Any real movement costs something — a meter that read 100% through a
  // small movement would be telling a comfortable lie at exactly the moment
  // it is being trusted.
  assert.ok(readSteadiness(perSecond(0.2), focal, frame30).steadiness < 1);
});

test('the percentage is pixels of smear, not a feeling', () => {
  // displacement = focal x rate x shutter, the same relation the aligner
  // uses. At 4032 px wide and 30 fps, one degree a second smears about 1.7 px
  // of a full-size photo — which is the whole reason a fraction of a degree
  // is worth reacting to.
  const oneDegree = readSteadiness(perSecond(1), focal, frame30);
  assert.ok(Math.abs(oneDegree.smear - 1.67) < 0.1,
    `~1.67 px at 1°/s, got ${oneDegree.smear}`);
  // And 0% is exactly the stated blur limit, not an arbitrary floor.
  const atLimit = BLUR_LIMIT_PIXELS / (focal * frame30);
  assert.ok(Math.abs(readSteadiness(atLimit, focal, frame30).steadiness) < 1e-9);
  // Past it there is no negative steadiness — it is a share, so it clamps.
  assert.equal(readSteadiness(atLimit * 3, focal, frame30).steadiness, 0);
});

test('70% is a hold a hand can actually reach', () => {
  // The threshold has to be achievable or the feature never fires, and strict
  // enough to be worth waiting for. Solving the mapping: 70% is about 1.1
  // degrees a second, which is a deliberate braced hold rather than a lucky
  // one. If a real hand cannot hold it, BLUR_LIMIT_PIXELS is the number to
  // move — and this test is where that decision is recorded.
  let atThreshold = 0;
  for (let deg = 0; deg < 10; deg += 0.001) {
    if (readSteadiness(perSecond(deg), focal, frame30).steadiness < DEFAULT_STEADY_THRESHOLD) {
      atThreshold = deg;
      break;
    }
  }
  assert.ok(atThreshold > 0.8 && atThreshold < 1.5,
    `70% should sit near 1°/s, got ${atThreshold.toFixed(2)}°/s`);
  // At the threshold the photo smears by well under half the blur limit.
  const smear = readSteadiness(perSecond(atThreshold), focal, frame30).smear;
  assert.ok(smear < BLUR_LIMIT_PIXELS * 0.31,
    `a 70% hold is ${smear.toFixed(2)} px of smear`);
});

test('a longer shutter is less forgiving, because it really is', () => {
  // The frame interval stands in for the exposure. In a dark room the camera
  // holds the shutter open longer than a frame, and the same hand then smears
  // more — so the reading must fall with the shutter rather than describe the
  // hand in isolation.
  const hand = perSecond(1);
  const fast = readSteadiness(hand, focal, 1 / 60);
  const slow = readSteadiness(hand, focal, 1 / 15);
  assert.ok(slow.smear > fast.smear * 3.9, 'four times the shutter, four times the smear');
  assert.ok(slow.steadiness < fast.steadiness, 'and a lower reading for the same hand');
});

test('nothing to divide by is not a reading of zero movement', () => {
  // No frame size yet, or no rate: the honest answer is "no smear known",
  // and it must not read as a confident measurement of stillness.
  assert.equal(readSteadiness(perSecond(1), 0, frame30).smear, 0);
  assert.equal(readSteadiness(perSecond(1), focal, 0).smear, 0);
});

test('a rate needs two samples close enough together to divide', () => {
  assert.ok(Math.abs(rateFrom(0.02, 100) - 0.2) < 1e-12, '0.02 rad in 100 ms is 0.2 rad/s');
  // A GAP is refused rather than divided. A backgrounded tab, a resumed page
  // or a dropped event would otherwise put a large rotation over a large time
  // and report a confident middling rate for a movement nobody made.
  assert.equal(rateFrom(0.5, 4000), null, 'a long gap says nothing');
  assert.equal(rateFrom(0.02, 0), null);
  assert.equal(rateFrom(0.02, -5), null);
  // And a rotation too large to be one sample's worth is a jump, not a rate.
  assert.equal(rateFrom(3, 50), null);
});

test('smoothing is by elapsed time, not by sample count', () => {
  // A fixed blend would smooth twice as hard on a phone that reports twice as
  // often — the same hand reading differently on two devices for no reason
  // anyone holding them could see.
  const oneStep = smoothRate(0, 1, 100);
  let twoSteps = 0;
  twoSteps = smoothRate(twoSteps, 1, 50);
  twoSteps = smoothRate(twoSteps, 1, 50);
  assert.ok(Math.abs(oneStep - twoSteps) < 1e-9,
    'one 100 ms step equals two 50 ms steps');
  assert.ok(oneStep > 0 && oneStep < 1, 'and it is a smoothing, not a jump');
  assert.equal(smoothRate(0.4, 9, 0), 0.4, 'no time passed, nothing learned');
});

test('the shutter waits for a HOLD, not for a moment', () => {
  // A phone changing direction is motionless for one frame. Firing on that
  // would photograph the middle of a swing and call it steady.
  const shutter = new SteadyShutter();
  assert.equal(shutter.armed, false);
  assert.equal(shutter.update(1, 0).fire, false, 'a disarmed shutter never fires');

  shutter.arm();
  assert.equal(shutter.armed, true);
  assert.equal(shutter.update(0.4, 0).state, 'waiting');
  // Steady enough — the clock starts, and does NOT fire yet.
  assert.equal(shutter.update(0.9, 100).state, 'holding');
  assert.equal(shutter.update(0.9, 100 + HOLD_MS - 1).fire, false,
    'a millisecond short is still short');
  const done = shutter.update(0.9, 100 + HOLD_MS);
  assert.equal(done.fire, true);
  assert.equal(done.state, 'fired');
  // ONCE. A shutter that stayed armed would keep firing for as long as the
  // phone sat on a table.
  assert.equal(shutter.armed, false);
  assert.equal(shutter.update(1, 9999).fire, false);
});

test('losing the hold restarts the clock, but noise does not', () => {
  const shutter = new SteadyShutter();
  shutter.arm();
  shutter.update(0.9, 0);
  // Genuinely moved: the hold is abandoned, and the time already served does
  // not count towards the next one.
  assert.equal(shutter.update(0.3, 200).state, 'waiting');
  shutter.update(0.9, 300);
  assert.equal(shutter.update(0.9, 300 + HOLD_MS - 1).fire, false,
    'the clock restarted from the new hold');

  // HYSTERESIS. A reading resting exactly on the threshold crosses it on
  // sensor noise alone; without a release margin the hold would never
  // complete and the feature would look simply broken.
  const steady = new SteadyShutter();
  steady.arm();
  steady.update(DEFAULT_STEADY_THRESHOLD, 0);
  const sagged = steady.update(DEFAULT_STEADY_THRESHOLD - RELEASE_MARGIN / 2, 50);
  assert.equal(sagged.state, 'holding', 'a small sag is forgiven');
  assert.equal(steady.update(DEFAULT_STEADY_THRESHOLD, HOLD_MS).fire, true);
  // But entering a hold takes the full threshold, so the margin can never
  // become the threshold.
  const under = new SteadyShutter();
  under.arm();
  assert.equal(under.update(DEFAULT_STEADY_THRESHOLD - RELEASE_MARGIN / 2, 0).state, 'waiting');
});

test('the reading shows the numbers it came from, and its own stand-in', () => {
  const text = describeSteadiness(
    readSteadiness(perSecond(1), focal, frame30), frame30, true);
  assert.match(text, /\d+% steady/);
  assert.match(text, /°\/s/, 'the rate, so the percentage can be checked');
  assert.match(text, /px of smear/, 'and the pixels it works out to');
  // The shutter time is a STAND-IN and the sentence says so, including which
  // direction it errs in: understating blur, never overstating it.
  assert.match(text, /the frame stands in for the shutter/);
  assert.match(text, /smears more than this says and never less/);
  // An unmeasured frame rate is marked as assumed.
  assert.match(describeSteadiness(readSteadiness(0, focal, frame30), frame30, false),
    /rate assumed until measured/);
});
