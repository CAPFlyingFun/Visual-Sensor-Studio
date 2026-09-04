/**
 * Running a lens over a full-resolution photograph.
 *
 * The live camera path is limited by what `getUserMedia` negotiates — a video
 * stream, a few megapixels at best. A photograph taken by the system camera
 * app is not: an iPhone still is tens of megapixels, and once it is a file the
 * browser can read every one of those pixels. So the highest-detail lens
 * picture this app can produce does not come from its own camera at all.
 *
 * WHAT A STILL CANNOT GIVE. Four of the seven channels are temporal — image
 * speed, change, time since motion, and departure from a learned background
 * all need a sequence. One photograph has no sequence, so those channels are
 * genuinely absent rather than zero, and a lens bound to one renders empty.
 * That is reported, not hidden, because an empty picture with no explanation
 * looks like a broken feature rather than an honest answer.
 */

import { reliefField, rgbaToGray, sobelEdges } from './frame-processing.js';
import {
  buildRampLut,
  renderLens,
  type ChannelId,
  type ChannelSource,
  type CustomLens
} from './lens.js';

/** Channels that need a sequence, and so cannot exist for one photograph. */
export const TEMPORAL_CHANNELS: readonly ChannelId[] = ['speed', 'change', 'age', 'novelty'];

/**
 * WHERE THE STEPPING STARTS: the image's OWN pixel count, and nothing else.
 *
 * There used to be a fixed 16 MP ceiling here. Joshua removed it, 2026-09-04:
 * "the max pixel count needs to be (device-width * device-height) as each
 * camera is different and won't have a set number." He is right, and the
 * ceiling was never what made this safe.
 *
 * WHAT MAKES IT SAFE IS THE VERIFICATION, which is unchanged. iOS Safari
 * refuses to back a canvas beyond a device-dependent area and hands back a
 * BLANK one rather than an error, so no number written here could have been
 * correct for every device anyway — the honest move is to attempt the real
 * size and CHECK. decodePhoto draws, reads the pixels back, and halves the
 * budget whenever the result comes back blank or the canvas throws, up to
 * five times. That loop measures the device; a constant only ever guessed at
 * it, and guessed low on every camera larger than 16 MP.
 */
export function fullPixelBudget(sourceWidth: number, sourceHeight: number): number {
  return Math.max(1, Math.floor(sourceWidth) * Math.floor(sourceHeight));
}

export interface DecodedPhoto {
  data: ImageData;
  /** The file's own size, before any reduction. */
  sourceWidth: number;
  sourceHeight: number;
  /** True when the image had to be reduced to be decodable. */
  reduced: boolean;
}

export interface PhotoCanvasHost {
  createCanvas(width: number, height: number): {
    context: CanvasRenderingContext2D | null;
    width: number;
    height: number;
  };
}

/**
 * Has this canvas actually been drawn, or did the browser hand back a blank?
 *
 * A canvas too large for the device does not throw. It silently contains
 * nothing, and a lens over nothing is a picture of the base colour — which
 * would look like a bug in the lens rather than a limit of the browser.
 *
 * THE TEST IS ALPHA, not colour. An undrawn canvas is transparent black, so
 * every channel including alpha is zero; a photograph that decoded is opaque
 * wherever it was drawn however dark it is. Judging by RGB alone would call a
 * night photograph blank and then shrink it, repeatedly, until it gave up on
 * an image that was never the problem — and this app is used in the dark on
 * purpose.
 */
export function looksBlank(data: ArrayLike<number>, pixels: number): boolean {
  if (pixels <= 0) return true;
  const samples = Math.min(4000, pixels);
  const stride = Math.max(1, Math.floor(pixels / samples));
  for (let i = 0; i < pixels; i += stride) {
    const p = i * 4;
    if ((data[p + 3] ?? 0) !== 0) return false;
    if ((data[p] ?? 0) !== 0 || (data[p + 1] ?? 0) !== 0 || (data[p + 2] ?? 0) !== 0) return false;
  }
  // The last pixel too: a sparse stride can step over the only drawn corner.
  const last = (pixels - 1) * 4;
  return (data[last + 3] ?? 0) === 0
    && (data[last] ?? 0) === 0
    && (data[last + 1] ?? 0) === 0
    && (data[last + 2] ?? 0) === 0;
}

/** The size to decode at, preserving aspect, never above `maxPixels`. */
export function fitWithin(
  width: number,
  height: number,
  maxPixels: number
): { width: number; height: number; reduced: boolean } {
  const pixels = width * height;
  if (pixels <= maxPixels || pixels <= 0) return { width, height, reduced: false };
  const scale = Math.sqrt(maxPixels / pixels);
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    reduced: true
  };
}

export interface PhotoLensReport {
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  reduced: boolean;
  /** Bound channels a single photograph cannot supply. */
  missing: ChannelId[];
  /** Fraction of the frame the lens had a reading for. */
  coverage: number;
}

/**
 * Which of a lens's bound channels a photograph cannot answer.
 *
 * Reported before rendering so the caller can say so plainly rather than
 * presenting an empty picture and letting it be read as a failure.
 */
export function unavailableChannels(lens: CustomLens): ChannelId[] {
  const bound = new Set<ChannelId>([lens.color.channel]);
  if (lens.brightness) bound.add(lens.brightness.channel);
  return TEMPORAL_CHANNELS.filter((id) => bound.has(id));
}

/**
 * Paint a lens over a decoded photograph, at the photograph's own size.
 *
 * Only the spatial channels are supplied, because only those exist. Buffers
 * are allocated once and released with the call: at sixteen megapixels each
 * one is tens of megabytes, and holding them between renders is how a phone
 * browser discards the tab.
 */
export function renderPhotoLens(
  lens: CustomLens,
  photo: DecodedPhoto,
  out?: Uint8ClampedArray
): { rgba: Uint8ClampedArray; report: PhotoLensReport } {
  const { width, height } = photo.data;
  const gray = rgbaToGray(photo.data.data);
  const sources: ChannelSource = {};
  const bound = new Set<ChannelId>([lens.color.channel]);
  if (lens.brightness) bound.add(lens.brightness.channel);

  if (bound.has('luma')) sources.luma = { values: gray };
  if (bound.has('edges') || bound.has('relief')) {
    const edges = sobelEdges(gray, width, height);
    if (bound.has('edges')) sources.edges = { values: edges };
    if (bound.has('relief')) sources.relief = { values: reliefField(gray, width, height, undefined, edges) };
  }

  const rgba = out && out.length === width * height * 4
    ? out
    : new Uint8ClampedArray(width * height * 4);
  const result = renderLens(lens, sources, gray, width, height, rgba, buildRampLut(lens.stops));

  return {
    rgba,
    report: {
      width,
      height,
      sourceWidth: photo.sourceWidth,
      sourceHeight: photo.sourceHeight,
      reduced: photo.reduced,
      missing: unavailableChannels(lens),
      coverage: result.coverage
    }
  };
}

/** A short, honest sentence about what a still could not supply. */
export function describeMissing(missing: readonly ChannelId[]): string {
  if (!missing.length) return '';
  const names: Record<string, string> = {
    speed: 'image speed',
    change: 'change',
    age: 'time since motion',
    novelty: 'departure from the background'
  };
  const list = missing.map((id) => names[id] ?? id).join(' and ');
  return `This lens reads ${list}, which needs a sequence of frames — one photograph has none,`
    + ' so that part renders empty. Bind it to brightness, edges or relief for a still.';
}
