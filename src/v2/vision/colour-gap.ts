/**
 * How far one colour is from another — written ONCE.
 *
 * The shader needs this to decide what a lens matches; the app needs it to
 * report how much of the frame is matching right now. Two evaluators are
 * unavoidable (one runs on the GPU per pixel, one on the CPU over a sample),
 * so the thing that must not fork is the FORMULA: the weights live here as
 * constants, the GLSL is generated from those same constants, and a test
 * pins the two together.
 */

/** Tuning, stated as tuning: strength and brightness matter less than hue. */
export const GAP_WEIGHTS = { strength: 0.5, brightness: 0.35 } as const;

/** RGB (0–255) to HSV, each 0..1 — the one conversion in the TypeScript half. */
export function rgbToHsvValues(r: number, g: number, b: number): [number, number, number] {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const span = max - min;
  let hue = 0;
  if (span > 0) {
    if (max === red) hue = ((green - blue) / span + 6) % 6;
    else if (max === green) hue = (blue - red) / span + 2;
    else hue = (red - green) / span + 4;
    hue /= 6;
  }
  return [hue, max > 0 ? span / max : 0, max];
}

/**
 * 0 is the same colour, 1 is as far as this measure goes. The hue term is
 * weighted by how colourful BOTH colours are, because the hue of a grey
 * pixel is arithmetic rather than a measurement.
 */
export function colourGap(
  hsv: readonly [number, number, number],
  reference: readonly [number, number, number]
): number {
  let dh = Math.abs(hsv[0] - reference[0]);
  dh = Math.min(dh, 1 - dh) * 2;
  const ds = Math.abs(hsv[1] - reference[1]);
  const dv = Math.abs(hsv[2] - reference[2]);
  const hueWeight = Math.min(hsv[1], reference[1]);
  return Math.min(1, Math.sqrt(
    dh * dh * hueWeight + ds * ds * GAP_WEIGHTS.strength + dv * dv * GAP_WEIGHTS.brightness));
}

/** The same formula for the GPU, built from the same numbers. */
export const COLOUR_GAP_GLSL = `float colourGap(vec3 hsv, vec3 ref) {
  float dh = abs(hsv.x - ref.x);
  dh = min(dh, 1.0 - dh) * 2.0;
  float ds = abs(hsv.y - ref.y);
  float dv = abs(hsv.z - ref.z);
  float hueWeight = min(hsv.y, ref.y);
  return clamp(sqrt(dh * dh * hueWeight
    + ds * ds * ${GAP_WEIGHTS.strength.toFixed(2)}
    + dv * dv * ${GAP_WEIGHTS.brightness.toFixed(2)}), 0.0, 1.0);
}`;

/**
 * What share of a sampled frame this lens would call a match — the number
 * that answers "is this working, or is nothing here that colour?". A pixel
 * counts as matched when the lens's own range puts it past halfway, so the
 * reading follows the range the user set rather than a second opinion.
 */
export function matchShare(
  data: ArrayLike<number>,
  reference: readonly [number, number, number],
  normalise: (gap255: number) => number
): number {
  const pixels = Math.floor(data.length / 4);
  if (pixels <= 0) return 0;
  let matched = 0;
  for (let i = 0; i < pixels; i++) {
    const hsv = rgbToHsvValues(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    if (normalise(colourGap(hsv, reference) * 255) >= 0.5) matched++;
  }
  return matched / pixels;
}
