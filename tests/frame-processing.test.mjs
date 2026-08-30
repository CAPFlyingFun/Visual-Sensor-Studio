import test from 'node:test';
import assert from 'node:assert/strict';
import { rgbaToGray, sobelEdges } from '../.test-build/vision/frame-processing.js';

test('rgbaToGray converts RGB pixels to luminance', () => {
  const rgba = new Uint8ClampedArray([
    255, 255, 255, 255,
    0, 0, 0, 255,
    255, 0, 0, 255
  ]);
  const gray = rgbaToGray(rgba);
  assert.equal(gray[0], 255);
  assert.equal(gray[1], 0);
  assert.ok(gray[2] >= 53 && gray[2] <= 55);
});

test('sobelEdges highlights a sharp vertical boundary', () => {
  const width = 5;
  const height = 5;
  const gray = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 3; x < width; x++) gray[y * width + x] = 255;
  }
  const edges = sobelEdges(gray, width, height);
  assert.ok(edges[2 * width + 2] > 150);
});
