/**
 * Cropping a captured frame to a chosen aspect ratio.
 *
 * A camera cannot change its aspect ratio: the sensor reads out 4:3 (or
 * whatever its modes offer) and that is what arrives. A 16:9 photograph from
 * such a sensor is a 4:3 frame with the excess removed — there is no way to
 * gain field of view, only to give some up.
 *
 * So this only ever CROPS, never pads and never stretches. A widescreen crop
 * of a portrait frame takes from the sides; of a landscape frame, from the top
 * and bottom. The centre is kept because that is where a person aims.
 */

/** The region of a frame that satisfies a target ratio, centred. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Crop `width`×`height` to `ratio`, expressed as long side over short side.
 *
 * The ratio is applied in the frame's own ORIENTATION: a 16:9 request against
 * a portrait frame produces 9:16, because turning the phone should not turn
 * the photograph. Asking for a shape the frame already has returns the frame.
 */
export function cropToAspect(width: number, height: number, ratio: number): CropRect {
  if (!(width > 0) || !(height > 0) || !(ratio > 0)) {
    // Math.max(0, NaN) is NaN, so a non-finite size has to be replaced rather
    // than clamped — a NaN width propagates into a canvas size and the frame
    // silently never appears.
    const safe = (value: number) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
    return { x: 0, y: 0, width: safe(width), height: safe(height) };
  }

  const portrait = height > width;
  // long/short, so a single number describes both orientations.
  const target = portrait ? 1 / ratio : ratio;
  const current = width / height;

  let cropWidth = width;
  let cropHeight = height;
  if (current > target) {
    // Too wide for the target: take from the sides.
    cropWidth = Math.round(height * target);
  } else if (current < target) {
    // Too tall: take from the top and bottom.
    cropHeight = Math.round(width / target);
  }

  cropWidth = Math.max(1, Math.min(width, cropWidth));
  cropHeight = Math.max(1, Math.min(height, cropHeight));
  return {
    x: Math.floor((width - cropWidth) / 2),
    y: Math.floor((height - cropHeight) / 2),
    width: cropWidth,
    height: cropHeight
  };
}

export type SaveAspect = 'sensor' | 'wide';

/** Long-side-over-short-side ratio for a save option, or null to keep the frame. */
export function aspectRatioFor(option: SaveAspect): number | null {
  return option === 'wide' ? 16 / 9 : null;
}

/** How much of the frame a crop keeps, 0..1 — the cost, stated. */
export function retainedFraction(
  width: number,
  height: number,
  crop: CropRect
): number {
  const total = width * height;
  return total > 0 ? (crop.width * crop.height) / total : 0;
}
