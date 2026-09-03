import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NIGHT_TARGET_FRAMES, NIGHT_TARGET_MS, NIGHT_TICK_MS, describeNightCounters,
  emptyNightCounters, nightStackWeight
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
    sourceWidth: 682, sourceHeight: 384, actualCadenceMs: 253.1
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
  assert.match(line, /682×384/, 'the frozen source dimensions');
  assert.match(line, /253 ms/, 'the MEASURED cadence, not the assumed 250');

  // Plural restarts, and no "(0 restarts)" clutter when there were none.
  const many = describeNightCounters({ ...counters, restarts: 2 });
  assert.match(many, /2 restarts\b/);
  const none = describeNightCounters({ ...counters, restarts: 0 });
  assert.ok(!/restart/.test(none), 'zero restarts says nothing about restarts at all');

  // A missing cadence measurement (no ticks yet) reads as unmeasured, not zero.
  const fresh = describeNightCounters(emptyNightCounters());
  assert.match(fresh, /cadence —/, 'no ticks yet: the honest answer is unmeasured');
});
