/** Live luminance and RGB histograms over the analysis frame. */

export interface Histogram {
  /** 256 bins. Reused between calls — copy it if you need to keep one. */
  luminance: Uint32Array;
  red: Uint32Array;
  green: Uint32Array;
  blue: Uint32Array;
  /** Largest single luminance bin, for scaling a plot. */
  peakLuminanceBin: number;
  /** Fraction of pixels at or above the clipping threshold, 0..1. */
  clippedFraction: number;
  /** Fraction of pixels at or below the shadow floor, 0..1. */
  crushedFraction: number;
  totalPixels: number;
}

export function createHistogram(): Histogram {
  return {
    luminance: new Uint32Array(256),
    red: new Uint32Array(256),
    green: new Uint32Array(256),
    blue: new Uint32Array(256),
    peakLuminanceBin: 0,
    clippedFraction: 0,
    crushedFraction: 0,
    totalPixels: 0
  };
}

/**
 * Fill `target` from an RGBA frame. Bins are reused rather than reallocated,
 * because this runs on every analysed frame.
 */
export function computeHistogram(
  rgba: ArrayLike<number>,
  target: Histogram,
  clipThreshold = 242,
  shadowFloor = 8
): Histogram {
  target.luminance.fill(0);
  target.red.fill(0);
  target.green.fill(0);
  target.blue.fill(0);

  const pixels = Math.floor(rgba.length / 4);
  let clipped = 0;
  let crushed = 0;

  for (let i = 0, p = 0; i < pixels; i++, p += 4) {
    const r = rgba[p] ?? 0;
    const g = rgba[p + 1] ?? 0;
    const b = rgba[p + 2] ?? 0;
    target.red[r]++;
    target.green[g]++;
    target.blue[b]++;

    const y = Math.round(r * 0.2126 + g * 0.7152 + b * 0.0722);
    const bin = y < 0 ? 0 : y > 255 ? 255 : y;
    target.luminance[bin]++;
    if (bin >= clipThreshold) clipped++;
    if (bin <= shadowFloor) crushed++;
  }

  let peak = 0;
  for (let i = 0; i < 256; i++) {
    if (target.luminance[i] > peak) peak = target.luminance[i];
  }

  target.peakLuminanceBin = peak;
  target.totalPixels = pixels;
  target.clippedFraction = pixels ? clipped / pixels : 0;
  target.crushedFraction = pixels ? crushed / pixels : 0;
  return target;
}
