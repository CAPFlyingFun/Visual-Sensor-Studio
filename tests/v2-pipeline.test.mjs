import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  DEFAULT_GEOMETRY_INPUTS, fitShortSide, resolveGeometry
} from '../.test-build/v2/camera/geometry.js';
import { captureAtMaxStream } from '../.test-build/v2/capture/shutter.js';
import { pickContainer } from '../.test-build/v2/capture/record.js';
import {
  STREAM_TIERS, DEFAULT_STREAM_TIER, tierAvailable, tierById
} from '../.test-build/v2/camera/stream-tiers.js';
import { readState } from '../.test-build/v2/state.js';
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

const INPUTS = {
  previewBoxShortSide: 800, analysisShortSide: 384,
  photoPolicy: 'source', recordPolicy: 'source'
};

test('every resolved size carries a reason', () => {
  const g = resolveGeometry(size(3024, 4032), INPUTS);
  for (const key of ['analysis', 'preview', 'photo', 'recordInput']) {
    assert.ok(g[key].reason.length > 0, `${key} must say why it is this size`);
    assert.ok(g[key].width > 0 && g[key].height > 0);
  }
  assert.deepEqual(g.source, size(3024, 4032), 'SOURCE passes through untouched');
});

test('RECORD IN follows the responsive stream and ignores the display', () => {
  // The responsive live policy already bounds per-frame cost, so recording
  // does not invent a second ceiling — and the viewfinder can never shrink
  // what the encoder receives.
  const source = size(720, 960);
  const wide = resolveGeometry(source, { ...INPUTS, previewBoxShortSide: 2000 });
  const tiny = resolveGeometry(source, { ...INPUTS, previewBoxShortSide: 200 });
  assert.deepEqual(wide.recordInput, tiny.recordInput,
    'record geometry must ignore the display entirely');
  assert.deepEqual({ width: wide.recordInput.width, height: wide.recordInput.height },
    { width: 720, height: 960 });
  assert.match(wide.recordInput.reason, /responsive stream/);

  // A numeric policy caps the short side and names itself, for the day a
  // device measurement demands one.
  const capped = resolveGeometry(size(3024, 4032), { ...INPUTS, recordPolicy: 548 });
  assert.deepEqual({ width: capped.recordInput.width, height: capped.recordInput.height },
    { width: 548, height: 730 });
  assert.match(capped.recordInput.reason, /548/);
});

test('stream tiers are one registry: deliberate, labelled, defaulting responsive', () => {
  assert.ok(STREAM_TIERS.length >= 3, '720, 1080 and MAX at least');
  assert.equal(new Set(STREAM_TIERS.map((t) => t.id)).size, STREAM_TIERS.length, 'unique ids');
  for (const tier of STREAM_TIERS) {
    assert.ok(tier.label.length > 0 && tier.streamLabel.length > 0,
      `${tier.id} needs a button label and a SOURCE-row description`);
    assert.ok(tier.shortSide === 'max' || tier.shortSide > 0);
  }
  assert.equal(STREAM_TIERS.filter((t) => t.shortSide === 'max').length, 1,
    'exactly one tier asks for the largest mode');

  // Joshua's ladder: familiar video classes, and a tier RECORDS WHAT IT
  // STREAMS — "if MAX is recorded in 1080, that's not MAX". His classes
  // double: 2K = 2160 short (twice 1080), 4K = 4320 long edge ("technically
  // 4K is actually 4320") = 3240 short at 4:3. A class the camera cannot
  // fill greys out (tierAvailable below) rather than clamping in disguise.
  assert.deepEqual(STREAM_TIERS.map((t) => t.id), ['720', '1080', '2k', '4k', 'maximum']);
  assert.deepEqual(STREAM_TIERS.map((t) => t.shortSide), [720, 1080, 2160, 3240, 'max']);
  for (const tier of STREAM_TIERS) {
    assert.equal(tier.recordPolicy, 'source', `${tier.id} records the stream it chose`);
  }
  assert.match(tierById('maximum')?.clipWarning ?? '', /crash/i,
    'the measured 12 MP risk is stated on MAX, not hidden');
  assert.match(tierById('maximum')?.clipWarning ?? '', /Photos always stay at MAX/,
    'stills are exempt from the risk and say so');
  assert.match(tierById('4k')?.clipWarning ?? '', /crash/i,
    'a running 4K stream is ~14 MP or more — the same stated filtered-clip risk as MAX');
  assert.ok(!tierById('720')?.clipWarning && !tierById('1080')?.clipWarning
    && !tierById('2k')?.clipWarning,
    'no scare copy on the proven tiers');
  const fallback = tierById(DEFAULT_STREAM_TIER);
  assert.ok(fallback && fallback.shortSide === 720,
    'the default tier is the responsive one — the maximum never arrives by accident');
  assert.match(fallback.streamLabel, /responsive/);
  assert.equal(readState().streamTier, DEFAULT_STREAM_TIER,
    'the state boots on the registry default — one owner for the default');
  assert.equal(tierById('nope'), null);
});

test('a tier is offered only when the camera can fill its class', () => {
  // Joshua, 2026-09-01: "if it can't do 4320×5760 for 4K, [it] should be
  // grayed out saying device's output is not big enough" — his iPhone
  // (3024×4032) keeps 4 of the 5 tiers.
  const iphone = 3024;
  assert.deepEqual(
    STREAM_TIERS.filter((t) => tierAvailable(t, iphone)).map((t) => t.id),
    ['720', '1080', '2k', 'maximum']);
  // A camera at exactly the class boundary fills it.
  assert.equal(tierAvailable(tierById('2k'), 2160), true);
  assert.equal(tierAvailable(tierById('2k'), 2159), false);
  // The rule is generic, not a 4K special case.
  assert.deepEqual(
    STREAM_TIERS.filter((t) => tierAvailable(t, 480)).map((t) => t.id),
    ['maximum'], 'a tiny camera honestly offers only its own largest');
  // MAX never greys: it promises the camera's own largest, not a number.
  assert.equal(tierAvailable(tierById('maximum'), 1), true);
  // Unknown capability greys NOTHING — that would state an unmeasured fact.
  for (const tier of STREAM_TIERS) {
    assert.equal(tierAvailable(tier, null), true, `${tier.id} stays offered when capability is unknown`);
    assert.equal(tierAvailable(tier, 0), true);
  }
});

test('the record policy records the chosen stream; no silent default cap', () => {
  // A tier records what it streams (Joshua, 2026-09-01) — the measured 12 MP
  // crash risk lives as the MAX tier's stated warning, never a hidden cap.
  // Photos keep the full sensor regardless.
  assert.equal(DEFAULT_GEOMETRY_INPUTS.recordPolicy, 'source');
  const g = resolveGeometry(size(3024, 4032), { ...DEFAULT_GEOMETRY_INPUTS, previewBoxShortSide: 0 });
  assert.deepEqual({ width: g.recordInput.width, height: g.recordInput.height },
    { width: 3024, height: 4032 }, 'the chosen stream is what records');
  assert.deepEqual({ width: g.photo.width, height: g.photo.height },
    { width: 3024, height: 4032 }, 'the photo keeps the full sensor');

  const small = resolveGeometry(size(720, 960), DEFAULT_GEOMETRY_INPUTS);
  assert.deepEqual({ width: small.recordInput.width, height: small.recordInput.height },
    { width: 720, height: 960 });
  assert.match(small.recordInput.reason, /responsive stream/);
});

test('the container ladder prefers mp4, falls back honestly, never pins a level', () => {
  assert.equal(pickContainer(() => true), 'video/mp4');
  assert.equal(pickContainer((mime) => mime === 'video/webm'), 'video/webm');
  assert.equal(pickContainer(() => false), '',
    'no admitted container means the browser default, measured afterwards');
  assert.equal(pickContainer(() => { throw new Error('no recorder'); }), '');
  // The whole point: no candidate carries a codecs= parameter, so no
  // hard-coded H.264 profile/level can ever cap the encoder again.
  const seen = [];
  pickContainer((mime) => { seen.push(mime); return false; });
  assert.ok(seen.length > 0 && seen.every((mime) => !mime.includes('codecs')),
    `plain containers only, saw: ${seen.join(', ')}`);
});

test('analysis downsamples for vision work and says so', () => {
  const g = resolveGeometry(size(3024, 4032), INPUTS);
  assert.deepEqual({ width: g.analysis.width, height: g.analysis.height }, { width: 384, height: 512 });
  assert.match(g.analysis.reason, /downsampled/);

  // A stream already below the analysis tier is used whole, honestly.
  const small = resolveGeometry(size(320, 240), INPUTS);
  assert.deepEqual({ width: small.analysis.width, height: small.analysis.height }, { width: 320, height: 240 });
  assert.match(small.analysis.reason, /already smaller/);
});

test('preview fits the viewfinder; an unmeasured viewfinder is admitted, not guessed', () => {
  const g = resolveGeometry(size(3024, 4032), INPUTS);
  assert.deepEqual({ width: g.preview.width, height: g.preview.height }, { width: 800, height: 1066 });
  assert.match(g.preview.reason, /viewfinder/);

  // Before layout has been measured there is no cap — and the reason says
  // "not measured yet" rather than pretending a decision was made.
  const unmeasured = resolveGeometry(size(960, 720), DEFAULT_GEOMETRY_INPUTS);
  assert.deepEqual({ width: unmeasured.preview.width, height: unmeasured.preview.height }, { width: 960, height: 720 });
  assert.match(unmeasured.preview.reason, /not measured yet/);

  // A viewfinder larger than the stream shows the stream as it is.
  const bigBox = resolveGeometry(size(960, 720), { ...INPUTS, previewBoxShortSide: 2000 });
  assert.deepEqual({ width: bigBox.preview.width, height: bigBox.preview.height }, { width: 960, height: 720 });
  assert.match(bigBox.preview.reason, /smaller than the viewfinder/);
});

test('the preview cap can NEVER touch the photo', () => {
  // The class of bug V2 exists to kill: on main, the display budget capped the
  // recording at 548×732 while the sensor delivered 3024×4032. Here the photo
  // must be byte-identical whatever the viewfinder measures.
  const source = size(3024, 4032);
  const wide = resolveGeometry(source, { ...INPUTS, previewBoxShortSide: 2000 });
  const tiny = resolveGeometry(source, { ...INPUTS, previewBoxShortSide: 200 });
  assert.deepEqual(wide.photo, tiny.photo, 'photo geometry must ignore the display entirely');
  assert.deepEqual({ width: wide.photo.width, height: wide.photo.height }, { width: 3024, height: 4032 });
  assert.match(wide.photo.reason, /negotiated stream/);
});

test('a numeric photo policy caps the short side and names itself', () => {
  const capped = resolveGeometry(size(3024, 4032), { ...INPUTS, photoPolicy: 1080 });
  assert.deepEqual({ width: capped.photo.width, height: capped.photo.height }, { width: 1080, height: 1440 });
  assert.match(capped.photo.reason, /1080/);

  // A policy at or above the stream is no cap at all.
  const uncapped = resolveGeometry(size(960, 720), { ...INPUTS, photoPolicy: 1080 });
  assert.deepEqual({ width: uncapped.photo.width, height: uncapped.photo.height }, { width: 960, height: 720 });
  assert.match(uncapped.photo.reason, /negotiated stream/);
});

/* --- The shutter: LIVE SOURCE != PHOTO OUTPUT ----------------------------- */

/**
 * A scripted stream: `frames` is what successive decoded frames report (and
 * what measure() then returns — a decoded frame IS the stream's state); an
 * empty queue behaves like a stalled stream (nextFrame times out).
 */
function scriptedStream({
  start, frames = [], lumas = [], applyMax = true, applyRestore = true, throwOnMax = false
}) {
  let current = start;
  const queue = [...frames];
  let lumaIndex = 0;
  const calls = { requestMax: 0, restore: [], framesServed: 0, lumaSamples: 0 };
  const stream = {
    measure: () => current,
    // A steady 0.3 when no script is given — an already-converged exposure.
    // A script CYCLES, so an oscillating pair keeps oscillating forever.
    sampleLuma: () => {
      calls.lumaSamples += 1;
      return lumas.length ? lumas[(lumaIndex++) % lumas.length] : 0.3;
    },
    requestMax: async () => {
      calls.requestMax += 1;
      if (throwOnMax) throw new Error('engine gone');
      return { applied: applyMax };
    },
    restore: async (shortSide) => {
      calls.restore.push(shortSide);
      return { applied: applyRestore };
    },
    nextFrame: async () => {
      const next = queue.shift();
      if (!next) return null;
      calls.framesServed += 1;
      current = next;
      return next;
    }
  };
  return { stream, calls };
}

const FAST = {
  confirmTimeoutMs: 300, settleFrames: 2, settleMs: 0,
  exposureStableFrames: 2, exposureTimeoutMs: 200, exposureDeltaMax: 0.02
};

const BIG = { width: 3024, height: 4032 };
const SMALL = { width: 720, height: 960 };

test('shutter: max granted, rendered at MEASURED size, walked back and confirmed', async () => {
  const { stream, calls } = scriptedStream({
    start: SMALL,
    // One frame confirms the grant, two settle the (steady) exposure, one
    // confirms the restore.
    frames: [BIG, BIG, BIG, SMALL]
  });
  const rendered = [];
  const outcome = await captureAtMaxStream(stream, async (dims, escalation) => {
    rendered.push({ dims, escalation });
    return { saved: true };
  }, FAST);

  assert.equal(outcome.escalation, 'granted');
  assert.equal(outcome.restoration, 'restored');
  assert.deepEqual(outcome.captureSource, BIG);
  assert.equal(rendered.length, 1, 'the shader runs exactly once per shutter');
  assert.deepEqual(rendered[0].dims, BIG,
    'the render uses what the camera GRANTED, never what was requested');
  assert.deepEqual(calls.restore, [720], 'restore aims at the remembered short side');
  assert.ok(outcome.timing.totalMs >= 0 && outcome.timing.maxFrameReadyMs >= 0);
  assert.ok(outcome.timing.exposureSettledMs !== null,
    'a steady exposure is confirmed, not assumed');
  assert.ok(outcome.timing.liveRestoredMs !== null, 'a confirmed restore carries its time');
});

test('shutter: capture waits for the exposure to CONVERGE after the mode switch', async () => {
  // The dark-photo device finding: a granted mode change resets AE, and the
  // first 12 MP frame saved a bright room at mean luma 16/255. The shutter
  // must watch the measured luminance climb and only render once it stops
  // moving — never grab frame one, never fix it in the shader afterwards.
  const { stream, calls } = scriptedStream({
    start: SMALL,
    frames: [BIG, BIG, BIG, BIG, BIG, BIG, BIG, SMALL],
    lumas: [0.14, 0.19, 0.25, 0.28, 0.29, 0.295, 0.297]
  });
  let framesWhenRendered = 0;
  const outcome = await captureAtMaxStream(stream, async () => {
    framesWhenRendered = calls.framesServed;
    return { saved: true };
  }, FAST);

  assert.equal(outcome.escalation, 'granted');
  assert.ok(outcome.timing.exposureSettledMs !== null, 'convergence was detected');
  assert.ok(framesWhenRendered >= 5,
    `the render waited through the AE ramp, not frame one (rendered after ${framesWhenRendered} frames)`);
  assert.ok(calls.lumaSamples >= 5, 'stability was measured, not assumed');
});

test('shutter: a hunting exposure times out honestly and still captures', async () => {
  const { stream } = scriptedStream({
    start: SMALL,
    frames: Array.from({ length: 200 }, () => BIG),
    lumas: [0.1, 0.4]
  });
  const outcome = await captureAtMaxStream(stream, async () => ({ saved: true }), FAST);
  assert.equal(outcome.escalation, 'granted');
  assert.equal(outcome.timing.exposureSettledMs, null,
    'an exposure that never stabilised is reported as unconfirmed, not papered over');
  assert.ok(outcome.still, 'the shot is still taken with whatever exposure exists');
});

test('shutter: a stream already at maximum settles quickly as "unchanged"', async () => {
  // Joshua's nuance: what matters is a confirmed frame AFTER the request,
  // then using whatever dimensions arrived — no dimension change exists to
  // wait for here, and that must not cost the whole timeout.
  const max = { width: 3024, height: 4032 };
  const { stream, calls } = scriptedStream({ start: max, frames: [max, max, max, max, max] });
  const outcome = await captureAtMaxStream(stream, async (dims) => ({ dims }), FAST);

  assert.equal(outcome.escalation, 'unchanged');
  assert.deepEqual(outcome.captureSource, max, 'saved from the stream as it really is');
  assert.ok(calls.framesServed <= 3, `settled after a couple of frames, served ${calls.framesServed}`);
  assert.equal(calls.lumaSamples, 0,
    'an unchanged mode kept its converged exposure — no wait, no sampling');
  assert.deepEqual(calls.restore, [3024],
    'the walk-back still runs — asking stored the max request in the engine');
  assert.equal(outcome.restoration, 'not needed');
});

test('shutter: a declined request saves the honest current frame', async () => {
  const { stream, calls } = scriptedStream({ start: { width: 720, height: 960 }, applyMax: false });
  const rendered = [];
  const outcome = await captureAtMaxStream(stream, async (dims, escalation) => {
    rendered.push(escalation);
    return { ok: true };
  }, FAST);

  assert.equal(outcome.escalation, 'declined');
  assert.deepEqual(outcome.captureSource, { width: 720, height: 960 });
  assert.deepEqual(rendered, ['declined'], 'the outcome is reported, not faked');
  assert.equal(calls.restore.length, 1, 'the stored stream request is still reset');
  assert.equal(outcome.restoration, 'not needed');
});

test('shutter: a refused restore is reported, never retried in a loop', async () => {
  const { stream, calls } = scriptedStream({
    start: SMALL,
    frames: [BIG, BIG, BIG],
    applyRestore: false
  });
  const outcome = await captureAtMaxStream(stream, async () => ({ ok: true }), FAST);

  assert.equal(outcome.escalation, 'granted');
  assert.equal(outcome.restoration, 'refused');
  assert.equal(calls.restore.length, 1, 'exactly one restore attempt — no restart loop');
  assert.ok(outcome.still, 'the photo still comes out');
  assert.equal(outcome.timing.liveRestoredMs, null);
});

test('shutter: an unconfirmed restore says so', async () => {
  const { stream } = scriptedStream({
    start: SMALL,
    // Grant, two settle frames, then frames keep reporting the capture mode
    // until the restore confirmation concludes nothing changed.
    frames: [BIG, BIG, BIG, BIG]
  });
  const outcome = await captureAtMaxStream(stream, async () => ({ ok: true }), FAST);
  assert.equal(outcome.escalation, 'granted');
  assert.equal(outcome.restoration, 'unconfirmed');
});

test('shutter: a failed render never skips the walk-back', async () => {
  const { stream, calls } = scriptedStream({
    start: SMALL,
    frames: [BIG, BIG, BIG, SMALL]
  });
  const outcome = await captureAtMaxStream(stream, async () => {
    throw new Error('encoder exploded');
  }, FAST);

  assert.equal(outcome.still, null);
  assert.equal(calls.restore.length, 1, 'the live stream is walked back regardless');
  assert.equal(outcome.restoration, 'restored');
});

test('shutter: a throwing engine bridge is a declined request, not a crash', async () => {
  const { stream, calls } = scriptedStream({ start: { width: 720, height: 960 }, throwOnMax: true });
  const outcome = await captureAtMaxStream(stream, async () => ({ ok: true }), FAST);
  assert.equal(outcome.escalation, 'declined');
  assert.ok(outcome.still, 'the shot is still saved from the live stream');
  assert.equal(calls.restore.length, 1);
});

/* --- Terminology stays consistent with docs/camera_rule.md ---------------- */

test('the camera rule document and the code speak the same language', () => {
  const rule = readFileSync(new URL('../docs/camera_rule.md', import.meta.url), 'utf8');
  for (const term of [
    'Camera Capability', 'Camera Stream / Source', 'Viewfinder', 'Preview Render',
    'Analysis', 'Photo Output', 'Recording Render', 'Encoded Output'
  ]) {
    assert.ok(rule.includes(term), `camera_rule.md must define "${term}"`);
  }
  assert.match(rule, /MAXIMUM SAVED OUTPUT DOES NOT MEAN MAXIMUM LIVE CAMERA STREAM/);
  assert.match(rule, /No downstream output may silently inherit/i);

  const html = readFileSync(new URL('../public/v2.html', import.meta.url), 'utf8');
  for (const label of ['SOURCE', 'CAPABILITY', 'VIEWFINDER', 'PREVIEW', 'ANALYSIS', 'PHOTO POLICY', 'LAST PHOTO']) {
    assert.ok(html.includes(`>${label}<`), `the truth table needs a ${label} row`);
  }

  const appTs = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');
  assert.match(appTs, /streamLabel/, 'the SOURCE row reads its description from the tier registry');
  assert.match(tierById(DEFAULT_STREAM_TIER)?.streamLabel ?? '', /responsive live stream/,
    'the default policy names itself');
  // The maximum is reachable ONLY through a deliberate tier choice or the
  // shutter — never on ordinary startup.
  assert.ok(!/^\s*camera\.preferMaxCaptureSize/m.test(appTs.split('async function startCamera')[1]?.split('}')[0] ?? ''),
    'startCamera never asks for the maximum');
});

/* --- The filter registry (Rules 4–5) -------------------------------------- */

test('FILTERS is the one list: unique ids, honest metadata, real shaders', () => {
  assert.ok(FILTERS.length >= 4, 'rgb, ironbow, difference and edges at least');
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
    // The metadata and the shader must agree about history: a temporal
    // filter's BODY samples uPrevious; a non-temporal one never does.
    const body = filter.fragment.split('void main')[1] ?? '';
    assert.equal(body.includes('uPrevious'), filter.temporal,
      `${filter.id}: temporal metadata and shader body must agree`);
  }
  assert.deepEqual(FILTERS.map((f) => f.id), ['rgb', 'ironbow', 'difference', 'edges']);
  assert.equal(filterById('rgb')?.name, 'RGB');
  assert.equal(filterById('nope'), null);

  // Motion's honesty contract: history at analysis resolution means video is
  // its product and stills are declined, in the metadata itself (Rule 10).
  const motion = filterById('difference');
  assert.ok(motion && motion.temporal && !motion.supportsPhoto && motion.supportsVideo,
    'Motion declines stills rather than upscaling analysis-resolution history');
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
