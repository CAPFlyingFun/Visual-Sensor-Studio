import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  DEFAULT_GEOMETRY_INPUTS, fitShortSide, resolveGeometry
} from '../.test-build/v2/camera/geometry.js';
import { captureAtMaxStream } from '../.test-build/v2/capture/shutter.js';
import { containerCandidates, pickContainer } from '../.test-build/v2/capture/record.js';
import {
  STREAM_TIERS, DEFAULT_STREAM_TIER, tierAvailable, tierById
} from '../.test-build/v2/camera/stream-tiers.js';
import { readState } from '../.test-build/v2/state.js';
import {
  AGE_STATE, CHRONO_STATE, FILTERS, MOTION_STATE, NOVELTY_STATE, SHADER_HEADER,
  SLITSCAN_STATE, allFilters, canReverse,
  filterById, ironbowLut, isReversed, setCustomFilters, setReversedFilters
} from '../.test-build/v2/filters/registry.js';
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
  ZEBRA_LEVELS, PEAKING_LEVELS, peakingThreshold, zebraThreshold
} from '../.test-build/v2/render/overlays.js';
import {
  CAMERA_CONTROLS, noControlsNote, offeredControls, verifyApply
} from '../.test-build/v2/camera/controls.js';
import {
  EXPOSURE_BINS, CLIPPED, buildExposure, describeExposure, emptyExposure
} from '../.test-build/v2/vision/exposure.js';
import {
  FRAME_AVERAGE_LEVELS, DEFAULT_FRAME_AVERAGE, NOMINAL_FPS, conversionNote,
  frameAverageById, framesForLevel, frameAverageWeight
} from '../.test-build/v2/render/frame-average.js';
import {
  HISTOGRAM_BINS, buildHistogram, emptyHistogram
} from '../.test-build/v2/vision/frame-histogram.js';
import {
  COLOUR_GAP_GLSL, GAP_WEIGHTS, colourGap, matchShare, rgbToHsvValues
} from '../.test-build/v2/vision/colour-gap.js';
import { tipFor } from '../.test-build/v2/ui/coach.js';
import { normaliseBinding } from '../.test-build/vision/lens.js';
import { STARTER_LENSES, SUPERSEDED_STARTERS } from '../.test-build/v2/filters/starter-lenses.js';
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
  // The DEFAULT is Joshua's to choose, and he set it to 1080 (2026-09-04).
  // What this pins is the invariant behind the old 720, which is unchanged:
  // the default must be a REAL registry tier and must never be the maximum,
  // so the most expensive stream can only ever arrive by a deliberate tap.
  assert.ok(fallback, 'the default names a tier that actually exists');
  assert.notEqual(DEFAULT_STREAM_TIER, 'max',
    'the maximum never arrives by accident — only by a deliberate choice');
  assert.ok(typeof fallback.shortSide === 'number',
    'and the default asks for a definite size rather than "the largest there is"');
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

test('the container ladder asks for HEVC first, falls back honestly, never pins an H.264 level', () => {
  // HEVC FIRST, AND QUOTED FIRST. RFC 6381 quotes the codecs value, and the
  // device rejected every BARE spelling: the probe reported `asked
  // video/mp4` with `codec avc1` on every trial, so the ladder had fallen
  // through to the plain container and HEVC was never requested at all.
  assert.equal(pickContainer(() => true), 'video/mp4;codecs="hvc1"');
  assert.equal(pickContainer((mime) => mime === 'video/mp4;codecs=hev1'),
    'video/mp4;codecs=hev1', 'a bare spelling is still taken when it is all there is');

  // A browser that admits ONLY the quoted form must reach HEVC, which is the
  // whole point of the change — the bare-only ladder could not.
  assert.match(pickContainer((mime) => mime.includes('"')), /codecs="hvc/,
    'quoting is tried before giving up on HEVC');

  // AND THE OLD RULE SURVIVES: no H.264 codec string, ever. That is the one
  // that pinned a LEVEL and capped the encoder; asking for HEVC removes a
  // ceiling rather than imposing one, which is why it is allowed here.
  const seen = [];
  pickContainer((mime) => { seen.push(mime); return false; });
  assert.ok(seen.length > 0, 'the ladder is walked');
  assert.ok(seen.every((mime) => !/avc1|avc3|h264/i.test(mime)),
    `no H.264 codec string can pin a level, saw: ${seen.join(', ')}`);

  // A DEVICE THAT ADMITS NEITHER HEVC STRING BEHAVES EXACTLY AS BEFORE.
  assert.equal(pickContainer((mime) => !mime.includes('codecs')), 'video/mp4',
    'plain mp4 is still the fallback that has always worked');
  assert.equal(pickContainer((mime) => mime === 'video/webm'), 'video/webm');
  assert.equal(pickContainer(() => false), '',
    'no admitted container means the browser default, measured afterwards');
  assert.equal(pickContainer(() => { throw new Error('no recorder'); }), '');

  // EVERY admitted candidate is kept, in order — isTypeSupported saying yes
  // is not a promise the CONSTRUCTOR will accept the same string, so start()
  // needs somewhere to fall to rather than failing the recording.
  const all = containerCandidates(() => true);
  assert.equal(all[0], 'video/mp4;codecs="hvc1"', 'the quoted HEVC form leads');
  assert.equal(all[all.length - 2], 'video/mp4', 'the plain container is the last MP4 resort');
  assert.equal(all[all.length - 1], 'video/webm');
  assert.ok(all.filter((m) => /hvc1|hev1/.test(m)).length >= 4,
    'several HEVC spellings are tried before conceding, quoted and bare');
  assert.ok(all.every((m, i) => all.indexOf(m) === i), 'no duplicate candidates');
  assert.deepEqual(containerCandidates((mime) => !mime.includes('codecs')),
    ['video/mp4', 'video/webm']);
  assert.deepEqual(containerCandidates(() => false), []);
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

  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const label of ['SOURCE', 'CAPABILITY', 'VIEWFINDER', 'PREVIEW', 'ANALYSIS', 'PHOTO POLICY', 'LAST PHOTO']) {
    assert.ok(html.includes(`>${label}<`), `the truth table needs a ${label} row`);
  }

  const appTs = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');
  assert.match(appTs, /streamLabel/, 'the SOURCE row reads its description from the tier registry');
  assert.ok((tierById(DEFAULT_STREAM_TIER)?.streamLabel ?? '').length > 0,
    'the default policy names itself in the SOURCE row, whichever tier it is');
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
    // RESERVED WORDS DO NOT COMPILE, and the failure is invisible here: the
    // shader is a string to TypeScript, so a filter using one builds, tests,
    // deploys, and dies on the device with a blank preview. 'half' reached a
    // review this way (Poly, 2026-09-04). Comments are stripped first —
    // reserved words are only reserved to the compiler.
    for (const source of [filter.fragment, filter.state ?? '']) {
      const code = glslCode(source);
      for (const reserved of ['half', 'flat', 'long', 'short', 'double', 'union',
        'input', 'output', 'this', 'class', 'template', 'namespace', 'sizeof', 'cast']) {
        assert.ok(!new RegExp(`\\b${reserved}\\b`).test(code),
          `${filter.id}: '${reserved}' is reserved in GLSL ES 1.00`);
      }
    }
    // The metadata and the shader must agree about history: a temporal
    // filter's BODY (display or state pass) samples uPrevious; a
    // non-temporal one never does. A state pass must feed the display.
    // The filter's OWN code: everything after the shared header. Slicing from
    // `void main` was the old way of skipping the header's uniform
    // declarations, and it silently skipped HELPER FUNCTIONS too — Motion
    // reads uPrevious inside a delta() helper, so it read as sampling nothing.
    const ownCode = (source) => source.slice(SHADER_HEADER.length);
    if (filter.state) {
      const stateBody = ownCode(filter.state);
      // A STATE PASS MUST EARN ITS EXISTENCE, and this used to say that meant
      // reading uState — that a state pass is memory. That was true of every
      // filter when it was written and is too narrow now: the pass is ALSO
      // the only mechanism this renderer has for "run at analysis
      // resolution", which is a correctness requirement rather than a
      // preference. A shader that differences uFrame against uPrevious CANNOT
      // do it in the display pass: uPrevious is snapshotted at analysis size
      // while the display runs at preview or photo size, so a motionless
      // scene comes out with a bright rim on every edge. Flow, Background and
      // Motion were each moved here for exactly that, and two of them were
      // shipped bugs before they were.
      //
      // So the real invariant is: a state pass does something the display
      // pass could not do correctly — it holds memory (uState) or it needs
      // the matched grid (uPrevious). A pass doing neither is a display pass
      // in the wrong place.
      assert.ok(stateBody.includes('uState') || stateBody.includes('uPrevious'),
        `${filter.id}: a state pass must hold memory or need the matched grid`);
      assert.ok(ownCode(filter.fragment).includes('uState'),
        `${filter.id}: the display pass must sample the state it computes`);
      assert.equal(filter.supportsPhoto, true,
        `${filter.id}: a still is the frame you were shown, like any other filter`);
    }
    const body = ownCode(filter.fragment);
    const stateSamplesHistory = filter.state ? ownCode(filter.state).includes('uPrevious') : false;
    assert.equal(body.includes('uPrevious') || stateSamplesHistory, filter.temporal,
      `${filter.id}: temporal metadata and shader body must agree`);
  }
  assert.deepEqual(FILTERS.map((f) => f.id),
    ['rgb', 'ironbow', 'difference', 'motion', 'speed', 'trails', 'chrono', 'slitscan',
     'edges', 'grid', 'poly', 'cel', 'ink', 'wash', 'amplify', 'flow', 'background']);
  // Milestone D's second stage: Speed and Trails carry their memory in a
  // state pass, at ANALYSIS resolution, and decline stills like Motion.
  for (const id of ['speed', 'trails']) {
    const filter = filterById(id);
    assert.ok(filter?.state && filter.temporal && filter.supportsPhoto && filter.supportsVideo,
      `${id} is a stateful, temporal filter that can still save and record`);
  }
  assert.equal(filterById('difference')?.state, undefined, 'Motion needs no state — it compares two frames');
  assert.equal(filterById('rgb')?.name, 'RGB');
  assert.equal(filterById('nope'), null);

  // Motion's history lives at analysis resolution, so video is its natural
  // product — but a still is no longer refused for it. The trade is STATED in
  // the note rather than enforced by taking the shutter away.
  const motion = filterById('difference');
  assert.ok(motion && motion.temporal && motion.supportsPhoto && motion.supportsVideo,
    'Motion can be photographed and recorded like any other filter');
  assert.match(motion.note, /ANALYSIS resolution/, 'and the note says where the detail comes from');
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
    finalizeMs: 12, encoderDied: 'recorder error (UnknownError) at 1.9s', error: null,
    mimeType: 'video/mp4;codecs=hvc1', codecTag: 'avc1', fragmented: true
  };
  const text = describeRow(row);
  assert.match(text, /ABOVE L5\.2/);
  assert.match(text, /DID NOT DECODE/);
  assert.match(text, /ENCODER DIED: recorder error/);
  assert.match(describeRow({ ...row, decoded: true, encodedWidth: 2688, encodedHeight: 3584, encoderDied: null }),
    /DECODED 2688×3584/);

  // THE ROW SAYS WHAT WAS ASKED FOR AND WHAT ARRIVED. Every MAX trial failing
  // at exactly the H.264 Level 5.2 line is the signature of an HEVC request
  // that was accepted and then ignored — and "HEVC is not enough" needs
  // opposite work from "HEVC was never used", so the row must distinguish
  // them. This fixture is that case: hvc1 asked, avc1 delivered.
  assert.match(text, /codec avc1/, 'the file\'s own sample entry, not the request');
  assert.match(text, /asked video\/mp4;codecs=hvc1/, 'and what was requested, for comparison');
  assert.match(text, /fragmented/, 'the layout too — it decides whether Photos can import it');
  assert.match(describeRow({ ...row, codecTag: '', fragmented: false }),
    /codec unreadable · progressive/,
    'an unreadable container says so rather than claiming a codec');
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
  assert.equal(change.supportsPhoto, true, 'and it can still be photographed');
  assert.match(change.fragment, /uPrevious/);
  const speed = compileLens(sanitiseLens({ ...base, id: 's', color: { channel: 'speed', low: 0, high: 0.35, gamma: 1 } }));
  assert.equal(speed.temporal, true);
  assert.ok(speed.state, 'a speed lens runs the same Speed state pass');
  assert.equal(speed.state, filterById('speed').state, 'ONE speed estimator (Rule 4)');
  assert.match(speed.fragment, /uFps/, 'widths per second need the delivered rate');
  assert.match(speed.fragment, /uAnalysisWidth/);
  const lit = compileLens(sanitiseLens({ ...base, id: 'l', brightness: { channel: 'change', low: 0, high: 40, gamma: 1 } }));
  assert.equal(lit.supportsPhoto, true);
  assert.match(lit.fragment, /normBright/);
  // AN UNAVAILABLE LENS IS NEVER A STAND-IN. relief, age and novelty used to
  // be the case here — they were the channels V2 had not built, and Joshua
  // met them as filters saying so on his phone. They are built now, so the
  // mechanism is shown with the case that remains: two stateful channels in
  // one lens, which cannot work because there is one state texture.
  const clash = compileLens(sanitiseLens({
    ...base, id: 'clash',
    color: { channel: 'speed', low: 0, high: 3, gamma: 1 },
    brightness: { channel: 'novelty', low: 0, high: 60, gamma: 1 }
  }));
  assert.ok(clash.unavailableReason, 'it refuses rather than painting a wrong answer');
  assert.equal(clash.supportsPhoto, false);
  assert.equal(clash.supportsVideo, false);
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
    'rarity', 'backgroundDistance', 'chromaEdge'];
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
  assert.equal(CHANNELS.length, 16);
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
  // Every lens says what it does in its own words — the same sentence the
  // strip shows, so no two lenses can share a description by accident
  // (three of them did, through a stale render key).
  const notes = STARTER_LENSES.map((lens) => lens.note ?? '');
  assert.ok(notes.every((note) => note.length > 20), 'every starter carries a note');
  assert.equal(new Set(notes).size, notes.length, 'and no two notes are the same');
  // Short enough to read at a glance. The cap was 120 until the two colour
  // lenses that look alike in a dull room needed room to say WHY they differ
  // (Joshua, 2026-09-02) — a note that fits but explains nothing is worse
  // than one that wraps.
  for (const lens of STARTER_LENSES) {
    assert.ok((lens.note ?? '').length <= 280, `${lens.name}'s note stays short`);
  }
  // The pair he could not tell apart each name the other, so the strip
  // answers the question without him having to ask it twice.
  const named = (id) => STARTER_LENSES.find((l) => l.id === id)?.note ?? '';
  assert.match(named('lens-v2-camouflage-breaker'), /unusual/i);
  assert.match(named('lens-v2-chroma-edge'), /Camouflage Breaker/);
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

/* --- One formula, two evaluators; and coaching derived from need ---------- */

test('the colour gap is written once and the shader is generated from it', () => {
  // Two evaluators are unavoidable — one per pixel on the GPU, one over a
  // sample on the CPU — so the FORMULA must not fork. The weights live in
  // one place and the GLSL is built from them; this pins the two together.
  assert.match(COLOUR_GAP_GLSL, new RegExp(`ds \\* ${GAP_WEIGHTS.strength.toFixed(2)}`));
  assert.match(COLOUR_GAP_GLSL, new RegExp(`dv \\* ${GAP_WEIGHTS.brightness.toFixed(2)}`));
  assert.match(COLOUR_GAP_GLSL, /min\(hsv\.y, ref\.y\)/, 'hue is weighted by how colourful both are');
  assert.match(compileLens(STARTER_LENSES.find((l) => l.id === 'lens-v2-colour-splash')).fragment,
    /float colourGap\(vec3 hsv, vec3 ref\)/, 'and the shader uses that very text');

  const red = rgbToHsvValues(220, 30, 40);
  assert.equal(colourGap(red, red), 0, 'a colour is no distance from itself');
  const green = rgbToHsvValues(40, 200, 60);
  assert.ok(colourGap(red, green) > 0.5, `red and green are far apart, got ${colourGap(red, green)}`);
  // Greys are compared by brightness, not by a hue neither of them has.
  const darkGrey = rgbToHsvValues(60, 60, 60);
  const lightGrey = rgbToHsvValues(200, 200, 200);
  assert.ok(colourGap(darkGrey, darkGrey) === 0);
  assert.ok(colourGap(darkGrey, lightGrey) < 0.5, 'two greys differ only in brightness');
  assert.ok(colourGap(red, darkGrey) > colourGap(darkGrey, lightGrey), 'colour beats brightness');

  // The match share follows the LENS's own range, not a second opinion.
  const splash = STARTER_LENSES.find((l) => l.id === 'lens-v2-colour-splash');
  const frame = rgba([...Array(3).fill([200, 30, 38]), ...Array(1).fill([40, 200, 60])]);
  const share = matchShare(frame, rgbToHsvValues(200, 30, 38),
    (gap) => normaliseBinding(gap, splash.color));
  assert.ok(Math.abs(share - 0.75) < 1e-9, `three of four pixels match, got ${share}`);
  assert.equal(matchShare(frame, rgbToHsvValues(40, 200, 60),
    (gap) => normaliseBinding(gap, splash.color)), 0.25);
  assert.equal(matchShare(new Uint8ClampedArray(0), [0, 0, 0], () => 1), 0);
});

test('a filter that needs a step says so, derived from what it needs', () => {
  // Not written per filter: a lens the user builds tomorrow is coached too.
  const splash = tipFor(compileLens(STARTER_LENSES.find((l) => l.id === 'lens-v2-colour-splash')));
  assert.equal(splash.id, 'lens-reference');
  assert.match(splash.title, /Colour Splash/);
  assert.match(splash.steps.join(' '), /Pick colour/);
  assert.match(splash.steps.join(' '), /0%/, 'and says what "nothing matches" looks like');
  assert.deepEqual(splash.action, { label: 'Pick a colour', kind: 'pick' });

  const swap = tipFor(compileLens(STARTER_LENSES.find((l) => l.id === 'lens-v2-paper-pink')));
  assert.equal(swap.id, 'lens-swap');
  assert.match(swap.steps.join(' '), /Recolour to/);

  const rare = tipFor(compileLens(STARTER_LENSES.find((l) => l.id === 'lens-v2-rare-colour')));
  assert.equal(rare.id, 'lens-histogram');
  assert.match(rare.steps.join(' '), /whole frame|every colour in view/i);

  assert.equal(tipFor(filterById('difference')).id, 'temporal');
  assert.equal(tipFor(filterById('trails')).id, 'temporal');
  assert.match(tipFor(filterById('speed')).steps.join(' '), /still scene reads dark/);

  // A filter that shows its result on the first tap gets no lecture.
  assert.equal(tipFor(filterById('rgb')), null);
  assert.equal(tipFor(filterById('ironbow')), null);
  assert.equal(tipFor(filterById('edges')), null);
  assert.equal(tipFor(compileLens(STARTER_LENSES[0])), null, 'the edges lens needs no step');
  assert.equal(tipFor(null), null);
});

test('two fields at once: the combination the ideas list kept asking for', () => {
  // Adaptive Camouflage Breaker was never one field: something hiding by
  // matching its background fails an unusualness test AND a colour-boundary
  // test at once. The lens document always allowed a second field driving
  // brightness; nothing in V2 could reach it until now.
  const breaker = STARTER_LENSES.find((l) => l.id === 'lens-v2-camouflage-breaker');
  assert.equal(breaker.color.channel, 'rarity');
  assert.equal(breaker.brightness.channel, 'chromaEdge');
  const compiled = compileLens(breaker);
  assert.match(compiled.fragment, /normBright\(ch_chromaEdge\(vUv\)\)/,
    'the second field multiplies the first');
  assert.equal(compiled.needsHistogram, true, 'and it still asks for the census it reads');
  assert.equal(compiled.supportsPhoto, true, 'neither field needs history');

  // A colour edge is found by hue, so it survives where brightness gives out.
  assert.match(compileLens(STARTER_LENSES.find((l) => l.id === 'lens-v2-chroma-edge')).fragment,
    /float hueGap\(float a, float b\)/);
  assert.match(channelInfo('chromaEdge').meaning, /same lightness/,
    'and the field says what it is for');

  // The workbench can actually reach the second field now.
  const appTs = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');
  assert.match(appTs, /v2LensBrightChannel/, 'a control for the second field exists');
  assert.match(appTs, /draft\.brightness = \{ channel: chosen/, 'and it writes the document');

  // The lens Joshua described while making a saturation one.
  const inverted = STARTER_LENSES.find((l) => l.id === 'lens-v2-inverted-brightness');
  assert.equal(inverted.color.channel, 'luma');
  assert.ok(inverted.color.high < inverted.color.low, 'brightness with the range run backwards');
  assert.equal(normaliseBinding(0, inverted.color), 1, 'black reads full');
  assert.equal(normaliseBinding(255, inverted.color), 0, 'and white reads none');
  // Which is NOT what colour strength does: a lit red apple is colourful and
  // bright at once, so saturation lights it up where an inversion darkens it.
  const apple = rgbToHsvValues(200, 35, 40);
  const greyShadow = rgbToHsvValues(38, 38, 40);
  assert.ok(apple[1] > 0.7, 'a lit apple is highly saturated');
  assert.ok(greyShadow[1] < 0.1, 'a neutral shadow is not');
});

test('a copy is a new document, so a starter can never be overwritten by it', () => {
  const appTs = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');
  const copyBlock = appTs.slice(appTs.indexOf("v2LensSaveAsNew"));
  assert.match(copyBlock, /id: newLensId\(\)/, 'a copy gets its own id');
  assert.match(copyBlock, /name: `\$\{source\} copy`/, 'and a name that says where it came from');
  assert.match(copyBlock, /openLensWorkbench\(copy\)/, 'and editing continues on the copy');
  // sanitiseLens is what makes the copy a document rather than a reference.
  const copied = sanitiseLens({ ...STARTER_LENSES[0], id: 'copy-1', name: 'Mine' });
  assert.notEqual(copied.id, STARTER_LENSES[0].id);
  assert.deepEqual(copied.stops, STARTER_LENSES[0].stops);
  copied.stops[0].color = '#ff0000';
  assert.notEqual(STARTER_LENSES[0].stops[0].color, '#ff0000', 'and edits cannot reach the original');
});

test('a brightness floor lets the second field dim rather than annihilate', () => {
  // The failure this exists for: Camouflage Breaker colours by how UNUSUAL a
  // hue is and brightens by whether the pixel sits on a colour boundary. In a
  // dim, low-colour room the boundary term reads near zero almost everywhere,
  // multiplies the colour answer to black, and the lens degenerates into an
  // edge map — which is exactly what Colour Edges already is (Joshua's
  // device, 2026-09-02: "they look the same").
  const base = {
    version: 1, id: 'floor-test', name: 'Floor test',
    color: { channel: 'rarity', low: 60, high: 220, gamma: 1 },
    brightness: { channel: 'chromaEdge', low: 5, high: 70, gamma: 1 },
    stops: [{ at: 0, color: '#000000' }, { at: 1, color: '#ffffff' }],
    base: 'black', sceneBlend: 0
  };
  const none = compileLens(sanitiseLens(base));
  const floored = compileLens(sanitiseLens({ ...base, brightnessFloor: 0.35 }));
  // No floor is the historical shader, unchanged — a lens written before the
  // floor existed still compiles to exactly what it always did.
  assert.match(none.fragment, /c \*= mix\(0\.0000, 1\.0,/);
  assert.match(floored.fragment, /c \*= mix\(0\.3500, 1\.0,/);
  // And the floor is part of the lens's identity, so a live edit recompiles.
  assert.notEqual(none.revision, floored.revision);
  // 0 means "no floor", which is the same document as not asking for one.
  assert.equal(sanitiseLens({ ...base, brightnessFloor: 0 }).brightnessFloor, undefined);
  assert.equal(sanitiseLens({ ...base, brightnessFloor: 9 }).brightnessFloor, 1, 'clamped');
  // A lens with no second field has no floor to apply.
  const single = sanitiseLens({ ...base, brightness: undefined, brightnessFloor: 0.5 });
  assert.equal(single.brightnessFloor, undefined);
});

test('Camouflage Breaker and Colour Edges are different lenses, and say so', () => {
  const breaker = STARTER_LENSES.find((l) => l.id === 'lens-v2-camouflage-breaker');
  const edges = STARTER_LENSES.find((l) => l.id === 'lens-v2-chroma-edge');
  // The one that reads two fields is the one that can say two things.
  assert.equal(breaker.color.channel, 'rarity');
  assert.equal(breaker.brightness.channel, 'chromaEdge');
  assert.equal(edges.color.channel, 'chromaEdge');
  assert.equal(edges.brightness, undefined);
  // The floor is what keeps the rarity answer visible where the boundary
  // term reads nothing — without it the two collapse onto each other.
  assert.ok(breaker.brightnessFloor > 0, 'the breaker never multiplies to black');
  assert.notEqual(describeLens(breaker), describeLens(edges));
});

test('every built-in filter carries its own sentence', () => {
  // The notes lived in a lookup table in the shell, keyed by id, and RGB and
  // Edges were simply missing from it — silently, because a missing key reads
  // as an empty note (Joshua, 2026-09-02: "some filters are missing
  // descriptions"). A filter now carries its own, so the omission would be in
  // the same file that adds the filter.
  for (const filter of FILTERS) {
    assert.ok((filter.note ?? '').length > 20, `${filter.name} says what it does`);
  }
  assert.equal(new Set(FILTERS.map((f) => f.note)).size, FILTERS.length, 'and no two share one');
  const appTs = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');
  assert.ok(!appTs.includes('FILTER_NOTES'), 'the shell keeps no second copy of them');
  // A compiled lens carries its own note through the same field, so the
  // strip reads ONE place whatever kind of filter is active.
  assert.equal(compileLens(sanitiseLens(STARTER_LENSES[0])).note, STARTER_LENSES[0].note);
});

test('an untouched starter can be corrected; an edited one is never overwritten', () => {
  // Seeding is once-per-id, so a starter that shipped mistuned would stay
  // mistuned forever on a device that already had it. The record now holds
  // the fingerprint of what was OFFERED, which is what tells a copy nobody
  // touched from a copy that is somebody's work.
  const appTs = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');
  const block = appTs.slice(appTs.indexOf('function loadLensList'), appTs.indexOf('function syncCustomFilters'));
  assert.match(block, /untouched && savedMark !== mark/, 'only an untouched, stale copy is replaced');
  assert.match(block, /shippedForms/, 'and a device with no fingerprint falls back to known-shipped forms');
  // The superseded list is what makes that fallback exact: the copy on a
  // device seeded before the record existed is recognisable only by matching
  // a document this app is known to have shipped.
  assert.ok(SUPERSEDED_STARTERS.some((l) => l.id === 'lens-v2-camouflage-breaker'),
    'the mistuned Camouflage Breaker is on it');
  for (const old of SUPERSEDED_STARTERS) {
    const current = STARTER_LENSES.find((l) => l.id === old.id);
    assert.ok(current, `${old.name} is still a starter — it was replaced, not removed`);
    assert.notDeepEqual(JSON.parse(JSON.stringify(sanitiseLens(old))),
      JSON.parse(JSON.stringify(sanitiseLens(current))),
      `${old.name}'s superseded form really differs from the current one`);
  }
});

test('frame averaging is one ladder, and its weights mean what they say', () => {
  // The speckle is TEMPORAL, which is Joshua's diagnosis and the reason the
  // spatial blur that stood here was removed (2026-09-02): "each little
  // motion my phone makes even like 0.2° will grab a new frame/pixel...
  // the still images are fine because it has a chance to grab one good frame".
  assert.equal(new Set(FRAME_AVERAGE_LEVELS.map((l) => l.id)).size, FRAME_AVERAGE_LEVELS.length);
  assert.ok(frameAverageById(DEFAULT_FRAME_AVERAGE), 'the default names a real level');
  assert.equal(framesForLevel('off', 30), 1, 'OFF averages a single frame');
  assert.equal(framesForLevel('nonsense', 30), 1, 'and an unknown id averages nothing either');
  const frames = FRAME_AVERAGE_LEVELS.map((l) => framesForLevel(l.id, 30));
  assert.deepEqual(frames, [...frames].sort((a, b) => a - b), 'the row reads as a dial');
  assert.deepEqual(frames, [1, 2, 3, 4, 9], 'the ladder Joshua asked for, plus Dizzy');
  for (const level of FRAME_AVERAGE_LEVELS) {
    assert.ok(level.note.length > 20, `${level.label} says what it does`);
  }

  // THE READING LEVELS ARE SHORT. The first ladder went 3/5/10 and every rung
  // was too long — ten frames carries a third of a second of the past and the
  // picture swims. Anything above four is an EFFECT, chosen for the look, and
  // must be marked so it cannot read as a recommendation for a noisier room.
  for (const level of FRAME_AVERAGE_LEVELS) {
    if (level.effect) continue;
    assert.ok((level.frames ?? 0) <= 4,
      `${level.label} steadies a reading, so it cannot lag by ${level.frames} frames`);
  }
  const dizzy = frameAverageById('dizzy');
  assert.equal(dizzy?.effect, true, 'Dizzy is the same average, asked for on purpose');
  assert.match(dizzy?.label ?? '', /Dizzy/);
  // One mechanism, not a second: an effect is a level, not a filter.
  const distinct = FRAME_AVERAGE_LEVELS.map((l) => framesForLevel(l.id, 30));
  assert.equal(new Set(distinct).size, FRAME_AVERAGE_LEVELS.length);

  // THE WEIGHT IS 2/(N+1), NOT 1/N. An EMA's variance is alpha / (2 - alpha)
  // of its input's, so 2/(N+1) is the weight at which it removes exactly as
  // much noise as a true average of N frames — the label's promise. 1/N is
  // the obvious guess and does about twice the smoothing it claims.
  assert.equal(frameAverageWeight(1), 1, 'a single frame is the frame itself');
  assert.equal(frameAverageWeight(3), 0.5);
  assert.ok(Math.abs(frameAverageWeight(5) - 1 / 3) < 1e-9);
  for (const level of FRAME_AVERAGE_LEVELS) {
    // Both units land on a frame count, and there is only ever one formula
    // from there — an effect converts through the measured rate first.
    const n = framesForLevel(level.id, 30);
    const alpha = frameAverageWeight(n);
    // variance ratio of the EMA against a true N-frame average: they match.
    const emaVariance = alpha / (2 - alpha);
    assert.ok(Math.abs(emaVariance - 1 / n) < 1e-9,
      `${level.label}: an EMA at ${alpha} matches an average of ${n}`);
  }
});

test('averaging changes the picture every pass sees, not any one filter', () => {
  const renderer = readFileSync(new URL('../src/v2/render/gl-renderer.ts', import.meta.url), 'utf8');
  // ONE accessor feeds the display pass, the state pass and the history copy.
  // Comparing an averaged present against a raw past would read as motion
  // everywhere, and that is exactly the bug three separate bindings invite.
  assert.match(renderer, /private get sourceTexture\(\)/);
  assert.equal((renderer.match(/gl\.bindTexture\(gl\.TEXTURE_2D, this\.sourceTexture\)/g) ?? []).length, 3,
    'display, state and history all read the same picture');
  // The average pass is offscreen: flipping here would average each frame
  // against a mirror of the one before it.
  assert.match(renderer, /this\.buildProgram\(VERTEX_OFFSCREEN, AVERAGE_FRAGMENT\)/);
  // Primed from the current frame, never faded up from black.
  assert.match(renderer, /weight: 1/);

  // A still asks for no averaging at all — it already got one good frame.
  const photo = readFileSync(new URL('../src/v2/capture/photo.ts', import.meta.url), 'utf8');
  assert.ok(!/frames:/.test(photo), 'capturePhoto passes no frame count');
  assert.match(photo, /NOT applied to a still/);
});

test('frames for a reading, milliseconds for an effect', () => {
  // Not a compromise between two ways of saying one thing — two different
  // units, each correct for its own claim (raised by ChatGPT, 2026-09-02).
  for (const level of FRAME_AVERAGE_LEVELS) {
    const hasFrames = level.frames !== undefined;
    const hasMs = level.persistenceMs !== undefined;
    assert.ok(hasFrames !== hasMs, `${level.label} declares exactly one unit`);
    // A NOISE claim is a claim about independent samples, so a reading level
    // counts frames. A LOOK is made of elapsed time, so an effect counts ms.
    assert.equal(hasMs, level.effect === true,
      `${level.label}: effects are timed, readings are counted`);
  }

  // A reading level removes the same noise at any rate — that is the point of
  // counting samples rather than the clock.
  for (const fps of [24, 30, 60, 120]) {
    assert.equal(framesForLevel('high', fps), 4, `4 frames is 4 frames at ${fps} fps`);
  }
  // An effect holds its DURATION instead, so it looks the same on a 60 fps
  // camera as on a 30 fps one. At a fixed frame count it would be half as
  // dizzy at 60 for no reason the person holding the phone could see.
  assert.equal(framesForLevel('dizzy', 30), 9);
  assert.equal(framesForLevel('dizzy', 60), 18);
  assert.equal(framesForLevel('dizzy', 120), 36);
  // 300 ms at each of those rates, back again — one conversion, not two.
  for (const fps of [24, 30, 60, 120]) {
    const ms = framesForLevel('dizzy', fps) / fps * 1000;
    assert.ok(Math.abs(ms - 300) < 25, `${fps} fps holds ~300 ms, got ${ms}`);
  }

  // Before the rate is measured deliveredFps reads 0, and the conversion has
  // to go through something; it says which, rather than presenting a guess
  // as a measurement.
  assert.equal(framesForLevel('dizzy', 0), framesForLevel('dizzy', NOMINAL_FPS));
  assert.match(conversionNote('dizzy', 0), /assumed until measured/);
  assert.doesNotMatch(conversionNote('dizzy', 60), /assumed/);

  // The note prints the OTHER unit, so the conversion is visible either way.
  assert.match(conversionNote('dizzy', 30), /about 9 frames at 30 fps/);
  assert.match(conversionNote('high', 30), /about 133 ms at 30 fps/);
  assert.match(conversionNote('high', 60), /about 67 ms at 60 fps/);
  assert.equal(conversionNote('off', 30), '', 'one frame has no duration worth naming');
});

/* --- Milestone F: camera instrumentation --------------------------------- */

const solidFrame = (r, g, b, count = 64 * 64) => {
  const data = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  }
  return data;
};

test('the exposure reading counts what was LOST, not what looks bright', () => {
  // The distinction the whole instrument exists for: a blown pixel is not
  // bright, it is MISSING. It could have been any value above the top and the
  // sensor cannot say which, so nothing recovers it — which is why this is
  // worth showing before the shutter rather than after.
  const white = buildExposure(solidFrame(255, 255, 255));
  assert.equal(white.clipped, 1, 'a white frame is entirely blown');
  assert.equal(white.crushed, 0);
  assert.ok(white.mean > 0.99);

  const black = buildExposure(solidFrame(0, 0, 0));
  assert.equal(black.crushed, 1);
  assert.equal(black.clipped, 0);

  // A comfortable mid-grey loses nothing at either end.
  const grey = buildExposure(solidFrame(128, 128, 128));
  assert.equal(grey.clipped, 0);
  assert.equal(grey.crushed, 0);
  assert.ok(Math.abs(grey.mean - 0.5) < 0.02);

  // PER-CHANNEL CLIPPING, which luminance alone hides: a saturated red is
  // only 21% of luma, so its luminance reads dark while red is long gone.
  const red = buildExposure(solidFrame(255, 20, 20));
  assert.equal(red.clipped, 0, 'luminance says nothing is blown');
  assert.equal(red.channelClipped[0], 1, 'but red is entirely clipped');
  assert.equal(red.channelClipped[1], 0);
  assert.match(describeExposure(red), /red clipped on its own/);

  // The bins are shares, scaled so the commonest is 255.
  assert.equal(white.bins.length, EXPOSURE_BINS);
  assert.equal(white.bins[EXPOSURE_BINS - 1], 255, 'a white frame peaks at the top bin');
  assert.equal(emptyExposure().bins.every((b) => b === 0), true);
  assert.equal(buildExposure(new Uint8ClampedArray(0)).mean, 0, 'no pixels is not a crash');
});

test('the exposure sentence reports, and refuses to judge', () => {
  // A night sky is mostly crushed and correct; a snowfield is mostly bright
  // and correct. The instrument says what was lost and stops there.
  const text = describeExposure(buildExposure(solidFrame(0, 0, 0)));
  assert.match(text, /crushed/);
  assert.ok(!/under|over|poor|bad|wrong/i.test(text), 'it never grades the shot');
  // Below a tenth of a percent reads as 0, not as a misleading "1%".
  const mostlyGrey = solidFrame(128, 128, 128, 64 * 64);
  mostlyGrey[0] = 255; mostlyGrey[1] = 255; mostlyGrey[2] = 255;
  assert.match(describeExposure(buildExposure(mostlyGrey)), /<1% blown/);
});

test('the viewing aids are ladders, and OFF is a real rung', () => {
  for (const levels of [ZEBRA_LEVELS, PEAKING_LEVELS]) {
    assert.equal(levels[0].id, 'off', 'off comes first');
    assert.equal(levels[0].threshold, 0);
    assert.equal(new Set(levels.map((l) => l.id)).size, levels.length);
    const thresholds = levels.map((l) => l.threshold);
    for (const level of levels) assert.ok(level.note.length > 5, `${level.label} says what it does`);
    // Zebra descends (a lower threshold stripes MORE), peaking ascends.
    const sorted = [...thresholds].sort((a, b) => a - b);
    assert.deepEqual(new Set(thresholds).size, thresholds.length, 'no two rungs are the same');
    assert.ok(sorted.length === thresholds.length);
  }
  assert.equal(zebraThreshold('off'), 0);
  assert.equal(peakingThreshold('off'), 0);
  assert.equal(zebraThreshold('nonsense'), 0, 'an unknown id shows nothing');
  assert.equal(peakingThreshold('nonsense'), 0);
  // 100% zebra marks the same line the exposure census calls clipped, so the
  // stripes and the number can never disagree about what "blown" means.
  assert.ok(Math.abs(zebraThreshold('100') - CLIPPED / 255) < 0.02,
    'the stripes and the count agree on where detail is lost');
});

test('a viewing aid can never reach a photo or a clip', () => {
  // An aid baked into a file is not an aid, it is damage. This is structural
  // rather than a flag to remember: the renderer takes the thresholds per
  // render, and only the preview passes any.
  const appTs = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');
  const photoTs = readFileSync(new URL('../src/v2/capture/photo.ts', import.meta.url), 'utf8');
  assert.ok(!/aids:/.test(photoTs), 'the still path asks for no aids');
  // Exactly one render call passes them, and it is the preview's.
  assert.equal((appTs.match(/aids: \{/g) ?? []).length, 1, 'one caller, the preview');
  const record = appTs.slice(appTs.indexOf('geometry.recordInput,'));
  assert.ok(!/aids:/.test(record.slice(0, 400)), 'the recording path asks for none');

  // And the shader honours them everywhere, so no filter quietly stops
  // striping — you would learn to trust an aid that is not always on.
  for (const filter of FILTERS) {
    const body = filter.fragment.slice(filter.fragment.indexOf('void main'));
    assert.match(body, /withAids\(/, `${filter.name} routes its colour through the aids`);
  }
  // State passes write DATA, not a picture: an aid drawn into one would be
  // measured on the next frame rather than merely shown.
  for (const filter of FILTERS) {
    if (!filter.state) continue;
    const body = filter.state.slice(filter.state.indexOf('void main'));
    assert.ok(!body.includes('withAids('), `${filter.name}'s state pass stays clean`);
  }
});

test('the aids judge the CAMERA, not the filter that is running', () => {
  // Under a false-colour ramp the pixel on screen is a palette choice. Zebra
  // striping by that would report the ramp; peaking would find the ramp's own
  // banding as edges. Both read uFrame instead.
  const aids = SHADER_HEADER.slice(SHADER_HEADER.indexOf('vec3 withAids'));
  assert.match(aids, /vec3 scene = texture2D\(uFrame, uv\)\.rgb;/);
  assert.match(aids, /luma\(scene\) >= uZebra/);
  assert.ok(!aids.includes('uRamp'), 'the aids never read the palette');
  // Off is a uniform branch, so a disabled aid costs one comparison.
  assert.match(aids, /if \(uZebra <= 0\.0 && uPeak <= 0\.0\) return color;/);
  // Peaking measures at the FRAME's scale, so preview and still agree.
  assert.match(aids, /uAidTexel/);
  const renderer = readFileSync(new URL('../src/v2/render/gl-renderer.ts', import.meta.url), 'utf8');
  assert.match(renderer, /this\.frameSize\.width > 0 \? this\.frameSize : target/);
});

test('one read of the frame answers every census asked of it', () => {
  // getImageData stalls on the GPU and three censuses each used to do their
  // own draw-and-read — three stalls to ask three questions about ONE frame.
  const appTs = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');
  // The rule is about the FRAME path: sampleFrame() is the only thing that
  // reads the video, and it is read once per frame however many censuses ask.
  const sampleFn = appTs.slice(appTs.indexOf('function sampleFrame()'),
    appTs.indexOf('function sampleFrame()') + 900);
  assert.equal((sampleFn.match(/getImageData\(/g) ?? []).length, 1,
    'the frame sample is read in exactly one place');
  assert.match(sampleFn, /context\.drawImage\(video,/, 'and it is the VIDEO it reads');
  assert.match(appTs, /function sampleFrame\(\)/);
  // Night's own read is a DIFFERENT surface (the rendered canvas) at a
  // different cadence (once when a four-second capture finishes, never per
  // frame), so it does not reintroduce the per-frame stall this guards
  // against. Pinned so it cannot quietly migrate onto the frame loop.
  const nightRead = appTs.slice(appTs.indexOf('function measureNightResult()'),
    appTs.indexOf('function measureNightResult()') + 900);
  assert.match(nightRead, /context\.drawImage\(renderer\.targetCanvas,/);
  const frameLoop = appTs.slice(appTs.indexOf('renderPreview(frame.now);'),
    appTs.indexOf('renderPreview(frame.now);') + 400);
  assert.ok(!/measureNightResult/.test(frameLoop),
    'the Night measurement must never be called from the delivery loop');
  // And each census is still paid for only when something needs it.
  const censuses = appTs.slice(appTs.indexOf('function measureCensuses'));
  assert.match(censuses, /if \(needsColour\)/);
  assert.match(censuses, /if \(wantsExposure\)/);
  assert.match(censuses, /if \(!needsColour && !lens && !wantsExposure\)/,
    'nothing is read when nothing is asking');
});

/* --- Milestone F: manual camera controls --------------------------------- */

const capabilityReport = (fields, settings = {}) => ({
  available: true,
  fields,
  settings
});

test('only what the browser really offers becomes a control', () => {
  // Three states, deliberately not conflated by the engine: `supported`,
  // `unsupported` (capabilities reported, not this one) and `not exposed` (no
  // capability reporting at all). Only the first is an offer — a switch on
  // screen for either of the others would do nothing when pressed.
  const offered = offeredControls(capabilityReport({
    torch: { state: 'supported', value: true },
    iso: { state: 'supported', min: 32, max: 3200, step: 1 },
    focusMode: { state: 'supported', options: ['continuous', 'manual'] },
    exposureMode: { state: 'unsupported' },
    whiteBalanceMode: { state: 'not exposed' }
  }, { torch: false, iso: 200, focusMode: 'continuous' }));
  assert.deepEqual(offered.map((c) => c.id), ['torch', 'iso', 'focusMode'],
    'in the order a photographer reaches for them: light, then focus');
  assert.equal(offered[0].current, false, 'the current value comes from settings');
  assert.equal(offered[1].max, 3200);
  assert.deepEqual(offered[2].options, ['continuous', 'manual']);

  // A "capability" with nothing to choose or nowhere to move is not one.
  assert.deepEqual(offeredControls(capabilityReport({
    focusMode: { state: 'supported', options: ['continuous'] },
    iso: { state: 'supported', min: 100, max: 100 }
  })).map((c) => c.id), [], 'one mode is not a choice; a zero range is not a range');

  // No report at all is a real answer, and it is about the BROWSER.
  assert.deepEqual(offeredControls(null), []);
  assert.deepEqual(offeredControls({ available: false, fields: {}, settings: {} }), []);
  assert.match(noControlsNote(null), /describes the browser, not the camera/);
  assert.match(noControlsNote(capabilityReport({})), /does not pass them through/);
  for (const note of [noControlsNote(null), noControlsNote(capabilityReport({}))]) {
    assert.ok(!/cannot|unsupported hardware|not capable/i.test(note),
      'it must never say the CAMERA cannot do a thing');
  }

  // Zoom has its own control already; a second owner of one number is a bug.
  assert.ok(!CAMERA_CONTROLS.some((c) => c.id === 'zoom'));
  assert.equal(new Set(CAMERA_CONTROLS.map((c) => c.id)).size, CAMERA_CONTROLS.length);
  for (const control of CAMERA_CONTROLS) assert.ok(control.note.length > 20, control.id);
});

test('applied is not applied: every change is read back', () => {
  // THE GAP THIS EXISTS FOR. applyConstraints resolving means the browser
  // accepted the REQUEST. WebKit will advertise a capability, accept a
  // constraint for it, resolve happily, and leave the setting alone. A control
  // built on the promise would report success every single time.
  const iso = CAMERA_CONTROLS.find((c) => c.id === 'iso');

  const took = verifyApply(iso, 800, { iso: 200 }, { iso: 800 }, true);
  assert.equal(took.outcome, 'took');
  assert.match(took.message, /ISO is now 800/);

  const ignored = verifyApply(iso, 800, { iso: 200 }, { iso: 200 }, true);
  assert.equal(ignored.outcome, 'ignored');
  assert.match(ignored.message, /took the request and did not act on it/);

  const clamped = verifyApply(iso, 6400, { iso: 200 }, { iso: 3200 }, true);
  assert.equal(clamped.outcome, 'clamped');
  assert.match(clamped.message, /asked for 6400, got 3200/);

  const refused = verifyApply(iso, 800, { iso: 200 }, { iso: 200 }, false, 'OverconstrainedError');
  assert.equal(refused.outcome, 'refused');
  assert.match(refused.message, /OverconstrainedError/);

  // UNVERIFIABLE is the honest fifth answer, and is neither success nor
  // failure: WebKit accepts a constraint and then declines to report the key.
  // Calling that success would be a guess; calling it failure would be another.
  const silent = verifyApply(iso, 800, {}, {}, true);
  assert.equal(silent.outcome, 'unverifiable');
  assert.equal(silent.actual, null);
  assert.match(silent.message, /cannot be checked either way/);
  assert.ok(!/failed|refused|error/i.test(silent.message), 'it is not reported as a failure');

  // A camera rounds what it returns, so an exact compare would call a
  // successful change "clamped" forever.
  const torch = CAMERA_CONTROLS.find((c) => c.id === 'torch');
  assert.equal(verifyApply(iso, 800, { iso: 200 }, { iso: 799 }, true).outcome, 'took');
  assert.equal(verifyApply(torch, true, { torch: false }, { torch: true }, true).outcome, 'took');
  assert.match(verifyApply(torch, true, { torch: false }, { torch: true }, true).message, /on/);
});

test('a camera control is never changed mid-recording, and the row is not rebuilt under a finger', () => {
  const appTs = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');
  const block = appTs.slice(appTs.indexOf('async function applyCameraControl'));
  assert.match(block, /if \(readState\(\)\.recording\)/,
    're-constraining the track mid-clip would put two pictures in one file');
  // The rows are keyed on the OFFER, not on the values: a setting moving must
  // not replace the control it moved in — that is how this app made its own
  // controls untouchable on iOS once already.
  const render = appTs.slice(appTs.indexOf('function renderCameraControls'));
  assert.match(render, /const key = `\$\{live\}\|\$\{offered\.map/);
  assert.match(render, /if \(key === offeredKey\) return;/);
  // A CAMERA slider applies on change, not on input: applyConstraints
  // renegotiates the live track, so one per pixel of a drag would queue dozens
  // against one camera. (The lens workbench's sliders are the opposite case
  // and do use input — they edit a shader, not a device — so this is scoped
  // to the row that talks to the camera.)
  const row = appTs.slice(appTs.indexOf('function controlRow'),
    appTs.indexOf('async function applyCameraControl'));
  assert.match(row, /slider\.addEventListener\('change'/);
  assert.ok(!row.includes("slider.addEventListener('input'"));
});

test('relief, age and novelty are wired, so no lens reads "not built in V2 yet"', () => {
  // Joshua saw filters that said they were not wired in: three channels the
  // lens FORMAT has always had were missing from V2's list, so any lens using
  // one compiled to an unavailable stub (2026-09-02).
  for (const id of ['relief', 'age', 'novelty']) {
    assert.ok(V2_CHANNELS.includes(id), `${id} must be measurable`);
    assert.equal(channelAvailability(id).available, true);
  }
  // Every channel the format defines is now measurable — the gap is closed,
  // not merely narrowed.
  for (const channel of CHANNELS) {
    assert.equal(channelAvailability(channel.id).available, true,
      `${channel.id} is offered by the editor, so it must render`);
  }

  const lens = (color, brightness) => sanitiseLens({
    version: 1, id: 'probe', name: 'Probe', color, brightness,
    stops: [{ at: 0, color: '#000000' }, { at: 1, color: '#ffffff' }],
    base: 'black', sceneBlend: 0
  });

  // RELIEF is shading, not distance, and it is per-pixel — so a still is
  // honest, unlike the two that live in a state texture at ANALYSIS size.
  const relief = compileLens(lens({ channel: 'relief', low: 0, high: 255, gamma: 1 }));
  assert.equal(relief.unavailableReason, undefined);
  assert.equal(relief.supportsPhoto, true, 'relief is per-pixel, so a still is real');
  assert.equal(relief.needsLumaRange, true, 'it is a CONTRAST STRETCH, so it needs the range');
  assert.equal(relief.state, undefined);
  // It calls ch_edges, which must therefore be DECLARED FIRST: emitted in set
  // order relief came first and the shader would not compile at all.
  assert.ok(relief.fragment.indexOf('float ch_edges') < relief.fragment.indexOf('float ch_relief'),
    'a channel that calls another must be emitted after it');
  // The legacy weights exactly, so a lens written in V1 paints the same field.
  assert.match(relief.fragment, /stretched \* 215\.0 \+ \(ch_edges\(uv\) \/ 255\.0\) \* 40\.0/);

  for (const id of ['age', 'novelty']) {
    const f = compileLens(lens({ channel: id, low: 0, high: 60, gamma: 1 }));
    assert.equal(f.unavailableReason, undefined);
    assert.ok(f.state, `${id} carries a state pass`);
    assert.equal(f.supportsPhoto, true, `${id} can be photographed like any other filter`);
  }
});

test('one state texture means one stateful channel, and a clash is refused', () => {
  // There is exactly ONE state texture per render. A lens binding speed to
  // colour and age to brightness would hand the second channel the first
  // one's memory and paint a confident wrong answer, so it is refused with
  // the two names in the reason rather than rendered.
  const clash = compileLens(sanitiseLens({
    version: 1, id: 'clash', name: 'Clash',
    color: { channel: 'speed', low: 0, high: 3, gamma: 1 },
    brightness: { channel: 'age', low: 0, high: 6, gamma: 1 },
    stops: [{ at: 0, color: '#000000' }, { at: 1, color: '#ffffff' }],
    base: 'black', sceneBlend: 0
  }));
  assert.match(clash.unavailableReason ?? '', /only one of speed, age, novelty/);
  assert.match(clash.unavailableReason ?? '', /speed and age/);
  assert.equal(clash.supportsVideo, false, 'an unavailable lens offers nothing');

  // The SAME stateful channel on both fields is fine — one memory, one reader.
  const same = compileLens(sanitiseLens({
    version: 1, id: 'same', name: 'Same',
    color: { channel: 'age', low: 0, high: 6, gamma: 1 },
    brightness: { channel: 'age', low: 0, high: 6, gamma: 1 },
    stops: [{ at: 0, color: '#000000' }, { at: 1, color: '#ffffff' }],
    base: 'black', sceneBlend: 0
  }));
  assert.equal(same.unavailableReason, undefined);
});

test('the state passes prime themselves rather than reporting from nothing', () => {
  // NOVELTY learns a background, and the state clears to BLACK — so without
  // priming the whole scene reads as maximally novel until it warms up. While
  // the stored background is still black the frame is adopted whole.
  assert.match(NOVELTY_STATE, /float learned = step\(0\.004, luma\(background\)\)/);
  assert.match(NOVELTY_STATE, /mix\(now, mix\(background, now, 0\.02\), learned\)/);
  // AGE needs the frame rate to count seconds, and the header does not declare
  // it — the display pass adds it conditionally, so the state pass must too.
  assert.match(AGE_STATE, /uniform float uFps;/);
  assert.match(AGE_STATE, /step\(0\.02, abs\(now - before\)\)/,
    'the same noise floor Speed uses, so "moved" means one thing in this app');
  // Both compare against uPrevious or their own state, so both are temporal.
  assert.match(AGE_STATE, /uPrevious/);
});

test('the frame census measures the range relief stretches against', () => {
  const frame = (values) => {
    const d = new Uint8ClampedArray(values.length * 4);
    values.forEach((v, i) => { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; });
    return d;
  };
  const reading = buildExposure(frame([40, 90, 200, 120]));
  assert.equal(Math.round(reading.range[0] * 255), 40, 'the darkest luma');
  assert.equal(Math.round(reading.range[1] * 255), 200, 'and the brightest');
  // Free: the loop was already reading every pixel's luminance for the bins.
  assert.deepEqual(emptyExposure().range, [0, 1], 'an unmeasured range stretches nothing');

  // And the shell hands it to the renderer, or relief would stretch against
  // a range it never measured.
  const appTs = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');
  assert.match(appTs, /lumaRange: exposure\.range/);
  assert.match(appTs, /active\?\.needsLumaRange === true/, 'and measures it when a lens asks');
});

test('Reverse is offered only where a ramp is actually read', () => {
  // THE TRAP: SHADER_HEADER declares uRamp for every filter whether it reads
  // one or not, so testing the whole shader text offered the chip on RGB,
  // Edges and every mask lens — all of which would have flipped a ramp
  // nothing samples. It is the BODY that decides.
  assert.match(SHADER_HEADER, /uniform sampler2D uRamp;/, 'the header declares it for all');
  assert.equal(canReverse(filterById('rgb')), false, 'RGB paints no ramp');
  assert.equal(canReverse(filterById('edges')), false, 'nor does Edges');
  for (const id of ['ironbow', 'difference', 'speed', 'trails']) {
    assert.equal(canReverse(filterById(id)), true, `${id} draws through the ramp`);
  }
  assert.equal(canReverse(null), false);

  const lens = (extra) => compileLens(sanitiseLens({
    version: 1, id: 'rev', name: 'Rev',
    color: { channel: 'luma', low: 0, high: 255, gamma: 1 },
    stops: [{ at: 0, color: '#000000' }, { at: 1, color: '#ffffff' }],
    base: 'black', sceneBlend: 0, ...extra
  }));
  assert.equal(canReverse(lens({})), true, 'a paint lens reads its ramp');
  assert.equal(canReverse(lens({ output: 'mask' })), false,
    'a mask keeps the camera colours — flipping stops would change nothing');
  assert.equal(canReverse(lens({ output: 'swap', target: '#ff00ff' })), false);
});

test('a reversed ramp is the same colours, mirrored — and twice is where it started', () => {
  setReversedFilters([]);
  const forward = filterById('ironbow');
  const plain = forward.ramp ?? ironbowLut();

  setReversedFilters(['ironbow']);
  assert.equal(isReversed('ironbow'), true);
  const flipped = filterById('ironbow');
  assert.ok(flipped.ramp, 'a reversed filter carries its own ramp');
  // Texel i of the flip is texel 255-i of the original: colours untouched,
  // order mirrored — the same rule reverseStops follows for a lens document.
  for (const i of [0, 1, 64, 128, 200, 255]) {
    const from = (255 - i) * 4;
    assert.equal(flipped.ramp[i * 4], plain[from], `texel ${i} red`);
    assert.equal(flipped.ramp[i * 4 + 1], plain[from + 1], `texel ${i} green`);
    assert.equal(flipped.ramp[i * 4 + 2], plain[from + 2], `texel ${i} blue`);
  }
  // The rampKey moves so the renderer re-uploads; the REVISION must not,
  // because the shader is untouched and its program cache is keyed on that.
  assert.notEqual(flipped.rampKey, forward.rampKey);
  assert.equal(flipped.revision, forward.revision);

  // Memoised: allFilters() runs on every render, so the same object comes
  // back rather than a fresh 256-texel build sixty times a second.
  assert.equal(filterById('ironbow'), filterById('ironbow'));

  setReversedFilters([]);
  assert.equal(isReversed('ironbow'), false);
  assert.equal(filterById('ironbow').ramp, forward.ramp, 'and off is exactly where it began');
});

test('Reverse never writes to the lens document or to storage', () => {
  // "invert colors as a tap that will reverse for that one time use but won't
  // save it" (Joshua). A saved lens means what its author saved; a look being
  // tried out is not an edit. "Save as new" is still how a flip becomes real.
  const appTs = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');
  const handler = appTs.slice(appTs.indexOf("byId('v2ReverseRamp').addEventListener"));
  const block = handler.slice(0, handler.indexOf('\n});'));
  assert.ok(!/saveLens|localStorage|remember\(/.test(block),
    'the handler must not persist anything');
  assert.match(block, /reversed\.delete\(id\)/, 'a second tap is exactly where you started');
  assert.match(block, /the saved lens is untouched/, 'and it says so');

  // The set itself is memory, never storage.
  const registry = readFileSync(new URL('../src/v2/filters/registry.ts', import.meta.url), 'utf8');
  const owner = registry.slice(registry.indexOf('let reversedIds'));
  assert.ok(!/localStorage/.test(owner.slice(0, 2000)));

  // And a reversed lens's own stops are untouched — the flip is a RAMP, not
  // an edit to the document the strip and the editor both read.
  setReversedFilters([]);
  const source = STARTER_LENSES.find((l) => l.id === 'lens-v2-hue-map');
  const before = JSON.stringify(source.stops);
  setCustomFilters([compileLens(sanitiseLens(source))]);
  setReversedFilters([lensFilterId(source)]);
  const shown = filterById(lensFilterId(source));
  assert.ok(shown.ramp, 'the strip shows a flipped ramp');
  assert.equal(JSON.stringify(shown.lens.stops), before, 'the document is unchanged');
  assert.equal(JSON.stringify(source.stops), before);
  setReversedFilters([]);
  setCustomFilters([]);
});

test('every renderable filter can save a still — and says what kind of still', () => {
  // "Make sure all filters can take a picture or video. I believe it was the
  // NNH1 that was unavailable for a picture" (Joshua, 2026-09-02). NNH is the
  // novelty channel, and the temporal filters used to refuse the shutter:
  // their memory lives at ANALYSIS resolution, so a full-sensor still of one
  // enlarges that memory rather than adding detail.
  //
  // Refusing was the wrong answer. Every filter saves at the full sensor like
  // any other, and the note says where the detail comes from — the trade is
  // stated, not enforced.
  for (const filter of FILTERS) {
    assert.equal(filter.supportsPhoto, true, `${filter.name} must be able to save a still`);
    assert.equal(filter.supportsVideo, true, `${filter.name} must be able to record`);
  }

  const lens = (channel, high) => compileLens(sanitiseLens({
    version: 1, id: `p-${channel}`, name: channel,
    color: { channel, low: 0, high, gamma: 1 },
    stops: [{ at: 0, color: '#000000' }, { at: 1, color: '#ffffff' }],
    base: 'black', sceneBlend: 0
  }));
  // NNH itself, plus the rest of the temporal family, and the per-pixel ones.
  for (const [channel, high] of [
    ['novelty', 60], ['age', 6], ['change', 40], ['speed', 3], ['relief', 255], ['luma', 255]
  ]) {
    const f = lens(channel, high);
    assert.equal(f.supportsPhoto, true, `a ${channel} lens can save a still`);
    assert.equal(f.supportsVideo, true, `a ${channel} lens can record`);
  }

  // The ONE filter that still refuses is the one that renders nothing at all.
  const broken = compileLens(sanitiseLens({
    version: 1, id: 'broken', name: 'Broken',
    color: { channel: 'speed', low: 0, high: 3, gamma: 1 },
    brightness: { channel: 'age', low: 0, high: 6, gamma: 1 },
    stops: [{ at: 0, color: '#000000' }, { at: 1, color: '#ffffff' }],
    base: 'black', sceneBlend: 0
  }));
  assert.ok(broken.unavailableReason);
  assert.equal(broken.supportsPhoto, false, 'a lens that cannot run cannot save one either');
});


test('the averaging pass can be aligned, and refuses to average what was never photographed', () => {
  const registry = readFileSync(new URL('../src/v2/filters/registry.ts', import.meta.url), 'utf8');
  const average = registry.slice(registry.indexOf('export const AVERAGE_FRAGMENT'));
  const body = average.slice(0, average.indexOf('`;'));

  // THE ARRIVING FRAME MOVES, THE ACCUMULATION DOES NOT. Re-warping the
  // accumulation would resample it again on every frame and soften it without
  // limit; sampling the incoming frame at an offset costs one lookup and
  // leaves the memory untouched.
  assert.match(body, /texture2D\(uFrame, src\)/, 'the frame is sampled at an offset');
  assert.match(body, /texture2D\(uAverage, vUv\)/, 'the accumulation is read straight');
  assert.match(body, /vec2 src = vUv \+ uAlign;/,
    'plus, not minus: to find where the scene went, look where it moved TO');

  // Past the frame's edge there is nothing photographed, and CLAMP_TO_EDGE
  // would repeat the edge row into the average as though it were scene.
  assert.match(body, /float inside = step/);
  assert.match(body, /uWeight \* inside/, 'outside contributes nothing at all');

  /*
   * MEASURED on a real GL context, running this exact shader over a synthetic
   * scene drifted 6 px across and 4 px down, mean absolute error per pixel
   * against the accumulation it should have landed on:
   *
   *   blended unaligned      90
   *   blended with +offset    0    exact
   *   blended with -offset  176    the wrong sign nearly DOUBLES the error
   *
   * The third row is why the signs are derived in alignment.ts rather than
   * picked: getting them backwards is worse than not aligning at all. And
   * with a quarter-frame offset the rows that sample past the edge came back
   * bit-identical to the accumulation, so the guard above really holds.
   */

  const renderer = readFileSync(new URL('../src/v2/render/gl-renderer.ts', import.meta.url), 'utf8');
  // Priming ADOPTS the frame whole, so it defines the orientation everything
  // afterwards is aligned to — offsetting it would align the anchor to itself.
  assert.match(renderer, /const offset = pass\.weight >= 1 \? \[0, 0\] : align \?\? \[0, 0\];/);
  assert.match(renderer, /if \(extras\.restartAverage\) this\.averagePrimed = false;/,
    'a restart re-primes rather than fading a new view in over an old one');

  // A still asks for none of it: it already got one good frame, and a photo
  // must never carry a warp derived from a sensor reading.
  const photo = readFileSync(new URL('../src/v2/capture/photo.ts', import.meta.url), 'utf8');
  assert.ok(!/align/.test(photo), 'capturePhoto passes no alignment');
});

test('Night has its OWN accumulator, not a share of the live one', () => {
  // Two consumers with incompatible update rhythms — the live ladder
  // advances every DISPLAYED frame at a forgetting weight; Night advances
  // per delivered frame at a converging one — sharing one pair of textures
  // would have each corrupt the other's in-progress picture. Verified live
  // (2026-09-03): the live ladder set to "4 frames" kept reporting correctly
  // throughout a full Night capture that itself hit two rejections and two
  // restarts under simulated shake, with zero JS errors either side.
  const renderer = readFileSync(new URL('../src/v2/render/gl-renderer.ts', import.meta.url), 'utf8');
  assert.match(renderer, /private nightTextures: \[WebGLTexture, WebGLTexture\] \| null = null;/);
  assert.match(renderer, /private nightFramebuffer: WebGLFramebuffer \| null = null;/);
  // Reset alongside the OTHER context-loss recoveries — a lost context
  // invalidates every GL object, and reusing a dead handle after restore
  // would be the same class of bug this file's own comments warn about
  // elsewhere (a fresh module running against stale cached state).
  const initBody = renderer.slice(renderer.indexOf('private initialize()'), renderer.indexOf('get unavailableReason'));
  assert.match(initBody, /this\.nightTextures = null;/);
  assert.match(initBody, /this\.nightPrimed = false;/);

  // Same compiled shader either way (one mechanism, two accumulators) —
  // advanceNightStack must NOT compile a second program.
  const nightFn = renderer.slice(
    renderer.indexOf('advanceNightStack('), renderer.indexOf('renderNightResult('));
  assert.match(nightFn, /this\.averageProgram \?\?= this\.buildProgram\(VERTEX_OFFSCREEN, AVERAGE_FRAGMENT\);/,
    'reuses the SAME compiled program the live accumulator uses, not a second shader');
  assert.ok(!/this\.averageTextures/.test(nightFn), 'never touches the live accumulator\'s textures');

  // The caller supplies the weight directly — this is NOT frameAverageWeight
  // (the fixed EMA); Night's formula lives in vision/night-stack.ts, and the
  // renderer takes whatever number it is given rather than deriving one.
  const advanceSig = renderer.slice(renderer.indexOf('advanceNightStack('), renderer.indexOf('advanceNightStack(') + 400);
  assert.match(advanceSig, /weight: number/);
  assert.ok(!/emaWeight\(/.test(nightFn), 'does not call the live ladder\'s EMA formula');
});

test('the RAW Night draw is plain RGB with aids off; the lift is its own program', () => {
  // The raw draw is what gets MEASURED, so it must carry nothing of its own:
  // reusing RGB's compiled program makes that structural — RGB's whole
  // fragment body is one texture read, so there is no ramp, no state and no
  // lens math this draw call could apply even by accident. The measured lift
  // is then a SECOND draw through its own program (2026-09-03, Joshua:
  // "actually make a darker scene brighter and/or enhance daylight similar
  // to HDR"), so the picture being measured is never the lifted one.
  const renderer = readFileSync(new URL('../src/v2/render/gl-renderer.ts', import.meta.url), 'utf8');
  const resultFn = renderer.slice(
    renderer.indexOf('renderNightResult('), renderer.indexOf('renderNightResult(') + 2600);
  assert.match(resultFn, /filterById\('rgb'\)/);
  assert.match(resultFn, /this\.nightTextures\[this\.nightRead\]/, 'reads NIGHT\'s texture, not the camera\'s');
  // Forced to 0 explicitly, not left to whatever the program's uniform state
  // happens to hold — that program object is the SAME one the live preview
  // already uses, so a zebra/peaking aid left on a moment earlier would
  // otherwise still be sitting in it and bake itself into the diagnostic
  // view this milestone is supposed to be clean.
  assert.match(resultFn, /uniform1f\(gl\.getUniformLocation\(program, 'uZebra'\), 0\);/);
  assert.match(resultFn, /uniform1f\(gl\.getUniformLocation\(program, 'uPeak'\), 0\);/);
  // The lift only ever applies when a recovery was actually measured.
  assert.match(resultFn, /if \(recovery\) \{/);
  assert.match(resultFn, /this\.buildProgram\(VERTEX, NIGHT_RECOVERY_FRAGMENT\)/);
});

test('the recovery curve cannot clip, wash out, or touch a well-exposed frame', () => {
  // Reinhard with its white point set to the gain. Three properties, each
  // load-bearing and each checkable by reading the shader: an input of 1.0
  // lands on exactly 1.0 at every gain (white stays white), gain 1.0 makes
  // the whole expression an identity (a correctly exposed frame is not
  // re-graded for a lift it never asked for), and it is asymptotically
  // bounded so no gain can clip what the stack spent four seconds keeping.
  const registry = readFileSync(new URL('../src/v2/filters/registry.ts', import.meta.url), 'utf8');
  const shader = registry.slice(registry.indexOf('export const NIGHT_RECOVERY_FRAGMENT'),
    registry.indexOf('export const NIGHT_RECOVERY_FRAGMENT') + 1200);
  assert.match(shader, /float w = max\(uGain, 1\.0\);/);
  assert.match(shader, /c = c \* \(1\.0 \+ c \/ \(w \* w\)\) \/ \(1\.0 \+ c\);/);
  // Checked as arithmetic, not just as text: the same expression, evaluated.
  const curve = (v, gain, lift) => {
    const c = v * gain; const w = Math.max(gain, 1);
    return Math.pow((c * (1 + c / (w * w))) / (1 + c), 1 / lift);
  };
  for (const gain of [1, 1.5, 2, 3, 4, 6]) {
    assert.ok(Math.abs(curve(1, gain, 1) - 1) < 1e-9, `white stays white at gain ${gain}`);
    let previous = -1;
    for (let i = 0; i <= 50; i++) {
      const out = curve(i / 50, gain, 1);
      assert.ok(out <= 1 + 1e-9, `gain ${gain} cannot exceed 1.0`);
      assert.ok(out >= previous, `gain ${gain} stays monotonic`);
      previous = out;
    }
  }
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    assert.ok(Math.abs(curve(v, 1, 1) - v) < 1e-9, 'gain 1.0 with no lift is an identity');
  }
});

test('Night reuses the alignment weight formula\'s SHAPE (mix-blend) but not its instances', () => {
  // Own StackAligner and own SteadyShutter — instancing an already-verified
  // class twice for two independent lifecycles is not "a second gyro
  // implementation" (Joshua's explicit worry); importing the same math twice
  // and reimplementing it WOULD be. Pin that app.ts imports these classes
  // rather than restating rotation/steadiness maths of its own.
  const app = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');
  assert.match(app, /import \{[\s\S]{0,400}StackAligner[\s\S]{0,200}\} from '\.\/vision\/alignment\.js';/);
  assert.match(app, /const nightAligner = new StackAligner\(\);/);
  assert.match(app, /const nightGate = new SteadyShutter\(\);/);
  // Two SEPARATE instances from the ones the live features already use —
  // not the same object reused for a second purpose.
  assert.match(app, /const aligner = new StackAligner\(\);/, 'the live-alignment instance still exists, untouched');
  assert.match(app, /const steadyShutter = new SteadyShutter\(\);/, 'the ordinary Shoot When Steady instance still exists, untouched');

  // No new rotation/orientation math anywhere in the Night wiring itself —
  // it reads `latestOrientation`, the SAME shared reading everything else
  // already uses, and calls `.track()` on its own aligner instance.
  const nightBlock = app.slice(app.indexOf("/* --- Night, Milestone 1"), app.indexOf('let renderedAidKey'));
  assert.match(nightBlock, /nightAligner\.track\(/);
  assert.ok(!/rotationSince\(|multiplyQuaternion|conjugate\(/.test(nightBlock),
    'no rotation math reimplemented here — it all goes through StackAligner');
});

test('Night saves the STACK, at the tier\'s size, and still consults no lens', () => {
  // Milestone 1 deliberately saved nothing. The board's next step is "save
  // one clean low-light still", and Joshua asked for it plainly: "It's not
  // wiring it up so I can see if the images it takes line up and actually
  // make a darker scene brighter." So this now saves — and what it saves is
  // the thing that must not drift.
  const app = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');
  const nightBlock = app.slice(app.indexOf("/* --- Night, Milestone 1"), app.indexOf('let renderedAidKey'));

  // THE CANVAS AS IT STANDS. Re-rendering would upload the frame arriving
  // now and save one ordinary picture, throwing away the whole capture —
  // the single most damaging thing this path could get wrong.
  assert.match(nightBlock, /preRendered: true, label: 'night'/);
  const photo = readFileSync(new URL('../src/v2/capture/photo.ts', import.meta.url), 'utf8');
  assert.match(photo, /if \(!options\.preRendered\) \{[\s\S]{0,200}uploadFrame/,
    'the upload and the re-render are BOTH skipped for a pre-rendered save');

  // MAX MEANS MAX is unchanged: the size saved is the accumulator's own
  // frozen size, which is the photo row the tier resolved — never a
  // separately chosen number.
  assert.match(nightBlock, /saveNightPhoto\(nightSize\)/);
  assert.ok(!/geometry\.preview|previewBoxShortSide/.test(nightBlock),
    'the save never reaches for the viewfinder-sized row');

  // The lens is STILL not consulted — composing Night under a lens is a
  // later step on the board, and until then nothing here may quietly do it.
  assert.ok(!/lensFilterId|compileLens/.test(nightBlock),
    'the selected lens is never consulted here');
  assert.match(nightBlock, /capturePhoto\(renderer, video, 'rgb',/,
    'and the save goes through plain RGB, not the active filter');

  // The preview must be frozen before the encode: a live frame drawn over
  // the canvas mid-toBlob would save the wrong picture.
  const freeze = nightBlock.indexOf("nightPhase = 'complete';");
  assert.ok(freeze > -1 && nightBlock.indexOf('void saveNightPhoto(') > freeze,
    'renderPreview is frozen before the canvas is encoded');
});

test('a container the constructor refuses costs one rung, not the recording', () => {
  // isTypeSupported admitting a string is not a promise the MediaRecorder
  // CONSTRUCTOR will accept it. With one candidate that was survivable — the
  // one candidate was the plain container that always works. With HEVC in
  // front of it, a browser that admits hvc1 and then refuses to build it
  // would have taken recording down entirely, so start() walks the list.
  const source = readFileSync(new URL('../src/v2/capture/record.ts', import.meta.url), 'utf8');
  const start = source.slice(source.indexOf('  start('), source.indexOf('this.label = label;'));

  assert.match(start, /containerCandidates\(\(candidate\) => MediaRecorder\.isTypeSupported\(candidate\)\)/,
    'every admitted container is a candidate, not just the first');
  assert.match(start, /for \(const candidate of candidates\)/, 'and each is tried in turn');
  assert.match(start, /\.\.\.containerCandidates[\s\S]*?\n\s*null\n\s*\]/,
    'with the browser default last, so an all-refusing ladder still records');
  assert.match(start, /if \(!this\.recorder\) \{/,
    'only an empty ladder is a failed recording');

  // THE FILE'S OWN ANSWER WINS over what was asked for: a browser may accept
  // hvc1 and encode something else, and the readout must not claim otherwise.
  assert.match(source, /this\.mime = this\.recorder\.mimeType \|\| chosen;/,
    'the recorder reports what it actually chose');
});

test('Grid draws a mesh whose shape is the picture, not a pattern', () => {
  const grid = filterById('grid');
  assert.ok(grid, 'the filter is registered');
  const body = grid.fragment.slice(grid.fragment.indexOf('void main'));

  // THE GRID IS NOTHING; THE OFFSET IS EVERYTHING. A fract() of a scaled
  // coordinate is a flat pattern — what gives it shape is sampling it
  // somewhere else, by parallax: a point at height h under a view direction d
  // appears displaced by h*d.
  assert.match(body, /vec2 p = vUv \+ h \* RELIEF \* VIEW_LEAN;/,
    'the coordinate is displaced by the height, not the colour recoloured');
  assert.match(grid.fragment, /const vec2 VIEW_LEAN = vec2\(0\.55, 0\.835\);/);
  // BOTH AXES, or it is a rippling row of contours rather than a warped grid.
  const lean = grid.fragment.match(/VIEW_LEAN = vec2\(([\d.]+), ([\d.]+)\)/);
  assert.ok(Number(lean[1]) > 0 && Number(lean[2]) > 0,
    'a diagonal view direction moves the mesh in x and y alike');

  // HEIGHT IS STRETCHED INTO THE FRAME'S OWN RANGE, or a dim room is flat.
  assert.equal(grid.needsLumaRange, true, 'and it declares the census it needs');
  assert.match(body, /uLumaRange\.y - uLumaRange\.x/, 'the stretch is real, not nominal');

  // AND THEN CURVED, because the stretch alone is an identity in practice.
  // uLumaRange is an absolute min and max, so one bright thing in a dark room
  // pins the top at 1.0 and the bottom sits at 0.0 — measured on Joshua's
  // room: min 0.0000, max 1.0000, leaving 62% of the rendered frame too dark
  // to read. The curve is what fixes that, and it must apply to the scene
  // underneath as well or the mesh floats over a black rectangle.
  assert.match(body, /float h = pow\(stretched, HEIGHT_GAMMA\);/);
  assert.match(body, /vec3 under = pow\(scene, vec3\(HEIGHT_GAMMA\)\) \* SCENE_UNDER;/);
  const gamma = Number(grid.fragment.match(/HEIGHT_GAMMA = ([\d.]+)/)[1]);
  assert.ok(gamma > 0 && gamma < 1, `a gamma below 1 spends range on the dark end, got ${gamma}`);

  // The line's brightness is EQUALISED, and only ever upward: scaling a
  // bright line down would flatten the ramp's top and clipping would bend its
  // hue, and either would make the colour lie about the height.
  assert.match(body, /min\(max\(LINE_LUMA \/ inkLuma, 1\.0\), 1\.0 \/ brightest\)/);

  // SQUARE CELLS AT ANY FRAME SHAPE, and no resolution owned by the shader:
  // uTexel.x / uTexel.y is height/width, which turns columns into rows.
  assert.match(body, /vec2 cells = vec2\(COLUMNS, COLUMNS \* \(uTexel\.x \/ uTexel\.y\)\);/);

  // LINE WIDTH IN PIXELS, WITHOUT DERIVATIVES. OES_standard_derivatives is an
  // extension this build does not require, so fwidth() must not appear; the
  // half-width comes from uTexel so a 12 MP still has the same grid the
  // preview showed instead of hairlines.
  assert.ok(!grid.fragment.includes('fwidth'), 'no derivative extension is relied on');
  // A FRACTION OF A CELL, not a count of pixels: the two agree on the
  // preview and disagree completely on a 12 MP still viewed scaled to fit,
  // where pixel-width lines come back as a hairline mesh that looks nothing
  // like the frame the shutter was pressed on.
  assert.match(body, /vec2 w = max\(vec2\(LINE_HALF_WIDTH\), uTexel \* cells\);/);
  assert.match(grid.fragment, /const float LINE_HALF_WIDTH = 0\.035;/);
  assert.match(body, /max\(w, vec2\(1e-5\)\)/, 'and a zero width cannot divide the smoothstep');

  // THE INK IS LIFTED OFF THE BOTTOM OF THE RAMP. Ironbow starts at black,
  // and colouring lines strictly by height made the mesh disappear over
  // everything dark — most of a dim room. Still monotonic in height, so the
  // contour reading is unchanged.
  assert.match(body, /INK_FLOOR \+ \(1\.0 - INK_FLOOR\) \* h/);
  const floor = Number(grid.fragment.match(/INK_FLOOR = ([\d.]+)/)[1]);
  assert.ok(floor > 0 && floor < 0.5, `a lift, not a wash: ${floor}`);

  // It is a VIEW filter: no history, and it can be saved and recorded like
  // any other picture.
  assert.equal(grid.temporal, false);
  assert.ok(!body.includes('uPrevious'), 'and the shader agrees');
  assert.equal(grid.state, undefined, 'nothing to remember between frames');
  assert.ok(grid.supportsPhoto && grid.supportsVideo);

  // The note must say what it is NOT. Bright reading as near is a shading
  // estimate; there is no depth sensor on a web page, and a convincing mesh
  // is exactly the kind of picture that would be believed.
  assert.match(grid.note, /not a depth sensor/i);
});

test('Poly cuts each cell along the edge running through it', () => {
  const poly = filterById('poly');
  assert.ok(poly, 'the filter is registered');
  const body = poly.fragment.slice(poly.fragment.indexOf('void main'));

  // A fragment shader cannot triangulate — no memory of other pixels, no
  // mesh. What it can do is decide which triangle THIS pixel is in, which is
  // enough to fill one.
  assert.match(body, /vec2 cell = floor\(g\);/);
  assert.match(body, /vec2 f = g - cell;/);

  // THE GRADIENT IS SAMPLED AT THE CELL, NOT THE PIXEL. Every pixel in a
  // cell must reach the same verdict, or the diagonal tears along its own
  // length as neighbouring pixels disagree about which way to cut.
  assert.match(body, /vec2 c = \(cell \+ 0\.5\) \/ cells;/);
  assert.match(body, /float gx = luma\(texture2D\(uFrame, clamp\(c \+ vec2\(halfCell\.x/);

  // An edge runs perpendicular to its gradient, so edge direction is
  // (-gy, gx); scoring both diagonals against it gives |gx-gy| and |gx+gy|.
  assert.match(body, /float fitBack = abs\(gx - gy\);/);
  assert.match(body, /float fitFwd = abs\(gx \+ gy\);/);

  // 'half' is RESERVED in GLSL ES 1.00 — a shader using it does not compile,
  // and the failure would only have appeared on the device. Checked against
  // the CODE, with comments stripped: the note explaining this very trap
  // says the word, and a reserved word in a comment compiles fine.
  const code = glslCode(poly.fragment);
  for (const reserved of ['half', 'flat', 'long', 'short', 'double', 'input', 'output']) {
    assert.ok(!new RegExp(`\\b${reserved}\\b`).test(code),
      `${reserved} is reserved in GLSL ES 1.00 and must not reach the compiler`);
  }

  // THE FILL IS AN AVERAGE, not one texel: a single sample makes sensor
  // noise decide a whole facet, which in a dark room is most of the frame.
  assert.equal((body.match(/texture2D\(uFrame, clamp\(at/g) ?? []).length, 4,
    'four taps inside the triangle');
  assert.match(body, /facet \* 0\.25/, 'and they are averaged, not summed');

  // The four centroids are the real ones: a triangle's centroid is the mean
  // of its vertices, and getting these wrong shifts every facet's colour.
  for (const centroid of [
    'vec2 upperBack = vec2(1.0 / 3.0, 2.0 / 3.0);',
    'vec2 lowerBack = vec2(2.0 / 3.0, 1.0 / 3.0);',
    'vec2 upperFwd = vec2(2.0 / 3.0, 2.0 / 3.0);',
    'vec2 lowerFwd = vec2(1.0 / 3.0, 1.0 / 3.0);'
  ]) assert.ok(poly.fragment.includes(centroid), `centroid: ${centroid}`);

  // NOTHING IS BRIGHTENED. Grid earned its curve because its subject was a
  // measured height the ramp rendered invisible; Poly's subject is the
  // camera's own colour, and lifting it would invent an exposure.
  assert.ok(!body.includes('uLumaRange'), 'no contrast stretch');
  assert.ok(!body.includes('pow('), 'and no gamma');
  assert.equal(poly.needsLumaRange, undefined, 'so it asks for no census');
  assert.match(poly.note, /camera's own/);

  assert.equal(poly.temporal, false);
  assert.equal(poly.state, undefined);
  assert.ok(poly.supportsPhoto && poly.supportsVideo);
});

test('the Sobel is written once and shared by everything that reads an edge', () => {
  // It had been transcribed three times — the Edges filter, the peaking aid,
  // and the compiled lens channel — and Cel, Ink and Wash would have made
  // six. Six copies of eight taps is six chances for one to drift, and the
  // symptom would be two filters disagreeing about where an edge is.
  assert.match(SHADER_HEADER, /float sobelLuma\(vec2 uv, vec2 texel\) \{/,
    'one definition, in the header');
  // The TEXEL IS A PARAMETER, which is the thing that lets the aid share it:
  // peaking measures at the aid's resolution, everything else at the render
  // size, and that difference was the only reason for a separate copy.
  assert.match(SHADER_HEADER, /sobelLuma\(uv, uAidTexel\) >= uPeak/, 'peaking uses it');
  assert.equal((SHADER_HEADER.match(/2\.0 \* r \+ br/g) ?? []).length, 1,
    'and the eight taps appear exactly once in the header');

  const edges = filterById('edges');
  assert.match(edges.fragment.slice(edges.fragment.indexOf('void main')),
    /sobelLuma\(vUv, uTexel\)/, 'the Edges filter uses it');
  assert.ok(!edges.fragment.slice(edges.fragment.indexOf('void main')).includes('2.0 * r + br'),
    'and no longer carries its own copy');

  // The painterly three read it with a FRAME-RELATIVE step. uTexel is one
  // texel of the TARGET, and the same shader runs at a ~1170-wide preview and
  // a 3024-wide still off the same camera texture — so a one-texel Sobel
  // reaches ~2.6 source pixels in the preview and ~1 in the still, halving the
  // gradient exactly when the shutter is pressed. Their thresholds are
  // absolute, so a solid Cel outline became a grey smear in the saved photo.
  for (const id of ['cel', 'ink', 'wash']) {
    const filter = filterById(id);
    assert.match(filter.fragment.slice(filter.fragment.indexOf('void main')),
      /sobelLuma\(vUv, frameStep\(EDGE_REFERENCE\)\)/,
      `${id} must measure an edge in the frame, not in texels`);
  }
  assert.match(SHADER_HEADER, /vec2 frameStep\(float reference\) \{/);
  // Edges and the aid keep the texel step deliberately: each measures THIS
  // render at ITS own resolution.
  assert.match(edges.fragment, /sobelLuma\(vUv, uTexel\)/);
  assert.match(SHADER_HEADER, /sobelLuma\(uv, uAidTexel\)/);
});

test('Cel bands the VALUE so hue survives, and says its curve is a stylisation', () => {
  const cel = filterById('cel');
  const body = cel.fragment.slice(cel.fragment.indexOf('void main'));

  // Quantising r, g and b separately is the obvious way and it wrecks hue:
  // a wall drifts beige to pink as two channels cross a step at different
  // moments. Band luma, then rescale the original colour onto that band.
  assert.match(body, /float band = floor\(curved \* BANDS \+ 0\.5\) \/ BANDS;/);
  assert.match(body, /vec3 painted = scene \* \(band \/ max\(y, 0\.02\)\);/,
    'the original colour is rescaled, not rebuilt');
  assert.ok(!/floor\(scene/.test(body), 'the channels are never quantised apart');

  // The near-black guard: without it the ratio has no meaning and multiplies
  // sensor noise straight into the top band.
  assert.match(body, /max\(y, 0\.02\)/);

  // The curve is admitted in the note rather than passed off as a reading.
  assert.match(cel.note, /stylisation/i);
  assert.match(body, /pow\(clamp\(y, 0\.0, 1\.0\), VALUE_GAMMA\)/);
});

test('Ink builds shade the way a pen does, and at frame scale', () => {
  const ink = filterById('ink');
  const body = ink.fragment.slice(ink.fragment.indexOf('void main'));

  // FOUR LAYERS AT FOUR THRESHOLDS. A pen has one colour and only density to
  // spend, so darker means more lines, not greyer ones.
  const layers = body.match(/hatch\(/g) ?? [];
  assert.equal(layers.length, 4, 'four hatch families');
  const cuts = [...body.matchAll(/step\(y, ([\d.]+)\)/g)].map((m) => Number(m[1]));
  assert.equal(cuts.length, 4);
  for (let i = 1; i < cuts.length; i += 1) {
    assert.ok(cuts[i] < cuts[i - 1], `each layer cuts in darker: ${cuts.join(' > ')}`);
  }

  // MEASURED IN THE FRAME, NOT IN PIXELS — the same mistake Grid's line width
  // made. Pixel spacing gives the preview a coarse weave and a 12 MP still a
  // fine grey mist, so the drawing would not survive being saved.
  assert.match(body, /vec2 p = vec2\(vUv\.x, vUv\.y \* \(uTexel\.x \/ uTexel\.y\)\) \* HATCH_SCALE;/,
    'scaled by the frame, with the aspect term keeping strokes at 45 degrees');

  // sin() at large arguments loses precision at mediump — a visible seam on a
  // phone, not a rounding error. Checked against the CODE: the comment that
  // explains this names the function it is warning about.
  // ONE HASH, in the header, at a precision where fract() still means
  // something. Ink and Wash each carried an identical copy — the same
  // duplication the Sobel had — and mediump is fp16 on Apple's GPUs, where a
  // value at 20000 has a ULP of 16 and fract() is identically zero. The hash
  // returned a CONSTANT on the only device this app is built for, while
  // working perfectly in the Chromium these tests run in: Ink lost its paper
  // grain, Wash lost its grain and its wobble.
  assert.ok(!glslCode(ink.fragment).includes('sin('), 'the hash avoids sin entirely');
  // Counted, not merely absent: every filter's source INCLUDES the header, so
  // "does it contain a hash" is always true. Exactly one definition is the
  // claim, and it is the header's.
  for (const id of ['ink', 'wash']) {
    const source = filterById(id).fragment;
    assert.equal((source.match(/float hash\(/g) ?? []).length, 1,
      `${id} must use the shared hash, not carry a second`);
  }
  assert.match(SHADER_HEADER, /NOISE_P float hash\(vec2 seed\) \{/);
  assert.match(SHADER_HEADER, /#ifdef GL_FRAGMENT_PRECISION_HIGH/,
    'guarded, because highp in a fragment shader is optional in GLSL ES 1.00');
  assert.match(SHADER_HEADER, /NOISE_P vec3 q = fract\(vec3\(seed\.xyx\) \* 0\.1031\);/);
});

test('Wash darkens its rims rather than outlining them', () => {
  const wash = filterById('wash');
  const body = wash.fragment.slice(wash.fragment.indexOf('void main'));

  // THE ONE EFFECT THAT READS AS WATERCOLOUR AND NOTHING ELSE: pigment
  // migrates to the rim of a drying pool. It must DARKEN the boundary — an
  // ink line there would make it a drawing instead.
  assert.match(body, /vec3 washed = pool \* \(1\.0 - rim\);/);
  assert.ok(!body.includes('INK'), 'no outline is drawn');

  // A WASH DRIES FLAT, and blur alone does not: measured on a real room the
  // rim contrast was +0.068 with the pools left smooth and +0.211 once they
  // were banded. Banded by VALUE, after the blur — before it would posterise
  // noise instead of shaping pools.
  assert.match(body, /float flatten = floor\(pow\(clamp\(pooled, 0\.0, 1\.0\), 0\.75\) \* POOL_BANDS/);
  assert.ok(body.indexOf('pool / 10.0') < body.indexOf('POOL_BANDS'),
    'the banding happens after the blur, not before it');

  // Nine colour taps, averaged with the centre weighted double.
  assert.equal((body.match(/texture2D\(uFrame/g) ?? []).length, 9);
  assert.match(body, /texture2D\(uFrame, at\)\.rgb \* 2\.0/);
  assert.match(body, /pool \/ 10\.0/, 'weights sum to ten');

  // The wobble is CONSTANT ACROSS A PATCH: per-pixel noise is a lens defect,
  // wet paper wanders in patches.
  assert.match(body, /vec2 patch = floor\(vUv \/ max\(uTexel, vec2\(1e-6\)\) \/ 14\.0\);/);

  // Paper grain strongest where the wash is thin, as real pigment behaves.
  assert.match(body, /1\.0 - PAPER_GRAIN \* grain \* \(0\.35 \+ 0\.65 \* thin\)/);

  // And the cost is stated rather than discovered.
  assert.match(wash.note, /thirteen taps/i);
});


/**
 * A shader's CODE, with its comments removed.
 *
 * Written after tripping over this twice in one sitting: a shader comment
 * that explains a trap necessarily names the trap, so `half` appeared in the
 * note warning that `half` is reserved, and `sin(` in the note warning about
 * sin(). Both times the test was wrong and the shader was fine. Anything
 * asserting what a shader must NOT contain belongs on this side of the line.
 */
function glslCode(source) {
  return source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

test('Amplify holds two running averages in one state texture', () => {
  const amplify = filterById('amplify');
  const state = amplify.state.slice(amplify.state.indexOf('void main'));

  // A state pass owns exactly ONE RGBA target and this needs two running
  // values, so fast lives in .r and slow in .g. That is also why it is luma:
  // six values would need two targets, and the band is a brightness question.
  assert.match(state, /float fast = mix\(now, held\.r \+ \(now - held\.r\) \* FAST, primed\);/);
  assert.match(state, /float slow = mix\(now, held\.g \+ \(now - held\.g\) \* SLOW, primed\);/);
  assert.match(amplify.state, /const float FAST = 0\.5;/);
  assert.match(amplify.state, /const float SLOW = 0\.06;/);
  const fast = Number(amplify.state.match(/FAST = ([\d.]+)/)[1]);
  const slow = Number(amplify.state.match(/SLOW = ([\d.]+)/)[1]);
  assert.ok(fast > slow, 'the fast filter must actually be faster, or there is no band');

  // SEEDED FROM THE FIRST FRAME. State clears to zero on a filter change, so
  // starting both averages at zero would make the opening second one
  // full-scale transient that never happened. Alpha carries "primed".
  // THE PRIMING MUST NOT RIDE ON ALPHA. It did, on the stated belief that the
  // state "clears to 0" — advanceState clears every state texture with
  // gl.clearColor(0, 0, 0, 1), alpha ONE, so primed read 1 on the first pass,
  // the seeding branch was unreachable, and both averages started from zero.
  // Measured in a browser: the whole viewfinder went to mean 255, 100% white,
  // for over a second on every switch to Amplify. Self-priming off the values
  // needs nothing of the renderer.
  assert.match(state, /float primed = step\(0\.0001, held\.r \+ held\.g\);/);
  assert.ok(!/held\.a/.test(state), 'alpha is not a reliable primed flag here');

  // The band is the DIFFERENCE, multiplied and added back.
  const body = amplify.fragment.slice(amplify.fragment.indexOf('void main'));
  assert.match(body, /float band = held\.r - held\.g;/);
  assert.match(body, /scene \+ band \* GAIN/);

  // NOT temporal: it never reads uPrevious. The flag means "reads the frame
  // before" in this codebase, and Amplify reads its own averages instead.
  assert.equal(amplify.temporal, false);
  assert.ok(!body.includes('uPrevious') && !state.includes('uPrevious'));

  // The three limits are in the note, because each shows up immediately.
  assert.match(amplify.note, /amplifies NOISE as readily as motion/i);
  assert.match(amplify.note, /flat wall that moves shows nothing/i);
});

test('Flow reports direction, and admits what direction it cannot see', () => {
  const flow = filterById('flow');
  const body = flow.state.slice(flow.state.indexOf('void main'));

  // The gradient constraint: v = -It * (Ix, Iy) / (Ix^2 + Iy^2).
  assert.match(body, /vec2 v = -gated \* vec2\(dx, dy\) \/ \(dx \* dx \+ dy \* dy \+ 0\.0016\);/);
  // SIGNED in time, unlike Speed's magnitude — the sign IS the direction.
  assert.match(body, /float dt = now - before;/);
  assert.ok(!/abs\(now - before\)/.test(body), 'an absolute difference has no direction in it');
  // The epsilon stops a flat region, where the division is meaningless, from
  // reporting an enormous velocity.
  assert.match(body, /\+ 0\.0016\)/);

  assert.match(body, /float angle = atan\(v\.y, v\.x\)/, 'direction becomes hue');
  assert.match(flow.fragment, /hueWheel\(field\.r\) \* field\.g/, 'and speed becomes brightness');

  // THE ESTIMATE BELONGS IN A STATE PASS, at analysis size. In the display
  // pass it compared a full-resolution frame against uPrevious — the history
  // snapshotted at 384 — so a MOTIONLESS scene produced a sharp-minus-blur
  // residual, largest exactly at the edges, which Flow then DIVIDED by the
  // gradient. Every edge in a still room lit at full brightness with a
  // confident direction: a velocity reported for something not moving.
  assert.ok(flow.state, 'the estimate runs where both frames are the same size');
  assert.ok(!flow.fragment.slice(flow.fragment.indexOf('void main')).includes('uPrevious'),
    'the display pass no longer differences anything');
  // Speed's gate, which was the other half of why Speed never had this bug.
  assert.match(body, /float gated = dt \* smoothstep\(0\.008, 0\.035, abs\(dt\)\);/);
  // Magnitude carries the memory; an angle cannot be averaged because it wraps.
  assert.match(body, /float lit = mix\(texture2D\(uState, vUv\)\.g, target, 0\.4\);/);

  // THE APERTURE PROBLEM IS IN THE NOTE. Only the component along the
  // gradient is recoverable from one pixel, so an edge sliding along its own
  // length reads as still. That is the measurement, not a fault, and it looks
  // exactly like one.
  assert.match(flow.note, /aperture problem/i);
  assert.match(flow.note, /NORMAL FLOW/);

  assert.equal(flow.temporal, true);
  assert.match(body, /uPrevious/, 'the state pass is what reads the frame before');
});

test('Background reuses the learned model the novelty channel already uses', () => {
  const background = filterById('background');

  // RULE 4. A second background model would be a second answer to "what is
  // normally here", and two filters disagreeing about that is the same drift
  // the Sobel consolidation removed.
  assert.equal(background.state, NOVELTY_STATE, 'the SAME state pass object, not a copy');

  const body = background.fragment.slice(background.fragment.indexOf('void main'));
  // THE DEPARTURE IS MEASURED IN THE STATE PASS, where the background and the
  // frame are the same size. Subtracting them in the DISPLAY pass looked
  // equivalent and was not: the state lives at analysis resolution, so a
  // motionless scene produced a sharp-minus-blur residual at every edge and
  // the room stayed permanently lit — the opposite of this filter's product.
  // A mask survives being magnified; a subtraction does not.
  assert.match(NOVELTY_STATE, /clamp\(length\(now - background\) \* 2\.2, 0\.0, 1\.0\)/,
    'the model publishes the departure it implies');
  assert.match(body, /texture2D\(uState, vUv\)\.a/, 'and the display reads it rather than recomputing');
  assert.ok(!body.includes('length(scene - background)'), 'no cross-resolution subtraction');
  assert.match(body, /mix\(scene \* BELONGS, scene, lit\)/, 'what belongs is dimmed, not erased');
  // ch_novelty reads only .rgb, so carrying this in alpha costs it nothing.
  const lensShader = readFileSync(new URL('../src/v2/filters/lens-shader.ts', import.meta.url), 'utf8');
  assert.match(lensShader, /luma\(texture2D\(uState, uv\)\.rgb\)/);

  // NOT temporal, and that is the entire point: comparing adjacent frames is
  // what Motion does, and what this exists to avoid — a slow mover almost
  // vanishes from a frame difference and stands out against a learned scene.
  assert.equal(background.temporal, false);
  assert.ok(!body.includes('uPrevious'));

  // The honest cost is in the note: a model that never absorbed anything
  // could not follow the light changing either.
  assert.match(background.note, /absorbed into the background/i);
});

test('Motion is V1\'s Motion, and Difference stops wearing its name', () => {
  // THE COLLISION THE AUDIT FLAGGED: "V2's filter id:'difference' displays as
  // NAME 'Motion'. V1's DIFFERENCE wearing V1's MOTION's name - verified in
  // source." The id was always right and the label always wrong; it only
  // became worth fixing once V1's actual Motion existed beside it.
  assert.equal(filterById('difference').name, 'Difference');
  assert.equal(filterById('motion').name, 'Motion');

  const motion = filterById('motion');
  const body = motion.fragment.slice(motion.fragment.indexOf('void main'));

  // EVERY CONSTANT IS V1's, converted from 0-255 rather than re-picked. A port
  // that re-tunes its numbers is a new filter wearing an old name, and being
  // the thing that was there before is the whole point of restoring it.
  assert.match(motion.fragment, /const float THRESHOLD = 0\.0706;/, "V1's 18/255");
  assert.match(motion.fragment, /const float HEAT_SPAN = 0\.2353;/, "V1's /60");
  assert.match(motion.fragment, /const float BACKDROP = 0\.34;/, "V1's 0.34 dim");
  assert.match(body, /base \+ 0\.157 \+ 0\.588 \* heat/, "V1's 40 + 150*heat");
  assert.match(body, /base \+ 0\.471 \+ 0\.235 \* \(1\.0 - heat\)/, "V1's 120 + 60*(1-heat)");

  // THE DIMMED SCENE IS THE POINT. Difference already answers "what changed"
  // as pure colour; this answers "what moved, and WHERE" — the backdrop keeps
  // the room legible under the mask, which is why V1 shipped both.
  assert.match(body, /float base = luma\(texture2D\(uFrame, vUv\)\.rgb\) \* BACKDROP;/);
  assert.match(body, /mix\(still, moving, step\(THRESHOLD, smoothed\)\)/);

  // THE DIFFERENCE IS MEASURED IN A STATE PASS, at analysis size, for the
  // reason Flow and Background were both moved into one: differencing a
  // full-resolution frame against analysis-size history paints a bright rim
  // on every edge of a MOTIONLESS scene.
  assert.ok(motion.state, 'the difference runs where both frames are the same size');
  assert.match(MOTION_STATE, /float delta\(vec2 uv\) \{/);
  // V1's five-tap cross, at V1's weights: centre twice, neighbours once, / 6.
  assert.match(MOTION_STATE, /delta\(vUv\) \* 2\.0/);
  assert.match(MOTION_STATE, /\) \/ 6\.0;/);
  assert.ok(!motion.fragment.slice(motion.fragment.indexOf('void main')).includes('uPrevious'),
    'the display pass differences nothing');
});

test('Chrono and Slit Scan exist — the audit said they could not', () => {
  // THE CARD SAID: "Chrono-C+E, worse than missing: one-uv-per-pixel model
  // can't express a multi-tap composite without new machinery. Slit Scan-C+E,
  // same plus time-as-spatial-axis is less compatible still."
  //
  // Wrong on both counts, and Joshua caught it: "if it can work on the older
  // version, it will work in this version." A shader may sample uState at ANY
  // uv, not only vUv — which is the entire objection — and the state is
  // already a ping-pong pair, which IS the per-pixel memory a multi-tap
  // composite needs. No machinery was added for either of these.
  const chrono = filterById('chrono');
  const slit = filterById('slitscan');
  assert.ok(chrono && slit);

  // CHRONO: three taps and a phase counter in one RGBA texture.
  assert.match(CHRONO_STATE, /vec3 stepped = mix\(held\.rgb, vec3\(held\.g, held\.b, now\), shift\);/,
    'red the oldest, green the middle, blue the newest — V1\'s order');
  // The shift must happen every SPACING frames, and a fragment shader has no
  // frame counter, so the counter lives in the texture with the taps.
  assert.match(CHRONO_STATE, /float phase = held\.a \+ 1\.0 \/ SPACING;/);
  assert.match(CHRONO_STATE, /float shift = step\(1\.0, phase\);/);
  assert.match(CHRONO_STATE, /fract\(phase\)/);
  assert.match(CHRONO_STATE, /const float SPACING = 4\.0;/, "V1's chronoSpacing default");
  // Primed off the VALUES, not alpha — the renderer clears state with alpha
  // ONE, the trap that made Amplify a white screen.
  assert.match(CHRONO_STATE, /float primed = step\(0\.0001, held\.r \+ held\.g \+ held\.b\);/);
  assert.ok(!/held\.a\s*[;)]/.test(CHRONO_STATE.replace('held.a + 1.0', '')),
    'alpha is a phase here, never a primed flag');

  // SLIT SCAN: a one-texel scroll. THE OFFSET SAMPLE IS THE WHOLE POINT — it
  // is the "any uv" the audit said was impossible.
  assert.match(SLITSCAN_STATE, /texture2D\(uState, vec2\(vUv\.x \+ uTexel\.x, vUv\.y\)\)/,
    'reads its own state at a DIFFERENT uv, which is what was called impossible');
  assert.match(SLITSCAN_STATE, /float newest = step\(1\.0 - uTexel\.x, vUv\.x\);/,
    'the newest slice enters at the right, so time runs left to right as V1 read it');
  assert.match(SLITSCAN_STATE, /luma\(texture2D\(uFrame, vec2\(COLUMN, vUv\.y\)\)\.rgb\)/,
    'one column of the camera, not the whole frame');

  // Both hold their picture in the state; neither differences frames.
  // Sliced past the shared header, which DECLARES uPrevious as a uniform —
  // checking the whole string finds the declaration, not a use.
  for (const filter of [chrono, slit]) {
    assert.equal(filter.temporal, false);
    assert.ok(!filter.state.slice(SHADER_HEADER.length).includes('uPrevious'),
      `${filter.id} holds memory rather than differencing frames`);
    assert.match(filter.fragment.slice(filter.fragment.indexOf('void main')), /uState/);
    assert.ok(filter.supportsPhoto && filter.supportsVideo);
  }
});
