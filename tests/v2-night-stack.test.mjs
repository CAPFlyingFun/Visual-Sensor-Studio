import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NIGHT_COUNTDOWN_MS, NIGHT_TARGET_FRAMES, NIGHT_TARGET_MS, NIGHT_TICK_MS,
  describeNightCounters, emptyNightCounters, nightCountdownSecondsLeft,
  nightStackWeight
} from '../.test-build/v2/vision/night-stack.js';

/*
 * Night, Milestone 1: "Does the ~0.25-second, gyro-aligned finite stack work
 * correctly on my actual iPhone PWA?" (Joshua, 2026-09-03). The alignment
 * itself is StackAligner, already tested in v2-alignment.test.mjs and
 * verified on device; the gate is SteadyShutter, already tested in
 * v2-steadiness.test.mjs. This file tests only what is NEW here: the
 * converging-mean weight formula and the counters readout.
 */

test('the cadence and target are exactly what Joshua asked for', () => {
  assert.equal(NIGHT_TICK_MS, 250, 'a candidate roughly every 0.25s');
  assert.equal(NIGHT_TARGET_MS, 4000, 'runs for about 4 seconds');
  assert.equal(NIGHT_TARGET_FRAMES, 16, '4000ms / 250ms — the "~16 accepted frames" figure');
});

test('the weight is a CONVERGING mean (1/n), not the live ladder\'s forgetting EMA', () => {
  // Joshua's own recurrence: mean1 = frame1, mean2 = mean1 + (frame2-mean1)/2,
  // mean3 = mean2 + (frame3-mean2)/3 — i.e. weight = 1/n for the n-th frame.
  assert.equal(nightStackWeight(2), 0.5);
  assert.equal(nightStackWeight(3), 1 / 3);
  assert.equal(nightStackWeight(4), 0.25);
  assert.equal(nightStackWeight(16), 1 / 16);
  // Defensive for n<=1, matching render/frame-average.ts's frameAverageWeight
  // shape — a function total over its domain is one fewer thing to get
  // wrong at a call site, even though n=1 is meant to be handled by the
  // renderer's own priming path rather than a blend.
  assert.equal(nightStackWeight(1), 1);
  assert.equal(nightStackWeight(0), 1);

  // This is NOT the fixed 2/(N+1) EMA the live frame-averaging ladder uses —
  // that formula never converges past a small window; Night's must, because
  // it is a finite stack, not a rolling one. At n=16 the two would disagree
  // by nearly 2x (2/17 ≈ 0.118 vs 1/16 = 0.0625) — different tools for
  // different jobs, not a rename of one formula.
  const ema17 = 2 / 17;
  assert.ok(Math.abs(nightStackWeight(16) - ema17) > 0.04,
    'the converging weight and the EMA weight are genuinely different numbers at n=16');
});

test('a convex blend cannot clip, whatever the weight — checked, not assumed', () => {
  // Joshua: "Do NOT implement Night as: 8-bit frame + frame + frame + frame
  // and allow it to clip brighter and brighter." mix(before, now, w) is a
  // convex combination for any w in the weights this formula ever produces
  // (0 < w <= 1), so the result can never leave the range spanned by its two
  // inputs — it structurally cannot run away upward. This test pins that the
  // formula never LEAVES that range of weights, which is the property the
  // shader's mix() depends on to make the "cannot clip" claim true.
  for (let n = 1; n <= 40; n++) {
    const w = nightStackWeight(n);
    assert.ok(w > 0 && w <= 1, `weight for n=${n} is ${w}, must stay in (0, 1]`);
  }
});

test('candidates, accepted and rejected are cumulative; stack count is not', () => {
  // The distinction Joshua asked for by naming both separately: "accepted"
  // is a total for the whole capture (so a restart's history is still
  // visible), "stack count" is what the CURRENT accumulator holds (which a
  // restart genuinely does reset, because the old content really is gone).
  const counters = emptyNightCounters();
  assert.equal(counters.acceptedFrames, 0);
  assert.equal(counters.stackCount, 0);
  assert.equal(counters.restarts, 0);
  // Nothing here invents a confidence number — every field is a plain count
  // or a measured millisecond/pixel value.
  for (const key of Object.keys(counters)) {
    assert.ok(!/confidence|quality|score/i.test(key), `${key} is not a fabricated confidence figure`);
  }
});

test('the readout states every number Joshua asked for, and nothing it did not measure', () => {
  const counters = {
    elapsedMs: 3800, candidateFrames: 15, acceptedFrames: 12, rejectedFrames: 3,
    stackCount: 8, restarts: 1, offsetPixels: 2.4, maxOffsetPixels: 61.2,
    tierLabel: '1080', streamWidth: 1080, streamHeight: 1440,
    stackedWidth: 924, stackedHeight: 1232, sensorWidth: 3024, sensorHeight: 4032,
    actualCadenceMs: 253.1, meanBefore: 0.118, gain: 3.56, lift: 1.42
  };
  const line = describeNightCounters(counters);
  assert.match(line, /3\.8s/, 'elapsed');
  assert.match(line, /15 candidates/);
  assert.match(line, /12 accepted/);
  assert.match(line, /3 rejected/);
  assert.match(line, /stack 8/);
  assert.match(line, /1 restart\b/, 'singular for exactly one');
  assert.match(line, /2\.4 px/, 'current offset');
  assert.match(line, /max 61\.2 px/);
  assert.match(line, /253 ms/, 'the MEASURED cadence, not the assumed 250');

  // THE RESOLUTION STORY (Joshua, 2026-09-03: "link the resolution to what
  // the setting is like 720, 1080, 4K, MAX"). Four different numbers, each
  // named for what it actually is — the setting, what the camera granted,
  // what Night really stacked, and the sensor's own maximum. Reading any one
  // of these as another is the confusion Milestone 2 has to avoid.
  assert.match(line, /tier 1080/, 'the SETTING, by its own label');
  assert.match(line, /stream 1080×1440/, 'what the camera granted under it');
  assert.match(line, /stacked 924×1232/, 'what Night actually accumulated');
  assert.match(line, /sensor 3024×4032/, 'what a MAX photo would have to be');

  // THE RECOVERY, reported as what it measured and what it then did.
  assert.match(line, /lift 3\.56× gain, 1\.42 shadows \(mean 0\.118\)/);
  // A frame that needed nothing says so plainly rather than reporting a 1x
  // lift as though something happened.
  const untouched = describeNightCounters({ ...counters, gain: 1, lift: 1, meanBefore: 0.44 });
  assert.match(untouched, /no lift needed \(mean 0\.440\)/);
  assert.ok(!/1\.00×/.test(untouched), 'an identity lift is not dressed up as an adjustment');

  // Plural restarts, and no "(0 restarts)" clutter when there were none.
  const many = describeNightCounters({ ...counters, restarts: 2 });
  assert.match(many, /2 restarts\b/);
  const none = describeNightCounters({ ...counters, restarts: 0 });
  assert.ok(!/restart/.test(none), 'zero restarts says nothing about restarts at all');

  // A missing cadence measurement (no ticks yet) reads as unmeasured, not zero.
  const fresh = describeNightCounters(emptyNightCounters());
  assert.match(fresh, /cadence —/, 'no ticks yet: the honest answer is unmeasured');
  // Same for a size nobody has reported: an em dash, never a fabricated 0×0.
  assert.match(fresh, /stream —/);
  assert.match(fresh, /sensor —/);
  assert.match(fresh, /tier —/);
  assert.ok(!/0×0/.test(fresh), 'an unknown size is never rendered as 0×0');
});

test('the countdown is a fixed 3s wait BEFORE the gate, not a replacement for it', () => {
  // Joshua, on the phone, after Milestone 1 worked: "make a 3s countdown
  // before it actually starts because if not using a tripod, as soon as
  // you tap and release your finger, your hands are going to move a
  // little." A fixed number, not a measurement — it exists purely to give
  // the tap's own release motion time to settle before anything judges the
  // hold.
  assert.equal(NIGHT_COUNTDOWN_MS, 3000);
});

test('the displayed countdown reads 3, 2, 1 — never 0, never negative', () => {
  // Ceiling, not rounding: at 2.98s remaining the honest whole-second
  // answer is still "3", not "2" — rounding down would read as though a
  // whole second had already passed when it had not.
  assert.equal(nightCountdownSecondsLeft(0), 3);
  assert.equal(nightCountdownSecondsLeft(1), 3);
  assert.equal(nightCountdownSecondsLeft(20), 3);
  assert.equal(nightCountdownSecondsLeft(1000), 2);
  assert.equal(nightCountdownSecondsLeft(2000), 1);
  assert.equal(nightCountdownSecondsLeft(2999), 1);
  // Right at (or past) the boundary the countdown phase is already over in
  // app.ts's own tick check (`now - start < NIGHT_COUNTDOWN_MS`), so this
  // function is never actually called with an elapsed this large in
  // practice — but it still must not show something nonsensical like "0" or
  // a negative number if it ever were.
  assert.equal(nightCountdownSecondsLeft(3000), 1);
  assert.equal(nightCountdownSecondsLeft(5000), 1);
});
