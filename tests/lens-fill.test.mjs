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
  assert.ok(code.includes('vec2 regionFill(vec4 k)'), 'the fill is emitted');

  // THE LOAD-BEARING LINE. The body is distance from the frame's prevailing
  // level, which the middle of a slab answers as loudly as its rim. Two
  // earlier versions were rejected by measurement: the broad ring's VARIANCE
  // (true only in a band around each outline — a soft dilation, and it left a
  // door at exactly 0.00) and the broad ring's MEAN (a band-pass, so the bare
  // wall beside a lamp reached 0.90 while the door stayed at 0.00).
  const body = code.slice(code.indexOf('float body ='));
  assert.match(body.slice(0, 120), /abs\(k\.y - uBackground\)/);

  // It must never read the edge map — that is the difference it exists for.
  const fillBody = code.slice(code.indexOf('vec2 regionFill'), code.indexOf('float normColour'));
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
  assert.match(code, /return vec2\(clamp\(body \* coherent[^;]*, \(k\.x \+ k\.y\) \* 0\.5\);/,
    'and the second component is the mean of the samples already taken');

  // The radii are frame-relative, so a 3024-wide still is the same picture as
  // the preview it was framed in rather than a quarter of the reach.
  assert.match(code, /frameStep\(RING_REFERENCE\)/);
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

test('a colour per shape is held along the outline, never given to the dark', () => {
  const lens = sanitiseLens({ ...BLUE_OUTLINE, shapeHue: 1 });
  assert.equal(lens.shapeHue, 1);
  // Zero is "one palette", which is what every lens before this meant — so it
  // stores as absent and the two documents stay the same document.
  assert.equal(sanitiseLens({ ...BLUE_OUTLINE, shapeHue: 0 }).shapeHue, undefined);

  const code = compileLens(lens).fragment;
  assert.ok(code.includes('vec3 shapeTint('), 'the tint is emitted');
  // NOTHING THE LENS LEFT DARK IS GIVEN A COLOUR. Without this the black
  // background picks up a hue and the whole picture turns to soup.
  assert.match(code, /if \(hsv\.z <= 0\.001\) return c;/);
  // The hue is SET rather than rotated, and saturation is lifted with it: the
  // top of this ramp is #eafaff, which has almost no hue to rotate, so the
  // brightest edges — the ones most worth telling apart — would have stayed
  // white.
  assert.match(code, /mix\(hsv\.x, drawn, SHAPE_HUE\)/);
  assert.match(code, /max\(hsv\.y, 0\.62 \* SHAPE_HUE\)/);
  // Keyed on the NEIGHBOURHOOD, not the pixel: that is what holds one colour
  // along a whole contour instead of shimmering along it.
  assert.match(code, /shapeTint\(c, \(k\.x \+ k\.y\) \* 0\.5, scene\)/);

  // Sixteen taps, taken once, whether or not a fill is also asking.
  const both = compileLens(sanitiseLens({ ...BLUE_OUTLINE, shapeHue: 1, fill: FILL })).fragment;
  assert.equal((both.match(/vec2 ringStats\(/g) ?? []).length, 1, 'one definition of the ring');
  assert.equal((both.match(/vec4 k = ringKey\(vUv\);/g) ?? []).length, 1, 'read once');

  // Paint mode only, like the fill and for the same reason.
  for (const output of ['mask', 'swap']) {
    const other = compileLens(sanitiseLens({ ...BLUE_OUTLINE, output, shapeHue: 1 })).fragment;
    assert.ok(!other.includes('shapeTint'), `${output} is left alone`);
  }
  // And it is in the revision, or a live edit would not redraw.
  assert.notEqual(compileLens(sanitiseLens(BLUE_OUTLINE)).revision, compileLens(lens).revision);
});

test('Prism ships as the shape-colour starter', () => {
  const prism = STARTER_LENSES.find((lens) => lens.id === 'lens-v2-prism');
  assert.ok(prism, 'Prism is a starter');
  assert.equal(prism.shapeHue, 1);
  assert.equal(prism.fill, undefined, 'outlines are what was asked about');
  assert.match(prism.note, /Not object recognition/,
    'and the note states the limit rather than hiding it');
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

test('kinds colour by what an edge IS, and push the big things back', () => {
  const lens = sanitiseLens({ ...BLUE_OUTLINE, kinds: { strength: 0.9, depth: 0.5 } });
  assert.deepEqual(lens.kinds, { strength: 0.9, depth: 0.5 });
  // Strength zero is off, and off is the absence of the block.
  assert.equal(sanitiseLens({ ...BLUE_OUTLINE, kinds: { strength: 0, depth: 1 } }).kinds, undefined);

  const code = compileLens(lens).fragment;
  assert.ok(code.includes('vec3 kindTint('), 'the kinds are emitted');

  // ONE SOBEL, split so its DIRECTION is available (Rule 4) — a second copy
  // of the eight taps could drift from the one the edge map uses.
  assert.match(code, /sobelGrad\(uv, frameStep\(KIND_REFERENCE\)\)/);

  // MEASURED COARSELY. At the edge map's own scale the gradient direction
  // wobbles pixel to pixel along one contour and the picture came back as
  // rainbow speckle; a wider step lets a long straight edge hold one
  // direction, and organic gradients disagree at that distance and cancel.
  assert.match(code, /const float KIND_REFERENCE = 220\.0;/);

  // SNAPPED, not blended: a continuous mix of hues is a gradient wearing the
  // word "categories".
  assert.match(code, /mix\(HUE_GROWN, HUE_BUILT, step\(0\.5, built\)\)/);

  // TWO KINDS, and the third was cut rather than faked. A "text" colour that
  // cannot tell a label from a tea towel is decoration, and four measured
  // attempts is when to stop.
  assert.ok(!code.includes('HUE_DETAIL'), 'no third kind is emitted');

  // DEPTH IS SPENT ON VALUE ALONE. Moving a large shape's hue would say it
  // changed kind, which it did not.
  assert.match(code, /hsv\.z \* depth/);
  assert.match(code, /float big = 1\.0 - smoothstep\([^)]*abs\(rings\.x - rings\.y\)\)/);

  // Sixteen taps, taken once, shared by every feature that asks.
  const both = compileLens(sanitiseLens({ ...BLUE_OUTLINE, kinds: lens.kinds, fill: FILL })).fragment;
  assert.equal((both.match(/vec4 ringKey\(/g) ?? []).length, 1);
  assert.match(both, /vec4 k = ringKey\(vUv\);/);
  assert.match(both, /regionFill\(k\)/);
  assert.match(both, /kindTint\(c, vUv, k\)/);

  // Kinds and a random hue answer the same question, so the kinds win and the
  // random one is not even emitted.
  const clash = compileLens(sanitiseLens({ ...BLUE_OUTLINE, shapeHue: 1, kinds: lens.kinds })).fragment;
  assert.ok(clash.includes('kindTint') && !clash.includes('shapeTint'));

  // Paint mode only, and in the revision so a live edit redraws.
  assert.ok(!compileLens(sanitiseLens({ ...BLUE_OUTLINE, output: 'mask', kinds: lens.kinds }))
    .fragment.includes('kindTint'));
  assert.notEqual(compileLens(sanitiseLens(BLUE_OUTLINE)).revision, compileLens(lens).revision);
});

test('Blueprint ships, and says which kind it does NOT offer', () => {
  const blueprint = STARTER_LENSES.find((lens) => lens.id === 'lens-v2-blueprint');
  assert.ok(blueprint, 'Blueprint is a starter');
  assert.ok(blueprint.kinds.strength > 0 && blueprint.kinds.depth > 0);
  assert.match(blueprint.note, /text and closed contours need to be traced, not measured/,
    'the missing kind is named rather than quietly absent');
});
