/**
 * EXPOSURE — what the frame's brightness is actually doing, measured.
 *
 * Milestone F's histogram. It answers the two questions a viewfinder cannot:
 * how the light is distributed, and — the one that decides whether a shot is
 * recoverable — how much of it has been LOST at either end. A blown highlight
 * is not bright, it is missing: every pixel at 255 could have been any value
 * above it and the sensor cannot say which. No amount of later processing
 * brings that back, which is why this is worth showing before the shutter
 * rather than after.
 *
 * The same 64×64 sample the colour census already takes serves this too: one
 * read of the frame, several questions asked of it. Counting shares means a
 * uniform stretch to a square changes nothing, since every pixel's weight is
 * the same wherever it came from.
 *
 * LUMA, NOT THE GREEN CHANNEL. Rec. 709 luminance (the same `luma` the
 * shaders use) so the reading agrees with what the filters measure.
 * Per-channel clipping is reported separately, because a red flower can blow
 * its red channel while the luminance still looks comfortable.
 */

/** 64 bins ≈ 4 counts each, and it matches the colour census's resolution. */
export const EXPOSURE_BINS = 64;

/** At or above this, a pixel's true value is unknown — it may be far higher. */
export const CLIPPED = 250;
/** At or below this, shadow detail is gone the same way. */
export const CRUSHED = 5;

export interface ExposureReading {
  /** Share of the frame at each luma, 0–255 scaled so the commonest is 255. */
  bins: Uint8Array;
  /** Mean luma, 0..1. */
  mean: number;
  /** Share of pixels whose luminance is clipped, 0..1. */
  clipped: number;
  /** Share of pixels whose luminance is crushed, 0..1. */
  crushed: number;
  /**
   * Share clipped in EACH channel, 0..1. A saturated colour can lose one
   * channel while luminance still reads mid-grey, and only this notices.
   */
  channelClipped: [number, number, number];
}

export function emptyExposure(): ExposureReading {
  return {
    bins: new Uint8Array(EXPOSURE_BINS),
    mean: 0,
    clipped: 0,
    crushed: 0,
    channelClipped: [0, 0, 0]
  };
}

export function buildExposure(data: ArrayLike<number>): ExposureReading {
  const pixels = Math.floor(data.length / 4);
  if (pixels <= 0) return emptyExposure();

  const counts = new Uint32Array(EXPOSURE_BINS);
  let total = 0;
  let clipped = 0;
  let crushed = 0;
  const channels: [number, number, number] = [0, 0, 0];

  for (let i = 0; i < pixels; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    // Rec. 709, the same weights the shaders' luma() uses.
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    total += y;
    counts[Math.min(EXPOSURE_BINS - 1, Math.floor(y / 256 * EXPOSURE_BINS))] += 1;
    if (y >= CLIPPED) clipped += 1;
    if (y <= CRUSHED) crushed += 1;
    if (r >= CLIPPED) channels[0] += 1;
    if (g >= CLIPPED) channels[1] += 1;
    if (b >= CLIPPED) channels[2] += 1;
  }

  let peak = 0;
  for (const count of counts) if (count > peak) peak = count;
  const bins = new Uint8Array(EXPOSURE_BINS);
  if (peak > 0) {
    for (let i = 0; i < EXPOSURE_BINS; i++) bins[i] = Math.round(counts[i] / peak * 255);
  }

  return {
    bins,
    mean: total / pixels / 255,
    clipped: clipped / pixels,
    crushed: crushed / pixels,
    channelClipped: [channels[0] / pixels, channels[1] / pixels, channels[2] / pixels]
  };
}

/**
 * The reading in one sentence.
 *
 * Deliberately does NOT say "well exposed" or "underexposed": a night sky is
 * mostly crushed and correct, a snowfield is mostly bright and correct. It
 * reports what was lost and leaves the judgement to whoever framed the shot.
 */
export function describeExposure(reading: ExposureReading): string {
  // ANY loss reads as loss. Rounding a single clipped pixel down to "0%"
  // would be a small lie from an instrument whose entire subject is what has
  // gone missing — only a genuine none is none.
  const percent = (value: number): string =>
    value <= 0 ? '0%' : value < 0.01 ? '<1%' : `${Math.round(value * 100)}%`;
  const parts = [`mean ${Math.round(reading.mean * 100)}%`];
  parts.push(`${percent(reading.clipped)} blown`);
  parts.push(`${percent(reading.crushed)} crushed`);
  const worst = Math.max(...reading.channelClipped);
  if (worst > reading.clipped + 0.01) {
    const name = ['red', 'green', 'blue'][reading.channelClipped.indexOf(worst)];
    parts.push(`${percent(worst)} of ${name} clipped on its own`);
  }
  return parts.join(' · ');
}
