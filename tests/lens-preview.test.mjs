import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LensPreview,
  RAMP_PRESETS,
  TEST_BAR_SPEEDS,
  drawTestScene,
  previewStep
} from '../.test-build/vision/lens-preview.js';
import { MotionSpeedField, UNRESOLVED } from '../.test-build/vision/motion-ironbow.js';
import { absoluteDifference } from '../.test-build/vision/frame-processing.js';
import { sanitiseLens } from '../.test-build/vision/lens-store.js';

const W = 120;
const H = 68;

function lensOn(channel, extra = {}) {
  return sanitiseLens({
    name: channel,
    color: { channel, low: 0, high: 1, gamma: 1 },
    stops: [{ at: 0, color: '#000000' }, { at: 1, color: '#ffffff' }],
    base: 'black',
    sceneBlend: 0,
    ...extra
  });
}

test('the test scene is deterministic', () => {
  // A preview that drifted would make two people comparing the same lens see
  // different pictures, and would make the quoted speeds unreproducible.
  const a = new Uint8ClampedArray(W * H);
  const b = new Uint8ClampedArray(W * H);
  drawTestScene(a, W, H, 1.25);
  drawTestScene(b, W, H, 1.25);
  assert.deepEqual(a, b);
});

test('the scene actually changes over time', () => {
  const a = new Uint8ClampedArray(W * H);
  const b = new Uint8ClampedArray(W * H);
  drawTestScene(a, W, H, 0);
  drawTestScene(b, W, H, 0.5);
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed++;
  assert.ok(changed > a.length * 0.01, `expected visible motion, ${changed} pixels moved`);
});

test('the scene has texture everywhere, so speed is measurable', () => {
  // The speed estimate divides by the local image gradient. A flat region has
  // none, so a scene without grain would read as unresolved everywhere and
  // teach the opposite of what it is for.
  const gray = new Uint8ClampedArray(W * H);
  drawTestScene(gray, W, H, 0.4);
  let flatRows = 0;
  for (let y = 1; y < H - 1; y++) {
    let spread = 0;
    for (let x = 1; x < W - 1; x++) {
      spread += Math.abs(gray[y * W + x] - gray[y * W + x + 1]);
    }
    if (spread / W < 0.5) flatRows++;
  }
  assert.equal(flatRows, 0, 'every row needs some texture');
});

test('the bars really travel at the speeds the caption quotes', () => {
  // The caption under the preview states three numbers, so they have to be
  // properties of the scene rather than decoration. This measures them out of
  // the RENDERED frames — the bar's brightness centroid tracked frame to
  // frame — rather than trusting the generator's own arithmetic.
  const dt = 1 / 20;
  const window = Math.floor(W * 0.7);
  const barHeight = Math.max(3, Math.round(H * 0.1));
  const barWidth = Math.max(4, Math.round(W * 0.09));
  const frames = [];
  const gray = new Uint8ClampedArray(W * H);
  for (let k = 0; k < 200; k++) {
    drawTestScene(gray, W, H, k * dt);
    frames.push(Uint8ClampedArray.from(gray));
  }

  TEST_BAR_SPEEDS.forEach((quoted, index) => {
    const top = Math.round(H * (0.08 + index * 0.16));
    const centroid = (frame) => {
      let sum = 0;
      let weight = 0;
      for (let y = top + 1; y < top + barHeight - 1; y++) {
        for (let x = 0; x < window; x++) {
          const value = frame[y * W + x];
          if (value > 125) {
            sum += x * value;
            weight += value;
          }
        }
      }
      return weight > 0 ? sum / weight : null;
    };
    const steps = [];
    for (let k = 1; k < frames.length; k++) {
      const a = centroid(frames[k - 1]);
      const b = centroid(frames[k]);
      if (a === null || b === null) continue;
      // Only frames where the bar is wholly inside the window: a straddling
      // bar has a truncated centroid that moves for the wrong reason.
      if (a < 2 || b < 2 || a > window - barWidth || b > window - barWidth) continue;
      // And not the wrap, which is a jump rather than a step.
      if (Math.abs(b - a) > barWidth) continue;
      steps.push(b - a);
    }
    assert.ok(steps.length > 20, `bar ${index} was not observed enough times`);
    // The MEAN, not the median. The slow bar moves 0.3 of a pixel per frame,
    // so individual steps quantise to 0 or 1 and only their average recovers
    // the true rate; a median would report whichever of the two is commoner.
    const measured = steps.reduce((sum, step) => sum + step, 0) / steps.length / dt / W;
    assert.ok(
      Math.abs(measured - quoted) < 0.012,
      `bar ${index} is quoted ${quoted} w/s but travels ${measured.toFixed(4)} w/s`
    );
  });
});

test('the speed estimate ranks the bars in the right order', () => {
  // A per-pixel normal-flow estimate is biased: inside a textured block the
  // local gradient varies, and where it is weak the ratio inflates, so it
  // reads high rather than recovering the quoted number. What it must get
  // right — and what makes it usable for designing a lens — is the ORDER.
  const field = new MotionSpeedField();
  const gray = new Uint8ClampedArray(W * H);
  const previous = new Uint8ClampedArray(W * H);
  const difference = new Uint8ClampedArray(W * H);
  const dt = 1 / 20;
  const barHeight = Math.max(3, Math.round(H * 0.1));
  const samples = TEST_BAR_SPEEDS.map(() => []);

  for (let k = 0; k < 120; k++) {
    previous.set(gray);
    drawTestScene(gray, W, H, k * dt);
    absoluteDifference(gray, previous, difference);
    field.update(difference, gray, W, H, k === 0 ? 0 : dt);
    if (k < 20) continue;
    TEST_BAR_SPEEDS.forEach((_, index) => {
      const top = Math.round(H * (0.08 + index * 0.16));
      const row = [];
      for (let y = top + 1; y < top + barHeight - 1; y++) {
        for (let x = 2; x < W - 2; x++) {
          const i = y * W + x;
          if (field.state[i] === 1 && field.rawSpeed[i] > 0) row.push(field.rawSpeed[i]);
        }
      }
      if (row.length > 4) {
        row.sort((a, b) => a - b);
        samples[index].push(row[Math.floor(row.length / 2)]);
      }
    });
  }

  const medians = samples.map((list) => {
    list.sort((a, b) => a - b);
    return list[Math.floor(list.length / 2)];
  });
  assert.ok(medians.every((m) => m > 0), `every bar should register: ${medians}`);
  assert.ok(medians[0] < medians[1], `slow ${medians[0]} should read under medium ${medians[1]}`);
  assert.ok(medians[1] < medians[2], `medium ${medians[1]} should read under fast ${medians[2]}`);
});

test('the lens speed channel is in real units, not an auto-scaled ratio', () => {
  // MotionSpeedField.speed is divided by a running auto-scale so the built-in
  // Ironbow keeps a slow scene readable. A lens is SAVED and SHARED, so a
  // range set today has to describe the same motion tomorrow — against a
  // scale that moves with the scene it would not.
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /sources\.speed = \{ values: speedField\.rawSpeed/);
  const preview = readFileSync(new URL('../src/vision/lens-preview.ts', import.meta.url), 'utf8');
  assert.match(preview, /values: this\.speedField\.rawSpeed/);
});

test('the still checkerboard is not reported as moving', () => {
  // Sharp edges that do not move are the case a change-detector gets wrong.
  const field = new MotionSpeedField();
  const gray = new Uint8ClampedArray(W * H);
  const previous = new Uint8ClampedArray(W * H);
  const difference = new Uint8ClampedArray(W * H);
  const dt = 1 / 20;
  for (let frame = 0; frame < 30; frame++) {
    previous.set(gray);
    drawTestScene(gray, W, H, frame * dt);
    absoluteDifference(gray, previous, difference);
    field.update(difference, gray, W, H, frame === 0 ? 0 : dt);
  }
  // The checkerboard patch, per drawTestScene.
  const x0 = Math.round(W * 0.06);
  const y0 = Math.round(H * 0.62);
  const size = Math.max(8, Math.round(Math.min(W, H) * 0.26));
  let moving = 0;
  let counted = 0;
  for (let y = y0 + 2; y < Math.min(H, y0 + size - 2); y++) {
    for (let x = x0 + 2; x < Math.min(W, x0 + size - 2); x++) {
      const i = y * W + x;
      counted++;
      if (field.state[i] !== 0 && field.state[i] !== UNRESOLVED && field.speed[i] > 0.02) moving++;
    }
  }
  assert.ok(counted > 20, 'the patch should be sampled');
  assert.ok(moving / counted < 0.25, `${((moving / counted) * 100).toFixed(0)}% of a still patch read as moving`);
});

test('every channel produces a picture in the preview', () => {
  // A channel that renders black no matter what would be an editor option
  // that appears broken. The scene has to exercise all of them.
  const channels = ['luma', 'speed', 'change', 'edges', 'relief', 'age', 'novelty'];
  for (const channel of channels) {
    const preview = new LensPreview(W, H);
    const lens = lensOn(channel);
    // Enough frames for the background model to warm up and trails to fill.
    let lit = 0;
    let rgba;
    for (let frame = 0; frame < 90; frame++) {
      rgba = preview.step(lens, 1 / 20);
    }
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i] + rgba[i + 1] + rgba[i + 2] > 24) lit++;
    }
    assert.ok(lit > 20, `${channel} rendered an almost empty preview (${lit} lit pixels)`);
  }
});

test('the preview never disturbs the camera pipeline', () => {
  // It owns its own speed field, trail buffer and background model. Sharing
  // the camera's would mean opening the editor destroyed a trail already
  // being recorded.
  const source = readFileSync(new URL('../src/vision/lens-preview.ts', import.meta.url), 'utf8');
  assert.match(source, /private speedField = new MotionSpeedField\(\)/);
  assert.match(source, /private trails = new MotionTrailBuffer\(\)/);
  assert.match(source, /private background = new BackgroundModel\(\)/);
});

test('the preview uses the real modules rather than faking channels', () => {
  const source = readFileSync(new URL('../src/vision/lens-preview.ts', import.meta.url), 'utf8');
  for (const real of ['MotionSpeedField', 'sobelEdges', 'reliefField', 'absoluteDifference', 'BackgroundModel']) {
    assert.ok(source.includes(real), `the preview must run the real ${real}`);
  }
});

test('a stalled tab cannot fast-forward the scene', () => {
  // requestAnimationFrame stops in a background tab; the first frame back
  // would otherwise carry a multi-second step and jump the bars across the
  // frame, which reads as a speed spike that never happened.
  assert.equal(previewStep(5), 0.2);
  assert.equal(previewStep(-1), 0);
  assert.equal(previewStep(0.05), 0.05);
});

test('every preset ramp is usable as it stands', () => {
  assert.ok(RAMP_PRESETS.length >= 4);
  for (const preset of RAMP_PRESETS) {
    assert.ok(preset.stops.length >= 2, `${preset.name} needs a ramp`);
    for (const stop of preset.stops) {
      assert.match(stop.color, /^#[0-9a-f]{6}$/i, `${preset.name} has a bad colour`);
      assert.ok(stop.at >= 0 && stop.at <= 1);
    }
    const sorted = [...preset.stops].sort((a, b) => a.at - b.at);
    assert.deepEqual(preset.stops, sorted, `${preset.name} should be listed in ramp order`);
  }
});
