import test from 'node:test';
import assert from 'node:assert/strict';
import * as sr from '../.test-build/vision/super-resolution.js';
import * as mtf from '../.test-build/vision/mtf.js';

/** A slanted step edge, blurred and noised, as a camera renders one. */
function edge(size, angleDegrees, blurSigma, noise = 0, seed = 1) {
  const p = sr.createPlane(size, size);
  const slope = Math.tan(angleDegrees * Math.PI / 180);
  for (let y = 0; y < size; y++) {
    const at = size / 2 + slope * (y - size / 2);
    for (let x = 0; x < size; x++) p.data[y * size + x] = x < at ? 40 : 210;
  }
  const blurred = sr.blurPlane(p, blurSigma);
  return noise > 0 ? sr.noisyPlane(blurred, noise, seed) : blurred;
}

/** MTF50 of a Gaussian of this sigma, in cycles per pixel. */
const theory = (sigma) => 0.1874 / sigma;

test('MTF50 matches theory across the range a camera actually delivers', () => {
  // The instrument has to be right before anything measured with it means
  // anything. A Gaussian blur has a closed-form MTF50 of 0.1874/sigma, so this
  // is checkable rather than merely plausible.
  for (const sigma of [0.8, 1.2, 1.8, 2.5]) {
    const got = mtf.measureSlantedEdge(edge(160, 5, sigma)).mtf50;
    assert.ok(got !== null, `sigma ${sigma} was refused`);
    const error = Math.abs(got - theory(sigma)) / theory(sigma);
    assert.ok(error < 0.1,
      `sigma ${sigma}: got ${got.toFixed(4)}, theory ${theory(sigma).toFixed(4)} (${(error * 100).toFixed(0)}% off)`);
  }
});

test('sharper always reads higher — the ordering is the whole point', () => {
  // Phase 2 compares a merge against an upscale. If the ordering can invert,
  // the comparison decides nothing.
  const readings = [0.8, 1.2, 1.8, 2.5].map((s) => mtf.measureSlantedEdge(edge(160, 5, s)).mtf50);
  for (let i = 1; i < readings.length; i++) {
    assert.ok(readings[i] < readings[i - 1],
      `blur ${i} read ${readings[i]} against ${readings[i - 1]} — ordering inverted`);
  }
});

test('THE BUG THE HARNESS CAUGHT: the centroid must be windowed, not row-wide', () => {
  // Noise contributes about 1.13 of its sigma to |gradient| at every pixel, so
  // a centroid over the whole row weighs the edge against noise from the entire
  // width. At 512 px and sigma 2 that is roughly 1157 of noise weight against
  // 170 from the edge, and the centroid collapses to the middle of the row.
  //
  // Measured with the row-wide version: MTF50 fell from 0.186 to 0.037 at
  // sigma 2, and got WORSE as the region grew — the signature of a ratio
  // problem rather than a sampling one, which is what named the cause.
  for (const size of [160, 320, 512]) {
    for (const noise of [0, 2, 4]) {
      const got = mtf.measureSlantedEdge(edge(size, 5, 1.0, noise, 7)).mtf50;
      assert.ok(got !== null, `${size}px at noise ${noise} was refused`);
      assert.ok(Math.abs(got - theory(1)) / theory(1) < 0.1,
        `${size}px at noise ${noise}: ${got.toFixed(4)} against ${theory(1).toFixed(4)}`);
    }
  }
});

test('a region with no edge is refused, not measured', () => {
  const flat = sr.createPlane(160, 160);
  flat.data.fill(120);
  const result = mtf.measureSlantedEdge(sr.noisyPlane(flat, 3, 2));
  assert.equal(result.mtf50, null);
  assert.match(result.reason, /grey levels across this region/);
});

test('an edge too straight to sample is refused, with the reason', () => {
  // A vertical edge is crossed at the same sub-pixel phase by every row, so the
  // fine detail the method depends on is simply absent. It is not a marginal
  // measurement, it is no measurement.
  const result = mtf.measureSlantedEdge(edge(160, 0, 1.0));
  assert.equal(result.mtf50, null);
  assert.match(result.reason, /off vertical/);
  assert.match(result.reason, /Tilt the phone/);
});

test('an edge too slanted to trust is refused too', () => {
  // A steeply leaning edge means one row crosses several pixels of transition,
  // smearing the thing being measured.
  const result = mtf.measureSlantedEdge(edge(160, 30, 1.0));
  assert.equal(result.mtf50, null);
  assert.match(result.reason, /leans/);
});

test('an edge sharper than the grid is reported as unbounded, not as a number', () => {
  // When contrast never falls to half before Nyquist, the region cannot bound
  // the resolution. Reporting Nyquist itself would be a ceiling presented as a
  // measurement — the same error as quoting a pegged detail estimate.
  const result = mtf.measureSlantedEdge(edge(160, 5, 0.3));
  assert.equal(result.mtf50, null);
  assert.match(result.reason, /never falls to half before Nyquist/);
});

test('every refusal carries the numbers behind it', () => {
  // "It did not work" sends someone to guess. The angle and the contrast tell
  // them which way to move the phone.
  const straight = mtf.measureSlantedEdge(edge(160, 0, 1.0));
  assert.ok(straight.contrast > 100, 'contrast should still be reported on a refusal');
  assert.ok(straight.edgeAngleDegrees !== null, 'the angle should be reported too');
});

test('contrast is a percentile range, not the extremes of the sample', () => {
  // The extremes of a large sample measure outliers, not contrast: 25,600
  // pixels of sigma-3 noise span about 24 grey levels with no edge present,
  // and the span GROWS with the region rather than describing it. A flat noisy
  // patch then cleared the contrast gate and was refused several stages later
  // for the wrong reason — the fix is honest about which failure it is.
  const flat = sr.createPlane(160, 160);
  flat.data.fill(120);
  const noisy = mtf.measureSlantedEdge(sr.noisyPlane(flat, 3, 2));
  assert.ok(noisy.contrast < mtf.MIN_CONTRAST,
    `a flat noisy region reported ${noisy.contrast.toFixed(1)} of contrast`);
  assert.match(noisy.reason, /grey levels across this region/);

  // And it must not grow with the region, or the gate depends on framing.
  const big = sr.createPlane(512, 512);
  big.data.fill(120);
  const bigger = mtf.measureSlantedEdge(sr.noisyPlane(big, 3, 2));
  assert.ok(Math.abs(bigger.contrast - noisy.contrast) < 4,
    'contrast should not scale with the number of pixels');

  // A real edge still reads its full step, since half its pixels sit each side.
  assert.ok(mtf.measureSlantedEdge(edge(160, 5, 1.0)).contrast > 150);
});
