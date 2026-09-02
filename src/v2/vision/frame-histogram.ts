/**
 * What colours this frame is MADE of — the measurement three lens ideas were
 * all waiting on (Rare Colour Finder, Dominant Colour Suppression,
 * Background Colour Subtract).
 *
 * A hue histogram over a small sample of the frame. Two facts come out of it:
 *
 *   bins      how much of the frame shares each hue, scaled so the commonest
 *             hue is 255. A pixel's RARITY is one minus its bin.
 *   dominant  the frame's prevailing colour — the peak of the histogram, with
 *             the strength and brightness measured from the pixels that
 *             actually voted for it rather than guessed.
 *
 * SATURATION IS THE VOTE. A grey pixel has no hue to speak of: its "hue" is
 * whichever way the arithmetic fell, so counting it would let a white wall
 * elect a colour. Each pixel therefore votes with its own colour strength,
 * and a frame with no colour in it reports no dominant hue rather than a
 * confident wrong one.
 *
 * Pure: pixels in, numbers out. The shell decides how often to call it and on
 * how small a frame — this never touches the DOM or the GPU.
 */

import { rgbToHsvValues } from './colour-gap.js';

/** 64 bins ≈ 5.6° each, and a hue maps straight onto a 64-texel lookup. */
export const HISTOGRAM_BINS = 64;

export interface FrameHistogram {
  /** Share of the frame's colour at each hue, 0–255, commonest hue = 255. */
  bins: Uint8Array;
  /** The prevailing colour as HSV, each 0..1. */
  dominant: [number, number, number];
  /** How much of the frame carried enough colour to vote at all, 0..1. */
  colourShare: number;
}

/** Below this saturation a pixel's hue is arithmetic rather than a colour. */
const VOTE_FLOOR = 0.12;

/**
 * A histogram with nothing in it yet: every hue equally common, so a lens
 * bound to rarity reads "nothing unusual here" while it waits, rather than
 * declaring the whole picture rare.
 */
export function emptyHistogram(): FrameHistogram {
  return {
    bins: new Uint8Array(HISTOGRAM_BINS).fill(255),
    dominant: [0, 0, 0],
    colourShare: 0
  };
}

export function buildHistogram(data: ArrayLike<number>): FrameHistogram {
  const pixels = Math.floor(data.length / 4);
  if (pixels <= 0) return emptyHistogram();

  const weights = new Float64Array(HISTOGRAM_BINS);
  // Strength and brightness accumulate per bin, so the dominant colour is
  // reported as it was actually seen.
  const strengths = new Float64Array(HISTOGRAM_BINS);
  const values = new Float64Array(HISTOGRAM_BINS);
  let voted = 0;

  for (let i = 0; i < pixels; i++) {
    const [h, s, v] = rgbToHsvValues(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    if (s < VOTE_FLOOR) continue;
    const bin = Math.min(HISTOGRAM_BINS - 1, Math.floor(h * HISTOGRAM_BINS));
    weights[bin] += s;
    strengths[bin] += s * s;
    values[bin] += s * v;
    voted++;
  }

  let peak = 0;
  let peakWeight = 0;
  for (let bin = 0; bin < HISTOGRAM_BINS; bin++) {
    if (weights[bin] > peakWeight) {
      peakWeight = weights[bin];
      peak = bin;
    }
  }
  if (peakWeight <= 0) return emptyHistogram();

  const bins = new Uint8Array(HISTOGRAM_BINS);
  for (let bin = 0; bin < HISTOGRAM_BINS; bin++) {
    bins[bin] = Math.round((weights[bin] / peakWeight) * 255);
  }
  return {
    bins,
    dominant: [
      (peak + 0.5) / HISTOGRAM_BINS,
      Math.min(1, strengths[peak] / peakWeight),
      Math.min(1, values[peak] / peakWeight)
    ],
    colourShare: voted / pixels
  };
}
