import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MotionSpeedField,
  MotionTrailBuffer,
  ironbowColor,
  renderMotionIronbow,
  upscaleSpeedField,
  INFERRED,
  RESOLVED,
  STILL,
  UNRESOLVED
} from '../.test-build/vision/motion-ironbow.js';

const W = 64;
const H = 48;

/** A difference mask with a moving patch in it. */
function movingPatch(x0, y0, size = 10, value = 90) {
  const diff = new Uint8ClampedArray(W * H);
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) {
      if (x >= 0 && x < W && y >= 0 && y < H) diff[y * W + x] = value;
    }
  }
  return diff;
}

function flowAt(x, y, magnitude, cellSize = 8) {
  return { vectors: [{ x, y, magnitude }], cellSize };
}

test('the ramp runs cool-and-dark to hot-and-bright', () => {
  const still = ironbowColor(0);
  const fast = ironbowColor(1);
  const mid = ironbowColor(0.5);

  const luma = ([r, g, b]) => r * 0.2126 + g * 0.7152 + b * 0.0722;
  assert.ok(luma(still) < luma(mid), 'still must be darker than medium');
  assert.ok(luma(mid) < luma(fast), 'medium must be darker than fast');
  assert.ok(still[2] > still[0], `slow end should be blue-dominant, got ${still}`);
  assert.ok(fast[0] > 240 && fast[1] > 240, `fast end should be near white, got ${fast}`);
});

/**
 * A triangle wave, so the spatial gradient has a known constant MAGNITUDE and
 * the recovered speed can be checked against arithmetic.
 *
 * A plain ramp was the obvious choice and the wrong one: at any useful slope it
 * saturates against 255 partway across, and a saturated region has no gradient
 * at all, so the estimator correctly resolved nothing and the test measured its
 * own scaffolding. A triangle folds back instead and never clips at any width.
 */
const PERIOD = 32;
function rampFrame(slope, width = W, height = H) {
  const gray = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const phase = x % PERIOD;
      const up = phase < PERIOD / 2 ? phase : PERIOD - phase;
      gray[y * width + x] = 40 + up * slope;
    }
  }
  return gray;
}

/** The difference a translation of `shift` pixels produces on that gradient. */
function rampDifference(slope, shift, width = W, height = H) {
  const diff = new Uint8ClampedArray(width * height);
  diff.fill(Math.round(Math.abs(slope * shift)));
  return diff;
}

/** The turning points of the triangle carry no gradient, so they never resolve. */
const SENSITIVE = { motionThreshold: 2, autoScale: false, fillRadius: 0 };

test('speed comes from the gradient, at every pixel', () => {
  // The whole reason for changing method: a block search resolved about
  // sixteen samples across a 256-pixel frame, which read as a grid. This
  // estimate exists at every pixel, so a smooth ramp produces a full field.
  const field = new MotionSpeedField();
  const slope = 3;
  const gray = rampFrame(slope);
  const diff = rampDifference(slope, 2);
  field.update(diff, gray, W, H, 1 / 30, { ...SENSITIVE, fullScale: 10 });

  let resolved = 0;
  for (const s of field.state) if (s === RESOLVED) resolved++;
  // Every interior pixel should carry its own reading, not one shared by a cell.
  // The triangle's turning points have no gradient by construction, so a
  // little under the full interior is the correct answer, not a shortfall.
  assert.ok(resolved > (W - 2) * (H - 2) * 0.85,
    `expected a per-pixel field, only ${resolved} pixels resolved`);
});

test('the recovered displacement matches the arithmetic', () => {
  // speed = |I_t| / |grad I|. On a ramp of slope 4 shifted by 2 pixels the
  // difference is 8, so the estimate must come back at 2 pixels per frame.
  const field = new MotionSpeedField();
  const slope = 3;
  const dt = 1 / 30;
  field.update(rampDifference(slope, 2), rampFrame(slope), W, H, dt,
    { ...SENSITIVE, fullScale: 1 });

  const expectedWidthsPerSecond = 2 / W / dt;
  assert.ok(Math.abs(field.report.peakWidthsPerSecond - expectedWidthsPerSecond) < 1e-6,
    `got ${field.report.peakWidthsPerSecond}, expected ${expectedWidthsPerSecond}`);
});

test('speed is measured per second, not per frame', () => {
  // The same real movement sampled at two frame rates must land on the same
  // colour. Reading displacement per FRAME would make the slower pipeline
  // report the scene as moving twice as fast, so the palette would track the
  // phone's workload instead of the world.
  const slope = 3;
  const gray = rampFrame(slope);
  const fast = new MotionSpeedField();
  const slow = new MotionSpeedField();

  // 2 px in 1/30 s and 4 px in 1/15 s are the same speed.
  const a = fast.update(rampDifference(slope, 2), gray, W, H, 1 / 30,
    { ...SENSITIVE, fullScale: 2 });
  const b = slow.update(rampDifference(slope, 4), gray, W, H, 1 / 15,
    { ...SENSITIVE, fullScale: 2 });

  assert.ok(Math.abs(a.peakWidthsPerSecond - b.peakWidthsPerSecond) < 1e-6,
    `${a.peakWidthsPerSecond} vs ${b.peakWidthsPerSecond} widths/sec`);
});

test('speed is independent of analysis resolution', () => {
  // The adaptive governor changes the analysis width while the app runs. A
  // gull must not change colour because the pipeline stepped down a notch.
  const slope = 3;
  const wide = new MotionSpeedField();
  const narrow = new MotionSpeedField();

  // Crossing the same FRACTION of the frame at both sizes.
  // A sixteenth of the frame per frame at both sizes, and both well inside the
  // estimator's ceiling so neither reading is clipped.
  const a = wide.update(rampDifference(slope, 8, 128, 96), rampFrame(slope, 128, 96),
    128, 96, 1 / 30, { ...SENSITIVE, fullScale: 5 });
  const b = narrow.update(rampDifference(slope, 4, 64, 48), rampFrame(slope, 64, 48),
    64, 48, 1 / 30, { ...SENSITIVE, fullScale: 5 });

  assert.ok(Math.abs(a.peakWidthsPerSecond - b.peakWidthsPerSecond) < 1e-6,
    `${a.peakWidthsPerSecond} vs ${b.peakWidthsPerSecond} widths/sec`);
});

test('a still scene produces no motion colour at all', () => {
  const field = new MotionSpeedField();
  const report = field.update(new Uint8ClampedArray(W * H), rampFrame(3), W, H, 1 / 30);
  assert.equal(report.movingFraction, 0);
  assert.equal(report.peakWidthsPerSecond, 0);
  assert.ok(field.state.every((s) => s === STILL));
});

test('change with no gradient behind it reads as unresolved, not as slow', () => {
  // A flat surface changing brightness carries no edge to measure displacement
  // by. Dividing anyway would turn sensor noise into a confident speed.
  const field = new MotionSpeedField();
  const flat = new Uint8ClampedArray(W * H).fill(128);
  const diff = new Uint8ClampedArray(W * H).fill(90);
  const report = field.update(diff, flat, W, H, 1 / 30, { fillRadius: 0 });

  assert.ok(report.movingFraction > 0, 'the change should be detected');
  assert.equal(report.unresolvedFraction, 1, 'no gradient means nothing was resolved');
  assert.equal(report.peakWidthsPerSecond, 0, 'no speed may be claimed');
  assert.ok(field.state.some((s) => s === UNRESOLVED));
  assert.ok(!field.state.some((s) => s === RESOLVED));
});

test('an implausibly small time step is refused rather than guessed at', () => {
  const field = new MotionSpeedField();
  const report = field.update(rampDifference(3, 2), rampFrame(3), W, H, 0.0001);
  assert.equal(report.peakWidthsPerSecond, 0);
  assert.equal(report.movingFraction, 0);
});

test('faster movement lands higher on the ramp', () => {
  const field = new MotionSpeedField();
  const gray = rampFrame(3);
  field.update(rampDifference(3, 1), gray, W, H, 1 / 30,
    { ...SENSITIVE, fullScale: 4 });
  const slow = field.report.peakWidthsPerSecond;
  field.update(rampDifference(3, 4), gray, W, H, 1 / 30,
    { ...SENSITIVE, fullScale: 4 });
  const fast = field.report.peakWidthsPerSecond;

  assert.ok(fast > slow, `fast ${fast} must exceed slow ${slow}`);
  assert.ok(slow > 0);
});

test('motion past what the method can resolve is reported, not hidden', () => {
  // The linearisation degrades past a few pixels, so fast motion is understated
  // and clipped. A reading that is a floor rather than a measurement has to say
  // so, or it reads as a confident slow number.
  const field = new MotionSpeedField();
  // A measurable gradient with a huge change: the division wants a displacement
  // far past what a local linearisation can support.
  const gray = rampFrame(4);
  const diff = new Uint8ClampedArray(W * H).fill(200);
  const report = field.update(diff, gray, W, H, 1 / 30, SENSITIVE);
  assert.ok(report.saturatedFraction > 0.5,
    `expected most readings clipped, got ${report.saturatedFraction}`);

  // And an ordinary scene must not be reported as saturated.
  const ordinary = field.update(rampDifference(3, 1), rampFrame(3), W, H, 1 / 30, SENSITIVE);
  assert.equal(ordinary.saturatedFraction, 0);
});

test('a flat interior inherits speed from the edges around it', () => {
  // A cheek or a coat changes brightness without carrying an edge, so it lands
  // in UNRESOLVED with speed all round its rim. Leaving it hollow describes the
  // object worse than growing the rim inward does.
  const field = new MotionSpeedField();
  const gray = new Uint8ClampedArray(W * H).fill(128);
  const diff = new Uint8ClampedArray(W * H);
  // A textured band down the middle, flat either side, all of it changing.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      diff[y * W + x] = 90;
      if (x >= 30 && x < 34) gray[y * W + x] = 128 + (x % 2) * 90;
    }
  }
  const hollow = field.update(diff, gray, W, H, 1 / 30, { fillRadius: 0 });
  const grown = new MotionSpeedField()
    .update(diff, gray, W, H, 1 / 30, { fillRadius: 6 });

  assert.equal(hollow.inferredFraction, 0, 'no fill means no inference');
  assert.ok(grown.inferredFraction > 0, 'the fill should reach the flat pixels');
  assert.ok(grown.unresolvedFraction < hollow.unresolvedFraction,
    'and unknown should shrink by exactly what it filled');
});

test('the fill reaches only as far as it is allowed', () => {
  // Bounded, so this stays interpolation near a measurement rather than
  // extrapolation across the whole frame.
  const gray = new Uint8ClampedArray(W * H).fill(128);
  const diff = new Uint8ClampedArray(W * H).fill(90);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) if (x < 4) gray[y * W + x] = 128 + (x % 2) * 90;
  }
  const near = new MotionSpeedField().update(diff, gray, W, H, 1 / 30, { fillRadius: 2 });
  const far = new MotionSpeedField().update(diff, gray, W, H, 1 / 30, { fillRadius: 10 });
  assert.ok(far.inferredFraction > near.inferredFraction, 'a longer reach fills more');
  assert.ok(far.unresolvedFraction > 0.5, 'but must not reach the whole frame');
});

test('the renderer distinguishes still, resolved and unresolved pixels', () => {
  const gray = new Uint8ClampedArray(3).fill(200);
  const speed = new Float32Array([0, 1, 0]);
  const state = new Uint8Array([STILL, RESOLVED, UNRESOLVED]);
  const out = new Uint8ClampedArray(3 * 4);
  renderMotionIronbow(gray, speed, state, out);

  const px = (i) => [out[i * 4], out[i * 4 + 1], out[i * 4 + 2]];
  const [sr, sg, sb] = px(0);
  assert.ok(sr === sg && sg === sb && sr < 200, 'still pixels stay a dimmed grey scene');
  const [fr, fg] = px(1);
  assert.ok(fr > 240 && fg > 240, 'full speed is the hot end of the ramp');
  const [ur, ug, ub] = px(2);
  assert.ok(ub > ur && ur !== ug, 'unresolved has its own colour, not a ramp entry');
});

test('trail memory is constant whatever the exposure length', () => {
  // The whole reason a 60 second exposure is possible on a phone.
  const short = new MotionTrailBuffer();
  const long = new MotionTrailBuffer();
  const speed = new Float32Array(W * H).fill(0.5);
  const state = new Uint8Array(W * H).fill(RESOLVED);

  for (let i = 0; i < 30; i++) short.update(speed, state, W, H, 1 / 30, { exposureSeconds: 1 });
  for (let i = 0; i < 30; i++) long.update(speed, state, W, H, 1 / 30, { exposureSeconds: 60 });

  // Measure the actual allocation, not a stringified proxy: the claim is that
  // sixty seconds of trail costs the same bytes as one second.
  const bytes = (buffer) => Object.values(buffer)
    .filter((value) => ArrayBuffer.isView(value))
    .reduce((total, view) => total + view.byteLength, 0);

  assert.ok(bytes(short) > 0, 'the buffer should hold something measurable');
  assert.equal(bytes(short), bytes(long));

  // And a much longer run must not grow it either.
  for (let i = 0; i < 600; i++) long.update(speed, state, W, H, 1 / 30, { exposureSeconds: 60 });
  assert.equal(bytes(long), bytes(short));
});

test('a trail fades to nothing by the end of its exposure window', () => {
  const trails = new MotionTrailBuffer();
  const speed = new Float32Array(W * H).fill(0.8);
  const moving = new Uint8Array(W * H).fill(RESOLVED);
  const still = new Uint8Array(W * H).fill(STILL);

  trails.update(speed, moving, W, H, 1 / 30, { exposureSeconds: 2 });
  const marked = trails.update(speed, still, W, H, 0.5, { exposureSeconds: 2 });
  assert.ok(marked.coverage > 0.9, 'the trail should still be there after half a second');

  // Two full seconds after the last mark, nothing may remain.
  const gone = trails.update(speed, still, W, H, 2, { exposureSeconds: 2 });
  assert.equal(gone.coverage, 0);
});

test('age dims a trail without changing the speed it recorded', () => {
  // Hue carries speed and brightness carries age; if fading altered the hue the
  // two readings would contaminate each other.
  const trails = new MotionTrailBuffer();
  const gray = new Uint8ClampedArray(W * H);
  const speed = new Float32Array(W * H).fill(1);
  const moving = new Uint8Array(W * H).fill(RESOLVED);
  const still = new Uint8Array(W * H).fill(STILL);
  const fresh = new Uint8ClampedArray(W * H * 4);
  const aged = new Uint8ClampedArray(W * H * 4);

  trails.update(speed, moving, W, H, 1 / 30, { exposureSeconds: 4 });
  trails.render(gray, fresh, { fade: true });
  trails.update(speed, still, W, H, 2, { exposureSeconds: 4 });
  trails.render(gray, aged, { fade: true });

  assert.ok(aged[0] < fresh[0], 'an older trail must be dimmer');
  assert.ok(aged[0] > 0, 'but not yet gone');

  // With fading off the same trail holds full strength.
  const held = new Uint8ClampedArray(W * H * 4);
  trails.render(gray, held, { fade: false });
  assert.equal(held[0], fresh[0]);
});

test('keepFastest holds the peak speed a pixel showed', () => {
  const trails = new MotionTrailBuffer();
  const gray = new Uint8ClampedArray(W * H);
  const moving = new Uint8Array(W * H).fill(RESOLVED);
  const fast = new Float32Array(W * H).fill(0.9);
  const slow = new Float32Array(W * H).fill(0.1);

  trails.update(fast, moving, W, H, 1 / 30, { exposureSeconds: 10, keepFastest: true });
  trails.update(slow, moving, W, H, 1 / 30, { exposureSeconds: 10, keepFastest: true });
  const kept = new Uint8ClampedArray(W * H * 4);
  trails.render(gray, kept, { fade: false });

  const rolling = new MotionTrailBuffer();
  rolling.update(fast, moving, W, H, 1 / 30, { exposureSeconds: 10, keepFastest: false });
  rolling.update(slow, moving, W, H, 1 / 30, { exposureSeconds: 10, keepFastest: false });
  const latest = new Uint8ClampedArray(W * H * 4);
  rolling.render(gray, latest, { fade: false });

  assert.ok(kept[0] > latest[0], 'keeping the fastest must stay hotter than keeping the latest');
});

test('shortening the exposure fades existing trails sooner', () => {
  // Otherwise the control appears to do nothing for a whole cycle.
  const trails = new MotionTrailBuffer();
  const speed = new Float32Array(W * H).fill(0.5);
  const moving = new Uint8Array(W * H).fill(RESOLVED);
  const still = new Uint8Array(W * H).fill(STILL);

  trails.update(speed, moving, W, H, 1 / 30, { exposureSeconds: 60 });
  trails.update(speed, still, W, H, 1 / 30, { exposureSeconds: 2 });
  const after = trails.update(speed, still, W, H, 2, { exposureSeconds: 2 });
  assert.equal(after.coverage, 0, 'a 60s trail must not survive two seconds of a 2s window');
});

test('resizing the analysis frame does not carry stale trails across', () => {
  const trails = new MotionTrailBuffer();
  const speed = new Float32Array(W * H).fill(1);
  const moving = new Uint8Array(W * H).fill(RESOLVED);
  trails.update(speed, moving, W, H, 1 / 30, { exposureSeconds: 30 });

  const small = new Float32Array(32 * 24);
  const smallState = new Uint8Array(32 * 24).fill(STILL);
  const report = trails.update(small, smallState, 32, 24, 1 / 30, { exposureSeconds: 30 });
  assert.equal(report.coverage, 0);
  assert.equal(report.framesAccumulated, 1);
});




test('a speed field enlarges smoothly but keeps its categories intact', () => {
  // Speed is a quantity and interpolates; measured/inferred/unknown are
  // categories and cannot be averaged — a pixel half way between measured and
  // unknown is not "half measured".
  const speed = new Float32Array([0, 1, 1, 0]);
  const state = new Uint8Array([STILL, RESOLVED, RESOLVED, STILL]);
  const out = upscaleSpeedField(speed, state, 2, 2, 8, 8);

  assert.equal(out.speed.length, 64);
  assert.equal(out.state.length, 64);
  // Every state in the output must be one that existed in the input.
  for (const s of out.state) assert.ok(s === STILL || s === RESOLVED, `invented state ${s}`);
  // And the speed must take intermediate values rather than only 0 and 1.
  const distinct = new Set([...out.speed].map((v) => v.toFixed(3)));
  assert.ok(distinct.size > 2, `expected a gradient, got ${distinct.size} levels`);
  for (const v of out.speed) assert.ok(v >= 0 && v <= 1, `out of range ${v}`);
});

test('enlarging a field with nothing in it stays empty', () => {
  const out = upscaleSpeedField(new Float32Array(4), new Uint8Array(4), 2, 2, 16, 16);
  assert.ok(out.speed.every((v) => v === 0));
  assert.ok(out.state.every((v) => v === STILL));
});

