/**
 * Still capture — a CaptureService, not filter math.
 *
 * The photo is the SAME shader the preview shows, drawn once at the PHOTO
 * geometry the authority resolved (the negotiated stream size by default),
 * then encoded and reported with its EXACT dimensions and weight. Nothing in
 * here decides a size, chooses a filter, or renders anything itself — one
 * WebGL context serves preview and photo, at different target sizes.
 */

import type { GlRenderer } from '../render/gl-renderer.js';
import type { SizedWithReason } from '../camera/geometry.js';
import {
  busiestCell, chooseQuality, halveLuma, lumaFromRgba, meanSsim, tileAt,
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

/**
 * The sample tile, in source pixels, and the grid it is chosen from.
 *
 * 256 square at FULL RESOLUTION — not a downscaled proxy, which would average
 * away the very artefacts the measurement is looking for. WHERE that tile
 * comes from is decided on a small map of the whole frame instead: cropping
 * nine candidates at full resolution cost nine GPU readbacks and nine seconds
 * of a 3840×2160 shutter, to answer a question a 96 px thumbnail answers.
 */
const SAMPLE_TILE = 256;
const SAMPLE_CELLS = 3;
const DETAIL_MAP = 96;

/** Scratch canvases; sized once per capture and reused across captures. */
let mapCanvas: HTMLCanvasElement | null = null;
let tileCanvas: HTMLCanvasElement | null = null;
let decodeCanvas: HTMLCanvasElement | null = null;

/** Luma of a canvas region, at the half scale every comparison here uses. */
function halvedLuma(
  context: CanvasRenderingContext2D, width: number, height: number
): Float32Array {
  return halveLuma(
    lumaFromRgba(context.getImageData(0, 0, width, height).data, width * height),
    width, height);
}

/** Decode an encoded tile back to luma, so it can be compared with its source. */
async function decodeTileLuma(blob: Blob, width: number, height: number): Promise<Float32Array | null> {
  const bitmap = await createImageBitmap(blob);
  try {
    decodeCanvas ??= document.createElement('canvas');
    decodeCanvas.width = width;
    decodeCanvas.height = height;
    const context = decodeCanvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    return halvedLuma(context, width, height);
  } finally {
    bitmap.close();
  }
}

/**
 * Measure how far this frame can be compressed before it changes.
 *
 * Returns null rather than a guess whenever it cannot answer — no
 * createImageBitmap, no 2D context, an encoder that refuses — and the caller
 * then saves at 1.00 exactly as it always did. A failed measurement must
 * cost file size, never fidelity.
 */
async function measureQuality(source: HTMLCanvasElement): Promise<QualityChoice | null> {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    mapCanvas ??= document.createElement('canvas');
    tileCanvas ??= document.createElement('canvas');
    const mapContext = mapCanvas.getContext('2d', { willReadFrequently: true });
    const context = tileCanvas.getContext('2d', { willReadFrequently: true });
    if (!mapContext || !context) return null;

    // ONE readback of the whole frame, small, to decide where to look.
    mapCanvas.width = DETAIL_MAP;
    mapCanvas.height = DETAIL_MAP;
    mapContext.drawImage(source, 0, 0, DETAIL_MAP, DETAIL_MAP);
    const map = lumaFromRgba(
      mapContext.getImageData(0, 0, DETAIL_MAP, DETAIL_MAP).data, DETAIL_MAP * DETAIL_MAP);
    const cell = busiestCell(map, DETAIL_MAP, DETAIL_MAP, SAMPLE_CELLS);

    // THE BUSIEST CELL, at full resolution: the answer is decided by the part
    // of the picture that suffers first, so measuring anywhere else would
    // report a similarity the rest of the frame does not enjoy.
    const tile = tileAt(cell.col, cell.row, SAMPLE_CELLS,
      source.width, source.height, SAMPLE_TILE);
    if (!tile) return null;
    tileCanvas.width = tile.width;
    tileCanvas.height = tile.height;
    context.drawImage(source, tile.x, tile.y, tile.width, tile.height,
      0, 0, tile.width, tile.height);
    const reference = halvedLuma(context, tile.width, tile.height);

    const canvas = tileCanvas;
    return await chooseQuality(async (quality) => {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!blob) return 0;
      const luma = await decodeTileLuma(blob, tile.width, tile.height);
      return luma ? meanSsim(reference, luma, tile.width >> 1, tile.height >> 1) : 0;
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
   * Measure how far this frame compresses before it changes, and save at
   * that quality instead of at 1.00. Off means the old behaviour byte for
   * byte. Never changes the PHOTO GEOMETRY — MAX MEANS MAX is about pixels,
   * and this is about how many bits each of them is worth.
   */
  visuallyLossless?: boolean;
}

export async function capturePhoto(
  renderer: GlRenderer,
  video: HTMLVideoElement,
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
  if (!options.preRendered) {
    if (!renderer.uploadFrame(video)) return null;
    if (!renderer.render(filterId, { width: photo.width, height: photo.height })) return null;
  }

  photoCanvas ??= document.createElement('canvas');
  photoCanvas.width = photo.width;
  photoCanvas.height = photo.height;
  const context = photoCanvas.getContext('2d');
  if (!context) return null;
  // The copy-out forces the GL work to complete, so the render stage is
  // honestly bounded here rather than at the (asynchronous) draw call.
  context.drawImage(renderer.targetCanvas, 0, 0);
  const renderDone = performance.now();

  // QUALITY IS MEASURED, NOT ASSUMED. It was 0.92 once — a sensible default
  // for a web image and the wrong one for this app, which exists to preserve
  // what the sensor saw — and then 1.00, which preserves the sensor's NOISE
  // at several times the file. Neither number knew anything about the picture
  // in front of it. This one is chosen by comparing real encodes of the real
  // frame, and falls back to 1.00 whenever it cannot be.
  const choice = options.visuallyLossless ? await measureQuality(photoCanvas) : null;
  const searchDone = performance.now();
  const quality = choice?.quality ?? MAX_STILL_QUALITY;
  const blob = await new Promise<Blob | null>((resolve) =>
    photoCanvas!.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) return null;
  const encodeDone = performance.now();

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `visual-sensor-v2-${options.label ?? filterId}-${photo.width}x${photo.height}-${stamp}.jpg`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);

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
