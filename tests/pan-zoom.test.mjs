/*
 * PAN AND ZOOM, as maths.
 *
 * Joshua, 2026-09-21: "the image should be separate from the UI, which the
 * image can allow pan and zoom, but the UI is fixed, like the full screen
 * camera." Judging whether a sharpening setting laid a white rind along an
 * edge is not a question a 430-point screen can answer about a 4032-pixel
 * photograph — you have to get close to it.
 *
 * Everything that decides where the picture is allowed to end up lives in one
 * pure module, so it can be checked here rather than by dragging a finger
 * across a device. The shell only owns the pointers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FIT, MAX_SCALE, MIN_SCALE, TAP_SCALE,
  clampView, overhang, panBy, toggleZoom, transformOf, zoomAbout
} from '../.test-build/v2/ui/pan-zoom.js';

/** A landscape frame with a picture fitted to its width. */
const FRAME = { width: 400, height: 800 };
const FITTED = { width: 400, height: 300 };

test('the fit is the identity, and nothing has to know the picture’s pixel size', () => {
  assert.deepEqual(FIT, { scale: 1, x: 0, y: 0 });
  assert.equal(transformOf(FIT), 'translate(0.00px, 0.00px) scale(1.0000)');
});

test('a fitted picture cannot be dragged off centre at all', () => {
  // Its overhang is zero on both axes: there is nothing outside the frame to
  // bring into it, so a drag has nowhere to go.
  assert.deepEqual(overhang(FRAME, FITTED, 1), { width: 0, height: 0 });
  const dragged = panBy(FIT, 260, -140, FRAME, FITTED);
  assert.deepEqual(dragged, { scale: 1, x: 0, y: 0 },
    'a picture with nothing hidden stays exactly where it is');
});

test('zoomed in, the drag stops with the picture’s edge against the frame’s', () => {
  // At 2× the picture is 800×600 in a 400×800 frame: 200 of overhang across,
  // and still none down, because 600 is shorter than 800.
  const at2 = { scale: 2, x: 0, y: 0 };
  assert.deepEqual(overhang(FRAME, FITTED, 2), { width: 200, height: 0 });
  const far = panBy(at2, 1000, 1000, FRAME, FITTED);
  assert.equal(far.x, 200, 'as far as its own overhang and no further');
  assert.equal(far.y, 0, 'and not at all on the axis that still fits');
  const back = panBy(at2, -1000, 0, FRAME, FITTED);
  assert.equal(back.x, -200, 'the same on the way back');
});

test('zooming out re-centres what zooming in pushed aside', () => {
  // Pushed hard against the right edge at 4×...
  const pushed = panBy({ scale: 4, x: 0, y: 0 }, 5000, 5000, FRAME, FITTED);
  assert.equal(pushed.x, 600);
  assert.equal(pushed.y, 200);
  // ...and coming back to the fit cannot leave it out there, because the
  // overhang it was using no longer exists.
  const fitted = clampView({ ...pushed, scale: 1 }, FRAME, FITTED);
  assert.deepEqual(fitted, { scale: 1, x: 0, y: 0 });
});

test('a pinch keeps what is under the fingers under the fingers', () => {
  // A point 100 to the right of centre, at the fit. The picture point there
  // is 100 from the picture's centre; after a 2× zoom it must still sit at
  // 100 on screen, which means the offset has to move by -100.
  const at = { x: 100, y: 0 };
  const zoomed = zoomAbout(FIT, 2, at, FRAME, FITTED);
  assert.equal(zoomed.scale, 2);
  assert.equal(zoomed.x, -100, 'the anchor did not slide out from under the pinch');
  // And the check that matters: the same picture point maps back to the same
  // screen point. Screen = offset + picturePoint × scale.
  const picturePoint = (at.x - FIT.x) / FIT.scale;
  assert.equal(zoomed.x + picturePoint * zoomed.scale, at.x);
});

test('a pinch past a limit anchors on the scale it actually got, not the one asked for', () => {
  // Asking for 40× from 4× when the ceiling is 8×: if the anchor maths used
  // the requested factor the picture would lurch sideways at the limit.
  const held = zoomAbout({ scale: 4, x: 0, y: 0 }, 10, { x: 120, y: 0 }, FRAME, FITTED);
  assert.equal(held.scale, MAX_SCALE);
  const applied = MAX_SCALE / 4;
  const expected = 120 - (120 - 0) * applied;
  const limit = overhang(FRAME, FITTED, MAX_SCALE).width;
  assert.equal(held.x, Math.max(-limit, Math.min(limit, expected)));
});

test('you cannot zoom out past the fit, or in past the ceiling', () => {
  assert.equal(zoomAbout(FIT, 0.2, { x: 0, y: 0 }, FRAME, FITTED).scale, MIN_SCALE,
    'there is nothing to see outside the picture, so pinching in stops at it');
  assert.equal(clampView({ scale: 99, x: 0, y: 0 }, FRAME, FITTED).scale, MAX_SCALE);
});

test('a double tap goes in about the tap, and a second one is an undo', () => {
  const inward = toggleZoom(FIT, { x: 80, y: 40 }, FRAME, FITTED);
  assert.equal(inward.scale, TAP_SCALE);
  // Anything above the fit comes ALL the way back — an undo that landed
  // somewhere new would not be one.
  assert.deepEqual(toggleZoom(inward, { x: 0, y: 0 }, FRAME, FITTED), FIT);
  assert.deepEqual(toggleZoom({ scale: 1.2, x: 10, y: 0 }, { x: 0, y: 0 }, FRAME, FITTED), FIT);
});

test('a tall picture in a wide frame behaves the same way on the other axis', () => {
  const wide = { width: 800, height: 400 };
  const tall = { width: 300, height: 400 };
  assert.deepEqual(overhang(wide, tall, 1), { width: 0, height: 0 });
  assert.deepEqual(overhang(wide, tall, 3), { width: 50, height: 400 });
  const dragged = panBy({ scale: 3, x: 0, y: 0 }, 0, -900, wide, tall);
  assert.equal(dragged.y, -400);
});

test('the transform is translate then scale, so the offset is in frame pixels', () => {
  // Written in this order on purpose: a scale applied first would multiply
  // the offset, and every clamp here is measured in the frame's own pixels.
  assert.equal(transformOf({ scale: 2.5, x: -12.345, y: 6 }),
    'translate(-12.35px, 6.00px) scale(2.5000)');
});
