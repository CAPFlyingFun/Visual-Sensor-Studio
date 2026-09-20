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
  /**
   * MODAL luma, 0..1 — the middle of the fullest bin, which is the level
   * most of the picture actually sits at.
   *
   * The mean is not that, and the difference matters wherever a frame is
   * bimodal. Joshua's room is: dark walls under a bright popcorn ceiling.
   * Its mean lands between the two and describes nothing in the picture, so
   * the walls read as far from it as the ceiling does. The mode lands ON the
   * walls, which is what "the background of this scene" means. Free here —
   * the bins are already counted.
   */
  mode: number;
  /** Share of pixels whose luminance is clipped, 0..1. */
  clipped: number;
  /** Share of pixels whose luminance is crushed, 0..1. */
  crushed: number;
  /**
   * The darkest and brightest luma in the frame, 0..1 — the contrast stretch
   * the relief channel needs. Free here: the loop is already reading every
   * pixel's luminance to build the bins.
   */
  range: [number, number];
  /**
   * THE BLACK AND WHITE POINTS, and they are NOT `range`.
   *
   * range is an absolute minimum and maximum, so one specular highlight or
   * one crushed pixel pins it. Relief found this the hard way and wrote it
   * down in the registry: measured in Joshua's own room, min 0.0000 and max
   * 1.0000, which makes a stretch between them an identity and does nothing
   * at all. It worked around the measurement with a gamma curve rather than
   * fixing it.
   *
   * These are percentiles — the luma below which LEVELS_TAIL of the picture
   * sits, and above which the same share sits. Ignoring a half-percent at
   * each end is what separates "where this picture starts and stops" from
   * "the two most extreme pixels in it".
   *
   * range stays exactly as it was: it is the honest reading of the extremes,
   * and the exposure instrument and relief both depend on it.
   */
  levels: [number, number];
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
    mode: 0,
    range: [0, 1],
    levels: [0, 1],
    clipped: 0,
    crushed: 0,
    channelClipped: [0, 0, 0]
  };
}

/**
 * The share of the picture ignored at EACH end when finding the black and
 * white points. Half a percent: enough to step over a specular highlight, a
 * hot pixel or a crushed corner, small enough that it is still the picture's
 * own extremes and not a guess at them.
 */
export const LEVELS_TAIL = 0.005;

/**
 * Below this measured span, a picture is FLAT and levels leaves it alone.
 *
 * A grey card, a fogged frame, a lens cap: stretching those to fill the
 * range would not reveal contrast, it would invent it, and the result would
 * be mostly amplified sensor noise presented as detail. 0.06 is about 15
 * levels out of 255.
 */
export const LEVELS_MIN_SPAN = 0.06;

/**
 * Walk the histogram in from both ends until LEVELS_TAIL of the picture has
 * been passed. The bin's OUTER edge is taken each time — the low bin's floor
 * and the high bin's ceiling — so the stretch can only ever clip less than
 * the tail asked for, never more.
 */
function percentileLevels(counts: Uint32Array, pixels: number): [number, number] {
  const tail = pixels * LEVELS_TAIL;
  let seen = 0;
  let lowBin = 0;
  for (let i = 0; i < EXPOSURE_BINS; i++) {
    seen += counts[i];
    if (seen > tail) { lowBin = i; break; }
  }
  seen = 0;
  let highBin = EXPOSURE_BINS - 1;
  for (let i = EXPOSURE_BINS - 1; i >= 0; i--) {
    seen += counts[i];
    if (seen > tail) { highBin = i; break; }
  }
  const black = lowBin / EXPOSURE_BINS;
  const white = (highBin + 1) / EXPOSURE_BINS;
  // A picture with nothing in it comes back as an identity rather than as a
  // reversed pair nothing downstream would know what to do with.
  return white > black ? [black, white] : [0, 1];
}

export function buildExposure(data: ArrayLike<number>): ExposureReading {
  const pixels = Math.floor(data.length / 4);
  if (pixels <= 0) return emptyExposure();

  const counts = new Uint32Array(EXPOSURE_BINS);
  let total = 0;
  let clipped = 0;
  let crushed = 0;
  let low = 255;
  let high = 0;
  const channels: [number, number, number] = [0, 0, 0];

  for (let i = 0; i < pixels; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    // Rec. 709, the same weights the shaders' luma() uses.
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    total += y;
    if (y < low) low = y;
    if (y > high) high = y;
    counts[Math.min(EXPOSURE_BINS - 1, Math.floor(y / 256 * EXPOSURE_BINS))] += 1;
    if (y >= CLIPPED) clipped += 1;
    if (y <= CRUSHED) crushed += 1;
    if (r >= CLIPPED) channels[0] += 1;
    if (g >= CLIPPED) channels[1] += 1;
    if (b >= CLIPPED) channels[2] += 1;
  }

  let peak = 0;
  let peakBin = 0;
  for (let i = 0; i < EXPOSURE_BINS; i++) {
    if (counts[i] > peak) { peak = counts[i]; peakBin = i; }
  }
  const bins = new Uint8Array(EXPOSURE_BINS);
  if (peak > 0) {
    for (let i = 0; i < EXPOSURE_BINS; i++) bins[i] = Math.round(counts[i] / peak * 255);
  }

  return {
    bins,
    mean: total / pixels / 255,
    // The middle of the fullest bin, not its edge.
    mode: (peakBin + 0.5) / EXPOSURE_BINS,
    range: [low / 255, high / 255],
    levels: percentileLevels(counts, pixels),
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
