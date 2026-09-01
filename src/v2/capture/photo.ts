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
  fileName: string;
  reason: string;
}

/** Copy target, reused across captures; photo sizes dwarf preview sizes. */
let photoCanvas: HTMLCanvasElement | null = null;

export async function capturePhoto(
  renderer: GlRenderer,
  video: HTMLVideoElement,
  filterId: string,
  photo: SizedWithReason
): Promise<PhotoResult | null> {
  if (!renderer.uploadFrame(video)) return null;
  if (!renderer.render(filterId, { width: photo.width, height: photo.height })) return null;

  photoCanvas ??= document.createElement('canvas');
  photoCanvas.width = photo.width;
  photoCanvas.height = photo.height;
  const context = photoCanvas.getContext('2d');
  if (!context) return null;
  context.drawImage(renderer.targetCanvas, 0, 0);

  const blob = await new Promise<Blob | null>((resolve) =>
    photoCanvas!.toBlob(resolve, 'image/jpeg', 0.92));
  if (!blob) return null;

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
    fileName,
    reason: photo.reason
  };
}
