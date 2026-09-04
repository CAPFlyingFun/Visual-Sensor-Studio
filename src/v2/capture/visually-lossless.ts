/**
 * HOW SMALL CAN THIS PICTURE GET BEFORE IT CHANGES? — measured, not guessed.
 *
 * Joshua, 2026-09-04, on a still this app saved at 3024×4032 and 3.69 MB:
 * "with a photo compression app, I got that same image and resolution at
 * 288KB. That's an awesome savings at no visual quality loss."
 *
 * He is right, and the reason is specific rather than magic. The still path
 * encodes at JPEG quality 1.00, which is the most expensive point on the
 * curve and very nearly the least useful: at 1.00 the quantisation tables are
 * flat, so the encoder spends bits reproducing SENSOR NOISE exactly —
 * grain it took the night stack real effort to average away. The last few
 * percent of nominal quality routinely costs several times the file for a
 * difference no eye can find. (Most encoders, Safari's included, also switch
 * chroma subsampling around the top of the range, which is a second multiple
 * on the same invisible ground.)
 *
 * THE TRAP is that "no visual quality loss" is exactly the kind of claim this
 * project does not accept on assertion. A fixed quality number would be a
 * guess applied to every picture — too high for a smooth dark room, too low
 * for a page of text — and MAX MEANS MAX has already been broken once by a
 * limit that seemed sensible in the abstract.
 *
 * So this measures. The picture is encoded at candidate qualities and the
 * result compared against the untouched original with SSIM, and the smallest
 * file whose measured similarity still clears the floor is the one saved.
 * The comparison is done on the BUSIEST TILE of the frame at full
 * resolution — the part that suffers first — so the number reported is a
 * worst case for the picture rather than an average that fine detail hides
 * inside.
 *
 * Everything here is pure: pixels and an injected encoder in, numbers out.
 * The DOM work (encoding, decoding, cropping) lives in photo.ts.
 */

/**
 * SSIM constants from Wang et al. 2004, "Image Quality Assessment: From Error
 * Visibility to Structural Similarity", IEEE TIP 13(4) — K1=0.01, K2=0.03
 * over an 8-bit dynamic range. They exist to stabilise the ratio where local
 * variance approaches zero, which is most of a dark frame, so they are not
 * an optional detail here.
 */
const L = 255;
const C1 = (0.01 * L) ** 2;
const C2 = (0.03 * L) ** 2;

/**
 * THE ONE CHOSEN NUMBER. Structural similarity at or above this counts as
 * visually lossless.
 *
 * 0.99 is the low end of what the literature treats as indistinguishable,
 * and it is used here in a deliberately conservative way: it is required of
 * the WORST tile in the frame, not of the frame's average, so the typical
 * region lands well above it. Raising it toward 1 does not buy visible
 * fidelity, it just walks back up the part of the curve where bits buy noise.
 */
export const VISUALLY_LOSSLESS_SSIM = 0.99;

/**
 * Candidate qualities, descending. Index 0 must be 1.00: it is the reference
 * the others are measured against, so it is similar to itself by definition
 * and is what the search falls back to when nothing else clears the floor.
 *
 * The rungs crowd together at the top because that is where the size curve
 * is steep, and stop at 0.60 because that is where it stops being a curve.
 * Measured on one of Joshua's own 3024×4032 frames, full size, real encoder:
 *
 *   q1.00  2139 KB      q0.60  345 KB      q0.40  296 KB      q0.20  249 KB
 *
 * Six-fold by 0.60, and then almost nothing: another whole third off the
 * quality number buys 14% of the file. There is no reason to go looking for
 * bytes down there, so the ladder does not — the bottom rung is where the
 * saving ends, not an opinion about where quality does.
 */
export const QUALITY_LADDER: readonly number[] = [
  1.00, 0.95, 0.92, 0.90, 0.85, 0.80, 0.75, 0.70, 0.65, 0.60
];

/**
 * Half the width and half the height, by 2×2 box average.
 *
 * WHY THE COMPARISON IS NOT MADE AT 1:1, which is the least obvious decision
 * here and the one that makes this work at all.
 *
 * SSIM against a noisy original punishes the encoder for REMOVING NOISE. A
 * flat, grainy patch quantises to a flat, clean patch, and the metric sees
 * all of the original's local variance disappear: measured here, that scores
 * 0.916 — far under any sane floor — so a grainy frame would pin the search
 * at 1.00 and save nothing. Which is precisely backwards, because grain is
 * what a big file is mostly made of and losing it is not losing the picture.
 *
 * Halving separates the two, and this was measured rather than hoped for:
 *
 *   noise removed from a flat patch   0.9163 at 1:1  →  0.9776 at 1:2
 *   an edge softened by one pixel     0.9419 at 1:1  →  0.9153 at 1:2
 *
 * Noise forgiven, STRUCTURE STILL CAUGHT — the edge scores worse after
 * halving, not better, because averaging concentrates a real error while it
 * cancels an unbiased one. So the measurement keeps its teeth for the damage
 * a person would actually see.
 *
 * It is also the honest scale to ask the question at. A 3024-wide photo on a
 * phone screen about 1200 physical pixels across is already being shown at
 * better than 2:1, so 1:2 is finer than the picture is ever displayed at,
 * and finer still than the eye resolves at arm's length. The encode itself
 * always happens at FULL resolution — it is the comparison that steps back,
 * because that is where the viewer is standing.
 */
export function halveLuma(luma: Float32Array, width: number, height: number): Float32Array {
  const w = width >> 1;
  const h = height >> 1;
  if (w < 1 || h < 1) return luma;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = 2 * y * width + 2 * x;
      out[y * w + x] = (luma[i] + luma[i + 1] + luma[i + width] + luma[i + width + 1]) / 4;
    }
  }
  return out;
}

/** Luma (Rec. 601) from packed RGBA, which is what getImageData hands back. */
export function lumaFromRgba(rgba: ArrayLike<number>, pixels: number): Float32Array {
  const out = new Float32Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    const p = i * 4;
    out[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  return out;
}

/**
 * Mean SSIM over 8×8 windows.
 *
 * Uniform windows rather than the paper's 11×11 Gaussian, and a stride of 4
 * rather than 1. Both are the usual fast approximation, and both are chosen
 * for a reason beyond speed: JPEG quantises in 8×8 blocks, so an 8-wide
 * window is the size of the artefact being looked for. The stride halves the
 * window count in each axis and changes the result in the third decimal.
 */
export function meanSsim(
  a: Float32Array, b: Float32Array, width: number, height: number
): number {
  const win = 8;
  const stride = 4;
  if (a.length !== b.length || width < win || height < win) return 0;
  let total = 0;
  let windows = 0;
  for (let y = 0; y + win <= height; y += stride) {
    for (let x = 0; x + win <= width; x += stride) {
      let sumA = 0, sumB = 0, sumAA = 0, sumBB = 0, sumAB = 0;
      for (let j = 0; j < win; j += 1) {
        let index = (y + j) * width + x;
        for (let i = 0; i < win; i += 1, index += 1) {
          const va = a[index];
          const vb = b[index];
          sumA += va; sumB += vb;
          sumAA += va * va; sumBB += vb * vb; sumAB += va * vb;
        }
      }
      const n = win * win;
      const muA = sumA / n;
      const muB = sumB / n;
      // Population moments, matching the reference implementation's use of
      // the biased estimator — the bias is identical on both images and
      // cancels in the ratio.
      const varA = sumAA / n - muA * muA;
      const varB = sumBB / n - muB * muB;
      const covAB = sumAB / n - muA * muB;
      total += ((2 * muA * muB + C1) * (2 * covAB + C2))
        / ((muA * muA + muB * muB + C1) * (varA + varB + C2));
      windows += 1;
    }
  }
  return windows > 0 ? total / windows : 0;
}

/**
 * How much high-frequency detail a tile carries — the mean absolute
 * Laplacian of its luma.
 *
 * Variance would be the obvious measure and it is the wrong one: a smooth
 * gradient across a tile has large variance and compresses almost for free,
 * while a patch of fine texture can have modest variance and be the first
 * thing a quantiser destroys. The Laplacian answers the question actually
 * being asked — how much does this neighbourhood disagree with itself.
 */
export function detailScore(luma: Float32Array, width: number, height: number): number {
  if (width < 3 || height < 3 || luma.length < width * height) return 0;
  let total = 0;
  let counted = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      total += Math.abs(4 * luma[i] - luma[i - 1] - luma[i + 1]
        - luma[i - width] - luma[i + width]);
      counted += 1;
    }
  }
  return counted > 0 ? total / counted : 0;
}

/** Where a sample tile sits in the frame, in source pixels. */
export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Tile positions to consider, spread evenly across the frame.
 *
 * Clamped rather than skipped when the frame is smaller than the grid would
 * like: a small picture still deserves a measurement, and a tile that hangs
 * off the edge would sample undefined pixels.
 */
export function tileAt(
  col: number, row: number, cells: number,
  frameWidth: number, frameHeight: number, tile: number
): TileRect | null {
  const width = Math.min(tile, frameWidth);
  const height = Math.min(tile, frameHeight);
  if (!(width > 0) || !(height > 0) || !(cells > 0)) return null;
  // Centre of the cell, then pulled back inside the frame.
  const cx = ((col + 0.5) / cells) * frameWidth;
  const cy = ((row + 0.5) / cells) * frameHeight;
  return {
    x: Math.round(Math.min(Math.max(0, cx - width / 2), frameWidth - width)),
    y: Math.round(Math.min(Math.max(0, cy - height / 2), frameHeight - height)),
    width,
    height
  };
}

export function tileGrid(
  frameWidth: number, frameHeight: number, tile: number, cells: number
): TileRect[] {
  const rects: TileRect[] = [];
  const seen = new Set<string>();
  for (let row = 0; row < cells; row += 1) {
    for (let col = 0; col < cells; col += 1) {
      const rect = tileAt(col, row, cells, frameWidth, frameHeight, tile);
      if (!rect) return [];
      const key = `${rect.x},${rect.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rects.push(rect);
    }
  }
  return rects;
}

/**
 * Which cell of the frame carries the most structure, read off a COARSE MAP
 * of the whole picture rather than off the cells themselves.
 *
 * The obvious implementation — crop each candidate tile at full resolution
 * and score it — costs one GPU readback per candidate, and that is not
 * theoretical: it added nine seconds to a 3840×2160 shutter in the headless
 * renderer, every one of them a "GPU stall due to ReadPixels". The picker
 * only has to decide WHERE to look, and one small downscale of the frame
 * answers that in a single read; the measurement itself still happens on a
 * full-resolution tile, which is the part that has to be exact.
 *
 * Downscaling is safe HERE for the same reason the comparison halves: edges
 * survive it and grain does not, and an edge is what this is hunting for.
 */
export function busiestCell(
  luma: Float32Array, width: number, height: number, cells: number
): { col: number; row: number } {
  let bestCol = 0;
  let bestRow = 0;
  let best = -1;
  for (let row = 0; row < cells; row += 1) {
    for (let col = 0; col < cells; col += 1) {
      const x0 = Math.floor((col * width) / cells);
      const x1 = Math.floor(((col + 1) * width) / cells);
      const y0 = Math.floor((row * height) / cells);
      const y1 = Math.floor(((row + 1) * height) / cells);
      let total = 0;
      let counted = 0;
      // Interior only: a Laplacian needs all four neighbours, and reaching
      // across a cell edge would score the boundary rather than the cell.
      for (let y = Math.max(1, y0); y < Math.min(height - 1, y1); y += 1) {
        for (let x = Math.max(1, x0); x < Math.min(width - 1, x1); x += 1) {
          const i = y * width + x;
          total += Math.abs(4 * luma[i] - luma[i - 1] - luma[i + 1]
            - luma[i - width] - luma[i + width]);
          counted += 1;
        }
      }
      const score = counted > 0 ? total / counted : 0;
      if (score > best) {
        best = score;
        bestCol = col;
        bestRow = row;
      }
    }
  }
  return { col: bestCol, row: bestRow };
}

export interface QualityChoice {
  /** The quality to encode the full frame at. */
  quality: number;
  /** Measured SSIM at that quality, on the tile it was measured on. */
  ssim: number;
  /** How many candidate encodes it took to get there. */
  probes: number;
}

/**
 * The lowest quality on the ladder whose measured similarity still clears the
 * floor.
 *
 * A BINARY SEARCH, which assumes similarity falls as quality falls. That is
 * true of every JPEG encoder in the sense that matters — a coarser
 * quantisation cannot reproduce more — but it is not guaranteed monotone to
 * the third decimal, so the returned ssim is always one that was actually
 * measured at the returned quality rather than interpolated from a neighbour.
 *
 * Four probes cover a ten-rung ladder. Each is a tile-sized encode, which is
 * a rounding error beside the twelve-megapixel one it is choosing for.
 */
export async function chooseQuality(
  measure: (quality: number) => Promise<number>,
  floor: number = VISUALLY_LOSSLESS_SSIM,
  ladder: readonly number[] = QUALITY_LADDER
): Promise<QualityChoice> {
  if (ladder.length === 0) return { quality: 1, ssim: 1, probes: 0 };
  // Index 0 is the reference and needs no measurement: it is the original.
  let best = 0;
  let bestSsim = 1;
  let low = 1;
  let high = ladder.length - 1;
  let probes = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const ssim = await measure(ladder[mid]);
    probes += 1;
    if (ssim >= floor) {
      best = mid;
      bestSsim = ssim;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return { quality: ladder[best], ssim: bestSsim, probes };
}

/**
 * A file's size in the unit it deserves.
 *
 * The still note said "0.29 MB" for a file this change was written to make
 * small, which reads as a rounding error rather than as the point. Below a
 * megabyte a picture is measured in kilobytes.
 */
export function describeFileSize(bytes: number): string {
  if (!(bytes > 0)) return '—';
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${(bytes / 1e6).toFixed(2)} MB`;
}

/** The choice in the words of the readout. */
export function describeQuality(choice: QualityChoice | null): string {
  if (!choice) return 'quality 1.00 (uncompared)';
  if (choice.quality >= 1) return 'quality 1.00 — nothing lower measured as lossless';
  return `quality ${choice.quality.toFixed(2)} · SSIM ${choice.ssim.toFixed(4)} on the busiest tile`;
}
