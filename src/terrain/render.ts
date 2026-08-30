/**
 * Drawing a heightfield so a hillside reads as a hillside.
 *
 * Three things layered, because no one of them is enough. A hypsometric tint
 * gives absolute height but flattens relief — a plateau and a valley floor at
 * the same altitude look identical. Hillshade gives shape but no scale. Contour
 * lines give exact steps but nothing between them. Together they read the way a
 * paper topographic map does.
 */

import { NO_DATA, type Heightfield } from './tiles.js';
import { clamp } from '../core/math.js';

export interface TerrainStats {
  min: number;
  max: number;
  mean: number;
  /** Cells that carried no data, as a fraction — ocean, or gaps in the survey. */
  missingFraction: number;
}

export function terrainStats(field: Heightfield): TerrainStats {
  const { data } = field;
  let min = Infinity;
  let max = -Infinity;
  let total = 0;
  let counted = 0;
  let missing = 0;

  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    if (value <= NO_DATA + 1) {
      missing++;
      continue;
    }
    if (value < min) min = value;
    if (value > max) max = value;
    total += value;
    counted++;
  }

  return {
    min: counted ? min : 0,
    max: counted ? max : 0,
    mean: counted ? total / counted : 0,
    missingFraction: data.length ? missing / data.length : 1
  };
}

/**
 * A contour interval that produces a readable number of lines.
 *
 * Chosen from the relief actually present rather than fixed: 10 m lines across
 * a mountain are unreadable ink, and 100 m lines across Florida are no lines at
 * all. The steps are the ones a real map would use.
 */
export function contourInterval(relief: number): number {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
  const target = Math.max(1, relief) / 12;
  for (const step of steps) if (step >= target) return step;
  return steps[steps.length - 1];
}

/** Cool low ground through green and tan to bare rock and snow. */
function hypsometric(t: number): [number, number, number] {
  const stops: Array<[number, number, number, number]> = [
    [0.0, 38, 70, 96],
    [0.12, 54, 106, 84],
    [0.3, 96, 138, 74],
    [0.5, 158, 158, 86],
    [0.68, 172, 130, 78],
    [0.84, 150, 118, 106],
    [1.0, 238, 240, 246]
  ];
  const value = clamp(t, 0, 1);
  let i = 0;
  while (i < stops.length - 2 && value > stops[i + 1][0]) i++;
  const [t0, r0, g0, b0] = stops[i];
  const [t1, r1, g1, b1] = stops[i + 1];
  const span = t1 - t0 || 1;
  const f = clamp((value - t0) / span, 0, 1);
  return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f];
}

export interface TerrainRenderOptions {
  /** Sun direction in degrees from north. */
  azimuth?: number;
  /** Sun height above the horizon, in degrees. */
  altitude?: number;
  /** Vertical exaggeration. 1 is true scale. */
  exaggeration?: number;
  contours?: boolean;
}

/**
 * Render the field to RGBA.
 *
 * The shading uses the standard hillshade relation, with the gradient taken in
 * GROUND units so the same hill shades the same way at any zoom. Exaggeration
 * is applied to the gradient rather than to the height, so it changes the
 * shading without moving any contour line off its true elevation.
 */
export function renderTerrain(
  field: Heightfield,
  stats: TerrainStats,
  out: Uint8ClampedArray,
  options: TerrainRenderOptions = {}
): Uint8ClampedArray {
  const { data, width, height } = field;
  // Compass bearing to the mathematical convention aspect is measured in.
  // Used raw, a sun in the west lands perpendicular to an east-west slope and
  // lights neither flank — the shading silently vanishes rather than erroring.
  const compass = options.azimuth ?? 315;
  const azimuth = (((360 - compass + 90) % 360) * Math.PI) / 180;
  const altitude = ((options.altitude ?? 45) * Math.PI) / 180;
  const exaggeration = options.exaggeration ?? 2;
  const showContours = options.contours ?? true;

  const relief = Math.max(1, stats.max - stats.min);
  const interval = contourInterval(relief);
  const spacing = field.metresPerPixel * 2;

  const zenith = Math.PI / 2 - altitude;
  const sinZenith = Math.sin(zenith);
  const cosZenith = Math.cos(zenith);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const p = i * 4;
      const centre = data[i];

      if (centre <= NO_DATA + 1) {
        // Water and gaps are drawn as water, not as a height of -32768.
        out[p] = 22;
        out[p + 1] = 42;
        out[p + 2] = 66;
        out[p + 3] = 255;
        continue;
      }

      const left = data[i - (x > 0 ? 1 : 0)];
      const right = data[i + (x < width - 1 ? 1 : 0)];
      const up = data[i - (y > 0 ? width : 0)];
      const down = data[i + (y < height - 1 ? width : 0)];

      const dzdx = ((right - left) / spacing) * exaggeration;
      const dzdy = ((down - up) / spacing) * exaggeration;
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);

      const shade = clamp(
        cosZenith * Math.cos(slope) + sinZenith * Math.sin(slope) * Math.cos(azimuth - aspect),
        0,
        1
      );

      const [r, g, b] = hypsometric((centre - stats.min) / relief);
      // Shading multiplies the tint rather than replacing it, with a floor so a
      // shadowed slope keeps its colour instead of going to black.
      const light = 0.35 + shade * 0.85;
      let red = r * light;
      let green = g * light;
      let blue = b * light;

      if (showContours) {
        // A line wherever the surface crosses a multiple of the interval,
        // detected by the band changing between neighbours rather than by
        // testing the height itself — which would draw lines of varying width
        // depending on how steep the ground is.
        const band = Math.floor(centre / interval);
        if (Math.floor(right / interval) !== band || Math.floor(down / interval) !== band) {
          const major = band % 5 === 0;
          const ink = major ? 0.45 : 0.7;
          red = red * ink;
          green = green * ink;
          blue = blue * ink;
        }
      }

      out[p] = red;
      out[p + 1] = green;
      out[p + 2] = blue;
      out[p + 3] = 255;
    }
  }
  return out;
}
