import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  DEFAULT_GEOMETRY_INPUTS, fitShortSide, resolveGeometry
} from '../.test-build/v2/camera/geometry.js';
import { belowCapability } from '../.test-build/v2/camera/policy.js';
import { FILTERS, filterById, ironbowLut } from '../.test-build/v2/filters/registry.js';
import { ironbowColor } from '../.test-build/vision/motion-ironbow.js';

/*
 * V2 Milestone B: the geometry authority and the filter registry, tested as
 * the pure data they are. The GPU half of B — that these shaders actually
 * draw, and that a photo comes out at exactly the PHOTO geometry — runs in a
 * real browser in v2-geometry.test.mjs.
 */

const size = (width, height) => ({ width, height, aspect: width / height });

/* --- fitShortSide: the one shared resize arithmetic (Rule 6) -------------- */

test('fitShortSide preserves aspect, lands on even pixels, never upscales', () => {
  // Landscape 4:3 downsampled to the analysis tier.
  assert.deepEqual(fitShortSide(size(1920, 1440), 384), size(512, 384));

  // The legacy baseline's own numbers: a 3024×4032 portrait sensor fitted to
  // a 548 short side. Both sides even — the row the encoder would otherwise
  // fight over.
  const fitted = fitShortSide(size(3024, 4032), 548);
  assert.deepEqual(fitted, size(548, 730));
  assert.ok(fitted.width % 2 === 0 && fitted.height % 2 === 0);
  assert.ok(Math.abs(fitted.aspect - 3024 / 4032) < 0.01, 'aspect survives the fit');

  // A target larger than the source must return the source: fitting never
  // invents detail.
  assert.deepEqual(fitShortSide(size(960, 720), 3000), size(960, 720));
});

/* --- resolveGeometry: distinct facts, each with its reason (Rules 2–3) ---- */

test('every resolved size carries a reason', () => {
  const g = resolveGeometry(size(3024, 4032), {
    previewBoxShortSide: 800, analysisShortSide: 384, photoPolicy: 'source'
  });
  for (const key of ['analysis', 'preview', 'photo']) {
    assert.ok(g[key].reason.length > 0, `${key} must say why it is this size`);
    assert.ok(g[key].width > 0 && g[key].height > 0);
  }
  assert.deepEqual(g.source, size(3024, 4032), 'SOURCE passes through untouched');
});

test('analysis downsamples for vision work and says so', () => {
  const g = resolveGeometry(size(3024, 4032), {
    previewBoxShortSide: 800, analysisShortSide: 384, photoPolicy: 'source'
  });
  assert.deepEqual({ width: g.analysis.width, height: g.analysis.height }, { width: 384, height: 512 });
  assert.match(g.analysis.reason, /downsampled/);

  // A stream already below the analysis tier is used whole, honestly.
  const small = resolveGeometry(size(320, 240), {
    previewBoxShortSide: 800, analysisShortSide: 384, photoPolicy: 'source'
  });
  assert.deepEqual({ width: small.analysis.width, height: small.analysis.height }, { width: 320, height: 240 });
  assert.match(small.analysis.reason, /already smaller/);
});

test('preview fits the viewfinder; an unmeasured viewfinder is admitted, not guessed', () => {
  const g = resolveGeometry(size(3024, 4032), {
    previewBoxShortSide: 800, analysisShortSide: 384, photoPolicy: 'source'
  });
  assert.deepEqual({ width: g.preview.width, height: g.preview.height }, { width: 800, height: 1066 });
  assert.match(g.preview.reason, /viewfinder/);

  // Before layout has been measured there is no cap — and the reason says
  // "not measured yet" rather than pretending a decision was made.
  const unmeasured = resolveGeometry(size(960, 720), DEFAULT_GEOMETRY_INPUTS);
  assert.deepEqual({ width: unmeasured.preview.width, height: unmeasured.preview.height }, { width: 960, height: 720 });
  assert.match(unmeasured.preview.reason, /not measured yet/);

  // A viewfinder larger than the stream shows the stream as it is.
  const bigBox = resolveGeometry(size(960, 720), {
    previewBoxShortSide: 2000, analysisShortSide: 384, photoPolicy: 'source'
  });
  assert.deepEqual({ width: bigBox.preview.width, height: bigBox.preview.height }, { width: 960, height: 720 });
  assert.match(bigBox.preview.reason, /smaller than the viewfinder/);
});

test('the preview cap can NEVER touch the photo', () => {
  // The class of bug V2 exists to kill: on main, the display budget capped the
  // recording at 548×732 while the sensor delivered 3024×4032. Here the photo
  // must be byte-identical whatever the viewfinder measures.
  const source = size(3024, 4032);
  const wide = resolveGeometry(source, { previewBoxShortSide: 2000, analysisShortSide: 384, photoPolicy: 'source' });
  const tiny = resolveGeometry(source, { previewBoxShortSide: 200, analysisShortSide: 384, photoPolicy: 'source' });
  assert.deepEqual(wide.photo, tiny.photo, 'photo geometry must ignore the display entirely');
  assert.deepEqual({ width: wide.photo.width, height: wide.photo.height }, { width: 3024, height: 4032 });
  assert.match(wide.photo.reason, /negotiated stream/);
});

test('a numeric photo policy caps the short side and names itself', () => {
  const capped = resolveGeometry(size(3024, 4032), {
    previewBoxShortSide: 800, analysisShortSide: 384, photoPolicy: 1080
  });
  assert.deepEqual({ width: capped.photo.width, height: capped.photo.height }, { width: 1080, height: 1440 });
  assert.match(capped.photo.reason, /1080/);

  // A policy at or above the stream is no cap at all.
  const uncapped = resolveGeometry(size(960, 720), {
    previewBoxShortSide: 800, analysisShortSide: 384, photoPolicy: 1080
  });
  assert.deepEqual({ width: uncapped.photo.width, height: uncapped.photo.height }, { width: 960, height: 720 });
  assert.match(uncapped.photo.reason, /negotiated stream/);
});

/* --- Source policy: advertised vs negotiated ------------------------------ */

test('belowCapability separates "cannot do more" from "did not ask"', () => {
  // The device case that raised this: a 720×960 default stream on a camera
  // advertising the full sensor.
  assert.equal(belowCapability(size(720, 960), size(4032, 3024)), true);

  // Orientation-free: the capability reports landscape maxima while a
  // portrait stream transposes them. Same pixels, no gap.
  assert.equal(belowCapability(size(3024, 4032), size(4032, 3024)), false);
  assert.equal(belowCapability(size(4032, 3024), size(4032, 3024)), false);

  // Mode quantisation inside the 2% slack is rounding, not refusal…
  assert.equal(belowCapability(size(3018, 4026), size(4032, 3024)), false);
  // …and just past it is a real gap again.
  assert.equal(belowCapability(size(2880, 2160), size(4032, 3024)), true);

  // Missing facts mean "no evidence", never "escalate on faith".
  assert.equal(belowCapability(null, size(4032, 3024)), false);
  assert.equal(belowCapability(size(720, 960), null), false);
  assert.equal(belowCapability(null, null), false);
});

/* --- The filter registry (Rules 4–5) -------------------------------------- */

test('FILTERS is the one list: unique ids, honest metadata, real shaders', () => {
  assert.ok(FILTERS.length >= 3, 'Milestone B ships rgb, ironbow and edges');
  assert.equal(new Set(FILTERS.map((f) => f.id)).size, FILTERS.length, 'filter ids must be unique');
  const families = new Set(['view', 'motion', 'time', 'night', 'custom']);
  for (const filter of FILTERS) {
    assert.ok(filter.name.length > 0, `${filter.id} needs a display name`);
    assert.ok(families.has(filter.family), `${filter.id} has family ${filter.family}`);
    assert.equal(typeof filter.temporal, 'boolean');
    assert.equal(typeof filter.supportsPhoto, 'boolean');
    assert.equal(typeof filter.supportsVideo, 'boolean');
    assert.match(filter.fragment, /void main\(\)/, `${filter.id} must carry a fragment shader`);
    assert.match(filter.fragment, /uFrame/, `${filter.id} must sample the camera frame`);
    assert.equal(filter.temporal, false, 'nothing in B needs frame history yet');
  }
  assert.deepEqual(FILTERS.map((f) => f.id), ['rgb', 'ironbow', 'edges']);
  assert.equal(filterById('rgb')?.name, 'RGB');
  assert.equal(filterById('nope'), null);
});

test('one filter implementation: fragment shaders exist only in the registry', () => {
  // Rule 4 made structural. If a second gl_FragColor appears anywhere else in
  // src/v2, someone has begun a parallel filter path.
  const v2Root = fileURLToPath(new URL('../src/v2', import.meta.url));
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(v2Root);
  const offenders = files.filter((path) =>
    !path.endsWith('filters/registry.ts') && /gl_FragColor/.test(readFileSync(path, 'utf8')));
  assert.deepEqual(offenders, [], 'fragment shaders belong to the registry alone');
});

test('the Ironbow LUT is the legacy ramp, not a re-derivation', () => {
  const lut = ironbowLut();
  assert.equal(lut.length, 256 * 4, 'one row of 256 RGBA texels');
  for (const i of [0, 1, 64, 128, 192, 254, 255]) {
    const [r, g, b] = ironbowColor(i / 255);
    assert.equal(lut[i * 4], r, `texel ${i} red must come from ironbowColor`);
    assert.equal(lut[i * 4 + 1], g, `texel ${i} green`);
    assert.equal(lut[i * 4 + 2], b, `texel ${i} blue`);
    assert.equal(lut[i * 4 + 3], 255, `texel ${i} is opaque`);
  }
});
