import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateEffectiveResolution } from '../.test-build/vision/sharpness.js';

const W = 128;
const H = 128;

/** A natively sharp frame: detail present at every pixel. */
function sharpFrame(width = W, height = H) {
  const gray = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // High-frequency structure that survives only at full resolution.
      gray[y * width + x] = ((x * 7 + y * 13) % 2 === 0 ? 40 : 210)
        + Math.round(30 * Math.sin((x + y) / 5));
    }
  }
  return gray;
}

/** The same content rendered small, then bilinearly scaled up by `factor`. */
function upscaledFrame(factor) {
  const smallW = Math.round(W / factor);
  const smallH = Math.round(H / factor);
  const small = sharpFrame(smallW, smallH);
  const gray = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(smallH - 1, y / factor);
    const y0 = Math.floor(sy);
    const y1 = Math.min(smallH - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = Math.min(smallW - 1, x / factor);
      const x0 = Math.floor(sx);
      const x1 = Math.min(smallW - 1, x0 + 1);
      const fx = sx - x0;
      const top = small[y0 * smallW + x0] * (1 - fx) + small[y0 * smallW + x1] * fx;
      const bottom = small[y1 * smallW + x0] * (1 - fx) + small[y1 * smallW + x1] * fx;
      gray[y * W + x] = Math.round(top * (1 - fy) + bottom * fy);
    }
  }
  return gray;
}

test('a natively sharp frame is reported as full effective resolution', () => {
  const report = estimateEffectiveResolution(sharpFrame(), W, H);
  assert.equal(report.effectiveScale, 1, `expected full scale, got ${report.effectiveScale}`);
  assert.equal(report.likelyUpscaled, false);
  assert.ok(report.detailRatio < 0.86, `detail must be lost on halving, ratio ${report.detailRatio}`);
});

test('a 2x upscaled frame is caught and its real scale estimated', () => {
  // This is the case that matters: a track reporting 3840x2160 while
  // delivering a scaled-up 1920x1080. The pixel count is real, the detail
  // is not.
  const report = estimateEffectiveResolution(upscaledFrame(2), W, H);
  assert.ok(report.effectiveScale <= 0.5, `expected half scale or less, got ${report.effectiveScale}`);
  assert.equal(report.likelyUpscaled, true);
});

test('a 4x upscaled frame estimates a lower scale still', () => {
  const two = estimateEffectiveResolution(upscaledFrame(2), W, H);
  const four = estimateEffectiveResolution(upscaledFrame(4), W, H);
  assert.ok(four.effectiveScale <= two.effectiveScale,
    `4x (${four.effectiveScale}) must not read sharper than 2x (${two.effectiveScale})`);
  assert.equal(four.likelyUpscaled, true);
});

test('a featureless frame is never called upscaled', () => {
  // A blank wall or a dark room has no detail to lose either, and claiming an
  // upscale from that would be reading noise rather than measuring anything.
  const flat = new Uint8ClampedArray(W * H).fill(128);
  const report = estimateEffectiveResolution(flat, W, H);
  assert.equal(report.likelyUpscaled, false);
  assert.equal(report.effectiveScale, 1);

  const nearlyFlat = new Uint8ClampedArray(W * H);
  for (let i = 0; i < nearlyFlat.length; i++) nearlyFlat[i] = 40 + (i % 2);
  assert.equal(estimateEffectiveResolution(nearlyFlat, W, H).likelyUpscaled, false);
});

test('a tiny frame is handled without throwing', () => {
  const tiny = new Uint8ClampedArray(4).fill(100);
  const report = estimateEffectiveResolution(tiny, 2, 2);
  assert.ok(report.effectiveScale > 0);
});
