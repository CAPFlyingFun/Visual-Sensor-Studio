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
  // 2026-09-04: "instead of sampling every 0.25s, do it every frame up to 30
  // frames per second". The gate is now a CEILING, not a sampling period.
  assert.equal(NIGHT_TICK_MS, 30, 'a ceiling of about 30 frames a second, not a 0.25s period');
  assert.ok(NIGHT_TICK_MS < 1000 / 30,
    'set under the nominal 30fps interval so delivery jitter cannot halve the real rate');
  assert.ok(1000 / NIGHT_TICK_MS < 40, 'but still a real ceiling against a 60fps stream');
  // Ten seconds was tried and measured WORSE on device — drift and the
  // camera's own drifting exposure both grow with the hold. Back to four.
  assert.equal(NIGHT_TARGET_MS, 4000, 'runs for about 4 seconds');
  // The countdown sits BEFORE the gate, so integration is the full ten.
  assert.ok(NIGHT_COUNTDOWN_MS < NIGHT_TARGET_MS,
    'the settle window is not counted against the exposure');
  assert.equal(NIGHT_TARGET_FRAMES, 133, '4000ms / 30ms — what the ceiling implies');
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

/*
 * WHY THE 8-BIT ACCUMULATOR FROZE — the arithmetic behind the change of
 * format, evaluated here rather than asserted in a comment.
 *
 * The blend is mix(before, now, 1/n). An RGBA8 target rounds every result to
 * the nearest 1/255, so the STORED value only changes when the increment
 * clears half a step: |now - before| / n > 0.5/255. In Joshua's near-black
 * room the scene sits at two or three steps out of 255 and consecutive frames
 * differ by about one step, so the accumulator stops moving early in the
 * capture and every later frame writes back the number already there.
 *
 * Half-float's precision is RELATIVE — roughly value x 2^-11 to the nearest
 * representable — so near zero its steps are far finer than 8-bit's fixed
 * 1/255, which is exactly where a dark stack lives.
 */
test('an 8-bit accumulator cannot hold the mean a dark stack converges to', () => {
  const STEP = 1 / 255;
  // A dark scene whose TRUE mean falls between two 8-bit steps. This is the
  // ordinary case, not a contrived one: sensor noise makes frames alternate
  // around a level, and recovering that between-steps level is the entire
  // purpose of averaging them.
  const frame = (n) => (n % 2 === 0 ? 3 : 2) * STEP;
  const TRUE_MEAN = 2.5 * STEP;

  // THE FREEZE. With weight 1/n the increment is |now - before| / n, and an
  // 8-bit store ignores anything under half a step. A one-step difference
  // therefore cannot move the stored value at all from frame 3 onward.
  const firstFrozenFrame = Math.floor(STEP / (0.5 * STEP)) + 1;
  assert.equal(firstFrozenFrame, 3,
    'a one-step difference stops registering at the third frame');

  let stored = frame(1);
  for (let n = 2; n <= 15; n += 1) {
    stored = Math.round((stored + (frame(n) - stored) * nightStackWeight(n)) * 255) / 255;
  }
  // Fifteen frames land on a step, not on the level they average to. The
  // stack did its arithmetic correctly and the storage threw the answer away.
  assert.equal(Math.round(stored * 255), 3, 'the 8-bit stack lands on a representable step');
  assert.ok(Math.abs(stored - TRUE_MEAN) >= 0.5 * STEP,
    'and so sits half a step from the mean it was computing');

  // HALF-FLOAT holds it. Its precision is relative — about value x 2^-11 —
  // so near zero its steps are far finer than 8-bit's fixed 1/255.
  const halfStep = (v) => Math.pow(2, Math.floor(Math.log2(Math.abs(v) || 1)) - 10);
  const quantizeHalf = (v) => Math.round(v / halfStep(v)) * halfStep(v);
  let float = frame(1);
  for (let n = 2; n <= 15; n += 1) {
    float = quantizeHalf(float + (frame(n) - float) * nightStackWeight(n));
  }
  assert.ok(Math.abs(float - TRUE_MEAN) < 0.05 * STEP,
    `half-float converged to the true mean (landed ${(float * 255).toFixed(3)} of 255)`);

  // AND IT KEEPS MOVING AT THE FRAME COUNTS A LONGER CAPTURE WOULD REACH, so
  // raising the duration later is not blocked by this format in turn.
  const halfFloatFreezesAt = STEP / (0.5 * halfStep(2 * STEP));
  assert.ok(halfFloatFreezesAt > 300,
    `still moving past 300 frames (freezes near ${Math.round(halfFloatFreezesAt)})`);
});

test('the accumulator format is reported in the counters, empty until measured', () => {
  const counters = emptyNightCounters();
  assert.equal(counters.accumulatorFormat, '',
    'no claim before an allocation has actually happened');
  assert.ok(!describeNightCounters(counters).includes('accumulator '),
    'and nothing is said about it while it is unknown');
  assert.match(describeNightCounters({ ...counters, accumulatorFormat: 'RGBA16F' }),
    /accumulator RGBA16F/, 'once measured it reaches the copyable log');
});

/*
 * "Only adding and no division" (Joshua, 2026-09-04), as arithmetic.
 *
 * Summing N frames without dividing is identical to the running mean times
 * N. The accumulator keeps the mean because it is the better-conditioned
 * form; the sum is then recovered as a gain of N at the tone stage. These
 * check the two are the same number, and that the rule is safe in daylight.
 */
test('a gain of N is the sum of N frames, and daylight still binds first', () => {
  const TARGET = 0.42;
  const FLOOR = 0.0001;
  const recover = (mean, frames) =>
    Math.max(1, Math.min(Math.max(1, frames), TARGET / Math.max(mean, FLOOR)));

  // THE DARK ROOM, Joshua's measured numbers: mean 0.001 over 109 frames.
  // The picture asks for 420x; only 109 frames of light were collected.
  const dark = recover(0.001, 109);
  assert.equal(dark, 109, 'the dark scene is brightened by exactly the frames it gathered');
  // Which is the sum: mean x N is what adding without dividing would store.
  assert.ok(Math.abs(0.001 * 109 - 0.001 * dark) < 1e-12,
    'gain of N and the undivided sum are the same value');

  // THE OLD CEILING of 6 was the binding constraint by a factor of eighteen.
  assert.ok(dark / 6 > 15, 'the arbitrary cap was holding back most of the light');

  // DAYLIGHT: 109 frames were still gathered, but the picture only asks for
  // 1.4x. Handing it 109x would wash it out, so the measurement wins.
  assert.ok(Math.abs(recover(0.3, 109) - 1.4) < 1e-9,
    'a bright scene takes what it asks for, not what it collected');

  // A WELL-EXPOSED frame is left exactly alone; Night may only brighten.
  assert.equal(recover(0.42, 109), 1, 'gain 1.0 is an identity, never a darkening');
  assert.equal(recover(0.9, 109), 1, 'and an over-bright frame is not pulled down');

  // A SHORT STACK cannot claim a long one's light.
  assert.equal(recover(0.001, 1), 1, 'one frame gathered one frame of light');
  assert.equal(recover(0.001, 15), 15, 'fifteen frames, fifteen frames of light');
});

/*
 * THE COLOUR CAST, and why it is the sensor's rather than the room's.
 *
 * Each channel has its own noise floor. At an ordinary exposure the
 * difference is invisible; multiplied by a gain of 113 it becomes the
 * dominant colour. Joshua's runs are the evidence that it is an artefact:
 * the same closet came back GREEN on several captures and BLUE on the next,
 * and a wall does not change colour between two four-second exposures.
 */
test('the colour trim equalises a dark cast and leaves a real scene alone', () => {
  const TRUST = 0.05;
  const balanceFor = (rawMean, channels) => {
    const strength = Math.max(0, Math.min(1, (TRUST - rawMean) / TRUST));
    const average = (channels[0] + channels[1] + channels[2]) / 3;
    if (strength <= 0 || average <= 0) return [1, 1, 1];
    return channels.map((c) => (c > 0 ? 1 + strength * (average / c - 1) : 1));
  };

  // HIS BLUE RUN: mean 0.002, and a gained result dominated by blue.
  const trim = balanceFor(0.002, [0.20, 0.30, 0.55]);
  // Blue is pulled down, red is pulled up, and the correction is nearly full
  // strength because 0.002 is far below the trust threshold.
  assert.ok(trim[2] < 1, 'the dominant channel is trimmed down');
  assert.ok(trim[0] > 1, 'the weakest channel is brought up');
  // Applying it equalises the three to within a rounding error.
  const after = [0.20 * trim[0], 0.30 * trim[1], 0.55 * trim[2]];
  const spread = Math.max(...after) - Math.min(...after);
  assert.ok(spread < 0.02, `the cast is removed (spread ${spread.toFixed(4)})`);

  // BRIGHTNESS IS PRESERVED: equalising toward the AVERAGE, not toward the
  // weakest channel, which would darken the whole picture to fix its colour.
  const before = (0.20 + 0.30 + 0.55) / 3;
  assert.ok(Math.abs((after[0] + after[1] + after[2]) / 3 - before) < 0.01,
    'the average level is unchanged — this corrects colour, not exposure');

  // A REAL SCENE IS UNTOUCHED. At an ordinary exposure the strength is zero
  // and the trim is an exact identity, so a sunset stays a sunset.
  assert.deepEqual(balanceFor(0.30, [0.45, 0.30, 0.18]), [1, 1, 1],
    'daylight colour is evidence and is left exactly alone');
  assert.deepEqual(balanceFor(TRUST, [0.4, 0.3, 0.2]), [1, 1, 1],
    'and the ramp reaches identity exactly at the threshold, with no step');

  // IT RAMPS rather than switching, so nothing falls either side of a line.
  const partial = balanceFor(TRUST / 2, [0.2, 0.3, 0.55]);
  assert.ok(partial[2] > trim[2] && partial[2] < 1,
    'a half-trusted scene gets a half correction');
});

test('the trim is reported, including when it did nothing', () => {
  const counters = emptyNightCounters();
  assert.deepEqual(counters.balance, [1, 1, 1], 'an identity until measured');
  assert.match(describeNightCounters(counters), /colour untouched/,
    'saying so plainly beats leaving it to be inferred from a missing number');
  assert.match(describeNightCounters({ ...counters, balance: [1.4, 1.0, 0.7] }),
    /colour trim 1\.40\/1\.00\/0\.70/);
});
