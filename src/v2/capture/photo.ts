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

export interface PhotoResult {
  width: number;
  height: number;
  bytes: number;
  /** The encoded JPEG itself — held so a fresh tap can share it to Photos. */
  blob: Blob;
  fileName: string;
  reason: string;
  /** Measured stage costs: GPU render + copy-out, then JPEG encoding. */
  timing: { renderMs: number; encodeMs: number };
}

/** Copy target, reused across captures; photo sizes dwarf preview sizes. */
let photoCanvas: HTMLCanvasElement | null = null;

export async function capturePhoto(
  renderer: GlRenderer,
  video: HTMLVideoElement,
  filterId: string,
  photo: SizedWithReason,
  /**
   * SMOOTHING, in texels — the caller reads it from the one owner. A still
   * that measured the frame differently from the viewfinder it was framed in
   * would not be the same shader at a different size any more.
   */
  denoise = 0
): Promise<PhotoResult | null> {
  const t0 = performance.now();
  if (!renderer.uploadFrame(video)) return null;
  if (!renderer.render(filterId, { width: photo.width, height: photo.height },
    undefined, { denoise })) return null;

  photoCanvas ??= document.createElement('canvas');
  photoCanvas.width = photo.width;
  photoCanvas.height = photo.height;
  const context = photoCanvas.getContext('2d');
  if (!context) return null;
  // The copy-out forces the GL work to complete, so the render stage is
  // honestly bounded here rather than at the (asynchronous) draw call.
  context.drawImage(renderer.targetCanvas, 0, 0);
  const renderDone = performance.now();

  const blob = await new Promise<Blob | null>((resolve) =>
    photoCanvas!.toBlob(resolve, 'image/jpeg', 0.92));
  if (!blob) return null;
  const encodeDone = performance.now();

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `visual-sensor-v2-${filterId}-${photo.width}x${photo.height}-${stamp}.jpg`;
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
    timing: { renderMs: renderDone - t0, encodeMs: encodeDone - renderDone }
  };
}
