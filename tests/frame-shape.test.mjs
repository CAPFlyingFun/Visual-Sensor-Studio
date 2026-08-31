import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

test('the frame shape is one record, derived once', async () => {
  const { frameShape } = await import('../.test-build/vision/frame-shape.js');
  // A portrait 12MP capture, the case both historical bugs were found on.
  const s = frameShape(3024, 4032);
  assert.equal(s.short, 3024);
  assert.equal(s.long, 4032);
  assert.equal(s.valid, true);
  // ASPECT IS WIDTH/HEIGHT and is BELOW ONE in portrait. The whole point of
  // the module is that this has exactly one answer.
  assert.ok(Math.abs(s.aspect - 0.75) < 1e-9);
});

test('aspect follows the convention the display arithmetic requires', async () => {
  const { frameShape } = await import('../.test-build/vision/frame-shape.js');
  // displayedShortSide and measureDisplay both compute
  //   contentWidth = boxHeight * aspect
  // which is only correct for width/height. Handing them long/short gave 1.333
  // where 0.75 was needed and loosened the screen bound by a third.
  for (const [w, h] of [[3024, 4032], [1920, 1080], [1080, 1920], [640, 480]]) {
    const s = frameShape(w, h);
    assert.ok(Math.abs(h * s.aspect - w) < 1e-6, `${w}x${h}: boxHeight*aspect must give width`);
  }
  // And portrait really is below one, so a regression to long/short is caught.
  assert.ok(frameShape(3024, 4032).aspect < 1);
  assert.ok(frameShape(4032, 3024).aspect > 1);
});

test('elongation is the orientation-free ratio, and is not the aspect', async () => {
  const { frameShape, elongation } = await import('../.test-build/vision/frame-shape.js');
  // Both orientations of the same sensor elongate identically...
  assert.ok(Math.abs(elongation(frameShape(3024, 4032)) - 4 / 3) < 1e-9);
  assert.ok(Math.abs(elongation(frameShape(4032, 3024)) - 4 / 3) < 1e-9);
  // ...while their aspects are reciprocals. Conflating the two IS the bug.
  assert.notEqual(frameShape(3024, 4032).aspect, frameShape(4032, 3024).aspect);
});

test('one guard, so no caller invents its own fallback', async () => {
  const { frameShape, widthForShortSide, elongation, UNKNOWN_SHAPE } =
    await import('../.test-build/vision/frame-shape.js');
  // The four sites this replaced had three different fallbacks: `|| width`, a
  // bare Math.min that could yield zero, and an early return.
  for (const [w, h] of [[0, 0], [3024, 0], [0, 4032], [-1, 10], [Number.NaN, 10]]) {
    const s = frameShape(w, h);
    assert.equal(s.valid, false, `${w}x${h} must not be treated as a known shape`);
    assert.equal(s.short, 0);
    assert.equal(s.aspect, 0);
  }
  // And the derived helpers stay safe on an unknown shape rather than
  // returning a zero or a NaN that would size a canvas.
  assert.equal(widthForShortSide(UNKNOWN_SHAPE, 540), 540);
  assert.equal(elongation(UNKNOWN_SHAPE), 1);
});

test('widthForShortSide keeps the frame orientation', async () => {
  const { frameShape, widthForShortSide } = await import('../.test-build/vision/frame-shape.js');
  // Portrait: the short side IS the width, so it passes through.
  assert.equal(widthForShortSide(frameShape(3024, 4032), 720), 720);
  // Landscape: 720 on the short side is 960 across on a 4:3 sensor. Sizing by
  // width instead made a portrait phone render 1.78x the pixels of a landscape
  // one at the same named tier.
  assert.equal(widthForShortSide(frameShape(4032, 3024), 720), 960);
});

test('main derives the frame shape in exactly one place', () => {
  // The point of the refactor. Four sites computed the short side and three
  // computed the aspect; they agreed only by coincidence, and the coincidence
  // had already failed twice.
  assert.match(mainSource, /function cameraShape\(\): FrameShape \{\s*\n\s*return frameShape\(camera\.diagnostics\.videoWidth, camera\.diagnostics\.videoHeight\);/);
  // No site may reconstruct these from the diagnostics again.
  assert.doesNotMatch(mainSource, /Math\.min\(camera\.diagnostics\.videoWidth/);
  assert.doesNotMatch(mainSource, /videoHeight \|\| source/);
  assert.doesNotMatch(mainSource, /videoHeight \|\| camera\.diagnostics\.videoWidth/);
  assert.doesNotMatch(mainSource, /diagnostics\.videoWidth \/ diagnostics\.videoHeight/);
});

test('the screen bound is given width over height, never long over short', () => {
  // The live bug this refactor exposed: lensDisplayWidth built long/short and
  // handed it to displayedShortSide, which needs width/height. On a portrait
  // 3024x4032 camera that is 1.333 where 0.75 was wanted, so the panel bound
  // read 615px instead of 461px and drew 1.78x the pixels the window could
  // show. Joshua's own Display readout had both numbers on screen at once —
  // measureDisplay said 461, displayedShortSide was using 615.
  assert.match(mainSource, /displayedShortSide\(shape\.aspect, performance\.now\(\)\)/);
  assert.doesNotMatch(mainSource, /Math\.max\(source, camera\.diagnostics\.videoHeight/);
});
