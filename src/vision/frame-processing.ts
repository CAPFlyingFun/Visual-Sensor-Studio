import { clamp } from '../core/math.js';

export function rgbaToGray(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const gray = new Uint8ClampedArray(Math.floor(rgba.length / 4));
  for (let i = 0, p = 0; i + 3 < rgba.length; i += 4, p++) {
    gray[p] = Math.round(rgba[i] * 0.2126 + rgba[i + 1] * 0.7152 + rgba[i + 2] * 0.0722);
  }
  return gray;
}

export function sobelEdges(gray: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const edges = new Uint8ClampedArray(width * height);
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

export function reliefFromGray(gray: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const edges = sobelEdges(gray, width, height);
  const rgba = new Uint8ClampedArray(gray.length * 4);
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
    const value = clamp(Math.round(normalized * 215 + localEdge * 40), 0, 255);
    const p = i * 4;
    rgba[p] = value;
    rgba[p + 1] = value;
    rgba[p + 2] = value;
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
