/**
 * Sparse block-matching optical flow, sized for a phone browser.
 *
 * A dense Lucas-Kanade or Farneback field is far more than a live iPhone
 * preview needs, so this estimates one motion vector per grid cell using a
 * three-step search (TSS): the search window is probed at nine offsets, the
 * best offset becomes the new centre, and the step halves. That visits about
 * 27 candidate offsets instead of the (2r+1)^2 an exhaustive search would,
 * which is what keeps the mode usable at 10-20 processed frames per second.
 *
 * The result is a relative image-motion field. It cannot separate camera
 * motion from subject motion and it is not a calibrated velocity.
 */

export interface FlowVector {
  /** Cell centre in analysis-frame pixels. */
  x: number;
  y: number;
  /** Estimated displacement from the previous frame, in analysis-frame pixels. */
  dx: number;
  dy: number;
  magnitude: number;
}

export interface FlowField {
  vectors: FlowVector[];
  cellSize: number;
  width: number;
  height: number;
  /** Mean magnitude over accepted vectors only, in pixels. */
  meanMagnitude: number;
  maxMagnitude: number;
  /** Accepted vectors / candidate cells, 0..1. Low means a flat, untrackable scene. */
  coverage: number;
}

export interface FlowOptions {
  /** Spacing between sampled cell centres, in analysis-frame pixels. */
  cellSize?: number;
  /** Half-width of the matched patch. A radius of 3 matches a 7x7 patch. */
  patchRadius?: number;
  /** Largest displacement the search can resolve, in pixels. */
  maxShift?: number;
  /** Minimum local intensity range before a cell is considered trackable. */
  textureThreshold?: number;
  /** Vectors shorter than this are reported as still rather than as noise. */
  minMagnitude?: number;
}

const EMPTY_FIELD: FlowField = {
  vectors: [],
  cellSize: 0,
  width: 0,
  height: 0,
  meanMagnitude: 0,
  maxMagnitude: 0,
  coverage: 0
};

function patchSad(
  previous: ArrayLike<number>,
  current: ArrayLike<number>,
  width: number,
  cx: number,
  cy: number,
  px: number,
  py: number,
  radius: number
): number {
  let sum = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    const currentRow = (cy + dy) * width;
    const previousRow = (py + dy) * width;
    for (let dx = -radius; dx <= radius; dx++) {
      sum += Math.abs((current[currentRow + cx + dx] ?? 0) - (previous[previousRow + px + dx] ?? 0));
    }
  }
  return sum;
}

function patchRange(gray: ArrayLike<number>, width: number, x: number, y: number, radius: number): number {
  let min = 255;
  let max = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    const row = (y + dy) * width;
    for (let dx = -radius; dx <= radius; dx++) {
      const value = gray[row + x + dx] ?? 0;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  return max - min;
}

/**
 * Estimate per-cell displacement of `current` relative to `previous`.
 *
 * Both buffers must be single-channel grayscale of the same `width` x `height`.
 */
export function computeBlockFlow(
  previous: ArrayLike<number>,
  current: ArrayLike<number>,
  width: number,
  height: number,
  options: FlowOptions = {}
): FlowField {
  const cellSize = Math.max(6, Math.round(options.cellSize ?? 16));
  const patchRadius = Math.max(2, Math.round(options.patchRadius ?? 3));
  const maxShift = Math.max(1, Math.round(options.maxShift ?? 6));
  const textureThreshold = options.textureThreshold ?? 14;
  const minMagnitude = options.minMagnitude ?? 0.75;

  const margin = patchRadius + maxShift;
  if (width < margin * 2 + 1 || height < margin * 2 + 1) return EMPTY_FIELD;
  if (previous.length < width * height || current.length < width * height) return EMPTY_FIELD;

  const vectors: FlowVector[] = [];
  let candidates = 0;
  let magnitudeSum = 0;
  let maxMagnitude = 0;

  const startX = margin + Math.floor(((width - margin * 2 - 1) % cellSize) / 2);
  const startY = margin + Math.floor(((height - margin * 2 - 1) % cellSize) / 2);

  for (let y = startY; y < height - margin; y += cellSize) {
    for (let x = startX; x < width - margin; x += cellSize) {
      candidates++;

      // A flat patch matches everywhere, so its "best" offset is meaningless.
      if (patchRange(current, width, x, y, patchRadius) < textureThreshold) continue;

      let bestX = x;
      let bestY = y;
      let bestScore = patchSad(previous, current, width, x, y, x, y, patchRadius);

      // The step sequence has to be successive halves of a power of two
      // (4, 2, 1) rather than an arbitrary halving. With a sequence that skips
      // a power - 3 then 1, say - whole displacements become unreachable: a
      // two-pixel shift lands between the coarse probes and the refinement
      // never gets near it, so a real translation reads as no motion at all.
      let span = 1;
      while (span <= maxShift) span <<= 1;

      for (let step = Math.max(1, span >> 1); step >= 1; step >>= 1) {
        let stepBestX = bestX;
        let stepBestY = bestY;

        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const px = bestX + ox * step;
            const py = bestY + oy * step;
            if (Math.abs(px - x) > maxShift || Math.abs(py - y) > maxShift) continue;
            if (px < margin || py < margin || px >= width - margin || py >= height - margin) continue;

            const score = patchSad(previous, current, width, x, y, px, py, patchRadius);
            if (score < bestScore) {
              bestScore = score;
              stepBestX = px;
              stepBestY = py;
            }
          }
        }

        bestX = stepBestX;
        bestY = stepBestY;
      }

      // The patch moved from (bestX, bestY) in the previous frame to (x, y) now.
      const dx = x - bestX;
      const dy = y - bestY;
      const magnitude = Math.hypot(dx, dy);
      if (magnitude < minMagnitude) continue;

      magnitudeSum += magnitude;
      if (magnitude > maxMagnitude) maxMagnitude = magnitude;
      vectors.push({ x, y, dx, dy, magnitude });
    }
  }

  return {
    vectors,
    cellSize,
    width,
    height,
    meanMagnitude: vectors.length ? magnitudeSum / vectors.length : 0,
    maxMagnitude,
    coverage: candidates ? vectors.length / candidates : 0
  };
}

/**
 * Map a flow direction to a hue so a glance reads direction as colour.
 * Returns a CSS colour string; magnitude drives lightness, not hue.
 */
export function flowVectorColor(vector: FlowVector, referenceMagnitude: number): string {
  const hue = ((Math.atan2(vector.dy, vector.dx) * 180) / Math.PI + 360) % 360;
  const strength = referenceMagnitude > 0
    ? Math.min(1, vector.magnitude / referenceMagnitude)
    : 0;
  const lightness = Math.round(52 + 26 * strength);
  return `hsl(${Math.round(hue)}, 88%, ${lightness}%)`;
}
