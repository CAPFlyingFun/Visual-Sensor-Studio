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
import {
  ENCODER_PROBE_LADDER, H264_LEVEL_5_2_MACROBLOCKS, describeRow, macroblocks
} from '../.test-build/v2/capture/encoder-probe.js';
import {
  ASSUMED_ENVELOPE, envelopeFromMeasurement, largestEncodable, measurementFromRows
} from '../.test-build/v2/capture/encoder-envelope.js';
import { countMp4Frames } from '../.test-build/v2/capture/mp4-frames.js';
import {
  V2_CHANNELS, channelAvailability, compileLens, lensFilterId, lensRampRgba, lensRevision,
  reverseStops, rgbToHsv
} from '../.test-build/v2/filters/lens-shader.js';
import {
  averageRgb, coverScale, patchBoxPercent, patchRect, tapToSource
} from '../.test-build/v2/capture/color-sampler.js';
import { GUIDES, DEFAULT_GUIDE, guideById } from '../.test-build/v2/render/guides.js';
import {
  HISTOGRAM_BINS, buildHistogram, emptyHistogram
} from '../.test-build/v2/vision/frame-histogram.js';
import { allFilters, setCustomFilters } from '../.test-build/v2/filters/registry.js';
import { STARTER_LENSES } from '../.test-build/v2/filters/starter-lenses.js';
import { CHANNELS, buildRampLut, channelInfo, describeLens } from '../.test-build/vision/lens.js';
import { sanitiseLens } from '../.test-build/vision/lens-store.js';

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
  photoPolicy: 'source', recordPolicy: 'source', encoderMacroblocks: null
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
  assert.match(tierById('maximum')?.clipWarning ?? '', /encoder/i,
    'the measured encoder ceiling is stated on MAX, not hidden');
  assert.match(tierById('maximum')?.clipWarning ?? '', /Photos always stay at MAX/,
    'stills are exempt from the ceiling and say so');
  assert.match(tierById('4k')?.clipWarning ?? '', /encoder/i,
    'a running 4K stream is ~14 MP — above any Level 5.2 encoder, so it says so');
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
    // filter's BODY (display or state pass) samples uPrevious; a
    // non-temporal one never does. A state pass must feed the display.
    if (filter.state) {
      const stateBody = filter.state.slice(filter.state.indexOf('void main'));
      assert.ok(stateBody.includes('uState'), `${filter.id}: a state pass reads its own previous output`);
      assert.ok(filter.fragment.slice(filter.fragment.indexOf('void main')).includes('uState'),
        `${filter.id}: the display pass must sample the state it computes`);
      assert.equal(filter.supportsPhoto, false,
        `${filter.id}: state at ANALYSIS resolution cannot honestly fill a still`);
    }
    const body = filter.fragment.split('void main')[1] ?? '';
    const stateSamplesHistory = filter.state
      ? filter.state.slice(filter.state.indexOf('void main')).includes('uPrevious') : false;
    assert.equal(body.includes('uPrevious') || stateSamplesHistory, filter.temporal,
      `${filter.id}: temporal metadata and shader body must agree`);
  }
  assert.deepEqual(FILTERS.map((f) => f.id), ['rgb', 'ironbow', 'difference', 'speed', 'trails', 'edges']);
  // Milestone D's second stage: Speed and Trails carry their memory in a
  // state pass, at ANALYSIS resolution, and decline stills like Motion.
  for (const id of ['speed', 'trails']) {
    const filter = filterById(id);
    assert.ok(filter?.state && filter.temporal && !filter.supportsPhoto && filter.supportsVideo,
      `${id} is a stateful, temporal, video-only filter`);
  }
  assert.equal(filterById('difference')?.state, undefined, 'Motion needs no state — it compares two frames');
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
    !/filters\/(registry|lens-shader)\.ts$/.test(path) && /gl_FragColor/.test(readFileSync(path, 'utf8')));
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

test('the encoder probe ladder brackets the H.264 Level 5.2 frame limit exactly', () => {
  // The two hypotheses for dead MAX clips — frame size vs throughput — are
  // separable only if the ladder steps across the level line at one place
  // and then holds the size fixed while the fed rate changes.
  assert.equal(H264_LEVEL_5_2_MACROBLOCKS, 36864, 'MaxFS for Level 5.2, ITU-T H.264 Table A-1');
  assert.equal(macroblocks(2160, 2880), 24300, 'the proven 2K tier');
  assert.equal(macroblocks(2592, 3456), 34992, 'just below the line');
  assert.equal(macroblocks(2688, 3584), 37632, 'just above the line');
  assert.equal(macroblocks(3024, 4032), 47628, 'the sensor maximum');
  for (const trial of ENCODER_PROBE_LADDER) {
    assert.equal(trial.width % 16, 0, `${trial.width} must be macroblock-aligned`);
    assert.equal(trial.height % 16, 0, `${trial.height} must be macroblock-aligned`);
    assert.ok(Math.abs(trial.width / trial.height - 3 / 4) < 1e-9, 'every trial is 4:3 like the sensor');
  }
  // The size ladder at one fixed rate, crossing the line exactly once.
  const sizeLadder = ENCODER_PROBE_LADDER.slice(0, 4);
  assert.ok(sizeLadder.every((t) => t.fps === sizeLadder[0].fps), 'size trials share one fed rate');
  const above = sizeLadder.map((t) => macroblocks(t.width, t.height) > H264_LEVEL_5_2_MACROBLOCKS);
  assert.deepEqual(above, [false, false, true, true], 'below, below, above, above');
  // Then MAX held fixed while the fed rate walks down.
  const rateLadder = ENCODER_PROBE_LADDER.filter((t) => t.width === 3024 && t.height === 4032);
  assert.ok(rateLadder.length >= 4, 'MAX at four fed rates');
  assert.ok(new Set(rateLadder.map((t) => t.fps)).size === rateLadder.length, 'distinct fed rates');
  assert.ok(rateLadder.some((t) => t.fps === 30) && rateLadder.some((t) => t.fps <= 5),
    'from the full rate down to a rate no throughput problem could survive');
  // The row text names the level relationship and the decode verdict.
  const row = {
    trial: ENCODER_PROBE_LADDER[2], macroblocks: 37632, aboveLevel52: true, decoded: false,
    encodedWidth: 0, encodedHeight: 0, bytes: 1.5e6, measuredMbps: 4.8, chunkCount: 1,
    finalizeMs: 12, encoderDied: 'recorder error (UnknownError) at 1.9s', error: null
  };
  const text = describeRow(row);
  assert.match(text, /ABOVE L5\.2/);
  assert.match(text, /DID NOT DECODE/);
  assert.match(text, /ENCODER DIED: recorder error/);
  assert.match(describeRow({ ...row, decoded: true, encodedWidth: 2688, encodedHeight: 3584, encoderDied: null }),
    /DECODED 2688×3584/);
});

test('ENCODER CAPABILITY: the largest frame the encoder can write, with its reason', () => {
  // Measured 2026-09-01 on the reference iPhone: 34,992 decodes, 37,632
  // does not, at any frame rate — the H.264 Level 5.2 line (36,864).
  const size = (w, h) => ({ width: w, height: h, aspect: w / h });
  const held = largestEncodable(size(3024, 4032), H264_LEVEL_5_2_MACROBLOCKS);
  assert.ok(macroblocks(held.width, held.height) <= H264_LEVEL_5_2_MACROBLOCKS, 'fits the level');
  assert.ok(macroblocks(held.width, held.height) > 34992,
    'as large as the level allows — better than the probe\'s own "just below" trial');
  assert.ok(held.width % 2 === 0 && held.height % 2 === 0, 'even dimensions for the encoder');
  assert.ok(Math.abs(held.aspect - 3 / 4) < 0.002, 'the sensor aspect survives');
  assert.ok(held.width < 3024 && held.height < 4032, 'never upscaled, always smaller than the source');
  assert.deepEqual(largestEncodable(size(2160, 2880), H264_LEVEL_5_2_MACROBLOCKS), size(2160, 2880),
    'a frame already inside the envelope passes through untouched');

  // The probe's rows become the measurement; the measurement becomes the envelope.
  const row = (mbs, decoded, error = null) => ({ macroblocks: mbs, decoded, error });
  const iphone = measurementFromRows([row(24300, true), row(34992, true), row(37632, false), row(47628, false)]);
  assert.deepEqual(iphone, { largestDecoded: 34992, smallestFailed: 37632 });
  const bracketed = envelopeFromMeasurement(iphone);
  assert.equal(bracketed.maxMacroblocks, H264_LEVEL_5_2_MACROBLOCKS,
    'measurements that bracket the standard line adopt the line');
  assert.equal(bracketed.measured, true);
  assert.match(bracketed.reason, /Level 5\.2/);
  assert.match(bracketed.reason, /34,992 decoded, 37,632 did not/, 'the reason carries the evidence');

  const capable = envelopeFromMeasurement(measurementFromRows([row(24300, true), row(47628, true)]));
  assert.equal(capable.maxMacroblocks, 47628, 'a device that decodes everything keeps its MAX clips');
  assert.equal(capable.measured, true);

  const weaker = envelopeFromMeasurement(measurementFromRows([row(24300, true), row(30000, false)]));
  assert.equal(weaker.maxMacroblocks, 24300, 'a lower wall than the standard is honored as measured');

  assert.equal(envelopeFromMeasurement(null), ASSUMED_ENVELOPE, 'no measurement → the assumption, labelled');
  assert.equal(ASSUMED_ENVELOPE.measured, false);
  assert.match(ASSUMED_ENVELOPE.reason, /assumed/);
  assert.equal(envelopeFromMeasurement(measurementFromRows([row(24300, false, 'canvas unavailable')])),
    ASSUMED_ENVELOPE, 'rows that never ran do not count as failures');

  // The geometry authority holds RECORD IN under the envelope and names it.
  const g = resolveGeometry(size(3024, 4032), {
    ...INPUTS, encoderMacroblocks: { limit: H264_LEVEL_5_2_MACROBLOCKS, reason: bracketed.reason }
  });
  assert.deepEqual({ width: g.recordInput.width, height: g.recordInput.height },
    { width: held.width, height: held.height }, 'the same arithmetic — one owner');
  assert.match(g.recordInput.reason, /36,864-macroblock frame limit/);
  assert.match(g.recordInput.reason, /47,628 would not decode/);
  assert.match(g.recordInput.reason, /Level 5\.2/);
  assert.deepEqual(g.photo, { ...size(3024, 4032), reason: g.photo.reason },
    'PHOTO is untouched — JPEG has no such level');
  const inside = resolveGeometry(size(2160, 2880), {
    ...INPUTS, encoderMacroblocks: { limit: H264_LEVEL_5_2_MACROBLOCKS, reason: 'x' }
  });
  assert.equal(inside.recordInput.width, 2160, 'inside the envelope nothing changes');
  assert.doesNotMatch(inside.recordInput.reason, /macroblock/);
});

/* --- The encoder's KEPT rate is counted from the file ---------------------- */

const box = (type, ...parts) => {
  const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, body]);
};
const u32 = (...values) => {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeUInt32BE(v, i * 4));
  return b;
};
const fullbox = (type, version, ...parts) => box(type, Buffer.from([version, 0, 0, 0]), ...parts);

test('countMp4Frames reads the video track\'s sample tables, flat and fragmented', () => {
  // A flat MP4: 100 video samples of 20 ticks at a 600 timescale = 3.333 s,
  // beside an audio track that must NOT be counted as frames.
  const video = box('trak', box('mdia',
    fullbox('mdhd', 0, u32(0, 0, 600, 2000)),
    fullbox('hdlr', 0, u32(0), Buffer.from('vide'), u32(0, 0, 0), Buffer.from([0])),
    box('minf', box('stbl', fullbox('stts', 0, u32(1, 100, 20))))));
  const audio = box('trak', box('mdia',
    fullbox('mdhd', 0, u32(0, 0, 48000, 160000)),
    fullbox('hdlr', 0, u32(0), Buffer.from('soun'), u32(0, 0, 0), Buffer.from([0])),
    box('minf', box('stbl', fullbox('stts', 0, u32(1, 156, 1024))))));
  const flat = Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', video, audio), box('mdat', Buffer.alloc(16))]);
  const counted = countMp4Frames(new Uint8Array(flat));
  assert.deepEqual(counted, { frames: 100, seconds: 2000 / 600 });
  assert.ok(Math.abs(counted.frames / counted.seconds - 30) < 1e-9, 'a 30 fps file counts as 30 fps');

  // A fragmented MP4 (what a chunked WebKit recorder may write): sample
  // counts live in each fragment's run; the duration is the clip's own.
  const trun = (count) => fullbox('trun', 0, u32(count));
  const fragmented = Buffer.concat([
    box('moov', box('trak', box('mdia', fullbox('hdlr', 0, u32(0), Buffer.from('vide'), u32(0, 0, 0))))),
    box('moof', box('traf', trun(30))), box('mdat', Buffer.alloc(8)),
    box('moof', box('traf', trun(28))), box('mdat', Buffer.alloc(8))
  ]);
  assert.deepEqual(countMp4Frames(new Uint8Array(fragmented)), { frames: 58, seconds: null });

  // Not an MP4, or an MP4 with no index (the truncated-file signature): unmeasured, never guessed.
  assert.equal(countMp4Frames(new Uint8Array(Buffer.from('\x1aE\xdf\xa3webm-ish garbage'))), null);
  assert.equal(countMp4Frames(new Uint8Array(box('mdat', Buffer.alloc(64)))), null);
  assert.equal(countMp4Frames(new Uint8Array(0)), null);
});

/* --- Milestone E: a lens is data compiled to the one filter shape ---------- */

test('a custom lens compiles to a V2 filter in legacy units, with its own ramp', () => {
  const [book] = STARTER_LENSES;
  assert.equal(book.name, 'Coloring Book Style');
  assert.deepEqual(JSON.parse(JSON.stringify(sanitiseLens(book))), JSON.parse(JSON.stringify(book)),
    'the starter is already a clean document');
  const filter = compileLens(book);
  assert.equal(filter.id, lensFilterId(book));
  assert.equal(filter.family, 'custom');
  assert.equal(filter.lens, book);
  assert.equal(filter.unavailableReason, undefined);
  // Edges at full size: a still is honest, so photos are allowed; video too.
  assert.equal(filter.temporal, false);
  assert.equal(filter.supportsPhoto, true);
  assert.equal(filter.supportsVideo, true);
  assert.equal(filter.state, undefined);
  // The shader carries the document's numbers in the legacy 0–255 units and
  // the exact gamma — 254 stays 254, never a slider's near miss.
  assert.match(filter.fragment, /float high = 254\.0000;/);
  assert.match(filter.fragment, /float low = 0\.0000;/);
  assert.match(filter.fragment, /pow\(t, 1\.6000\)/);
  assert.match(filter.fragment, /\* 255\.0/, 'edges are measured in the legacy 0–255 scale');
  assert.match(filter.fragment, /ch_edges\(vUv\)/);
  const body = filter.fragment.slice(filter.fragment.indexOf('void main'));
  assert.doesNotMatch(body, /uState|uPrevious/, 'an edges lens needs no history');
  // The ramp IS the legacy LUT (Rule 6), with alpha added.
  const legacy = buildRampLut(book.stops);
  const rgba = lensRampRgba(book);
  assert.equal(rgba.length, 256 * 4);
  for (let i = 0; i < 256; i++) {
    assert.equal(rgba[i * 4], legacy[i * 3]);
    assert.equal(rgba[i * 4 + 1], legacy[i * 3 + 1]);
    assert.equal(rgba[i * 4 + 2], legacy[i * 3 + 2]);
    assert.equal(rgba[i * 4 + 3], 255);
  }
  assert.deepEqual(filter.ramp, rgba);
  assert.match(describeLens(book), /edge strength, 0–254, curve 1\.6/);

  // The revision fingerprints what changes the shader or the ramp — and only that.
  const renamed = { ...book, name: 'Other' };
  assert.equal(lensRevision(renamed), lensRevision(book), 'a name is not a shader change');
  const retuned = { ...book, color: { ...book.color, high: 255 } };
  assert.notEqual(lensRevision(retuned), lensRevision(book));
  assert.match(compileLens(retuned).fragment, /float high = 255\.0000;/);
  const recoloured = { ...book, stops: [{ at: 0, color: '#000000' }, { at: 1, color: '#ffffff' }] };
  assert.notEqual(compileLens(recoloured).rampKey, filter.rampKey, 'a new ramp means a new upload');
});

test('lens channels: temporal ones decline stills, speed reuses the Speed state, missing ones say so', () => {
  assert.deepEqual([...V2_CHANNELS].slice(0, 4), ['luma', 'edges', 'change', 'speed'],
    'the greyscale fields, then the colour ones');
  const base = STARTER_LENSES[0];
  const change = compileLens(sanitiseLens({ ...base, id: 'c', color: { channel: 'change', low: 0, high: 40, gamma: 1 } }));
  assert.equal(change.temporal, true);
  assert.equal(change.supportsPhoto, false, 'change lives at ANALYSIS resolution — no still');
  assert.match(change.fragment, /uPrevious/);
  const speed = compileLens(sanitiseLens({ ...base, id: 's', color: { channel: 'speed', low: 0, high: 0.35, gamma: 1 } }));
  assert.equal(speed.temporal, true);
  assert.ok(speed.state, 'a speed lens runs the same Speed state pass');
  assert.equal(speed.state, filterById('speed').state, 'ONE speed estimator (Rule 4)');
  assert.match(speed.fragment, /uFps/, 'widths per second need the delivered rate');
  assert.match(speed.fragment, /uAnalysisWidth/);
  // Brightness from a temporal channel also declines stills.
  const lit = compileLens(sanitiseLens({ ...base, id: 'l', brightness: { channel: 'change', low: 0, high: 40, gamma: 1 } }));
  assert.equal(lit.supportsPhoto, false);
  assert.match(lit.fragment, /normBright/);
  // A channel V2 does not compute compiles to an UNAVAILABLE filter — never a stand-in.
  for (const id of ['relief', 'age', 'novelty']) {
    assert.equal(channelAvailability(id).available, false);
    const missing = compileLens(sanitiseLens({ ...base, id: `m-${id}`, color: { channel: id, low: 0, high: 1, gamma: 1 } }));
    assert.match(missing.unavailableReason ?? '', /not built in V2 yet/);
    assert.equal(missing.supportsPhoto, false);
    assert.equal(missing.supportsVideo, false);
  }
  // Scene blend and base follow the legacy definition: blend mixes with scene luma.
  const blended = compileLens(sanitiseLens({ ...base, id: 'b', base: 'scene', sceneBlend: 0.5 }));
  assert.match(blended.fragment, /mix\(c, vec3\(sceneY\), 0\.5000\)/);
  assert.match(blended.fragment, /vec3 base = vec3\(sceneY\);/);
});

test('custom lenses join the one registry as data entries', () => {
  const builtIn = allFilters().map((f) => f.id);
  assert.deepEqual(builtIn, FILTERS.map((f) => f.id), 'no custom entries until the shell sets them');
  const book = compileLens(STARTER_LENSES[0]);
  setCustomFilters([book]);
  assert.deepEqual(allFilters().map((f) => f.id), [...FILTERS.map((f) => f.id), book.id]);
  assert.equal(filterById(book.id), book, 'filterById resolves a lens like any filter');
  assert.equal(filterById('rgb')?.id, 'rgb', 'built-ins are untouched');
  setCustomFilters([]);
  assert.equal(filterById(book.id), null);
});

test('reverseStops mirrors the ramp: black→white becomes white→black', () => {
  const mono = [{ at: 0, color: '#000000' }, { at: 1, color: '#ffffff' }];
  assert.deepEqual(reverseStops(mono),
    [{ at: 0, color: '#ffffff' }, { at: 1, color: '#000000' }]);
  // Reversing twice is exactly where it started — the button is its own undo.
  assert.deepEqual(reverseStops(reverseStops(mono)), mono);
  // An interior stop mirrors about the middle; colours are never touched.
  const three = [{ at: 0, color: '#f6f2e8' }, { at: 0.3, color: '#8a8474' }, { at: 1, color: '#12100c' }];
  assert.deepEqual(reverseStops(three), [
    { at: 0, color: '#12100c' },
    { at: 0.7, color: '#8a8474' },
    { at: 1, color: '#f6f2e8' }
  ]);
  assert.deepEqual(reverseStops(three).map((s) => s.color).sort(),
    three.map((s) => s.color).sort(), 'the same colours, in the other order');
  // The ramp LUT really is the mirror image.
  const forward = buildRampLut(mono);
  const back = buildRampLut(reverseStops(mono));
  assert.equal(forward[0], 0);
  assert.equal(back[0], 255);
  assert.equal(back[255 * 3], forward[0]);
});

test('the colour picker maps a tap through the object-fit: cover crop', () => {
  // A portrait stream in a shorter box: cover scales to fill the WIDTH and
  // crops the top and bottom away, which a naive width ratio gets wrong.
  const box = { width: 430, height: 360 };
  const source = { width: 720, height: 960 };
  const scale = coverScale(box, source);
  assert.ok(Math.abs(scale - 430 / 720) < 1e-9, 'cover fills the wider constraint');

  const centre = tapToSource({ x: 215, y: 180 }, box, source);
  assert.ok(Math.abs(centre.x - 360) < 0.5, `the box centre is the frame centre, got ${centre.x}`);
  assert.ok(Math.abs(centre.y - 480) < 0.5, `the box centre is the frame centre, got ${centre.y}`);

  // The top edge of the box is NOT row 0: the crop hides the frame's top.
  const top = tapToSource({ x: 215, y: 0 }, box, source);
  assert.ok(top.y > 100, `the cover crop hides the top of the frame, got row ${top.y}`);
  assert.ok(Math.abs(top.y - 178.6) < 1, `measured crop offset, got ${top.y}`);
  assert.notEqual(Math.round(top.y), 0, 'a naive width ratio would say row 0');

  // Points stay inside the frame, and a degenerate box refuses rather than guesses.
  const corner = tapToSource({ x: 1000, y: 1000 }, box, source);
  assert.ok(corner.x <= source.width - 1 && corner.y <= source.height - 1);
  assert.equal(tapToSource({ x: 1, y: 1 }, { width: 0, height: 0 }, source), null);

  // The patch is square, inside the frame, and centred where it can be.
  const patch = patchRect({ x: 360, y: 480 }, source, 9);
  assert.deepEqual(patch, { x: 356, y: 476, width: 9, height: 9 });
  const clamped = patchRect({ x: 0, y: 959 }, source, 9);
  assert.deepEqual(clamped, { x: 0, y: 951, width: 9, height: 9 });
  assert.ok(clamped.x >= 0 && clamped.y + clamped.height <= source.height);

  // The reading is the MEAN of the patch, with the shaders' own luma.
  const two = new Uint8ClampedArray([0, 0, 0, 255, 200, 100, 50, 255]);
  assert.deepEqual(averageRgb(two), { r: 100, g: 50, b: 25, luma: Math.round(0.2126 * 100 + 0.7152 * 50 + 0.0722 * 25) });
  assert.deepEqual(averageRgb(new Uint8ClampedArray(0)), { r: 0, g: 0, b: 0, luma: 0 });
});

test('viewfinder guides are one registry of percent-space lines', () => {
  assert.equal(new Set(GUIDES.map((g) => g.id)).size, GUIDES.length, 'guide ids must be unique');
  assert.equal(GUIDES[0].id, DEFAULT_GUIDE, 'the default is first and draws nothing');
  assert.equal(readState().guide, DEFAULT_GUIDE, 'the state boots on the registry default');
  assert.deepEqual(guideById('off').lines(1.2), [], 'Off is genuinely nothing');
  assert.equal(guideById('nope'), null);

  for (const guide of GUIDES) {
    assert.ok(guide.label.length > 0);
    for (const line of guide.lines(1.19)) {
      for (const value of [line.x1, line.y1, line.x2, line.y2]) {
        assert.ok(value >= 0 && value <= 100, `${guide.id}: percent-space only, got ${value}`);
      }
    }
  }

  // Thirds: two verticals and two horizontals, on the thirds.
  const thirds = guideById('thirds').lines(1.19);
  assert.equal(thirds.length, 4);
  const verticals = thirds.filter((l) => l.x1 === l.x2).map((l) => Number(l.x1.toFixed(2)));
  assert.deepEqual(verticals, [33.33, 66.67]);
  // Golden: the 1 : 0.618 : 1 section, which is NOT the thirds.
  const phi = guideById('phi').lines(1.19);
  const phiVerticals = phi.filter((l) => l.x1 === l.x2).map((l) => Number(l.x1.toFixed(1)));
  assert.deepEqual(phiVerticals, [38.2, 61.8]);
  assert.equal(guideById('grid4').lines(1).length, 6, 'a 4×4 grid is three lines each way');
  assert.equal(guideById('diagonals').lines(1).length, 2);

  // A guide draws lines and nothing else: the picker's reticle is its own
  // switch, because a marker in the middle of the picture is clutter when
  // nobody is sampling (Joshua, 2026-09-02).
  assert.ok(GUIDES.every((g) => !('centerSpot' in g)),
    'no guide may claim the reticle — it has its own toggle');
  assert.equal(readState().reticle, false, 'the reticle starts off, uninvited');
  assert.doesNotMatch(guideById('center').note, /\bring\b|picker|sampl/i,
    'the centre guide is a crosshair, not the sampling target');

  // The 1:1 guide really is square in real pixels, at either box shape, and
  // says plainly that nothing is cropped.
  for (const box of [{ width: 430, height: 360 }, { width: 360, height: 640 }]) {
    const square = guideById('square').lines(box.width / box.height);
    assert.equal(square.length, 4);
    const xs = square.flatMap((l) => [l.x1, l.x2]);
    const ys = square.flatMap((l) => [l.y1, l.y2]);
    const widthPx = (Math.max(...xs) - Math.min(...xs)) / 100 * box.width;
    const heightPx = (Math.max(...ys) - Math.min(...ys)) / 100 * box.height;
    assert.ok(Math.abs(widthPx - heightPx) < 0.001,
      `a square guide must be square: ${widthPx} × ${heightPx}`);
    assert.ok(Math.abs(widthPx - Math.min(box.width, box.height)) < 0.001, 'the largest centred square');
  }
  assert.match(guideById('square').note, /full frame/i, 'a crop guide must not imply a crop');
});

test('the sample ring on screen is the sample patch, on both axes', () => {
  const box = { width: 430, height: 360 };
  const source = { width: 720, height: 960 };
  const ring = patchBoxPercent(box, source, 9);
  // One square, two percentages: the same size in real pixels either way.
  const widthPx = ring.width / 100 * box.width;
  const heightPx = ring.height / 100 * box.height;
  assert.ok(Math.abs(widthPx - heightPx) < 1e-9, `${widthPx} vs ${heightPx}`);
  assert.ok(Math.abs(widthPx - 9 * coverScale(box, source)) < 1e-9,
    'the ring is nine source pixels at the cover scale — not a decorative size');
  assert.equal(patchBoxPercent({ width: 0, height: 0 }, source, 9), null);
});

/* --- The colour fields: one batch, most of the Lens Pack falls out -------- */

test('colour fields are shared as data but offered only by the engine that measures them', () => {
  const colour = ['hue', 'saturation', 'red', 'green', 'blue', 'colourDistance',
    'rarity', 'backgroundDistance'];
  for (const id of colour) {
    const info = channelInfo(id);
    assert.equal(info.id, id, `${id} is a real channel, not a fallback to luma`);
    assert.equal(info.gpuOnly, true, `${id} is measured by V2's GPU pipeline`);
    assert.equal(info.temporal, false, 'a colour field reads one frame');
    assert.ok(info.meaning.length > 20, `${id} says what it physically is`);
    assert.ok(V2_CHANNELS.includes(id), `${id} is offered in V2`);
    assert.equal(channelAvailability(id).available, true);
  }
  assert.equal(channelInfo('colourDistance').needsReference, true);
  assert.ok(colour.every((id) => !channelInfo(id).needsReference || id === 'colourDistance'));
  // The legacy engine measures none of them, and its editor says so by
  // leaving them out rather than offering a field it renders blank.
  const legacy = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const offers = legacy.match(/for \(const channel of CHANNELS.*/g) ?? [];
  assert.ok(offers.length >= 2, 'the legacy editor builds its channel list twice');
  for (const line of offers) {
    assert.match(line, /gpuOnly/, `the legacy editor must filter GPU-only fields: ${line}`);
  }
  // Greyscale fields are untouched by the addition.
  for (const id of ['luma', 'speed', 'change', 'edges', 'relief', 'age', 'novelty']) {
    assert.ok(!channelInfo(id).gpuOnly, `${id} stays available to both engines`);
  }
  assert.equal(CHANNELS.length, 15);
});

test('rgbToHsv agrees with the shader convention', () => {
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const [rh, rs, rv] = rgbToHsv('#ff0000');
  assert.ok(near(rh, 0) && near(rs, 1) && near(rv, 1), 'red sits at the wheel\'s origin');
  const [gh] = rgbToHsv('#00ff00');
  assert.ok(near(gh, 1 / 3), 'green is a third of the way round');
  const [bh] = rgbToHsv('#0000ff');
  assert.ok(near(bh, 2 / 3));
  const [, ws, wv] = rgbToHsv('#ffffff');
  assert.ok(near(ws, 0) && near(wv, 1), 'white has no colour strength');
  const [, ks, kv] = rgbToHsv('#000000');
  assert.ok(near(ks, 0) && near(kv, 0), 'black is defined, not a divide by zero');
});

test('the three output modes are one lens document away from each other', () => {
  const splash = STARTER_LENSES.find((l) => l.id === 'lens-v2-colour-splash');
  const hide = STARTER_LENSES.find((l) => l.id === 'lens-v2-colour-hide');
  // Isolate and Hide are the SAME lens with the range the other way round.
  assert.equal(splash.output, 'mask');
  assert.equal(hide.output, 'mask');
  assert.deepEqual(
    { low: splash.color.low, high: splash.color.high },
    { low: hide.color.high, high: hide.color.low },
    'one mode, two features, by the direction of the range');

  const mask = compileLens(splash).fragment;
  assert.match(mask, /mix\(vec3\(sceneY\), scene, t\)/, 'mask keeps the scene where it matches');
  assert.match(mask, /rgb2hsv/, 'a colour distance needs HSV');
  assert.match(mask, /const vec3 REF_HSV = vec3\(0\.99\d+, 0\.8\d+, 0\.78\d+\)/,
    'the reference colour is baked in as the measured HSV of #c81e28');
  assert.doesNotMatch(mask, /hsv2rgb/, 'nothing is written back to colour here');

  const swap = compileLens(STARTER_LENSES.find((l) => l.id === 'lens-v2-paper-pink')).fragment;
  assert.match(swap, /hsv2rgb\(vec3\(TARGET_HSV\.x, TARGET_HSV\.y, rgb2hsv\(scene\)\.z\)\)/,
    'a swap takes the target hue and keeps each pixel\'s own brightness');
  assert.match(swap, /const vec3 TARGET_HSV/);

  const paint = compileLens(STARTER_LENSES.find((l) => l.id === 'lens-v2-hue-map')).fragment;
  assert.match(paint, /texture2D\(uRamp, vec2\(t, 0\.5\)\)/, 'paint is still the ramp');
  assert.doesNotMatch(paint, /hsv2rgb/);
  assert.match(paint, /rgb2hsv/, 'but hue needs HSV to be measured at all');

  // A lens written before output modes existed still means what it meant.
  const book = STARTER_LENSES[0];
  assert.equal(book.output, undefined);
  assert.match(compileLens(book).fragment, /texture2D\(uRamp, vec2\(t, 0\.5\)\)/);
  assert.doesNotMatch(compileLens(book).fragment, /rgb2hsv/, 'and pays for nothing it does not use');

  // The shader changes when any of the new fields change.
  const base = lensRevision(splash);
  assert.notEqual(lensRevision({ ...splash, output: 'paint' }), base);
  assert.notEqual(lensRevision({ ...splash, reference: '#00ff00' }), base);
  assert.notEqual(lensRevision({ ...splash, target: '#00ff00' }), base);

  // Colour lenses read one frame, so a still is honest.
  for (const id of ['lens-v2-colour-splash', 'lens-v2-paper-pink', 'lens-v2-hue-map',
    'lens-v2-colour-strength', 'lens-v2-red-solo']) {
    const filter = compileLens(STARTER_LENSES.find((l) => l.id === id));
    assert.equal(filter.supportsPhoto, true, `${id} takes stills`);
    assert.equal(filter.temporal, false);
    assert.equal(filter.unavailableReason, undefined);
  }
});

test('the starter pack is valid, unique, and describes itself honestly', () => {
  assert.equal(new Set(STARTER_LENSES.map((l) => l.id)).size, STARTER_LENSES.length);
  for (const lens of STARTER_LENSES) {
    assert.deepEqual(JSON.parse(JSON.stringify(sanitiseLens(lens))), JSON.parse(JSON.stringify(lens)),
      `${lens.name} survives a save/load round trip unchanged`);
    assert.ok(channelAvailability(lens.color.channel).available,
      `${lens.name} uses a field V2 measures`);
  }
  assert.match(describeLens(STARTER_LENSES.find((l) => l.id === 'lens-v2-colour-splash')),
    /measured from #c81e28.*keeping the camera’s colour/);
  assert.match(describeLens(STARTER_LENSES.find((l) => l.id === 'lens-v2-paper-pink')),
    /recolouring matches toward #ff5ca8/);
});

/* --- The frame's colour census: three lenses from one measurement --------- */

const rgba = (pixels) => {
  const data = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([r, g, b], i) => {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  });
  return data;
};

test('the hue histogram counts colour, and greys do not get a vote', () => {
  const RED = [220, 30, 40];
  const GREEN = [40, 200, 60];
  const GREY = [128, 128, 128];

  // Mostly red, a little green: red is the peak and green is the rare one.
  const scene = buildHistogram(rgba([...Array(20).fill(RED), ...Array(2).fill(GREEN)]));
  assert.equal(scene.bins.length, HISTOGRAM_BINS);
  assert.equal(Math.max(...scene.bins), 255, 'the commonest hue defines the scale');
  const redBin = Math.floor(scene.dominant[0] * HISTOGRAM_BINS);
  assert.ok(scene.dominant[0] < 0.05 || scene.dominant[0] > 0.95, 'red sits at the wheel\'s origin');
  assert.equal(scene.bins[redBin], 255);
  // Two colours in the frame, two bins — and the outnumbered one reads rare.
  const present = [...scene.bins].filter((share) => share > 0);
  assert.equal(present.length, 2, 'nothing else was counted');
  const rarest = Math.min(...present);
  assert.ok(rarest > 0 && rarest < 60, `green is present but rare, got ${rarest}`);
  assert.ok(scene.dominant[1] > 0.5, 'the dominant colour reports the strength it was seen with');
  assert.ok(Math.abs(scene.colourShare - 1) < 1e-9, 'every pixel here had colour');

  // A grey wall elects nobody: no hue, no dominant colour, nothing rare.
  const wall = buildHistogram(rgba(Array(40).fill(GREY)));
  assert.deepEqual(wall, emptyHistogram(), 'a colourless frame reports no colour');
  assert.equal(wall.colourShare, 0);
  assert.ok(emptyHistogram().bins.every((b) => b === 255),
    'and "unmeasured" reads as ordinary, never as rare');

  // Greys beside colour are ignored rather than counted as a hue.
  const mixed = buildHistogram(rgba([...Array(10).fill(GREY), ...Array(10).fill(GREEN)]));
  assert.ok(Math.abs(mixed.colourShare - 0.5) < 1e-9, 'half the frame had a vote');
  assert.ok(Math.abs(mixed.dominant[0] - 1 / 3) < 0.02, 'and the half with colour decided');
  assert.deepEqual(buildHistogram(new Uint8ClampedArray(0)), emptyHistogram());
});

test('rarity and background distance are one measurement, three lenses', () => {
  for (const id of ['rarity', 'backgroundDistance']) {
    assert.equal(channelInfo(id).needsHistogram, true, `${id} reads the whole frame`);
    assert.equal(channelInfo(id).gpuOnly, true);
    assert.ok(V2_CHANNELS.includes(id));
  }
  // Only a lens that asks pays for the census.
  const rare = compileLens(STARTER_LENSES.find((l) => l.id === 'lens-v2-rare-colour'));
  const book = compileLens(STARTER_LENSES[0]);
  assert.equal(rare.needsHistogram, true);
  assert.ok(!book.needsHistogram, 'an edges lens never triggers a measurement it cannot use');
  assert.match(rare.fragment, /texture2D\(uHistogram, vec2\(hsv\.x, 0\.5\)\)/);
  assert.match(rare.fragment, /smoothstep\(0\.10, 0\.25, hsv\.y\)/,
    'a grey pixel has no hue to be rare in');

  const background = compileLens(STARTER_LENSES.find((l) => l.id === 'lens-v2-background-subtract'));
  assert.equal(background.needsHistogram, true);
  assert.match(background.fragment, /colourGap\(rgb2hsv\(texture2D\(uFrame, uv\)\.rgb\), uDominant\)/,
    'the background is the frame\'s measured prevailing colour, not a stored plate');
  // The distance function is written once and shared (Rule 6).
  const splash = compileLens(STARTER_LENSES.find((l) => l.id === 'lens-v2-colour-splash')).fragment;
  assert.match(splash, /float colourGap\(vec3 hsv, vec3 ref\)/);
  assert.equal((background.fragment.match(/float colourGap/g) ?? []).length, 1);
  assert.doesNotMatch(book.fragment, /colourGap/, 'and only where it is used');

  // All three take stills: a census is of the current frame, not of history.
  for (const id of ['lens-v2-rare-colour', 'lens-v2-background-subtract', 'lens-v2-rarity-map']) {
    const filter = compileLens(STARTER_LENSES.find((l) => l.id === id));
    assert.equal(filter.supportsPhoto, true);
    assert.equal(filter.temporal, false);
  }
});
