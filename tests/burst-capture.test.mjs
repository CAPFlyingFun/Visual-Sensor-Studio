import test from 'node:test';
import assert from 'node:assert/strict';
import * as sr from '../.test-build/vision/super-resolution.js';
import * as bc from '../.test-build/vision/burst-capture.js';

/** 1/f noise: the spectrum real scenes have. See super-resolution.test.mjs. */
function pinkScene(size, seed) {
  let a = seed >>> 0;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const p = sr.createPlane(size, size);
  p.data.fill(128);
  for (let octave = 1; octave <= 6; octave++) {
    const cells = 1 << octave;
    const amplitude = 90 / octave;
    const grid = new Float32Array((cells + 1) * (cells + 1));
    for (let i = 0; i < grid.length; i++) grid[i] = (rnd() - 0.5) * 2 * amplitude;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const gx = (x / size) * cells;
        const gy = (y / size) * cells;
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        const fx = gx - x0;
        const fy = gy - y0;
        const at = (i, j) => grid[j * (cells + 1) + i];
        const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
        const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
        p.data[y * size + x] += top * (1 - fy) + bottom * fy;
      }
    }
  }
  for (let i = 0; i < p.data.length; i++) p.data[i] = Math.max(0, Math.min(255, p.data[i]));
  return p;
}

const scene = pinkScene(128, 3);

test('the aligner recovers a known shift to the tenth of a pixel Phase 0 requires', () => {
  // Phase 0 measured the tolerance: 0.1px keeps most of the gain, 0.4px keeps
  // almost none, 0.8px is worse than not merging. So this is the bar, and an
  // aligner that cannot clear it makes the whole feature pointless.
  let worst = 0;
  for (const [dx, dy] of [[0, 0], [0.25, 0], [0.5, -0.25], [1.4, 2.7], [-2.3, 1.1], [3.75, -3.25]]) {
    const moved = sr.noisyPlane(sr.shiftPlane(scene, dx, dy), 2, 11);
    const got = bc.estimateShift(scene, moved, 6);
    worst = Math.max(worst, Math.hypot(got.shiftX - dx, got.shiftY - dy));
  }
  assert.ok(worst <= 0.1, `worst error ${worst.toFixed(3)} px exceeds the 0.1 px budget`);
});

test('the shift is NOT negated — sign errors here scatter every sample backwards', () => {
  // The first version negated the search result on the reasoning that it
  // "moves the frame back". Every estimate came out with the right magnitude
  // and the wrong sign, which a merge would have turned into a burst
  // depositing each sample on the opposite side of where it belonged — a
  // result that still looks like an image, which is why it needs a test.
  const moved = sr.shiftPlane(scene, 2.0, -1.0);
  const got = bc.estimateShift(scene, moved, 6);
  assert.ok(got.shiftX > 1, `expected about +2, got ${got.shiftX.toFixed(2)}`);
  assert.ok(got.shiftY < -0.5, `expected about -1, got ${got.shiftY.toFixed(2)}`);
});

test('a flat surface is refused rather than guessed at', () => {
  // A blank wall has nothing to match, and an argmin over noise is a confident
  // wrong answer. Measured: a flat plane scores about 0.024 here, so the floor
  // sits above it.
  const flat = sr.createPlane(128, 128);
  flat.data.fill(120);
  const got = bc.estimateShift(flat, sr.noisyPlane(flat, 2, 5), 6);
  assert.ok(got.confidence < bc.MIN_CONFIDENCE,
    `a flat wall scored ${got.confidence.toFixed(3)}, at or above the ${bc.MIN_CONFIDENCE} floor`);
  // And real texture must clear it comfortably, or the floor rejects everything.
  const real = bc.estimateShift(scene, sr.noisyPlane(sr.shiftPlane(scene, 1.5, 0.5), 2, 5), 6);
  assert.ok(real.confidence > 0.5, `textured scene scored only ${real.confidence.toFixed(2)}`);
});

test('THE FIX PHASE 0 IMPLIED: over-capture and select beats taking what you are given', () => {
  // Phase 0 concluded the capture had to be steered because random offsets
  // underperform. Selection reaches the same place from the other end: capture
  // more than you need, then discard the frames that duplicate an offset
  // already held. The hand does not have to cooperate, only wander.
  let a = 7;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const mean = (arr) => arr.reduce((x, y) => x + y, 0) / arr.length;

  const raw = [];
  const selected = [];
  for (let trial = 0; trial < 40; trial++) {
    const candidates = Array.from({ length: 32 }, () => ({
      shiftX: rnd() * 10, shiftY: rnd() * 10, confidence: 1
    }));
    raw.push(sr.offsetSpread(candidates.slice(0, 8)));
    selected.push(sr.offsetSpread(bc.selectDiverseSubset(candidates, 8).map((i) => candidates[i])));
  }
  // THE NUMBERS THAT MATTER, and the honest shape of them: taking the first
  // eight lands right ON the floor Phase 0 set — averaging about 0.53 to 0.56
  // depending on the burst, which is a coin flip on whether merging is worth
  // doing at all. Selecting from thirty-two clears it every time.
  //
  // So selection does not turn a bad burst into a good one. It turns an
  // unpredictable one into a reliable one, which is what a shipped feature
  // needs and what a gamble cannot be.
  const marginOfFloor = Math.abs(mean(raw) - bc.SPREAD_FLOOR);
  assert.ok(marginOfFloor < 0.05,
    `first-8 averaged ${mean(raw).toFixed(3)}, expected to straddle the ${bc.SPREAD_FLOOR} floor`);
  assert.ok(mean(selected) > bc.SPREAD_FLOOR + 0.05,
    `selected-8 averaged ${mean(selected).toFixed(3)}, which should clear the floor comfortably`);
  assert.ok(mean(selected) > mean(raw) + 0.08, 'and the gain should be substantial');
  // Reliability, not just the average — a feature that sometimes makes
  // pictures worse is worse than one that sometimes declines to run.
  //
  // Measured over 200 bursts, this is how the capture count was chosen:
  //   8 candidates  clear the floor 46% of the time  (a coin flip)
  //  16                              91%
  //  24                              97%
  //  32                              99.5%
  // Hence CAPTURE_CANDIDATES below: over-capture four to one, keep eight.
  const clearing = selected.filter((s) => s > bc.SPREAD_FLOOR).length / selected.length;
  assert.ok(clearing >= 0.95, `only ${(clearing * 100).toFixed(0)}% of bursts cleared the floor`);
});

test('selection cannot invent diversity that is not in the candidates', () => {
  // Eight candidates, keep eight: nothing to choose between, so the honest
  // result is no change. A selector that appeared to improve here would be
  // reporting a spread its frames do not have.
  const clustered = Array.from({ length: 8 }, (_, i) => ({
    shiftX: i * 0.02, shiftY: i * 0.01, confidence: 1
  }));
  const picked = bc.selectDiverseSubset(clustered, 8);
  assert.equal(picked.length, 8);
  assert.ok(Math.abs(sr.offsetSpread(picked.map((i) => clustered[i])) - sr.offsetSpread(clustered)) < 1e-9);
});

test('a tripod is told the truth, not given a merge', () => {
  // No motion means no second viewpoint, and no processing invents one. A
  // webcam bolted to a monitor is a legitimate way to use this app and must
  // get an honest answer rather than an upscale labelled as a merge.
  const still = Array.from({ length: 8 }, () => ({ shiftX: 0, shiftY: 0, confidence: 0.9 }));
  const verdict = bc.judgeBurst(still, 8);
  assert.equal(verdict.stationary, true);
  assert.equal(verdict.worthMerging, false);
  assert.match(verdict.reason, /tripod|fixed mount/i);
  assert.match(verdict.reason, /single frame/i);
});

test('a featureless scene is reported as unmeasurable, not as stationary', () => {
  // Two different failures with two different fixes: point somewhere with
  // detail, versus stop resting the phone on something.
  const blind = Array.from({ length: 8 }, (_, i) => ({
    shiftX: i * 0.3, shiftY: i * 0.2, confidence: 0.01
  }));
  const verdict = bc.judgeBurst(blind, 8);
  assert.equal(verdict.worthMerging, false);
  assert.match(verdict.reason, /texture/i);
});

test('a good handheld burst is approved, and says why', () => {
  const good = Array.from({ length: 8 }, (_, i) => ({
    shiftX: (i % 4) * 0.25 + Math.floor(i / 4),
    shiftY: Math.floor(i / 4) * 0.5 + (i % 2) * 0.25,
    confidence: 0.8
  }));
  const verdict = bc.judgeBurst(good, 8);
  assert.equal(verdict.worthMerging, true);
  assert.ok(verdict.selectedSpread >= bc.SPREAD_FLOOR);
  assert.match(verdict.reason, /more detail than any single frame/i);
});

test('a marginal burst is refused with the number that refused it', () => {
  // "It did not work" is not actionable. The percentage and the threshold are.
  const marginal = Array.from({ length: 8 }, (_, i) => ({
    shiftX: 0.5 + i * 0.01, shiftY: 0.5 + i * 0.01, confidence: 0.8
  }));
  const verdict = bc.judgeBurst(marginal, 8);
  assert.equal(verdict.worthMerging, false);
  assert.match(verdict.reason, /% of the sub-pixel grid/);
  assert.match(verdict.reason, /capture more frames/i);
});

test('rotation converts to pixels through the focal length, and refuses without one', () => {
  // The conversion the motion trigger runs on: a small pan moves the image by
  // focal length times the angle.
  assert.ok(Math.abs(bc.rotationToPixels(0.001, 2159) - 2.159) < 1e-6);
  // An unknown field of view means an unknown focal length, and guessing one
  // would silently mis-scale every trigger decision.
  assert.equal(bc.rotationToPixels(0.001, 0), 0);
});
