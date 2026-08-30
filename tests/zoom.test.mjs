import test from 'node:test';
import assert from 'node:assert/strict';
import { zoomPresetStops } from '../.test-build/sensors/zoom.js';

test('a 1x..5x range offers the familiar 1/2/3 stops plus the maximum', () => {
  assert.deepEqual(zoomPresetStops(1, 5), [1, 2, 3, 5]);
});

test('stops beyond the maximum are never offered', () => {
  assert.deepEqual(zoomPresetStops(1, 2.5), [1, 2, 2.5]);
  assert.deepEqual(zoomPresetStops(1, 1.6), [1, 1.6]);
});

test('a non-multiplier range gets evenly spaced stops instead of 1/2/3', () => {
  const stops = zoomPresetStops(100, 400);
  assert.equal(stops[0], 100);
  assert.equal(stops[stops.length - 1], 400);
  assert.ok(stops.length >= 3);
  for (let i = 1; i < stops.length; i++) {
    assert.ok(stops[i] > stops[i - 1], 'stops must be strictly increasing');
  }
});

test('an unusable range yields no stops at all', () => {
  assert.deepEqual(zoomPresetStops(1, 1), []);
  assert.deepEqual(zoomPresetStops(3, 2), []);
  assert.deepEqual(zoomPresetStops(Number.NaN, 4), []);
});

test('at most four stops are offered so they fit beside the slider', () => {
  assert.ok(zoomPresetStops(1, 20).length <= 4);
});
