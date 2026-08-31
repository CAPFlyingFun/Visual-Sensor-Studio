import test from 'node:test';
import assert from 'node:assert/strict';
import * as sr from '../.test-build/vision/super-resolution.js';

/**
 * Phase 0 of docs/multi-frame-super-resolution.md — the experiment, not a
 * regression net around it. Each assertion records a finding that changed what
 * the project should build, so a failure here means the conclusion moved and
 * needs re-measuring rather than re-baselining.
 *
 * THE SCENE MATTERS MORE THAN ANY PARAMETER, and that is itself a finding.
 * The first pass used a zone plate and produced two confident results that
 * both turned out to be artifacts of it: that weighted splatting always loses
 * to bicubic, and that most of the gain comes from single-frame deconvolution
 * rather than from the burst. Re-run on 1/f noise and on a real photograph,
 * both reversed. So these tests use 1/f "pink" noise, which has the spectrum
 * natural images actually have, and every conclusion asserted here was
 * confirmed against a crop of a real photograph before being written down.
 */

const BIN = 2;
const SIZE = 256;
const PSF = 0.7;
const IBP = { iterations: 3, gain: 0.4, correctionSigma: 0.5 };

/**
 * 1/f noise by summing interpolated random grids at halving scales.
 *
 * Deterministic, no fixture, and — unlike a zone plate — it distributes energy
 * across the band the way a photograph does, which is what stopped this
 * experiment reaching the wrong answer twice.
 */
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

function tremor(count, amplitude, seed) {
  let a = seed >>> 0;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const out = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < count; i++) {
    x += (rnd() - 0.5) * amplitude;
    y += (rnd() - 0.5) * amplitude;
    out.push({ shiftX: x, shiftY: y });
  }
  return out;
}

const scene = pinkScene(SIZE, 9);
const TREMOR = tremor(8, 1.4, 42);
const CLUSTERED = Array.from({ length: 8 }, (_, i) => ({ shiftX: i * 0.02, shiftY: i * 0.01 }));
const SPREAD = Array.from({ length: 8 }, (_, i) => ({
  shiftX: (i % 4) * 0.25 + Math.floor(i / 4),
  shiftY: Math.floor(i / 4) * 0.5
}));

/** Capture a burst and score everything against bicubic upscaling of frame 0. */
function bench(shifts, { blur = 0, psfSigma = PSF, noise = 2 } = {}) {
  const frames = sr.synthesiseBurst(scene, shifts, {
    binFactor: BIN, psfSigma, noiseSigma: noise, motionBlurScenePixels: blur, seed: 7
  });
  // Ground truth is the scene AS THE LENS DELIVERS IT. Scoring against the raw
  // scene would score against something no camera could produce.
  const ideal = sr.blurPlane(scene, psfSigma);
  const control = sr.upscaleFrame(frames[0], BIN);
  const hf = (plane) => sr.highFrequencyPsnr(plane, ideal);
  return { frames, ideal, hf, base: hf(control), psfSigma };
}

/** The pipeline as Phase 0 leaves it: splat for an estimate, then invert. */
function reconstruct(b, frames = b.frames) {
  const splat = sr.mergeBurst(frames, { scale: BIN, robustness: 0, noiseSigma: 1 });
  return sr.refineBurst(frames, {
    scale: BIN, binFactor: BIN, psfSigma: b.psfSigma, ...IBP, initial: splat
  });
}

const gainOf = (b, frames) => b.hf(reconstruct(b, frames)) - b.base;

test('the forward model is the camera, in the right order', () => {
  const frames = sr.synthesiseBurst(scene, [{ shiftX: 0, shiftY: 0 }], {
    binFactor: BIN, psfSigma: PSF, noiseSigma: 0, seed: 1
  });
  assert.equal(frames[0].plane.width, SIZE / BIN);

  // Binning must AVERAGE, because that is what the sensor does. A gentler
  // filter here would remove the aliasing the whole idea depends on, and the
  // harness would confidently answer a question nobody asked.
  const flat = sr.createPlane(4, 4);
  flat.data.fill(10);
  flat.data[0] = 20;
  assert.equal(sr.binPlane(flat, 2).data[0], (20 + 10 + 10 + 10) / 4);
});

test('THE FINDING: merging recovers real resolution — but only with spread offsets', () => {
  // MEASURED WITH NOISE OFF, deliberately. Merging eight frames averages away
  // most of the read noise, and the high-frequency score rewards denoising
  // more than it rewards resolution (measured: a pure denoise scores +12.5 dB
  // on it against +8.4 dB overall). So a burst can post a healthy number while
  // resolving nothing at all, and scoring a noisy capture cannot tell the two
  // apart. Removing the noise removes the confound: what is left is resolution.
  const spread = gainOf(bench(SPREAD, { noise: 0 }));
  assert.ok(spread > 3, `evenly spread offsets should recover real detail; got ${spread.toFixed(2)} dB`);
});

test('THE FINDING THAT DECIDES THE FEATURE: ordinary tremor is NOT enough', () => {
  // With the denoising confound removed, a random handheld burst scores BELOW
  // bicubic upscaling of one frame. Its apparent gain on a noisy capture
  // (+2.15 dB) was almost entirely noise reduction.
  //
  // This is the difference between a feature that works and one that only
  // looks like it does, and it is invisible to any measurement taken on a
  // noisy capture — which is what a device test would have been.
  const tremorGain = gainOf(bench(TREMOR, { noise: 0 }));
  const spread = gainOf(bench(SPREAD, { noise: 0 }));
  assert.ok(tremorGain < 0,
    `random tremor should not beat bicubic on resolution; got ${tremorGain.toFixed(2)} dB`);
  assert.ok(spread > tremorGain + 5, 'and managed offsets must be far better');
  // Confirmed on a real photograph as well as on 1/f noise.
});

test('THE FINDING THAT DECIDES THE CAPTURE: without offset diversity it is WORSE than bicubic', () => {
  // Joshua proposed letting the motion sensors trigger each frame. Measured,
  // that is not a refinement — it is the difference between the feature
  // working and actively harming the picture. Eight frames landing on one
  // sub-pixel offset are eight copies of one measurement, and merging them
  // scores BELOW simply upscaling a single frame.
  const clustered = gainOf(bench(CLUSTERED, { noise: 0 }));
  const tremorGain = gainOf(bench(TREMOR, { noise: 0 }));
  const spread = gainOf(bench(SPREAD, { noise: 0 }));

  assert.ok(clustered < -5,
    `a steady hand must be far worse than bicubic; got ${clustered.toFixed(2)} dB`);
  assert.ok(tremorGain > clustered + 5, 'ordinary tremor must beat clustered');
  assert.ok(spread > 3, 'and only managed offsets actually recover resolution');
});

test('only the FRACTIONAL part of a shift carries new information', () => {
  // Which is why a diversity gate cannot simply watch total displacement: a
  // burst can travel a long way and still sample one offset.
  const wholePixels = Array.from({ length: 8 }, (_, i) => ({ shiftX: i, shiftY: i * 2 }));
  assert.ok(sr.offsetSpread(wholePixels) < 0.35);
  assert.ok(sr.offsetSpread(CLUSTERED) < 0.35);
  assert.ok(sr.offsetSpread(SPREAD) > 0.6);
  // And it wraps, because 0.99 and 0.01 are neighbours, not opposites.
  assert.ok(sr.offsetSpread([{ shiftX: 0.99, shiftY: 0.99 }, { shiftX: 0.01, shiftY: 0.01 }]) < 0.35);
});

test('FINDING: alignment must be near a tenth of a pixel', () => {
  // The spec guessed 0.1px. An early measurement on a zone plate suggested
  // 0.2px was plenty and the spec was too strict; on realistic content that
  // was wrong and the original guess was right. Phase 1 needs the tight number.
  const b = bench(TREMOR);
  let a = 999;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const withError = (err) => gainOf(b, b.frames.map((f, i) => i === 0 ? f : {
    plane: f.plane,
    shiftX: f.shiftX + (rnd() - 0.5) * 2 * err,
    shiftY: f.shiftY + (rnd() - 0.5) * 2 * err
  }));

  const exact = gainOf(b);
  assert.ok(withError(0.1) > exact * 0.8, 'a tenth of a pixel must be affordable');
  assert.ok(withError(0.8) < 0, 'and most of a pixel must be worse than not merging at all');
});

test('FINDING: motion blur degrades gracefully — the stillness gate is second-order', () => {
  // Also measured before being built. Mild smear costs little and even
  // regularises the inversion slightly, so a trigger demanding perfect
  // stillness would reject frames worth keeping. Diversity is the gate that
  // matters; stillness is a refinement.
  const still = gainOf(bench(TREMOR));
  const smeared = gainOf(bench(TREMOR, { blur: 4 }));
  assert.ok(smeared > 0, 'four pixels of smear must still beat bicubic');
  assert.ok(smeared < still, 'but must cost something');
  assert.ok(smeared > still * 0.5, `and should not collapse; ${smeared.toFixed(2)} of ${still.toFixed(2)}`);
});

test('FINDING: back-projection is semi-convergent — early stopping IS the regulariser', () => {
  // It improves, then diverges. Running it to "convergence" produced -18 dB on
  // the first sweep and briefly looked like proof the idea was dead.
  const b = bench(TREMOR);
  const at = (iterations) => b.hf(sr.refineBurst(b.frames, {
    scale: BIN, binFactor: BIN, psfSigma: PSF, iterations, gain: 0.6, correctionSigma: 0
  })) - b.base;
  assert.ok(at(3) > at(20), 'many iterations must be worse than a few');
  assert.ok(at(20) < 0, `20 iterations should fall below bicubic; got ${at(20).toFixed(2)} dB`);
});

test('the estimator is NOT settled, and the test says so rather than pretending', () => {
  // On 1/f noise the splat alone scores best; on a real photograph the splat
  // followed by back-projection wins by a wide margin. Both beat bicubic,
  // which is the claim Phase 0 had to establish. Choosing between them needs
  // Phase 2 measurements on real captures, so nothing here asserts a winner.
  const b = bench(TREMOR);
  const splat = sr.mergeBurst(b.frames, { scale: BIN, robustness: 0, noiseSigma: 2 });
  const refined = sr.refineBurst(b.frames, {
    scale: BIN, binFactor: BIN, psfSigma: PSF, ...IBP
  });
  assert.ok(b.hf(splat) > b.base, 'splatting beats bicubic here');
  assert.ok(b.hf(refined) > b.base, 'back-projection beats bicubic here');
});

test('the high-frequency score CANNOT separate denoising from resolution', () => {
  // Documented as a limitation because it was nearly a wrong conclusion. The
  // high-pass score was added to stop a method winning by denoising while
  // resolving nothing — and it does not do that. It rewards a pure denoise
  // MORE than overall PSNR does.
  //
  // Which is why every resolution claim in this file is measured with the
  // noise turned off, and why the on-device measurement has to be a
  // slanted-edge MTF rather than any PSNR variant: on a real capture there is
  // no noise-free control to fall back on.
  const b = bench(TREMOR);
  const control = sr.upscaleFrame(b.frames[0], BIN);
  const noisy = sr.noisyPlane(control, 6, 3);
  const denoised = sr.blurPlane(noisy, 1.0);

  const overallGain = sr.psnr(denoised, b.ideal) - sr.psnr(noisy, b.ideal);
  const highGain = sr.highFrequencyPsnr(denoised, b.ideal) - sr.highFrequencyPsnr(noisy, b.ideal);
  assert.ok(overallGain > 0, 'denoising helps overall, as expected');
  assert.ok(highGain > overallGain,
    'and the high-frequency score rewards it MORE, which is the trap this records');
});
