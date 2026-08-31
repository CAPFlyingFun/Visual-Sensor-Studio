import { clamp } from '../core/math.js';

export function rgbaToGray(rgba: Uint8ClampedArray, out?: Uint8ClampedArray): Uint8ClampedArray {
  const count = Math.floor(rgba.length / 4);
  const gray = out && out.length === count ? out : new Uint8ClampedArray(count);
  for (let i = 0, p = 0; p < count; i += 4, p++) {
    gray[p] = Math.round(rgba[i] * 0.2126 + rgba[i + 1] * 0.7152 + rgba[i + 2] * 0.0722);
  }
  return gray;
}

export function sobelEdges(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  out?: Uint8ClampedArray
): Uint8ClampedArray {
  const count = width * height;
  const edges = out && out.length === count ? out : new Uint8ClampedArray(count);
  if (out) edges.fill(0);
  if (width < 3 || height < 3) return edges;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const a = gray[i - width - 1];
      const b = gray[i - width];
      const c = gray[i - width + 1];
      const d = gray[i - 1];
      const f = gray[i + 1];
      const g = gray[i + width - 1];
      const h = gray[i + width];
      const j = gray[i + width + 1];

      const gx = -a + c - 2 * d + 2 * f - g + j;
      const gy = -a - 2 * b - c + g + 2 * h + j;
      edges[i] = clamp(Math.round(Math.hypot(gx, gy)), 0, 255);
    }
  }
  return edges;
}

export function grayToRgba(gray: ArrayLike<number>, alpha = 255): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(gray.length * 4);
  for (let i = 0; i < gray.length; i++) {
    const value = clamp(Math.round(gray[i] ?? 0), 0, 255);
    const p = i * 4;
    rgba[p] = value;
    rgba[p + 1] = value;
    rgba[p + 2] = value;
    rgba[p + 3] = alpha;
  }
  return rgba;
}

/**
 * Relief as a single value per pixel, 0..255.
 *
 * This is the number `reliefFromGray` paints in grey, pulled out so a custom
 * lens can colour the same field rather than re-deriving it slightly
 * differently. It is CONTRAST-STRETCHED SHADING with an edge term — bright
 * reads as near, dark reads as far, because that is how a lit surface usually
 * behaves. It is not a distance and nothing here measures one.
 */
export function reliefField(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  out?: Uint8ClampedArray,
  edgeField?: Uint8ClampedArray
): Uint8ClampedArray {
  const edges = edgeField ?? sobelEdges(gray, width, height);
  const field = out && out.length === gray.length ? out : new Uint8ClampedArray(gray.length);
  let min = 255;
  let max = 0;
  for (const value of gray) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < gray.length; i++) {
    const normalized = (gray[i] - min) / range;
    const localEdge = edges[i] / 255;
    field[i] = clamp(Math.round(normalized * 215 + localEdge * 40), 0, 255);
  }
  return field;
}

export function reliefFromGray(gray: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const field = reliefField(gray, width, height);
  const rgba = new Uint8ClampedArray(gray.length * 4);
  for (let i = 0; i < field.length; i++) {
    const p = i * 4;
    rgba[p] = field[i];
    rgba[p + 1] = field[i];
    rgba[p + 2] = field[i];
    rgba[p + 3] = 255;
  }
  return rgba;
}

export function disparityToRgba(disparity: Float32Array, confidence: Float32Array, maxDisparity: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(disparity.length * 4);
  const maxD = Math.max(1, maxDisparity);

  for (let i = 0; i < disparity.length; i++) {
    const d = disparity[i];
    const c = clamp(confidence[i] ?? 0, 0, 1);
    const p = i * 4;
    if (!Number.isFinite(d)) {
      rgba[p] = 9;
      rgba[p + 1] = 13;
      rgba[p + 2] = 21;
      rgba[p + 3] = 255;
      continue;
    }

    const t = clamp(d / maxD, 0, 1);
    rgba[p] = Math.round(35 + 220 * t);
    rgba[p + 1] = Math.round(80 + 120 * (1 - Math.abs(t - 0.5) * 2));
    rgba[p + 2] = Math.round(235 - 190 * t);
    rgba[p + 3] = Math.round(110 + 145 * Math.max(0.25, c));
  }
  return rgba;
}

export interface LuminanceStats {
  /** Mean luminance, 0..255. */
  mean: number;
  /** Population standard deviation of luminance, 0..~128. */
  standardDeviation: number;
  min: number;
  max: number;
}

/**
 * Single-pass mean/variance over a grayscale buffer.
 *
 * Brightness is the mean; contrast is derived from the spread rather than the
 * min/max range so that one hot specular pixel cannot pin the readout at 100%.
 */
export function luminanceStats(gray: ArrayLike<number>): LuminanceStats {
  const count = gray.length;
  if (count === 0) return { mean: 0, standardDeviation: 0, min: 0, max: 0 };

  let sum = 0;
  let sumSquares = 0;
  let min = 255;
  let max = 0;

  for (let i = 0; i < count; i++) {
    const value = gray[i] ?? 0;
    sum += value;
    sumSquares += value * value;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  const mean = sum / count;
  const variance = Math.max(0, sumSquares / count - mean * mean);
  return { mean, standardDeviation: Math.sqrt(variance), min, max };
}

/**
 * Fraction of pixels whose Sobel response exceeds `threshold`, 0..1.
 *
 * This is a "how much structure is in frame" score, not a physical quantity.
 */
export function edgeDensity(edges: ArrayLike<number>, threshold = 48): number {
  if (edges.length === 0) return 0;
  let strong = 0;
  for (let i = 0; i < edges.length; i++) {
    if ((edges[i] ?? 0) >= threshold) strong++;
  }
  return strong / edges.length;
}

/**
 * Per-pixel |a - b| into a reusable buffer.
 *
 * `out` is reused across frames by the live vision loop so a 30 fps preview
 * does not allocate a new frame-sized array every tick.
 */
export function absoluteDifference(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  out?: Uint8ClampedArray
): Uint8ClampedArray {
  const count = Math.min(a.length, b.length);
  const target = out && out.length === count ? out : new Uint8ClampedArray(count);
  for (let i = 0; i < count; i++) {
    target[i] = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  }
  return target;
}

/**
 * Fraction of the frame whose luminance moved by more than `threshold`, 0..1.
 */
export function motionScore(difference: ArrayLike<number>, threshold = 18): number {
  if (difference.length === 0) return 0;
  let moving = 0;
  for (let i = 0; i < difference.length; i++) {
    if ((difference[i] ?? 0) >= threshold) moving++;
  }
  return moving / difference.length;
}

/**
 * Raw change intensity: a dark field where brighter, warmer pixels changed more.
 * This is the Frame Difference view and is deliberately unfiltered.
 */
export function differenceToRgba(
  difference: ArrayLike<number>,
  gain = 3.2,
  out?: Uint8ClampedArray
): Uint8ClampedArray {
  const count = difference.length;
  const rgba = out && out.length === count * 4 ? out : new Uint8ClampedArray(count * 4);

  for (let i = 0; i < count; i++) {
    const t = clamp(((difference[i] ?? 0) * gain) / 255, 0, 1);
    const p = i * 4;
    rgba[p] = Math.round(18 + 237 * Math.min(1, t * 1.5));
    rgba[p + 1] = Math.round(22 + 190 * t * t);
    rgba[p + 2] = Math.round(36 + 120 * Math.max(0, t - 0.55) * 2.2);
    rgba[p + 3] = 255;
  }
  return rgba;
}

/**
 * Cleaned motion view: a dimmed grayscale scene with thresholded moving
 * regions lit in cyan-green, so where motion happened reads at a glance.
 *
 * The threshold is applied against a 4-neighbour smoothed difference to
 * suppress single-pixel sensor noise without a full blur pass.
 */
export function motionMaskToRgba(
  gray: ArrayLike<number>,
  difference: ArrayLike<number>,
  width: number,
  height: number,
  threshold = 18,
  out?: Uint8ClampedArray
): Uint8ClampedArray {
  const count = width * height;
  const rgba = out && out.length === count * 4 ? out : new Uint8ClampedArray(count * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const base = Math.round((gray[i] ?? 0) * 0.34);

      let smoothed = difference[i] ?? 0;
      if (x > 0 && x < width - 1 && y > 0 && y < height - 1) {
        smoothed = (
          (difference[i] ?? 0) * 2
          + (difference[i - 1] ?? 0)
          + (difference[i + 1] ?? 0)
          + (difference[i - width] ?? 0)
          + (difference[i + width] ?? 0)
        ) / 6;
      }

      const p = i * 4;
      if (smoothed >= threshold) {
        const heat = clamp((smoothed - threshold) / 60, 0, 1);
        rgba[p] = clamp(Math.round(base + 40 + 150 * heat), 0, 255);
        rgba[p + 1] = clamp(Math.round(base + 150 + 105 * heat), 0, 255);
        rgba[p + 2] = clamp(Math.round(base + 120 + 60 * (1 - heat)), 0, 255);
      } else {
        rgba[p] = base;
        rgba[p + 1] = clamp(base + 4, 0, 255);
        rgba[p + 2] = clamp(base + 10, 0, 255);
      }
      rgba[p + 3] = 255;
    }
  }
  return rgba;
}

/**
 * Dimmed grayscale backdrop used as the canvas under the optical-flow arrows.
 */
export function dimGrayToRgba(
  gray: ArrayLike<number>,
  scale = 0.42,
  out?: Uint8ClampedArray
): Uint8ClampedArray {
  const count = gray.length;
  const rgba = out && out.length === count * 4 ? out : new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) {
    const value = clamp(Math.round((gray[i] ?? 0) * scale), 0, 255);
    const p = i * 4;
    rgba[p] = value;
    rgba[p + 1] = value;
    rgba[p + 2] = clamp(value + 12, 0, 255);
    rgba[p + 3] = 255;
  }
  return rgba;
}
