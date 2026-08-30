import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBlockFlow, flowVectorColor } from '../.test-build/vision/optical-flow.js';

const WIDTH = 96;
const HEIGHT = 72;

/**
 * A textured field the block matcher can lock onto.
 *
 * Four sine components with co-prime periods: smooth like real imagery, so
 * the match cost forms a basin a coarse-to-fine search can descend, with
 * comparable structure along both axes and both diagonals so the recovered
 * displacement is not limited by the aperture problem. The combined period is
 * far longer than the frame, so the best match inside the search window is
 * unambiguous.
 */
function texturedFrame(offsetX = 0, offsetY = 0) {
  const gray = new Uint8ClampedArray(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const sx = x - offsetX;
      const sy = y - offsetY;
      const value = 128
        + 50 * Math.sin(sx / 5)
        + 50 * Math.sin(sy / 5.5)
        + 40 * Math.sin((sx + sy) / 9)
        + 30 * Math.sin((sx - sy) / 7);
      gray[y * WIDTH + x] = Math.max(0, Math.min(255, Math.round(value)));
    }
  }
  return gray;
}

/** Mean recovered displacement over the accepted vectors. */
function meanFlow(field) {
  if (!field.vectors.length) return { dx: 0, dy: 0 };
  return {
    dx: field.vectors.reduce((sum, v) => sum + v.dx, 0) / field.vectors.length,
    dy: field.vectors.reduce((sum, v) => sum + v.dy, 0) / field.vectors.length
  };
}

test('a static scene produces no flow vectors', () => {
  const frame = texturedFrame();
  const field = computeBlockFlow(frame, frame, WIDTH, HEIGHT, { cellSize: 16, patchRadius: 3, maxShift: 6 });
  assert.equal(field.vectors.length, 0);
  assert.equal(field.meanMagnitude, 0);
  assert.equal(field.coverage, 0);
});

test('translation is recovered with the right magnitude and sign', () => {
  // Includes displacements that are not multiples of the coarse search step,
  // which is what the halving sequence has to be a power of two to reach.
  const cases = [
    { ox: 3, oy: 0 },
    { ox: 0, oy: -2 },
    { ox: 2, oy: 2 },
    { ox: -4, oy: 1 },
    { ox: 1, oy: -5 }
  ];

  for (const { ox, oy } of cases) {
    const field = computeBlockFlow(texturedFrame(0, 0), texturedFrame(ox, oy), WIDTH, HEIGHT, {
      cellSize: 16,
      patchRadius: 3,
      maxShift: 6
    });
    assert.ok(field.vectors.length > 0, `no vectors for offset (${ox}, ${oy})`);

    const mean = meanFlow(field);
    assert.ok(Math.abs(mean.dx - ox) <= 1.25, `offset (${ox}, ${oy}): expected dx near ${ox}, got ${mean.dx}`);
    assert.ok(Math.abs(mean.dy - oy) <= 1.25, `offset (${ox}, ${oy}): expected dy near ${oy}, got ${mean.dy}`);
  }
});

test('motion is only recoverable along axes the scene has structure on', () => {
  // The aperture problem, stated as a test rather than left as a surprise: a
  // scene textured only horizontally cannot report vertical motion, because
  // every vertical shift of it looks identical. This is a property of block
  // matching, not a defect in this implementation, and it is why the Motion
  // metric is a relative indicator rather than a measurement.
  // Vertical stripes: brightness depends on x only, so shifting the scene in
  // y produces a byte-for-byte identical frame.
  const stripes = (offsetX, offsetY) => {
    const gray = new Uint8ClampedArray(WIDTH * HEIGHT);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        void (y - offsetY);
        gray[y * WIDTH + x] = Math.round(128 + 100 * Math.sin((x - offsetX) / 5));
      }
    }
    return gray;
  };

  const movedVertically = computeBlockFlow(stripes(0, 0), stripes(0, 4), WIDTH, HEIGHT, { maxShift: 6 });
  assert.equal(movedVertically.vectors.length, 0, 'a vertical shift of vertical stripes is invisible');

  const horizontal = computeBlockFlow(stripes(0, 0), stripes(3, 0), WIDTH, HEIGHT, { maxShift: 6 });
  assert.ok(horizontal.vectors.length > 0, 'a horizontal shift of vertical stripes must be seen');
  assert.ok(Math.abs(meanFlow(horizontal).dx - 3) <= 1.25);
});

test('a flat untrackable scene is rejected rather than guessed at', () => {
  const flat = new Uint8ClampedArray(WIDTH * HEIGHT).fill(128);
  const shifted = new Uint8ClampedArray(WIDTH * HEIGHT).fill(128);
  const field = computeBlockFlow(flat, shifted, WIDTH, HEIGHT, { cellSize: 16, patchRadius: 3, maxShift: 6 });
  assert.equal(field.vectors.length, 0, 'a texture-free frame must produce no vectors');
});

test('displacement never exceeds the configured search radius', () => {
  const field = computeBlockFlow(texturedFrame(0, 0), texturedFrame(30, 30), WIDTH, HEIGHT, {
    cellSize: 16,
    patchRadius: 3,
    maxShift: 5
  });
  for (const vector of field.vectors) {
    assert.ok(Math.abs(vector.dx) <= 5, `dx ${vector.dx} exceeded maxShift`);
    assert.ok(Math.abs(vector.dy) <= 5, `dy ${vector.dy} exceeded maxShift`);
  }
});

test('a frame too small for the search window returns an empty field', () => {
  const tiny = new Uint8ClampedArray(4 * 4);
  const field = computeBlockFlow(tiny, tiny, 4, 4, { patchRadius: 3, maxShift: 6 });
  assert.equal(field.vectors.length, 0);
  assert.equal(field.width, 0);
});

test('flow colour encodes direction as hue', () => {
  const right = flowVectorColor({ x: 0, y: 0, dx: 4, dy: 0, magnitude: 4 }, 4);
  const down = flowVectorColor({ x: 0, y: 0, dx: 0, dy: 4, magnitude: 4 }, 4);
  assert.match(right, /^hsl\(0,/);
  assert.match(down, /^hsl\(90,/);
  assert.notEqual(right, down);
});
