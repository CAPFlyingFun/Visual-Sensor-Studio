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
  // Cool at the bottom: blue dominant. Hot at the top: near-white.
  assert.ok(still[2] > still[0], `slow end should be blue-dominant, got ${still}`);
  assert.ok(fast[0] > 240 && fast[1] > 240, `fast end should be near white, got ${fast}`);
});

test('speed is measured per second, not per frame', () => {
  // The same real movement sampled at two different frame rates must land on
  // the same colour. Reading flow in pixels-per-FRAME would make the slower
  // pipeline report the scene as moving twice as fast, so the palette would
  // track the phone's workload instead of the world.
  const diff = movingPatch(20, 16);
  const fast = new MotionSpeedField();
  const slow = new MotionSpeedField();

  // 4 px in 1/30 s and 8 px in 1/15 s are the same speed.
  const a = fast.update(diff, flowAt(24, 20, 4), W, H, 1 / 30, { fullScale: 2 });
  const b = slow.update(diff, flowAt(24, 20, 8), W, H, 1 / 15, { fullScale: 2 });

  assert.ok(Math.abs(a.peakWidthsPerSecond - b.peakWidthsPerSecond) < 1e-6,
    `${a.peakWidthsPerSecond} vs ${b.peakWidthsPerSecond} widths/sec`);
});

test('speed is independent of analysis resolution', () => {
  // The adaptive governor changes the analysis width while the app runs. A
  // gull must not change colour because the pipeline stepped down a notch.
  const wide = new MotionSpeedField();
  const narrow = new MotionSpeedField();

  const bigDiff = new Uint8ClampedArray(128 * 96).fill(90);
  const smallDiff = new Uint8ClampedArray(64 * 48).fill(90);

  // Crossing a tenth of the frame per frame, at both resolutions.
  const a = wide.update(bigDiff, flowAt(64, 48, 12.8, 16), 128, 96, 1 / 30, { fullScale: 5 });
  const b = narrow.update(smallDiff, flowAt(32, 24, 6.4, 8), 64, 48, 1 / 30, { fullScale: 5 });

  assert.ok(Math.abs(a.peakWidthsPerSecond - b.peakWidthsPerSecond) < 1e-6,
    `${a.peakWidthsPerSecond} vs ${b.peakWidthsPerSecond} widths/sec`);
});

test('a still scene produces no motion colour at all', () => {
  const field = new MotionSpeedField();
  const report = field.update(new Uint8ClampedArray(W * H), null, W, H, 1 / 30);
  assert.equal(report.movingFraction, 0);
  assert.equal(report.peakWidthsPerSecond, 0);
  assert.ok(field.state.every((s) => s === STILL));
});

test('movement with no flow behind it reads as unresolved, not as slow', () => {
  // A moving surface too flat to match must not be coloured as though its
  // speed had been measured, and must not vanish either.
  const field = new MotionSpeedField();
  const report = field.update(movingPatch(20, 16), null, W, H, 1 / 30);

  assert.ok(report.movingFraction > 0, 'the change should be detected');
  assert.equal(report.unresolvedFraction, 1, 'no flow means nothing was resolved');
  assert.equal(report.peakWidthsPerSecond, 0, 'no speed may be claimed');
  assert.ok(field.state.some((s) => s === UNRESOLVED));
  assert.ok(!field.state.some((s) => s === RESOLVED));
});

test('an implausibly small time step is refused rather than guessed at', () => {
  // dt near zero divides every speed toward infinity and paints a white streak
  // out of one pixel of jitter.
  const field = new MotionSpeedField();
  const report = field.update(movingPatch(20, 16), flowAt(24, 20, 4), W, H, 0.0001);
  assert.equal(report.peakWidthsPerSecond, 0);
  assert.equal(report.movingFraction, 0);
});

test('faster movement lands higher on the ramp', () => {
  const field = new MotionSpeedField();
  const diff = movingPatch(20, 16);

  field.update(diff, flowAt(24, 20, 2), W, H, 1 / 30, { fullScale: 4, autoScale: false });
  const slow = field.speed[20 * W + 24];
  field.update(diff, flowAt(24, 20, 8), W, H, 1 / 30, { fullScale: 4, autoScale: false });
  const fast = field.speed[20 * W + 24];

  assert.ok(fast > slow, `fast ${fast} must exceed slow ${slow}`);
  assert.ok(slow > 0);
});

test('overlapping flow cells keep the faster claim', () => {
  // A fast object crossing a slow background must not be erased by whichever
  // cell happens to be scattered last.
  const field = new MotionSpeedField();
  const diff = movingPatch(20, 16);
  const flow = {
    cellSize: 8,
    vectors: [{ x: 24, y: 20, magnitude: 9 }, { x: 25, y: 20, magnitude: 1 }]
  };
  field.update(diff, flow, W, H, 1 / 30, { fullScale: 20, autoScale: false });
  const here = field.speed[20 * W + 24];
  field.update(diff, flowAt(24, 20, 9), W, H, 1 / 30, { fullScale: 20, autoScale: false });
  assert.equal(here, field.speed[20 * W + 24]);
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

test('a plain interior inherits the speed measured at its own edges', () => {
  // Block matching only accepts a cell with enough texture, so a moving coat or
  // wing routinely has measured speed all around its edge and none in the
  // middle. Leaving the middle blank describes the scene worse than carrying
  // the neighbouring measurement in.
  const field = new MotionSpeedField();
  const diff = movingPatch(16, 16, 32);
  // One vector, at the patch's leading edge only.
  const report = field.update(diff, flowAt(20, 20, 6, 16), W, H, 1 / 30,
    { fullScale: 5, autoScale: false });

  assert.ok(report.inferredFraction > 0, 'the interior should inherit a speed');
  assert.ok(field.state.some((s) => s === RESOLVED), 'the measured cell stays measured');
  assert.ok(field.state.some((s) => s === INFERRED), 'neighbours are marked as inherited');
  // The ledger has to add up, or the readout is lying about what was measured.
  let measured = 0;
  let inferred = 0;
  let unresolved = 0;
  let moving = 0;
  for (let i = 0; i < field.state.length; i++) {
    if (diff[i] < 18) continue;
    moving++;
    if (field.state[i] === RESOLVED) measured++;
    else if (field.state[i] === INFERRED) inferred++;
    else if (field.state[i] === UNRESOLVED) unresolved++;
  }
  assert.equal(measured + inferred + unresolved, moving, 'every moving pixel needs a state');
  assert.ok(Math.abs(report.inferredFraction - inferred / moving) < 1e-9);
  assert.ok(Math.abs(report.unresolvedFraction - unresolved / moving) < 1e-9);
});

test('inference reaches one cell and no further', () => {
  // Bounded reach is what keeps this interpolation between measurements rather
  // than extrapolation into empty space.
  const field = new MotionSpeedField();
  const diff = new Uint8ClampedArray(W * H).fill(90);
  field.update(diff, flowAt(8, 8, 6, 8), W, H, 1 / 30, { fullScale: 5, autoScale: false });

  // The vector sits at (8,8) with 8px cells, so a pixel four cells away has no
  // business carrying its speed.
  const far = field.state[40 * W + 56];
  assert.equal(far, UNRESOLVED, 'distant movement must stay unresolved');
  assert.equal(field.state[8 * W + 8], RESOLVED);
});

test('an inferred speed is never counted as a measured one', () => {
  const field = new MotionSpeedField();
  const diff = new Uint8ClampedArray(W * H).fill(90);
  const report = field.update(diff, flowAt(24, 24, 6, 8), W, H, 1 / 30,
    { fullScale: 5, autoScale: false });

  let measured = 0;
  let inferred = 0;
  for (const s of field.state) {
    if (s === RESOLVED) measured++;
    if (s === INFERRED) inferred++;
  }
  assert.ok(inferred > measured, 'one cell of measurement should seed more inference than itself');
  assert.ok(Math.abs(report.inferredFraction - inferred / (W * H)) < 0.02);
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

test('speed varies smoothly across cells instead of in flat blocks', () => {
  // Painting each flow cell one colour draws the sampling grid rather than the
  // scene: a saved frame came back as large flat rectangles of solid colour.
  // The cells are samples of a continuous motion field, so the value between
  // them is interpolated.
  const field = new MotionSpeedField();
  const diff = new Uint8ClampedArray(W * H).fill(90);
  // Three cells in a row with clearly different speeds.
  const flow = {
    cellSize: 16,
    vectors: [
      { x: 8, y: 24, magnitude: 2 },
      { x: 24, y: 24, magnitude: 8 },
      { x: 40, y: 24, magnitude: 3 }
    ]
  };
  field.update(diff, flow, W, H, 1 / 30, { fullScale: 20, autoScale: false });

  const row = [];
  for (let x = 8; x <= 40; x++) row.push(field.speed[24 * W + x]);
  const levels = new Set(row.map((v) => v.toFixed(4)));
  assert.ok(levels.size > 12, `expected a gradient across the cells, got ${levels.size} levels`);

  // And it must actually rise toward the fast cell and fall away from it.
  const at = (x) => field.speed[24 * W + x];
  assert.ok(at(24) > at(16), 'speed should climb toward the fast cell');
  assert.ok(at(24) > at(32), 'and fall away from it');
});
