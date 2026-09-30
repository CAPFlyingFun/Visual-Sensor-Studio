import test from 'node:test';
import assert from 'node:assert/strict';
import { readState } from '../.test-build/v2/state.js';
import * as quality from '../.test-build/v2/capture/visually-lossless.js';

test('maximum JPEG quality is the default, compression needs an explicit choice', () => {
  assert.equal(readState().visuallyLossless, false);
});

test('optional compression never searches below quality 0.90', () => {
  assert.ok(Math.min(...quality.QUALITY_LADDER) >= 0.90);
});

test('compression measurement detects color loss at unchanged brightness', () => {
  assert.equal(typeof quality.rgbaSimilarity, 'function');
  const width = 16, height = 16;
  const reference = new Uint8ClampedArray(width * height * 4);
  const changed = new Uint8ClampedArray(reference.length);
  for (let i = 0; i < reference.length; i += 4) {
    reference.set([180, 80, 100, 255], i);
    // Rec.601 luma is almost unchanged, but the color visibly changes.
    changed.set([80, 131, 100, 255], i);
  }
  assert.equal(quality.rgbaSimilarity(reference, reference, width, height), 1);
  assert.ok(quality.rgbaSimilarity(reference, changed, width, height) < 0.99);
  assert.equal(quality.rgbaSimilarity(reference, changed.subarray(4), width, height), 0);
});
