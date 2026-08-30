/**
 * Effective-resolution estimation.
 *
 * A track can report 3840x2160 while delivering a scaled-up 1920x1080: the
 * pixel count is real, the detail is not. `width: { ideal: 3840 }` is
 * satisfiable by any scaler, so an honest reading of the reported resolution
 * is not an honest reading of the image.
 *
 * The test is a halve-and-restore round trip. Downscaling an image by two and
 * scaling it back destroys detail that only existed at the finer scale, so a
 * natively sharp image loses a lot of high-frequency energy. An image that was
 * already upscaled has no such detail to lose, and comes back nearly
 * unchanged. Comparing energy before and after therefore says whether the
 * pixels are carrying information or interpolation.
 */

/**
 * Mean neighbour-to-neighbour difference — a cheap stand-in for the energy
 * living at this image's own pixel scale.
 *
 * The differences are FORWARD (x+1 minus x), deliberately, not central
 * (x+1 minus x-1). A central difference spans two pixels, so it is exactly
 * blind to the one frequency this whole file exists to measure: an alternating
 * pixel pattern reads as zero gradient because the two sampled neighbours are
 * always the same phase. That made a maximally sharp frame look featureless and
 * a blurred one look detailed, which is the reverse of the truth.
 */
/** Below this mean difference there is nothing to measure. */
const FLATNESS_FLOOR = 1.2;

/**
 * Energy surviving the round trip below this means the level held real detail.
 *
 * The round trip is itself lossy — box-halving is a genuine low-pass, so even
 * an image that holds nothing at its own pixel scale does not come back
 * untouched. Measured on synthetic frames, a natively sharp image returns about
 * 0.02 of its energy and one already upscaled by two returns about 0.27, so the
 * boundary sits in the order-of-magnitude gap between them rather than near 1.
 */
const DETAIL_THRESHOLD = 0.2;

function gradientEnergy(gray: ArrayLike<number>, width: number, height: number): number {
  if (width < 2 || height < 2) return 0;
  let total = 0;
  let count = 0;
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const i = y * width + x;
      const dx = (gray[i + 1] ?? 0) - (gray[i] ?? 0);
      const dy = (gray[i + width] ?? 0) - (gray[i] ?? 0);
      total += Math.abs(dx) + Math.abs(dy);
      count++;
    }
  }
  return count ? total / count : 0;
}

/** Box-filter halving. */
function halve(gray: ArrayLike<number>, width: number, height: number): {
  data: Float32Array;
  width: number;
  height: number;
} {
  const w = Math.max(1, width >> 1);
  const h = Math.max(1, height >> 1);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x * 2;
      const sy = y * 2;
      const a = gray[sy * width + sx] ?? 0;
      const b = gray[sy * width + Math.min(sx + 1, width - 1)] ?? 0;
      const c = gray[Math.min(sy + 1, height - 1) * width + sx] ?? 0;
      const d = gray[Math.min(sy + 1, height - 1) * width + Math.min(sx + 1, width - 1)] ?? 0;
      out[y * w + x] = (a + b + c + d) / 4;
    }
  }
  return { data: out, width: w, height: h };
}

/** Bilinear doubling back to the original geometry. */
function double(
  source: ArrayLike<number>,
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number
): Float32Array {
  const out = new Float32Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y++) {
    const sy = Math.min(height - 1, y / 2);
    const y0 = Math.floor(sy);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < targetWidth; x++) {
      const sx = Math.min(width - 1, x / 2);
      const x0 = Math.floor(sx);
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = sx - x0;
      const top = (source[y0 * width + x0] ?? 0) * (1 - fx) + (source[y0 * width + x1] ?? 0) * fx;
      const bottom = (source[y1 * width + x0] ?? 0) * (1 - fx) + (source[y1 * width + x1] ?? 0) * fx;
      out[y * targetWidth + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return out;
}

export interface SharpnessReport {
  /**
   * Energy surviving one halve-and-restore at the frame's own size, 0..1.
   * Low means the pixels carry information; high means they carry
   * interpolation, which is what an upscale looks like.
   */
  detailRatio: number;
  /**
   * Fraction of the reported width that appears to carry real detail. 1 means
   * the pixels are earning their keep; 0.5 means about half of them are
   * interpolation.
   *
   * This is a COARSE floor, not a measurement: the search stops at the first
   * level holding detail, so a heavily upscaled frame reads as merely upscaled
   * rather than by exactly how much. Treat 0.5 as "at least halved".
   */
  effectiveScale: number;
  /** True when the frame looks materially upscaled. */
  likelyUpscaled: boolean;
}

/**
 * Detail present at this frame's own pixel scale, and how far below its
 * nominal size the real information appears to stop.
 *
 * A frame that genuinely has no texture — a blank wall, a dark room — also has
 * nothing to lose, so it can read as upscaled. This is an indicator to show
 * beside the reported resolution, not a measurement to act on automatically.
 */
export function estimateEffectiveResolution(
  gray: ArrayLike<number>,
  width: number,
  height: number,
  levels = 3
): SharpnessReport {
  let current: ArrayLike<number> = gray;
  let currentWidth = width;
  let currentHeight = height;
  let effectiveScale = 1;
  let detailRatio = 1;

  for (let level = 1; level <= levels; level++) {
    // The reference is measured at THIS level's geometry, not at the frame's
    // full size. Comparing a half-size energy against a full-size one compares
    // two different scales and means nothing.
    const reference = gradientEnergy(current, currentWidth, currentHeight);
    if (reference < FLATNESS_FLOOR) {
      // Too flat to judge. Claiming an upscale from an empty image would be
      // reading noise, so stop wherever we got to and call it honest.
      return { detailRatio, effectiveScale: level === 1 ? 1 : effectiveScale, likelyUpscaled: false };
    }

    const small = halve(current, currentWidth, currentHeight);
    const restored = double(small.data, small.width, small.height, currentWidth, currentHeight);
    const ratio = gradientEnergy(restored, currentWidth, currentHeight) / reference;
    if (level === 1) detailRatio = ratio;

    if (ratio < DETAIL_THRESHOLD) {
      // Halving destroyed real information, so this level is carrying detail
      // and the search stops here.
      return { detailRatio, effectiveScale, likelyUpscaled: effectiveScale < 0.75 };
    }

    effectiveScale /= 2;
    current = small.data;
    currentWidth = small.width;
    currentHeight = small.height;
  }

  return { detailRatio, effectiveScale, likelyUpscaled: effectiveScale < 0.75 };
}
