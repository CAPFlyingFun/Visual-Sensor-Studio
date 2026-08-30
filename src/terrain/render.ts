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

export interface RoughnessReport {
  /** Mean |second difference| across the field, in metres. The noise floor. */
  mean: number;
  /**
   * Ratio between the roughest and smoothest quarter of the field.
   *
   * Well above 1 means the tiles came from different surveys. That is a real
   * property of the dataset — it mosaics national and satellite sources — and
   * it shows up as a hard seam along a tile edge, which looks like a rendering
   * bug and is not one.
   */
  variation: number;
}

/**
 * How jagged the surface is, and whether that jaggedness is uniform.
 *
 * Second differences rather than first: a hillside has a large gradient and is
 * perfectly smooth, so measuring slope would call every mountain noisy. What
 * matters here is how much the gradient CHANGES from cell to cell, which is
 * what survey noise looks like and what terrain mostly does not do.
 */
export function estimateRoughness(field: Heightfield): RoughnessReport {
  const { data, width, height } = field;
  if (width < 4 || height < 4) return { mean: 0, variation: 1 };

  const quadrants = [0, 0, 0, 0];
  const counts = [0, 0, 0, 0];
  let total = 0;
  let counted = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const left = data[i - 1];
      const centre = data[i];
      const right = data[i + 1];
      if (left <= NO_DATA + 1 || centre <= NO_DATA + 1 || right <= NO_DATA + 1) continue;

      const curvature = Math.abs(left - 2 * centre + right);
      total += curvature;
      counted++;

      const q = (y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1);
      quadrants[q] += curvature;
      counts[q]++;
    }
  }

  const means = quadrants.map((sum, i) => (counts[i] > 32 ? sum / counts[i] : Number.NaN))
    .filter((value) => Number.isFinite(value));
  const low = Math.min(...means);
  const high = Math.max(...means);

  return {
    mean: counted ? total / counted : 0,
    variation: means.length > 1 && low > 1e-6 ? high / low : 1
  };
}

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
export function contourInterval(relief: number, noiseFloor = 0): number {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
  // Also kept clear of the survey noise. An interval near the noise floor draws
  // contours of the noise rather than of the ground, which is what turned a
  // flat coastal plain into speckle: 60 m of relief chose 5 m lines, and the
  // southern tiles carried more than a metre of jitter.
  const target = Math.max(Math.max(1, relief) / 12, noiseFloor * 4);
  for (const step of steps) if (step >= target) return step;
  return steps[steps.length - 1];
}

/**
 * A lightly smoothed copy, for shading and contours only.
 *
 * Never for the elevation readout: that should report what the survey said,
 * not what looks tidy. This exists because a contour line is a threshold, and a
 * threshold applied to noisy data produces a tangle whose detail is entirely
 * spurious.
 */
export function smoothField(field: Heightfield, passes = 1): Float32Array {
  const { width, height } = field;
  // Two owned buffers, ping-ponged. Starting from the field's own array and
  // swapping into it would write smoothed values back over the survey data
  // every other pass.
  let source = new Float32Array(field.data.length);
  source.set(field.data);
  let out = new Float32Array(source.length);

  for (let pass = 0; pass < Math.max(0, passes); pass++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (source[i] <= NO_DATA + 1) {
          out[i] = source[i];
          continue;
        }
        let total = 0;
        let weight = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            const value = source[ny * width + nx];
            // No-data neighbours are skipped rather than blurred in, or a
            // coastline would bleed a kilometre of ocean into the land.
            if (value <= NO_DATA + 1) continue;
            const w = dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1;
            total += value * w;
            weight += w;
          }
        }
        out[i] = weight > 0 ? total / weight : source[i];
      }
    }
    const swap = source;
    source = out;
    out = swap;
  }
  return source;
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
  /** Smoothing passes for the shading. Never applied to readouts. */
  smoothing?: number;
  /**
   * Smoothing passes for the contours, separately and usually higher.
   *
   * A contour is a THRESHOLD, so noise that merely textures the shading breaks
   * a contour line into a field of closed blobs. Shading and contouring have
   * genuinely different tolerances and one setting cannot serve both.
   */
  contourSmoothing?: number;
  /** Measured noise, so the contour interval can stay clear of it. */
  noiseFloor?: number;
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
  const { width, height } = field;
  // Shading and contours read SMOOTHED copies; every number reported to the
  // user still comes from the survey's own values.
  const data = options.smoothing ? smoothField(field, options.smoothing) : field.data;
  const contourData = options.contourSmoothing
    ? smoothField(field, options.contourSmoothing)
    : data;
  // Compass bearing to the mathematical convention aspect is measured in.
  // Used raw, a sun in the west lands perpendicular to an east-west slope and
  // lights neither flank — the shading silently vanishes rather than erroring.
  const compass = options.azimuth ?? 315;
  const azimuth = (((360 - compass + 90) % 360) * Math.PI) / 180;
  const altitude = ((options.altitude ?? 45) * Math.PI) / 180;
  const exaggeration = options.exaggeration ?? 2;
  const showContours = options.contours ?? true;

  const relief = Math.max(1, stats.max - stats.min);
  const interval = contourInterval(relief, options.noiseFloor ?? 0);
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

      if (showContours && contourData[i] > NO_DATA + 1) {
        // A line wherever the surface crosses a multiple of the interval,
        // detected by the band changing between neighbours rather than by
        // testing the height itself — which would draw lines of varying width
        // depending on how steep the ground is.
        const contourRight = contourData[i + (x < width - 1 ? 1 : 0)];
        const contourDown = contourData[i + (y < height - 1 ? width : 0)];
        const band = Math.floor(contourData[i] / interval);
        if (Math.floor(contourRight / interval) !== band
          || Math.floor(contourDown / interval) !== band) {
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
