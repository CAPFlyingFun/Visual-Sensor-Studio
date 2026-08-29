export interface ParallaxOptions {
  blockSize?: number;
  patchRadius?: number;
  maxDisparity?: number;
  verticalSearch?: number;
  textureThreshold?: number;
}

export interface DisparityResult {
  disparity: Float32Array;
  confidence: Float32Array;
  width: number;
  height: number;
  blockSize: number;
}

function patchSad(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  width: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number
): number {
  let sum = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    const rowA = (ay + dy) * width;
    const rowB = (by + dy) * width;
    for (let dx = -radius; dx <= radius; dx++) {
      sum += Math.abs(a[rowA + ax + dx] - b[rowB + bx + dx]);
    }
  }
  return sum;
}

function patchTexture(gray: Uint8ClampedArray, width: number, x: number, y: number, radius: number): number {
  let min = 255;
  let max = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    const row = (y + dy) * width;
    for (let dx = -radius; dx <= radius; dx++) {
      const value = gray[row + x + dx];
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  return max - min;
}

export function computeBlockDisparity(
  reference: Uint8ClampedArray,
  current: Uint8ClampedArray,
  width: number,
  height: number,
  options: ParallaxOptions = {}
): DisparityResult {
  if (reference.length !== width * height || current.length !== width * height) {
    throw new Error('Parallax inputs must match width × height.');
  }

  const blockSize = Math.max(2, Math.floor(options.blockSize ?? 6));
  const radius = Math.max(1, Math.floor(options.patchRadius ?? 2));
  const maxDisparity = Math.max(1, Math.floor(options.maxDisparity ?? 12));
  const verticalSearch = Math.max(0, Math.floor(options.verticalSearch ?? 1));
  const textureThreshold = Math.max(0, options.textureThreshold ?? 10);

  const disparity = new Float32Array(width * height);
  disparity.fill(Number.NaN);
  const confidence = new Float32Array(width * height);

  const marginX = radius + maxDisparity + 1;
  const marginY = radius + verticalSearch + 1;

  for (let y = marginY; y < height - marginY; y += blockSize) {
    for (let x = marginX; x < width - marginX; x += blockSize) {
      if (patchTexture(reference, width, x, y, radius) < textureThreshold) continue;

      let bestScore = Number.POSITIVE_INFINITY;
      let secondScore = Number.POSITIVE_INFINITY;
      let bestDx = 0;

      for (let dy = -verticalSearch; dy <= verticalSearch; dy++) {
        for (let dx = -maxDisparity; dx <= maxDisparity; dx++) {
          const score = patchSad(reference, current, width, x, y, x + dx, y + dy, radius);
          if (score < bestScore) {
            secondScore = bestScore;
            bestScore = score;
            bestDx = dx;
          } else if (score < secondScore) {
            secondScore = score;
          }
        }
      }

      const d = Math.abs(bestDx);
      const separation = Number.isFinite(secondScore) && secondScore > 0
        ? Math.max(0, Math.min(1, (secondScore - bestScore) / secondScore))
        : 0;

      const half = Math.floor(blockSize / 2);
      for (let fy = Math.max(0, y - half); fy < Math.min(height, y + half + 1); fy++) {
        for (let fx = Math.max(0, x - half); fx < Math.min(width, x + half + 1); fx++) {
          const index = fy * width + fx;
          disparity[index] = d;
          confidence[index] = separation;
        }
      }
    }
  }

  return { disparity, confidence, width, height, blockSize };
}
