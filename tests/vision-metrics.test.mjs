import test from 'node:test';
import assert from 'node:assert/strict';
import {
  absoluteDifference,
  differenceToRgba,
  dimGrayToRgba,
  edgeDensity,
  luminanceStats,
  motionMaskToRgba,
  motionScore,
  rgbaToGray,
  sobelEdges
} from '../.test-build/vision/frame-processing.js';

test('luminanceStats reports mean and spread of a grayscale buffer', () => {
  const flat = new Uint8ClampedArray([100, 100, 100, 100]);
  const flatStats = luminanceStats(flat);
  assert.equal(flatStats.mean, 100);
  assert.equal(flatStats.standardDeviation, 0);
  assert.equal(flatStats.min, 100);
  assert.equal(flatStats.max, 100);

  const split = new Uint8ClampedArray([0, 0, 200, 200]);
  const splitStats = luminanceStats(split);
  assert.equal(splitStats.mean, 100);
  assert.equal(splitStats.standardDeviation, 100);
});

test('luminanceStats tolerates an empty buffer', () => {
  const stats = luminanceStats(new Uint8ClampedArray(0));
  assert.deepEqual(stats, { mean: 0, standardDeviation: 0, min: 0, max: 0 });
});

test('edgeDensity rises with the share of strong edge pixels', () => {
  const none = edgeDensity(new Uint8ClampedArray([0, 0, 0, 0]), 48);
  const half = edgeDensity(new Uint8ClampedArray([0, 0, 200, 200]), 48);
  const all = edgeDensity(new Uint8ClampedArray([200, 200, 200, 200]), 48);
  assert.equal(none, 0);
  assert.equal(half, 0.5);
  assert.equal(all, 1);
});

test('absoluteDifference reuses a supplied buffer instead of allocating', () => {
  const a = new Uint8ClampedArray([10, 250, 0, 128]);
  const b = new Uint8ClampedArray([0, 200, 40, 128]);
  const scratch = new Uint8ClampedArray(4);
  const result = absoluteDifference(a, b, scratch);
  assert.equal(result, scratch, 'the provided buffer must be returned, not a copy');
  assert.deepEqual([...result], [10, 50, 40, 0]);
});

test('absoluteDifference allocates when the supplied buffer is the wrong size', () => {
  const a = new Uint8ClampedArray([10, 20]);
  const b = new Uint8ClampedArray([0, 0]);
  const wrongSize = new Uint8ClampedArray(9);
  const result = absoluteDifference(a, b, wrongSize);
  assert.notEqual(result, wrongSize);
  assert.equal(result.length, 2);
});

test('motionScore counts only pixels past the threshold', () => {
  const difference = new Uint8ClampedArray([0, 5, 20, 90]);
  assert.equal(motionScore(difference, 18), 0.5);
  assert.equal(motionScore(difference, 100), 0);
  assert.equal(motionScore(new Uint8ClampedArray(0), 18), 0);
});

test('a still scene scores no motion and a changed scene scores some', () => {
  const width = 8;
  const height = 8;
  const first = new Uint8ClampedArray(width * height).fill(40);
  const still = absoluteDifference(first, first);
  assert.equal(motionScore(still, 18), 0);

  const second = Uint8ClampedArray.from(first);
  for (let i = 0; i < 16; i++) second[i] = 220;
  const moved = absoluteDifference(second, first);
  assert.ok(motionScore(moved, 18) > 0.2);
});

test('motion mask highlights changed pixels and dims unchanged ones', () => {
  const width = 4;
  const height = 4;
  const gray = new Uint8ClampedArray(width * height).fill(120);
  const difference = new Uint8ClampedArray(width * height);
  // A solid changed block so the 4-neighbour smoothing keeps its centre lit.
  for (const index of [5, 6, 9, 10]) difference[index] = 200;

  const rgba = motionMaskToRgba(gray, difference, width, height, 18);
  const movedGreen = rgba[5 * 4 + 1];
  const stillGreen = rgba[0 * 4 + 1];
  assert.ok(movedGreen > stillGreen + 60, 'moving pixels must read brighter than static ones');
  assert.equal(rgba[3], 255);
});

test('difference view is distinct from motion view for the same input', () => {
  const width = 4;
  const height = 4;
  const gray = new Uint8ClampedArray(width * height).fill(120);
  const difference = new Uint8ClampedArray(width * height);
  for (const index of [5, 6, 9, 10]) difference[index] = 200;

  const motion = motionMaskToRgba(gray, difference, width, height, 18);
  const raw = differenceToRgba(difference, 3.2);
  assert.notDeepEqual([...motion], [...raw]);
  // The raw view ignores the scene and shows only change intensity.
  assert.ok(raw[0] < 40, 'unchanged pixels stay dark in the raw difference view');
});

test('dimGrayToRgba darkens the flow backdrop', () => {
  const rgba = dimGrayToRgba(new Uint8ClampedArray([200]), 0.42);
  assert.equal(rgba[0], 84);
  assert.equal(rgba[3], 255);
});

test('rgbaToGray and sobelEdges reuse supplied buffers', () => {
  const width = 5;
  const height = 5;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const value = (i % width) >= 3 ? 255 : 0;
    rgba[i * 4] = value;
    rgba[i * 4 + 1] = value;
    rgba[i * 4 + 2] = value;
    rgba[i * 4 + 3] = 255;
  }

  const grayBuffer = new Uint8ClampedArray(width * height);
  const gray = rgbaToGray(rgba, grayBuffer);
  assert.equal(gray, grayBuffer);

  const edgeBuffer = new Uint8ClampedArray(width * height);
  edgeBuffer.fill(199);
  const edges = sobelEdges(gray, width, height, edgeBuffer);
  assert.equal(edges, edgeBuffer);
  assert.ok(edges[2 * width + 2] > 150, 'the vertical boundary must still be detected');
  assert.equal(edges[0], 0, 'a reused edge buffer must be cleared, not left stale');
});
