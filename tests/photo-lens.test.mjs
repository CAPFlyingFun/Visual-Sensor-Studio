import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_MAX_PIXELS,
  TEMPORAL_CHANNELS,
  describeMissing,
  fitWithin,
  looksBlank,
  renderPhotoLens,
  unavailableChannels
} from '../.test-build/vision/photo-lens.js';
import { sanitiseLens } from '../.test-build/vision/lens-store.js';

const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const htmlSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function lensOn(channel, brightness) {
  return sanitiseLens({
    color: { channel, low: 0, high: 255, gamma: 1 },
    stops: [{ at: 0, color: '#000000' }, { at: 1, color: '#ffffff' }],
    brightness: brightness ? { channel: brightness, low: 0, high: 255, gamma: 1 } : undefined,
    base: 'black', sceneBlend: 0
  });
}

function photo(width, height, fill = (x, y) => ((x * 7 + y * 13) & 255)) {
  const data = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const v = fill(x, y);
      data.data[p] = v; data.data[p + 1] = v; data.data[p + 2] = v; data.data[p + 3] = 255;
    }
  }
  return { data, sourceWidth: width, sourceHeight: height, reduced: false };
}

test('a photo renders at its own size, not a reduced one', () => {
  const { rgba, report } = renderPhotoLens(lensOn('luma'), photo(64, 48));
  assert.equal(report.width, 64);
  assert.equal(report.height, 48);
  assert.equal(rgba.length, 64 * 48 * 4);
});

test('the spatial channels all work on a still', () => {
  for (const channel of ['luma', 'edges', 'relief']) {
    const { rgba, report } = renderPhotoLens(lensOn(channel), photo(48, 32));
    assert.deepEqual(report.missing, [], `${channel} should need nothing temporal`);
    let lit = 0;
    for (let i = 0; i < rgba.length; i += 4) if (rgba[i] > 8) lit++;
    assert.ok(lit > 20, `${channel} rendered an empty photo`);
  }
});

test('a temporal channel is reported as impossible rather than rendered as zero', () => {
  // One photograph has no sequence. Rendering the bottom of the ramp across
  // the frame would look like a confident reading of nothing; saying so is
  // the difference between an honest limit and an apparent bug.
  for (const channel of TEMPORAL_CHANNELS) {
    const missing = unavailableChannels(lensOn(channel));
    assert.deepEqual(missing, [channel]);
    assert.match(describeMissing(missing), /needs a sequence of frames/);
  }
});

test('a temporal brightness channel is reported too', () => {
  const missing = unavailableChannels(lensOn('luma', 'age'));
  assert.deepEqual(missing, ['age']);
});

test('a fully spatial lens says nothing is missing', () => {
  assert.equal(describeMissing(unavailableChannels(lensOn('relief', 'luma'))), '');
});

test('fitting preserves aspect and never exceeds the budget', () => {
  const fit = fitWithin(4536, 8064, 16_000_000);
  assert.ok(fit.width * fit.height <= 16_000_000);
  assert.ok(Math.abs(fit.width / fit.height - 4536 / 8064) < 0.01, 'aspect must survive');
  assert.equal(fit.reduced, true);
});

test('an image already within budget is untouched', () => {
  const fit = fitWithin(1920, 1080, DEFAULT_MAX_PIXELS);
  assert.deepEqual(fit, { width: 1920, height: 1080, reduced: false });
});

test('an undrawn canvas is detected rather than rendered as a lens picture', () => {
  // iOS Safari refuses an over-large canvas by returning a BLANK one instead
  // of throwing, so drawing and looking is the only reliable test. An undrawn
  // canvas is transparent black — alpha zero everywhere.
  const blank = new Uint8ClampedArray(64 * 64 * 4);
  assert.equal(looksBlank(blank, 64 * 64), true);
});

test('a very dark photograph is not mistaken for an undrawn canvas', () => {
  // The case that matters: judging by colour alone would call a night shot
  // blank, shrink it, and give up on an image that was never the problem —
  // and this app is pointed at dark scenes on purpose.
  const pixels = 300 * 300;
  const night = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i++) night[i * 4 + 3] = 255;
  assert.equal(looksBlank(night, pixels), false, 'opaque black is a photograph, not a failure');
});

test('a single drawn pixel in the far corner counts as drawn', () => {
  const pixels = 400 * 400;
  const data = new Uint8ClampedArray(pixels * 4);
  data[(pixels - 1) * 4 + 3] = 255;
  assert.equal(looksBlank(data, pixels), false);
});

test('the decoder steps down and verifies rather than trusting a limit', () => {
  const fn = mainSource.slice(
    mainSource.indexOf('async function decodePhoto'),
    mainSource.indexOf('async function applyLensToPhoto')
  );
  assert.match(fn, /looksBlank\(/, 'a blank result must be detected');
  assert.match(fn, /budget = Math\.floor\(budget \/ 2\)/, 'and stepped down');
  assert.match(fn, /for \(let attempt = 0; attempt < 5; attempt\+\+\)/);
});

test('the photo path uses the library, not the camera-app capture attribute', () => {
  // The native photo fallback was deliberately removed from this app and a
  // test forbids its return. This feature takes an already-taken photograph
  // instead, which needs no capture attribute and reverses no decision.
  const input = htmlSource.slice(htmlSource.indexOf('id="lensPhotoFile"'));
  assert.doesNotMatch(input.slice(0, 120), /capture/);
  assert.match(htmlSource, /id="lensPhotoButton"/);
});

test('the result states the size and any reduction it had to make', () => {
  assert.match(mainSource, /MP\)\./);
  assert.match(mainSource, /Reduced from \$\{report\.sourceWidth\}/);
  assert.match(mainSource, /describeMissing\(report\.missing\)/);
});
