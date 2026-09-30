/**
 * Still capture — a CaptureService, not filter math.
 *
 * The photo is the SAME shader the preview shows, drawn once at the PHOTO
 * geometry the authority resolved (the negotiated stream size by default),
 * then encoded and reported with its EXACT dimensions and weight. Nothing in
 * here decides a size, chooses a filter, or renders anything itself — one
 * WebGL context serves preview and photo, at different target sizes.
 */

import type { Enhancement } from '../render/enhancement.js';
import type { GlRenderer } from '../render/gl-renderer.js';
import type { SizedWithReason } from '../camera/geometry.js';
import {
  chooseQuality, rgbaSimilarity, tileGrid,
  type QualityChoice
} from './visually-lossless.js';

export interface PhotoResult {
  width: number;
  height: number;
  bytes: number;
  /** The encoded JPEG itself — held so a fresh tap can share it to Photos. */
  blob: Blob;
  fileName: string;
  reason: string;
  /** The JPEG quality this file was actually encoded at. */
  quality: number;
  /** What the quality search measured, or null when it did not run. */
  choice: QualityChoice | null;
  /** Measured stage costs: GPU render + copy-out, quality search, encoding. */
  timing: { renderMs: number; searchMs: number; encodeMs: number };
}

/**
 * JPEG quality for a saved still when nothing is measured: 1.0, no
 * compromise. Every other stage here is spent keeping detail, so a guessed
 * number is not the place to give it back. It is also what the quality
 * search falls back to whenever it cannot run or cannot prove better.
 */
const MAX_STILL_QUALITY = 1.0;

/** Nine distributed full-resolution crops, packed into one small probe atlas.
 * Includes quiet and colorful regions rather than only the busiest patch.
 * One atlas encode per quality candidate; no full-frame candidate encodes.
 */
const SAMPLE_TILE = 128;
const SAMPLE_CELLS = 3;
let tileCanvas: HTMLCanvasElement | null = null;
let decodeCanvas: HTMLCanvasElement | null = null;

async function measureQuality(source: HTMLCanvasElement): Promise<QualityChoice | null> {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const tiles = tileGrid(source.width, source.height, SAMPLE_TILE, SAMPLE_CELLS);
    if (!tiles.length) return null;
    const width = tiles[0].width;
    const height = tiles[0].height;
    if (width < 8 || height < 8) return null;
    tileCanvas ??= document.createElement('canvas');
    const canvas = tileCanvas;
    canvas.width = width * tiles.length;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    const references = tiles.map((tile, index) => {
      context.drawImage(source, tile.x, tile.y, width, height, index * width, 0, width, height);
      return context.getImageData(index * width, 0, width, height).data;
    });
    return await chooseQuality(async (quality) => {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!blob) return 0;
      const bitmap = await createImageBitmap(blob);
      try {
        decodeCanvas ??= document.createElement('canvas');
        decodeCanvas.width = canvas.width;
        decodeCanvas.height = height;
        const decoded = decodeCanvas.getContext('2d', { willReadFrequently: true });
        if (!decoded) return 0;
        decoded.drawImage(bitmap, 0, 0);
        return Math.min(...references.map((reference, index) => rgbaSimilarity(reference,
          decoded.getImageData(index * width, 0, width, height).data, width, height)));
      } finally {
        bitmap.close();
      }
    });
  } catch {
    return null;
  }
}

/** Copy target, reused across captures; photo sizes dwarf preview sizes. */
let photoCanvas: HTMLCanvasElement | null = null;

export interface CaptureOptions {
  /**
   * The target canvas ALREADY holds the picture to save, so this must not
   * upload a live frame over it. Night's four-second stack is the case: the
   * result is an accumulation of many frames, and re-rendering the current
   * one would save the single frame that happened to be arriving instead.
   */
  preRendered?: boolean;
  /** Names the file in place of the filter id (e.g. 'night'). */
  label?: string;
  /**
   * The frame's measured [min, max] luma. Grid stretches its height into this
   * range, and without it the still silently falls back to [0, 1] and comes
   * out a different picture from the preview the shutter was pressed on.
   */
  lumaRange?: [number, number];
  /**
   * The frame's modal luma, from the same census. The region fill measures
   * every patch against it, so a still saved without it would fill against a
   * background of zero and light up the whole picture.
   */
  background?: number;
  /**
   * CLARITY, and it must be here. The aids are forced to zero on this path
   * so stripes can never be baked into a file; clarity is the opposite kind
   * of thing — an edit — so a still saved without it would come out softer
   * than the preview the shutter was pressed on.
   */
  clarity?: { amount: number; floor: number };
  enhancement?: Enhancement;
  /**
   * AUTO-LEVELS, and it must be here for the same reason clarity is: it is
   * an EDIT, so a still saved without it would come out flatter than the
   * picture the shutter was pressed on. The renderer still refuses it for
   * any filter whose output is not the frame's tone.
   */
  levels?: { black: number; white: number; amount: number };
  /**
   * Measure how far this frame compresses before it changes, and save at
   * that quality instead of at 1.00. Off means the old behaviour byte for
   * byte. Never changes the PHOTO GEOMETRY — MAX MEANS MAX is about pixels,
   * and this is about how many bits each of them is worth.
   */
  visuallyLossless?: boolean;
}

/**
 * What a still is rendered FROM: the live camera element, or a frame already
 * held from it.
 *
 * Both are the same picture through the same shader at the same size; the
 * only difference is which upload the texture comes from. That is what lets
 * the review step re-render a shot — a different clarity, a different lens —
 * and still be looking at the capture path rather than a second one that
 * would drift from it (Rule 4).
 */
export type StillSource =
  HTMLVideoElement | ImageBitmap | HTMLImageElement | HTMLCanvasElement;

/**
 * THE RENDER HALF OF A CAPTURE, on its own.
 *
 * Split out for the review's live preview, which needs the picture on screen
 * the instant a setting changes and cannot afford the encode that follows:
 * a full-size JPEG at quality 1.00, and the decode back from it, are what
 * made every lens tap feel like an export. The preview draws the renderer's
 * own canvas; the file is still encoded from this same render, so there is
 * ONE definition of what a capture looks like (Rule 4) rather than a preview
 * path quietly drifting from the saved path.
 *
 * Nothing here encodes, copies out or allocates. False means the frame could
 * not be uploaded or the filter could not be drawn.
 */
export function renderStill(
  renderer: GlRenderer,
  source: StillSource,
  filterId: string,
  photo: SizedWithReason,
  options: CaptureOptions = {}
): boolean {
  // 'videoWidth' in source rather than instanceof: this module is loaded in
  // environments where the DOM constructor is not a global, and a capture
  // that threw a ReferenceError there would be a test-only failure wearing
  // the costume of a camera one.
  const uploaded = 'videoWidth' in source
    ? renderer.uploadFrame(source)
    : renderer.uploadHeld(source);
  if (!uploaded) return false;
  return renderer.render(filterId, { width: photo.width, height: photo.height },
    undefined, {
      lumaRange: options.lumaRange,
      background: options.background,
      clarity: options.clarity,
      enhancement: options.enhancement,
      levels: options.levels
    });
}

export async function capturePhoto(
  renderer: GlRenderer,
  source: StillSource,
  filterId: string,
  photo: SizedWithReason,
  options: CaptureOptions = {}
): Promise<PhotoResult | null> {
  // FRAME AVERAGING is deliberately NOT applied to a still, and Joshua named
  // the reason (2026-09-02): "the still images are fine because it has a
  // chance to grab one good frame and not moving". The averaging exists to
  // steady a LIVE preview being re-rolled thirty times a second; a photo has
  // no such problem, and blending a moving frame into it would only smear a
  // picture that was already sharp. render() below asks for none, on purpose.
  const t0 = performance.now();
  if (!options.preRendered
    && !renderStill(renderer, source, filterId, photo, options)) return null;

  photoCanvas ??= document.createElement('canvas');
  photoCanvas.width = photo.width;
  photoCanvas.height = photo.height;
  const context = photoCanvas.getContext('2d');
  if (!context) return null;
  // The copy-out forces the GL work to complete, so the render stage is
  // honestly bounded here rather than at the (asynchronous) draw call.
  context.drawImage(renderer.targetCanvas, 0, 0);
  const renderDone = performance.now();

  // Maximum quality bypasses probing. Opt-in compression is a sampled estimate
  // with a conservative lower bound; failed checks keep the 1.00 setting.
  const choice = options.visuallyLossless ? await measureQuality(photoCanvas) : null;
  const searchDone = performance.now();
  const quality = choice?.quality ?? MAX_STILL_QUALITY;
  const blob = await new Promise<Blob | null>((resolve) =>
    photoCanvas!.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) return null;
  const encodeDone = performance.now();

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `visual-sensor-v2-${options.label ?? filterId}-${photo.width}x${photo.height}-${stamp}.jpg`;

  // A CAPTURE WRITES NOTHING. It returns the bytes and the name for them; the
  // shell decides whether that ever becomes a file, and the only way it does
  // is a Share tap.
  //
  // This used to end with an <a download> and a synthetic click on every
  // single capture. On a desktop browser that is a silent download nobody
  // asked for. In an installed iOS PWA there is no download — Safari opens a
  // file viewer over the app, a JPG icon with the file's name and size and
  // "Open in Preview", and the only way out is the ✕.
  //
  // Joshua, 2026-09-21, with a screenshot of exactly that: "it still pop-ups
  // with show preview or save when it shouldn't". It fired on import because
  // opening a picture in the review encodes it — and once the review began
  // re-encoding after every setting, it fired again on every adjustment.
  //
  // The line beside offerShare that said "nothing has been written to disk"
  // was therefore false for the whole of this path, which is the part worth
  // keeping in mind: the readout was honest about the intent and the code
  // was doing something else.

  return {
    width: photo.width,
    height: photo.height,
    bytes: blob.size,
    blob,
    fileName,
    reason: photo.reason,
    quality,
    choice,
    timing: {
      renderMs: renderDone - t0,
      searchMs: searchDone - renderDone,
      encodeMs: encodeDone - searchDone
    }
  };
}
