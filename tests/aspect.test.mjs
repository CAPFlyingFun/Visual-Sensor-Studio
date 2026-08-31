import test from 'node:test';
import assert from 'node:assert/strict';
import { aspectRatioFor, cropToAspect, retainedFraction } from '../.test-build/vision/aspect.js';

const close = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

test('a landscape frame loses its top and bottom, never its sides', () => {
  // A 4:3 sensor frame is TALLER than 16:9, so widescreen takes from the top
  // and bottom. Taking from the sides would narrow the field of view for no
  // reason.
  const crop = cropToAspect(4032, 3024, 16 / 9);
  assert.equal(crop.width, 4032, 'the full width must be kept');
  assert.ok(crop.height < 3024);
  assert.ok(close(crop.width / crop.height, 16 / 9), `got ${crop.width}x${crop.height}`);
  assert.equal(crop.x, 0);
  assert.ok(crop.y > 0, 'and it must be centred');
});

test('a portrait frame loses its sides, and becomes 9:16 not 16:9', () => {
  // Turning the phone must not turn the photograph.
  const crop = cropToAspect(3024, 4032, 16 / 9);
  assert.equal(crop.height, 4032, 'the full height must be kept');
  assert.ok(crop.width < 3024);
  assert.ok(close(crop.height / crop.width, 16 / 9), `got ${crop.width}x${crop.height}`);
  assert.ok(crop.x > 0);
  assert.equal(crop.y, 0);
});

test('a square frame crops to widescreen in the sensor orientation', () => {
  const crop = cropToAspect(1080, 1080, 16 / 9);
  assert.equal(crop.width, 1080);
  assert.ok(close(crop.width / crop.height, 16 / 9));
});

test('asking for the shape it already has changes nothing', () => {
  const crop = cropToAspect(1920, 1080, 16 / 9);
  assert.deepEqual(crop, { x: 0, y: 0, width: 1920, height: 1080 });
});

test('a crop never leaves the frame', () => {
  for (const [w, h] of [[4032, 3024], [3024, 4032], [1080, 1080], [1920, 1080], [640, 480]]) {
    for (const ratio of [16 / 9, 4 / 3, 1, 2.39]) {
      const crop = cropToAspect(w, h, ratio);
      assert.ok(crop.x >= 0 && crop.y >= 0, `${w}x${h}@${ratio} started outside`);
      assert.ok(crop.x + crop.width <= w, `${w}x${h}@${ratio} ran off the right`);
      assert.ok(crop.y + crop.height <= h, `${w}x${h}@${ratio} ran off the bottom`);
      assert.ok(crop.width >= 1 && crop.height >= 1);
    }
  }
});

test('it only ever crops — it never invents pixels', () => {
  // There is no way to gain field of view from a sensor, only to give some up.
  for (const [w, h] of [[4032, 3024], [3024, 4032], [800, 600]]) {
    const crop = cropToAspect(w, h, 16 / 9);
    assert.ok(crop.width <= w && crop.height <= h);
    assert.ok(retainedFraction(w, h, crop) <= 1);
    assert.ok(retainedFraction(w, h, crop) > 0.5, 'a widescreen crop of 4:3 keeps most of it');
  }
});

test('degenerate input is refused rather than throwing', () => {
  for (const [w, h, r] of [[0, 0, 1], [-4, 10, 1], [10, 10, 0], [10, 10, -2], [NaN, 10, 1]]) {
    assert.doesNotThrow(() => cropToAspect(w, h, r));
    const crop = cropToAspect(w, h, r);
    assert.ok(crop.width >= 0 && crop.height >= 0);
  }
});

test('the sensor option keeps the frame as captured', () => {
  assert.equal(aspectRatioFor('sensor'), null);
  assert.ok(close(aspectRatioFor('wide'), 16 / 9));
});

test('the retained fraction is the cost, stated', () => {
  const crop = cropToAspect(4032, 3024, 16 / 9);
  const kept = retainedFraction(4032, 3024, crop);
  // 4:3 to 16:9 keeps three quarters of the height.
  assert.ok(close(kept, 0.75, 0.02), `kept ${kept}`);
});
