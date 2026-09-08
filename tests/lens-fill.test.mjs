import test from 'node:test';
import assert from 'node:assert/strict';

import { compileLens } from '../.test-build/v2/filters/lens-shader.js';
import { sanitiseLens, unsupportedFillKeys } from '../.test-build/vision/lens-store.js';
import { buildExposure } from '../.test-build/v2/vision/exposure.js';
import { STARTER_LENSES } from '../.test-build/v2/filters/starter-lenses.js';

/*
 * REGION FILL — the body of a shape rather than a fatter outline.
 *
 * The pixels themselves are measured in a browser (v2-geometry renders the
 * built room and reads the three regions back off the GPU). What is checked
 * here is everything that decides WHAT gets rendered: the document, the
 * compiled shader, the composition, and the backward compatibility that lets
 * every lens written before this still load.
 */

const BLUE_OUTLINE = {
  version: 1,
  id: 'lens-mtsr1u5r-f2ojy1',
  name: 'Blue Outline',
  color: { channel: 'luma', low: 0, high: 255, gamma: 0.8 },
  stops: [
    { at: 0, color: '#03121f' }, { at: 0.5, color: '#2f9fd6' }, { at: 1, color: '#eafaff' }
  ],
  brightness: { channel: 'edges', low: 0, high: 240, gamma: 0.8 },
  base: 'black',
  sceneBlend: 0
};
const FILL = { strength: 0.42, scale: 0.35, sensitivity: 0.72, textureReject: 0.9 };

test('a lens written before the fill existed loads and compiles unchanged', () => {
  // Joshua's own Blue Outline document, verbatim. Backward compatibility is
  // the one thing a schema change can break invisibly.
  const clean = sanitiseLens(BLUE_OUTLINE);
  assert.equal(clean.fill, undefined, 'no fill is invented for a document without one');
  assert.equal(clean.name, 'Blue Outline');
  assert.equal(clean.brightness.channel, 'edges');
  const filter = compileLens(clean);
  assert.equal(filter.unavailableReason, undefined);
  assert.ok(!filter.fragment.includes('regionFill'), 'and no fill code is emitted');
  assert.ok(!filter.needsLumaRange, 'nor is a census demanded it never needed');
});

test('a fill turned down to nothing IS the document without one', () => {
  // Off has to be the absence of the block, or "I turned it off" and "it was
  // never there" would be two different lenses that render identically.
  assert.equal(sanitiseLens({ ...BLUE_OUTLINE, fill: { ...FILL, strength: 0 } }).fill, undefined);
  const on = sanitiseLens({ ...BLUE_OUTLINE, fill: FILL });
  assert.deepEqual(on.fill, FILL);
});

test('fill fields this build cannot honour are NAMED, never silently dropped', () => {
  /*
   * The lens that started this: authored elsewhere, imported, and it rendered
   * exactly the same picture as the lens without the block because the parser
   * ignored every field it did not know.
   */
  const invented = {
    ...BLUE_OUTLINE,
    fill: {
      enabled: true, source: 'edges', mode: 'close-and-fill', bridgeGapPx: 6,
      closingRadiusPx: 3, fillStrength: 0.45, boundaryCoverage: 0.62,
      minRegionAreaPx: 120, maxEdgeDensity: 0.42, downsample: 2
    }
  };
  const ignored = unsupportedFillKeys(invented);
  for (const key of ['enabled', 'mode', 'bridgeGapPx', 'fillStrength', 'minRegionAreaPx']) {
    assert.ok(ignored.includes(key), `${key} is reported as ignored`);
  }
  // And nothing this build DOES read is ever reported as ignored.
  assert.deepEqual(unsupportedFillKeys({ ...BLUE_OUTLINE, fill: FILL }), []);
  assert.deepEqual(unsupportedFillKeys(BLUE_OUTLINE), [], 'no fill block, nothing to report');
});

test('the fill is a body signal, not a dilated edge', () => {
  const filter = compileLens(sanitiseLens({ ...BLUE_OUTLINE, fill: FILL }));
  const code = filter.fragment;
  assert.ok(code.includes('vec2 regionFill(vec2 uv)'), 'the fill is emitted');

  // THE LOAD-BEARING LINE. The body is distance from the frame's prevailing
  // level, which the middle of a slab answers as loudly as its rim. Two
  // earlier versions were rejected by measurement: the broad ring's VARIANCE
  // (true only in a band around each outline — a soft dilation, and it left a
  // door at exactly 0.00) and the broad ring's MEAN (a band-pass, so the bare
  // wall beside a lamp reached 0.90 while the door stayed at 0.00).
  const body = code.slice(code.indexOf('float body ='));
  assert.match(body.slice(0, 120), /abs\(wide\.x - uBackground\)/);

  // It must never read the edge map — that is the difference it exists for.
  const fillBody = code.slice(code.indexOf('float regionFill'), code.indexOf('float normColour'));
  assert.ok(!/sobelLuma|ch_edges/.test(fillBody), 'the fill never looks at the edges');

  // Composed UNDER the edge: a per-channel max, so a lit outline keeps all of
  // its brightness and only the dark interior is raised.
  assert.match(code, /c = max\(c, texture2D\(uRamp, vec2\(normColour\(fill\.y \* 255\.0\), 0\.5\)\)\.rgb \* fill\.x\)/);
  assert.ok(code.indexOf('c *= mix(') < code.indexOf('c = max(c,'),
    'the edge term is applied before the body is put under it');

  // THE BODY'S TONE IS ITS OWN AVERAGE, not this pixel's. Painted at the
  // per-pixel ramp position a specular highlight on a jar went white while
  // the shadow beside it dropped to the bottom of the ramp, and the body came
  // out as mottled as the picture it was meant to simplify (Joshua's kitchen,
  // 2026-09-08). A regression to `vec2(t, 0.5)` here would look like nothing
  // in a test that only asked whether a fill was emitted.
  assert.ok(!/regionFill\(vUv\)\)/.test(code.slice(code.indexOf('c = max(c,'))),
    'the fill is read once into a vec2, not called inline for its amount alone');
  assert.match(code, /return vec2\(clamp\(body \* coherent[^;]*, \(fine\.x \+ wide\.x\) \* 0\.5\);/,
    'and the second component is the mean of the samples already taken');

  // The radii are frame-relative, so a 3024-wide still is the same picture as
  // the preview it was framed in rather than a quarter of the reach.
  assert.match(code, /frameStep\(FILL_REFERENCE\)/);
  assert.ok(!/uTexel \* FILL_/.test(code), 'never a radius in texels');
});

test('the fill demands the census it measures against', () => {
  // It compares every patch to the frame's modal luma. Rendered without one,
  // uBackground is 0 and the whole picture reads as far from the background —
  // which is the entire frame filled, in a still, silently.
  assert.equal(compileLens(sanitiseLens({ ...BLUE_OUTLINE, fill: FILL })).needsLumaRange, true);
});

test('fill is offered only where it means something', () => {
  // mask and swap paint the camera's own colours; there is no ramp to lift a
  // body toward, so the block is ignored rather than half-honoured.
  for (const output of ['mask', 'swap']) {
    const filter = compileLens(sanitiseLens({
      ...BLUE_OUTLINE, output, reference: '#c81e28', fill: FILL
    }));
    assert.ok(!filter.fragment.includes('regionFill'), `${output} emits no fill`);
  }
  assert.ok(compileLens(sanitiseLens({ ...BLUE_OUTLINE, output: 'paint', fill: FILL }))
    .fragment.includes('regionFill'));
});

test('the fill changes the lens revision, or a live edit would not redraw', () => {
  const { revision: without } = compileLens(sanitiseLens(BLUE_OUTLINE));
  const { revision: with1 } = compileLens(sanitiseLens({ ...BLUE_OUTLINE, fill: FILL }));
  const { revision: with2 } = compileLens(sanitiseLens({
    ...BLUE_OUTLINE, fill: { ...FILL, sensitivity: 0.9 }
  }));
  assert.notEqual(without, with1);
  assert.notEqual(with1, with2, 'every one of the four numbers is in the shader');
});

test('Blue Antenna ships, and Blue Outline is not touched', () => {
  // "Do NOT replace Blue Outline. I want to compare them side by side."
  const antenna = STARTER_LENSES.find((lens) => lens.id === 'lens-v2-blue-antenna');
  assert.ok(antenna, 'Blue Antenna is a starter');
  assert.equal(antenna.name, 'Blue Antenna');
  assert.ok(antenna.fill && antenna.fill.strength > 0, 'and it actually fills');
  // Same palette and same channels as the lens it is the filled twin of.
  assert.deepEqual(antenna.stops, BLUE_OUTLINE.stops);
  assert.deepEqual(antenna.color, BLUE_OUTLINE.color);
  assert.deepEqual(antenna.brightness, BLUE_OUTLINE.brightness);
  assert.ok(!STARTER_LENSES.some((lens) => lens.id === BLUE_OUTLINE.id),
    'his own Blue Outline is his, and is not overwritten by a starter');
});

test('the modal luma is the background, and the mean is not', () => {
  /*
   * A bimodal frame — dark walls under a bright popcorn ceiling, which is the
   * room this was built in. The mean lands between the two and describes no
   * part of the picture; the mode lands on the walls, which is what a
   * background is. Getting this wrong makes the WALLS read as anomalous as
   * the ceiling, and the fill then lights the background.
   */
  const pixels = [];
  const push = (y, n) => { for (let i = 0; i < n; i++) pixels.push(y, y, y, 255); };
  push(18, 7000);   // walls, most of the frame
  push(210, 3000);  // a bright ceiling
  const reading = buildExposure(pixels);
  assert.ok(Math.abs(reading.mode - 18 / 255) < 0.02,
    `mode ${reading.mode.toFixed(3)} sits on the walls`);
  assert.ok(reading.mean > 0.2, `mean ${reading.mean.toFixed(3)} sits on neither`);
});
