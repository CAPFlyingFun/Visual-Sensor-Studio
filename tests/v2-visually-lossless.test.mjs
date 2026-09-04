import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  QUALITY_LADDER, VISUALLY_LOSSLESS_SSIM, chooseQuality, describeFileSize,
  busiestCell, describeQuality, detailScore, halveLuma, lumaFromRgba, meanSsim,
  tileAt, tileGrid
} from '../.test-build/v2/capture/visually-lossless.js';

/*
 * "That's an awesome savings at no visual quality loss."
 *
 * The claim in that sentence is the whole problem: no visual quality loss is
 * exactly what this project refuses to assert. These test the measurement
 * that turns it into a number — SSIM against the untouched original, on the
 * busiest tile of the frame, with the search that walks the quality ladder.
 */

/** A field of independent noise — incompressible, and what a dark frame is. */
function noise(width, height, amplitude, base = 128, seed = 1) {
  const out = new Float32Array(width * height);
  let s = seed;
  for (let i = 0; i < out.length; i += 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = base + ((s / 0x7fffffff) - 0.5) * 2 * amplitude;
  }
  return out;
}

test('SSIM is 1 for an image against itself, whatever it contains', () => {
  const a = noise(64, 64, 60);
  assert.equal(Math.abs(meanSsim(a, a, 64, 64) - 1) < 1e-9, true);

  const flat = new Float32Array(64 * 64).fill(7);
  assert.equal(Math.abs(meanSsim(flat, flat, 64, 64) - 1) < 1e-9, true);
});

test('SSIM falls as an image is disturbed, and monotonically', () => {
  const width = 64, height = 64;
  const source = noise(width, height, 50);
  const scores = [2, 8, 32].map((amplitude) => {
    const damaged = Float32Array.from(source);
    const grit = noise(width, height, amplitude, 0, 99);
    for (let i = 0; i < damaged.length; i += 1) damaged[i] += grit[i];
    return meanSsim(source, damaged, width, height);
  });
  assert.ok(scores[0] > scores[1], 'a small disturbance scores above a larger one');
  assert.ok(scores[1] > scores[2], 'and that above a larger one still');
  assert.ok(scores[0] < 1, 'and none of them is a perfect match');
});

test('brightness alone does not change SSIM — the contrast term carries it', () => {
  // Worth pinning because it is the intuition that has to be given up: a
  // dark frame is NOT automatically forgiven. The luminance term is ~1
  // wherever the two means agree, and the rest of the metric sees only
  // variance and covariance, which do not know where the black point is.
  const width = 64, height = 64;
  const disturb = (base) => {
    const source = noise(width, height, 4, base, 3);
    const flattened = new Float32Array(width * height).fill(base);
    return meanSsim(source, flattened, width, height);
  };
  assert.ok(Math.abs(disturb(8) - disturb(200)) < 0.002,
    'the same disturbance costs the same in a dark frame and a bright one');
});

test('halving forgives removed NOISE and still catches damaged STRUCTURE', () => {
  // THE MEASUREMENT THIS WHOLE APPROACH RESTS ON. SSIM against a noisy
  // original punishes an encoder for cleaning grain up, which would pin a
  // grainy frame at quality 1.00 and save nothing — backwards, since grain
  // is most of what a big file is. Halving to viewing scale separates the
  // two cases, and it must be checked in both directions: forgiving noise is
  // only safe if real damage survives the same step.
  const width = 128, height = 128;

  const grainy = noise(width, height, 4, 8, 3);
  const cleaned = new Float32Array(width * height).fill(8);
  const noiseAtFull = meanSsim(grainy, cleaned, width, height);
  const noiseAtHalf = meanSsim(
    halveLuma(grainy, width, height), halveLuma(cleaned, width, height),
    width >> 1, height >> 1);

  const edge = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) edge[y * width + x] = x < width / 2 ? 30 : 220;
  }
  const softened = Float32Array.from(edge);
  for (let y = 0; y < height; y += 1) {
    const i = y * width + width / 2;
    softened[i - 1] = 90;
    softened[i] = 160;
  }
  const edgeAtFull = meanSsim(edge, softened, width, height);
  const edgeAtHalf = meanSsim(
    halveLuma(edge, width, height), halveLuma(softened, width, height),
    width >> 1, height >> 1);

  assert.ok(noiseAtHalf > noiseAtFull + 0.05,
    `removed noise is forgiven by halving (${noiseAtFull.toFixed(4)} -> ${noiseAtHalf.toFixed(4)})`);
  assert.ok(edgeAtHalf <= edgeAtFull,
    `a softened edge is NOT forgiven by it (${edgeAtFull.toFixed(4)} -> ${edgeAtHalf.toFixed(4)})`);
});

test('halving is a 2x2 box average, and refuses to shrink past a pixel', () => {
  const luma = Float32Array.from([
    0, 10, 100, 100,
    20, 30, 100, 100,
    4, 4, 8, 8,
    4, 4, 8, 8
  ]);
  assert.deepEqual(Array.from(halveLuma(luma, 4, 4)), [15, 100, 4, 8]);
  const single = Float32Array.from([5]);
  assert.equal(halveLuma(single, 1, 1), single, 'nothing to halve is returned unchanged');
});

test('a window smaller than 8 px has nothing to measure and says so', () => {
  const tiny = new Float32Array(4 * 4).fill(10);
  assert.equal(meanSsim(tiny, tiny, 4, 4), 0);
  // Mismatched lengths are a caller bug, not a similarity of zero-point-nine.
  assert.equal(meanSsim(new Float32Array(64), new Float32Array(32), 8, 8), 0);
});

test('detail is high-frequency energy, not variance', () => {
  const width = 32, height = 32;
  // A GRADIENT has large variance and compresses almost for free.
  const gradient = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) gradient[y * width + x] = (x / width) * 255;
  }
  // A CHECKERBOARD has the same kind of range and is what a quantiser eats.
  const checker = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) checker[y * width + x] = ((x + y) % 2) * 255;
  }
  assert.ok(detailScore(checker, width, height) > detailScore(gradient, width, height) * 10,
    'the tile that suffers first scores far higher');

  const flat = new Float32Array(width * height).fill(120);
  assert.equal(detailScore(flat, width, height), 0, 'a flat tile has no detail at all');
  assert.equal(detailScore(new Float32Array(4), 2, 2), 0, 'and a tile too small to sample scores none');
});

test('luma follows Rec. 601 and reads RGBA in place', () => {
  const rgba = Uint8ClampedArray.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
  const luma = lumaFromRgba(rgba, 3);
  assert.ok(Math.abs(luma[0] - 0.299 * 255) < 1e-4);
  assert.ok(Math.abs(luma[1] - 0.587 * 255) < 1e-4);
  assert.ok(Math.abs(luma[2] - 0.114 * 255) < 1e-4);
});

test('the tile grid spreads across the frame and never hangs off it', () => {
  const rects = tileGrid(3024, 4032, 256, 3);
  assert.equal(rects.length, 9, 'a 3x3 grid over a frame with room for it');
  for (const rect of rects) {
    assert.equal(rect.width, 256);
    assert.equal(rect.height, 256);
    assert.ok(rect.x >= 0 && rect.x + rect.width <= 3024, 'inside horizontally');
    assert.ok(rect.y >= 0 && rect.y + rect.height <= 4032, 'inside vertically');
  }
  // Corners and centre are genuinely different places, not nine of the same.
  assert.equal(new Set(rects.map((r) => `${r.x},${r.y}`)).size, 9);

  // A frame SMALLER than the tile still gets measured, clamped rather than
  // skipped — and the duplicates that collapse into are not reported twice.
  const small = tileGrid(100, 80, 256, 3);
  assert.equal(small.length, 1);
  assert.deepEqual(small[0], { x: 0, y: 0, width: 100, height: 80 });
  assert.deepEqual(tileGrid(0, 100, 256, 3), []);
});

test('the busiest cell is found on a coarse map, in one read', () => {
  // The picker only decides WHERE to measure. Doing it by cropping each
  // candidate at full resolution cost one GPU readback apiece — nine seconds
  // on a 3840x2160 shutter — so it reads a 96 px map of the whole frame
  // instead. What it must still get right is finding the structure.
  const size = 96;
  const map = new Float32Array(size * size).fill(40);
  // A hard edge parked in the bottom-right cell of a 3x3 grid.
  for (let y = 70; y < 90; y += 1) {
    for (let x = 70; x < 90; x += 1) map[y * size + x] = (x % 2) * 255;
  }
  assert.deepEqual(busiestCell(map, size, size, 3), { col: 2, row: 2 });

  // A flat frame has no busiest anything; it must answer, not wander.
  assert.deepEqual(busiestCell(new Float32Array(size * size).fill(12), size, size, 3),
    { col: 0, row: 0 });
});

test('a cell maps to a tile that stays inside the frame', () => {
  const middle = tileAt(1, 1, 3, 3024, 4032, 256);
  assert.deepEqual(middle, { x: 1384, y: 1888, width: 256, height: 256 });
  // The corner cells are pulled back inside rather than hanging off.
  assert.deepEqual(tileAt(0, 0, 3, 3024, 4032, 256), { x: 376, y: 544, width: 256, height: 256 });
  const last = tileAt(2, 2, 3, 3024, 4032, 256);
  assert.ok(last.x + last.width <= 3024 && last.y + last.height <= 4032);
  // A frame smaller than the tile is clamped, not refused.
  assert.deepEqual(tileAt(2, 2, 3, 100, 80, 256), { x: 0, y: 0, width: 100, height: 80 });
  assert.equal(tileAt(0, 0, 3, 0, 80, 256), null);
});

test('the search returns the smallest file that still measures as identical', async () => {
  // A synthetic encoder whose similarity falls with quality, crossing the
  // floor between two known rungs.
  const asked = [];
  const measure = async (quality) => {
    asked.push(quality);
    return quality >= 0.85 ? 0.995 : 0.97;
  };
  const choice = await chooseQuality(measure, VISUALLY_LOSSLESS_SSIM, QUALITY_LADDER);
  assert.equal(choice.quality, 0.85, 'the lowest rung above the floor');
  assert.equal(choice.ssim, 0.995, 'reported at the quality actually chosen');
  assert.ok(choice.probes <= 4, `a ten-rung ladder in four probes, not ${choice.probes}`);
  assert.ok(!asked.includes(1.00), 'the reference is never re-measured against itself');
});

test('nothing below the floor is ever chosen, however bad the picture', async () => {
  const choice = await chooseQuality(async () => 0.5, VISUALLY_LOSSLESS_SSIM);
  assert.equal(choice.quality, 1.00, 'it falls back to the original quality');
  assert.equal(choice.ssim, 1, 'which is identical to itself by definition');
  assert.equal(describeQuality(choice), 'quality 1.00 — nothing lower measured as lossless');
});

test('an encoder that fails every probe cannot talk the search downward', async () => {
  // A refused encode reports 0, which must read as "worse", never as "fine".
  const choice = await chooseQuality(async () => 0, VISUALLY_LOSSLESS_SSIM);
  assert.equal(choice.quality, 1.00);
});

test('the ladder starts at the reference and only descends', () => {
  assert.equal(QUALITY_LADDER[0], 1.00, 'index 0 is the untouched original');
  for (let i = 1; i < QUALITY_LADDER.length; i += 1) {
    assert.ok(QUALITY_LADDER[i] < QUALITY_LADDER[i - 1], 'strictly descending');
    assert.ok(QUALITY_LADDER[i] > 0 && QUALITY_LADDER[i] < 1, 'and a real JPEG quality');
  }
  assert.ok(VISUALLY_LOSSLESS_SSIM > 0.98 && VISUALLY_LOSSLESS_SSIM < 1,
    'the floor is in the indistinguishable band, not at an unreachable 1');
});

test('a small file is reported in the unit that makes it look small', () => {
  assert.equal(describeFileSize(288_000), '288 KB');
  assert.equal(describeFileSize(3_690_000), '3.69 MB');
  assert.equal(describeFileSize(0), '—');
});

test('the still path measures quality rather than assuming it', () => {
  const photoTs = readFileSync(new URL('../src/v2/capture/photo.ts', import.meta.url), 'utf8');

  // MAX MEANS MAX is about pixels. The geometry must be untouched by this.
  assert.match(photoTs, /photoCanvas\.width = photo\.width;/);
  assert.match(photoTs, /photoCanvas\.height = photo\.height;/);

  // The measurement is on the FULL-RESOLUTION frame, not a proxy of it: a
  // downscale averages away the high-frequency detail that decides the answer.
  assert.match(photoTs, /const SAMPLE_TILE = 256;/);
  assert.match(photoTs, /tileAt\(cell\.col, cell\.row, SAMPLE_CELLS,\s*\n\s*source\.width, source\.height, SAMPLE_TILE\)/,
    'the tile is cut at full resolution');

  // ONE readback decides where to look. Cropping every candidate at full
  // resolution is what made the shutter nine seconds slower.
  assert.match(photoTs, /mapContext\.drawImage\(source, 0, 0, DETAIL_MAP, DETAIL_MAP\);/);
  assert.match(photoTs, /busiestCell\(map, DETAIL_MAP, DETAIL_MAP, SAMPLE_CELLS\)/);
  assert.equal((photoTs.match(/getImageData/g) ?? []).length, 2,
    'exactly two read paths: the coarse map, and the shared halvedLuma');

  // A FAILED MEASUREMENT COSTS FILE SIZE, NEVER FIDELITY.
  assert.match(photoTs, /if \(typeof createImageBitmap !== 'function'\) return null;/);
  assert.match(photoTs, /\} catch \{\s*\n\s*return null;/);
  assert.match(photoTs, /const quality = choice\?\.quality \?\? MAX_STILL_QUALITY;/);
  assert.match(photoTs, /const MAX_STILL_QUALITY = 1\.0;/);

  // THE COMPARISON IS AT VIEWING SCALE, on both sides. Reference and decoded
  // tile must be halved the same way or the SSIM is measured between two
  // different pictures.
  assert.match(photoTs, /const reference = halvedLuma\(context, tile\.width, tile\.height\);/,
    'the reference tile is halved');
  assert.match(photoTs, /return halvedLuma\(context, width, height\);/,
    'and so is every decoded candidate, through the same function');
  assert.match(photoTs, /meanSsim\(reference, luma, tile\.width >> 1, tile\.height >> 1\)/,
    'and it is measured at the halved size');

  // Off is the old behaviour exactly — no search, no cost.
  assert.match(photoTs, /options\.visuallyLossless \? await measureQuality\(photoCanvas\) : null/);

  // The decoded bitmap is released; a 12 MP capture path must not leak one
  // per probe.
  assert.match(photoTs, /\} finally \{\s*\n\s*bitmap\.close\(\);/);
});
