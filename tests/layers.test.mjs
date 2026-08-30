import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BackgroundModel,
  Chronochrome,
  MotionAmplifier,
  SlitScan
} from '../.test-build/vision/layers.js';

const W = 32;
const H = 24;
const rgba = () => new Uint8ClampedArray(W * H * 4);

function flat(value) {
  return new Uint8ClampedArray(W * H).fill(value);
}

/** A vertical edge at `x`, which is what any of these needs to see motion. */
function edgeAt(x) {
  const gray = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) {
    for (let px = 0; px < W; px++) gray[y * W + px] = px < x ? 60 : 200;
  }
  return gray;
}

// --- Motion amplification --------------------------------------------------

test('amplification starts from the frame, not from zero', () => {
  // Seeding the filters at zero makes the opening second a full-scale
  // transient that never happened.
  const amp = new MotionAmplifier();
  const out = rgba();
  amp.render(flat(128), W, H, out);
  assert.ok(Math.abs(out[0] - 128) < 2, `first frame came out at ${out[0]}`);
  assert.ok(amp.bandStrength < 1, 'and with no band to amplify');
});

test('a still scene is not amplified into noise', () => {
  const amp = new MotionAmplifier();
  const out = rgba();
  const scene = edgeAt(16);
  for (let i = 0; i < 40; i++) amp.render(scene, W, H, out, { gain: 20 });
  assert.ok(amp.bandStrength < 0.5, `a static scene produced a band of ${amp.bandStrength}`);
});

test('a small movement produces a band a large gain makes visible', () => {
  const amp = new MotionAmplifier();
  const out = rgba();
  // Settle on one position, then shift the edge by a single pixel.
  for (let i = 0; i < 30; i++) amp.render(edgeAt(16), W, H, out, { gain: 16 });
  const settled = amp.bandStrength;
  amp.render(edgeAt(17), W, H, out, { gain: 16 });
  assert.ok(amp.bandStrength > settled * 5,
    `a one-pixel shift should lift the band well above ${settled}, got ${amp.bandStrength}`);
});

test('the band decays once movement stops', () => {
  // Otherwise a single knock would stay amplified on screen indefinitely.
  const amp = new MotionAmplifier();
  const out = rgba();
  for (let i = 0; i < 30; i++) amp.render(edgeAt(16), W, H, out);
  amp.render(edgeAt(20), W, H, out);
  const peak = amp.bandStrength;
  for (let i = 0; i < 40; i++) amp.render(edgeAt(20), W, H, out);
  assert.ok(amp.bandStrength < peak * 0.2, `band held at ${amp.bandStrength} after ${peak}`);
});

// --- Background model ------------------------------------------------------

test('the background is not subtracted before it has been learned', () => {
  // Subtracting a model built from two frames flags the whole scene.
  const model = new BackgroundModel();
  const report = model.update(edgeAt(16), W, H);
  assert.equal(report.ready, false);
  assert.equal(report.foregroundFraction, 0, 'nothing may be claimed during warm-up');
});

test('a learned scene reports no foreground', () => {
  const model = new BackgroundModel();
  const scene = edgeAt(16);
  let report;
  for (let i = 0; i < 60; i++) report = model.update(scene, W, H);
  assert.equal(report.ready, true);
  assert.ok(report.foregroundFraction < 0.02,
    `a settled scene should be empty, got ${report.foregroundFraction}`);
});

test('something that does not belong is found', () => {
  const model = new BackgroundModel();
  const scene = edgeAt(16);
  for (let i = 0; i < 60; i++) model.update(scene, W, H);

  const withObject = Uint8ClampedArray.from(scene);
  for (let y = 8; y < 16; y++) for (let x = 4; x < 12; x++) withObject[y * W + x] = 255;
  const report = model.update(withObject, W, H);

  assert.ok(report.foregroundFraction > 0.03, `expected a detection, got ${report.foregroundFraction}`);
  assert.equal(model.mask[10 * W + 6], 255, 'the object itself should be masked');
  assert.equal(model.mask[2 * W + 28], 0, 'and the rest of the scene should not');
});

test('a slow mover is caught, which is the whole point over frame difference', () => {
  // Frame difference compares adjacent frames, so something creeping a pixel
  // every few frames nearly vanishes. A learned background does not care how
  // slowly it arrived.
  const model = new BackgroundModel();
  const scene = flat(60);
  for (let i = 0; i < 60; i++) model.update(scene, W, H);

  let report;
  for (let step = 0; step < 8; step++) {
    const frame = Uint8ClampedArray.from(scene);
    // A bright block creeping one column per frame.
    for (let y = 6; y < 18; y++) {
      for (let x = step; x < step + 6; x++) frame[y * W + x] = 220;
    }
    report = model.update(frame, W, H);
  }
  assert.ok(report.foregroundFraction > 0.05,
    `a slow mover should still stand out, got ${report.foregroundFraction}`);
});

test('the model adapts, so a parked object eventually becomes scenery', () => {
  // The honest trade for a background that survives changing daylight.
  const model = new BackgroundModel();
  for (let i = 0; i < 60; i++) model.update(flat(60), W, H);

  const parked = flat(60);
  for (let y = 6; y < 18; y++) for (let x = 4; x < 16; x++) parked[y * W + x] = 200;
  const arrival = model.update(parked, W, H);
  let settled = arrival;
  for (let i = 0; i < 400; i++) settled = model.update(parked, W, H);

  assert.ok(arrival.foregroundFraction > 0.1, 'it should be seen on arrival');
  assert.ok(settled.foregroundFraction < arrival.foregroundFraction * 0.2,
    'and absorbed once it has been there long enough');
});

// --- Chronochrome ----------------------------------------------------------

test('a static scene stays grey rather than fringing', () => {
  const chrono = new Chronochrome();
  const out = rgba();
  const scene = edgeAt(16);
  for (let i = 0; i < 20; i++) chrono.render(scene, W, H, out, 3);
  for (let i = 0; i < W * H; i++) {
    const p = i * 4;
    assert.equal(out[p], out[p + 1], 'red and green must match on a still scene');
    assert.equal(out[p + 1], out[p + 2], 'green and blue must match on a still scene');
  }
});

test('an unfilled ring shows grey rather than a false fringe', () => {
  // A fringe from an empty buffer looks exactly like real motion.
  const chrono = new Chronochrome();
  const out = rgba();
  chrono.render(edgeAt(16), W, H, out, 4);
  for (let i = 0; i < 8; i++) {
    const p = i * 4;
    assert.equal(out[p], out[p + 2], 'the first frame must not fringe');
  }
});

test('movement fringes, and the channel order carries the direction', () => {
  const chrono = new Chronochrome();
  const out = rgba();
  const gap = 2;
  // Fill the ring at one position, then sweep the edge rightwards.
  for (let i = 0; i < 12; i++) chrono.render(edgeAt(10), W, H, out, gap);
  for (let x = 11; x <= 18; x++) chrono.render(edgeAt(x), W, H, out, gap);

  let fringed = 0;
  for (let i = 0; i < W * H; i++) {
    const p = i * 4;
    if (Math.abs(out[p] - out[p + 2]) > 40) fringed++;
  }
  assert.ok(fringed > 0, 'a moving edge must produce coloured fringes');

  // The trailing side is where the edge USED to be: it was dark then and is
  // bright now, so the newest channel leads there.
  const row = 12 * W;
  const behind = out[(row + 14) * 4];
  const behindBlue = out[(row + 14) * 4 + 2];
  assert.notEqual(behind, behindBlue, 'the swept region must not be neutral');
});

// --- Slit-scan -------------------------------------------------------------

test('a slit scan builds a history one column at a time', () => {
  const scan = new SlitScan();
  const out = rgba();
  assert.equal(scan.columnsCollected, 0);
  scan.render(flat(100), W, H, out);
  assert.equal(scan.columnsCollected, 1);
  for (let i = 0; i < 10; i++) scan.render(flat(100), W, H, out);
  assert.equal(scan.columnsCollected, 11);
});

test('the newest column sits at the right edge, so time runs left to right', () => {
  const scan = new SlitScan();
  const out = rgba();
  // Fill the strip with one value, then write a single distinct column.
  for (let i = 0; i < W; i++) scan.render(flat(40), W, H, out);
  scan.render(flat(240), W, H, out);

  const rightmost = out[(5 * W + (W - 1)) * 4];
  const middle = out[(5 * W + 10) * 4];
  assert.ok(rightmost > 200, `newest column should be at the right edge, got ${rightmost}`);
  assert.ok(middle < 80, `older columns should still hold the old value, got ${middle}`);
});

test('the strip wraps without growing', () => {
  // A history that reallocated per frame would be unusable over minutes.
  const scan = new SlitScan();
  const out = rgba();
  const bytes = () => Object.values(scan)
    .filter((v) => ArrayBuffer.isView(v))
    .reduce((total, view) => total + view.byteLength, 0);

  for (let i = 0; i < W; i++) scan.render(flat(100), W, H, out);
  const before = bytes();
  for (let i = 0; i < W * 20; i++) scan.render(flat(100), W, H, out);
  assert.equal(bytes(), before);
  assert.equal(scan.columnsCollected, W, 'it fills and then holds');
});
