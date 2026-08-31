import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { estimateEffectiveResolution, usefulLevels } from '../.test-build/vision/sharpness.js';

/** A frame with real detail at its own pixel scale. */
function sharp(size) {
  const g = new Uint8ClampedArray(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) g[y * size + x] = (x + y) % 2 ? 235 : 20;
  }
  return g;
}

/** A frame carrying detail only at 1/factor of its size, then upscaled. */
function upscaled(size, factor) {
  const small = Math.max(2, Math.floor(size / factor));
  const base = new Float32Array(small * small);
  for (let i = 0; i < base.length; i++) {
    const x = i % small;
    const y = (i / small) | 0;
    base[i] = ((x * 37 + y * 91) % 255);
  }
  const g = new Uint8ClampedArray(size * size);
  for (let y = 0; y < size; y++) {
    const sy = Math.min(small - 1, y / factor);
    const y0 = Math.floor(sy);
    const y1 = Math.min(small - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < size; x++) {
      const sx = Math.min(small - 1, x / factor);
      const x0 = Math.floor(sx);
      const x1 = Math.min(small - 1, x0 + 1);
      const fx = sx - x0;
      const top = base[y0 * small + x0] * (1 - fx) + base[y0 * small + x1] * fx;
      const bot = base[y1 * small + x0] * (1 - fx) + base[y1 * small + x1] * fx;
      g[y * size + x] = top * (1 - fy) + bot * fy;
    }
  }
  return g;
}

test('the level count scales with the sample so range is not fixed at three', () => {
  // A 256px sample runs out after three halvings, so anything upscaled by
  // more than eight pegs at the floor. Range is the reason to sample larger.
  assert.equal(usefulLevels(256), 3);
  assert.equal(usefulLevels(512), 4);
  assert.equal(usefulLevels(1024), 5);
  // And it never returns zero, however small the sample.
  assert.ok(usefulLevels(8) >= 1);
  assert.ok(usefulLevels(1) >= 1);
});

test('a natively sharp frame is not called upscaled', () => {
  const report = estimateEffectiveResolution(sharp(512), 512, 512);
  assert.equal(report.likelyUpscaled, false);
  assert.equal(report.pegged, false);
  assert.equal(report.effectiveScale, 1);
});

test('an upscaled frame within range reports a scale, not a bound', () => {
  const report = estimateEffectiveResolution(upscaled(512, 4), 512, 512);
  assert.equal(report.likelyUpscaled, true);
  assert.equal(report.pegged, false, 'four levels should resolve a 4x upscale');
  assert.ok(report.effectiveScale <= 0.5, `expected a coarse scale, got ${report.effectiveScale}`);
});

test('a frame upscaled beyond the search range is flagged as pegged', () => {
  // This is the case that produced "≈378×504 real detail" from a search that
  // had simply run out of levels. The number was the floor of what three
  // halvings can express, not a measurement, and reporting it as a pixel size
  // stated a precision the method does not have.
  const size = 128;
  const report = estimateEffectiveResolution(upscaled(size, 32), size, size, 2);
  assert.equal(report.pegged, true, 'the search should admit it ran out');
  assert.equal(report.levelsSearched, 2);
  assert.equal(report.effectiveScale, 0.25, 'the floor of two halvings');
});

test('a sample too flat to judge is not called upscaled', () => {
  // An upscale so extreme that the base is a couple of pixels has nothing
  // left to measure. Claiming an upscale from an empty image would be reading
  // noise, so the honest answer is to decline.
  const report = estimateEffectiveResolution(upscaled(128, 64), 128, 128, 2);
  assert.equal(report.likelyUpscaled, false);
  assert.equal(report.pegged, false);
});

test('a pegged report is presented as a bound, never as a pixel size', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const fn = source.slice(
    source.indexOf('function measureEffectiveDetail'),
    source.indexOf('function grabFullFrame')
  );
  assert.match(fn, /if \(report\.pegged\)/);
  assert.match(fn, /at least \$\{factor\}× coarser/);
  // The precise size must be unreachable while pegged.
  const pegged = fn.slice(fn.indexOf('if (report.pegged)'));
  const precise = pegged.indexOf('effectiveWidth');
  const returned = pegged.indexOf('return');
  assert.ok(returned < precise || precise === -1, 'the bound must return before any pixel size');
  // And the raw ratio is shown either way, so the verdict can be checked.
  assert.match(fn, /ratio \$\{ratio\}/);
});

test('the sample is large enough to resolve a real upscale', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(source, /const DETAIL_SAMPLE = 512;/);
});

test('every report carries the fields a caller needs to judge it', () => {
  for (const frame of [sharp(256), upscaled(256, 8)]) {
    const report = estimateEffectiveResolution(frame, 256, 256);
    assert.equal(typeof report.pegged, 'boolean');
    assert.equal(typeof report.levelsSearched, 'number');
    assert.ok(report.levelsSearched >= 0);
    assert.ok(report.effectiveScale > 0 && report.effectiveScale <= 1);
  }
});
