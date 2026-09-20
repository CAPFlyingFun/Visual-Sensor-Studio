import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildExposure, emptyExposure } from '../.test-build/v2/vision/exposure.js';

/*
 * AN IMPORTED PICTURE IS MEASURED AGAINST ITSELF.
 *
 * Every lens that reads the frame takes two numbers from the census — the
 * luma RANGE Relief stretches into, and the modal luma the region fill
 * measures each patch against. The import path used to be handed the
 * CAMERA's census, because sampleFrame has only ever read the video element.
 * So a photograph put through Blue Antenna, Survey, Blueprint or the cloud
 * lenses was measured against whatever the camera was pointing at — or, with
 * the camera never started, against the [0, 1] default, which is no picture.
 */

const app = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');

/** A square of RGBA the census can count, at one flat luma. */
function flat(level, pixels = 64 * 64) {
  const data = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    data[i * 4] = level;
    data[i * 4 + 1] = level;
    data[i * 4 + 2] = level;
    data[i * 4 + 3] = 255;
  }
  return data;
}

test('two different pictures produce two different censuses', () => {
  // The whole reason the mix-up matters: these numbers are not interchangeable.
  const dark = buildExposure(flat(24));
  const bright = buildExposure(flat(216));
  assert.notDeepEqual(dark.range, bright.range,
    'a dark picture and a bright one do not share a luma range');
  assert.ok(Math.abs(dark.mode - bright.mode) > 0.5,
    `their modal luma differs by most of the scale, got ${dark.mode} and ${bright.mode}`);
});

test('the fallback is the empty census, never the camera’s', () => {
  // A neutral default is wrong in a way you can SEE. Another scene's numbers
  // are wrong in a way you cannot, which is the worse failure.
  const empty = emptyExposure();
  assert.deepEqual(empty.range, [0, 1]);
  assert.equal(empty.mode, 0);
  const render = app.slice(app.indexOf('function renderImport()'));
  const body = render.slice(0, render.indexOf('\n}\n'));
  assert.match(body, /const census = importExposure \?\? emptyExposure\(\)/);
  assert.ok(!/exposure\.range|exposure\.mode/.test(body.replace(/importExposure/g, '')),
    'the camera census does not appear in the import render at all');
});

test('the import render and the import save read the SAME census', () => {
  for (const [name, start] of [
    ['renderImport', 'function renderImport()'],
    ['saveImport', 'async function saveImport()']
  ]) {
    const fn = app.slice(app.indexOf(start));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.match(body, /lumaRange: census\.range/, `${name} stretches into the picture's own range`);
    assert.match(body, /background: census\.mode/, `${name} fills against the picture's own background`);
    assert.match(body, /clarity: clarityExtras\(\)/, `${name} carries clarity`);
  }
});

test('the census is measured once per file, and let go with it', () => {
  const load = app.slice(app.indexOf('async function loadImport('));
  assert.match(load.slice(0, load.indexOf('\n}\n')),
    /importExposure = census \? buildExposure\(census\) : null/,
    'measured when the file opens — an imported picture, unlike a frame, does not change');
  const clear = app.slice(app.indexOf('function clearImport()'));
  assert.match(clear.slice(0, clear.indexOf('\n}\n')), /importExposure = null/,
    'and dropped with the picture, so the next import cannot inherit it');
});

test('one sampler, two sources', () => {
  // sampleFrame kept its own name and its own emptiness test; what moved is
  // the drawing, so there is still ONE definition of how a census is sampled.
  assert.match(app, /function sampleSquare\(source: CanvasImageSource\)/);
  assert.match(app, /function sampleFrame\(\): Uint8ClampedArray \| null \{\s*\n\s*if \(video\.videoWidth === 0\) return null;\s*\n\s*return sampleSquare\(video\);/,
    'the live path is unchanged apart from delegating the draw');
  const draws = app.match(/context\.drawImage\(source, 0, 0, HISTOGRAM_SAMPLE/g) ?? [];
  assert.equal(draws.length, 1, 'the census sample is drawn in exactly one place');
});

test('changing clarity redraws the imported picture', () => {
  // Save has always re-rendered before encoding, so the FILE was right; the
  // canvas was not, and a picture that disagrees with what saving it produces
  // is the same failure the review step exists to prevent.
  // The redraw moved into afterEdit when Sharpen arrived — three controls
  // over two settings, all redrawing the same surfaces. What matters is that
  // changing clarity still reaches the import, not which function says so.
  const set = app.slice(app.indexOf('function setClarityLevel('));
  assert.match(set.slice(0, set.indexOf('\n}\n')), /applyEdits\(/);
  const after = app.slice(app.indexOf('function afterEdit()'));
  const body = after.slice(0, after.indexOf('\n}\n'));
  assert.match(body, /else if \(importedImage\) renderImport\(\)/);
  assert.match(body, /if \(held\) void refreshReview\(\)/,
    'and a held camera shot is still re-captured');
});
