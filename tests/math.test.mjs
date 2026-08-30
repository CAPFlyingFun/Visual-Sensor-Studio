import test from 'node:test';
import assert from 'node:assert/strict';
import { gpsToLocalMeters, median } from '../.test-build/core/math.js';

test('gpsToLocalMeters converts small latitude changes to northing meters', () => {
  const origin = { latitude: 30, longitude: -87, altitude: 10 };
  const point = { latitude: 30.000008983, longitude: -87, altitude: 12.5 };
  const local = gpsToLocalMeters(point, origin);
  assert.ok(Math.abs(local.z + 1) < 0.03, `expected about -1m north in scene z, got ${local.z}`);
  assert.ok(Math.abs(local.y - 2.5) < 0.001);
});

test('median ignores non-finite values and returns middle value', () => {
  assert.equal(median([9, Number.NaN, 1, 5, Infinity]), 5);
});
