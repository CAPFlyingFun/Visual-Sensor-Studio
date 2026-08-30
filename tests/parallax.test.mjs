import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBlockDisparity } from '../.test-build/vision/parallax.js';

function makeTexture(width, height) {
  const out = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[y * width + x] = (x * 17 + y * 29 + ((x * y) % 31) * 7) % 256;
    }
  }
  return out;
}

function shifted(source, width, height, dx) {
  const out = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceX = x - dx;
      out[y * width + x] = sourceX >= 0 && sourceX < width ? source[y * width + sourceX] : 0;
    }
  }
  return out;
}

test('computeBlockDisparity recovers a known horizontal image shift', () => {
  const width = 48;
  const height = 32;
  const reference = makeTexture(width, height);
  const current = shifted(reference, width, height, 3);
  const result = computeBlockDisparity(reference, current, width, height, {
    blockSize: 4,
    patchRadius: 2,
    maxDisparity: 6,
    verticalSearch: 1,
    textureThreshold: 8
  });

  const valid = [...result.disparity].filter((v) => Number.isFinite(v) && v > 0.5);
  valid.sort((a, b) => a - b);
  const middle = valid[Math.floor(valid.length / 2)];
  assert.ok(valid.length > 10, 'expected enough valid depth blocks');
  assert.ok(Math.abs(middle - 3) <= 1, `expected median disparity near 3px, got ${middle}`);
});
