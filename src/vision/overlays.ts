/**
 * Display overlays and palettes.
 *
 * All of these annotate an existing RGBA buffer in place, reusing the caller's
 * frame rather than producing another one, because they run per analysed
 * frame alongside everything else.
 */

import { clamp } from '../core/math.js';

/**
 * Visualisation palettes. These change how a frame is DISPLAYED and nothing
 * else — no palette gives the camera a sensitivity it does not have, and
 * `green` in particular is a colour scheme, not infrared night vision.
 */
export type NightPalette = 'natural' | 'monochrome' | 'green' | 'falsecolor';

/**
 * Map luminance to a perceptual ramp so small differences in a dark frame
 * become visible. This shows structure that is present but hard to see; it
 * does not add information the sensor never captured.
 */
function falseColor(value: number): [number, number, number] {
  const t = clamp(value / 255, 0, 1);
  if (t < 0.25) return [Math.round(t * 4 * 40), Math.round(t * 4 * 20), Math.round(60 + t * 4 * 140)];
  if (t < 0.5) return [Math.round((t - 0.25) * 4 * 30), Math.round(20 + (t - 0.25) * 4 * 180), Math.round(200 - (t - 0.25) * 4 * 120)];
  if (t < 0.75) return [Math.round((t - 0.5) * 4 * 220), Math.round(200 + (t - 0.5) * 4 * 55), Math.round(80 - (t - 0.5) * 4 * 60)];
  return [255, Math.round(255 - (t - 0.75) * 4 * 120), Math.round(20 + (t - 0.75) * 4 * 60)];
}

/**
 * Palettes are pure functions of luminance, so each is a 256-entry lookup
 * table built once rather than per-pixel arithmetic. Measured at 384x216 the
 * false-colour ramp cost 2.2 ms per frame computed directly and about a tenth
 * of that through a table — the difference between the most expensive stage in
 * the pipeline and an unnoticeable one.
 */
const paletteTables = new Map<NightPalette, Uint8ClampedArray>();

function paletteTable(palette: NightPalette): Uint8ClampedArray {
  const cached = paletteTables.get(palette);
  if (cached) return cached;

  const table = new Uint8ClampedArray(256 * 3);
  for (let y = 0; y < 256; y++) {
    let r: number;
    let g: number;
    let b: number;
    if (palette === 'monochrome') {
      r = y;
      g = y;
      b = y;
    } else if (palette === 'green') {
      r = clamp(Math.round(y * 0.16), 0, 255);
      g = clamp(Math.round(y * 1.06), 0, 255);
      b = clamp(Math.round(y * 0.22), 0, 255);
    } else {
      [r, g, b] = falseColor(y);
    }
    table[y * 3] = r;
    table[y * 3 + 1] = g;
    table[y * 3 + 2] = b;
  }
  paletteTables.set(palette, table);
  return table;
}

export function applyPalette(rgba: Uint8ClampedArray, palette: NightPalette): Uint8ClampedArray {
  if (palette === 'natural') return rgba;

  const table = paletteTable(palette);
  const pixels = Math.floor(rgba.length / 4);
  for (let i = 0, p = 0; i < pixels; i++, p += 4) {
    const y = (rgba[p] * 0.2126 + rgba[p + 1] * 0.7152 + rgba[p + 2] * 0.0722) | 0;
    const bin = (y < 0 ? 0 : y > 255 ? 255 : y) * 3;
    rgba[p] = table[bin];
    rgba[p + 1] = table[bin + 1];
    rgba[p + 2] = table[bin + 2];
  }
  return rgba;
}

/**
 * Light boost with gamma, for the Night lab.
 *
 * `gain` multiplies, `gamma` below 1 lifts shadows. Both amplify noise along
 * with signal — this makes a dark frame readable, it does not make the camera
 * more sensitive.
 */
export function applyLightBoost(
  rgba: Uint8ClampedArray,
  gain: number,
  gamma: number,
  lut?: Uint8ClampedArray
): Uint8ClampedArray {
  if (gain === 1 && gamma === 1) return rgba;

  // A 256-entry lookup table turns a per-channel pow() into an array read.
  const table = lut && lut.length === 256 ? lut : new Uint8ClampedArray(256);
  const safeGamma = gamma > 0 ? gamma : 1;
  for (let i = 0; i < 256; i++) {
    const normalised = Math.pow(i / 255, safeGamma);
    table[i] = clamp(Math.round(normalised * 255 * gain), 0, 255);
  }

  for (let p = 0; p < rgba.length; p += 4) {
    rgba[p] = table[rgba[p]];
    rgba[p + 1] = table[rgba[p + 1]];
    rgba[p + 2] = table[rgba[p + 2]];
  }
  return rgba;
}

/**
 * Diagonal zebra stripes over pixels at or above `threshold` (0..1 of full
 * scale), marking highlights that are at or near clipping.
 */
export function applyZebra(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  threshold = 0.95,
  phase = 0
): Uint8ClampedArray {
  const cutoff = clamp(threshold, 0, 1) * 255;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const luminance = rgba[p] * 0.2126 + rgba[p + 1] * 0.7152 + rgba[p + 2] * 0.0722;
      if (luminance < cutoff) continue;
      // Only every other diagonal band is painted, so the underlying detail
      // stays visible through the warning.
      if ((((x + y + phase) / 5) | 0) % 2 !== 0) continue;
      rgba[p] = 255;
      rgba[p + 1] = 40;
      rgba[p + 2] = 90;
    }
  }
  return rgba;
}

/**
 * Focus peaking from an existing edge map.
 *
 * Reuses the Sobel response the pipeline already computes rather than running
 * another pass. Strong local contrast is a good proxy for sharpness, but it is
 * a focus AID: high-contrast texture can peak while being slightly soft, and a
 * genuinely flat subject cannot peak at all.
 */
export function applyFocusPeaking(
  rgba: Uint8ClampedArray,
  edges: ArrayLike<number>,
  threshold = 90
): Uint8ClampedArray {
  const pixels = Math.min(Math.floor(rgba.length / 4), edges.length);
  for (let i = 0, p = 0; i < pixels; i++, p += 4) {
    const edge = edges[i] ?? 0;
    if (edge < threshold) continue;
    const strength = clamp((edge - threshold) / (255 - threshold), 0, 1);
    rgba[p] = clamp(Math.round(rgba[p] * (1 - strength) + 255 * strength), 0, 255);
    rgba[p + 1] = clamp(Math.round(rgba[p + 1] * (1 - strength) + 90 * strength), 0, 255);
    rgba[p + 2] = clamp(Math.round(rgba[p + 2] * (1 - strength) + 255 * strength), 0, 255);
  }
  return rgba;
}
