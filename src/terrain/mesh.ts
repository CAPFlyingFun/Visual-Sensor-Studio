/**
 * Terrain as geometry, in the same space the GPS track already lives in.
 *
 * The fusion scene positions everything in local ENU metres relative to the
 * first GPS fix: x east, y up, z NEGATIVE north. Terrain has to be built in
 * exactly that frame or it will look right and be wrong — a mesh drawn in its
 * own coordinates would sit beside the track rather than under it, and the
 * error is invisible until you notice the path floating off the hillside.
 */

import { gpsToLocalMeters } from '../core/math.js';
import { NO_DATA, fieldPixelToLonLat, projectToField, sampleHeight, type Heightfield } from './tiles.js';

export interface TerrainMesh {
  /** Interleaved xyz, in local metres relative to the origin. */
  positions: Float32Array;
  /** Interleaved rgb, 0..1. */
  colors: Float32Array;
  indices: Uint32Array;
  /** Vertices across and down. */
  columns: number;
  rows: number;
  /** Ground extent covered, in metres. */
  spanMetres: number;
  /** Elevation used as the vertical datum, in metres above sea level. */
  datumMetres: number;
  /** Vertices dropped for having no elevation data. */
  missingVertices: number;
}

export interface TerrainMeshOptions {
  /** Vertices along the longest edge. Lower is cheaper on a phone. */
  resolution?: number;
  /** Vertical exaggeration. 1 is true scale. */
  exaggeration?: number;
}

/** Same ramp the 2D map uses, so the two views agree about what is high. */
function hypsometric(t: number): [number, number, number] {
  const stops: Array<[number, number, number, number]> = [
    [0.0, 0.15, 0.27, 0.38],
    [0.12, 0.21, 0.42, 0.33],
    [0.3, 0.38, 0.54, 0.29],
    [0.5, 0.62, 0.62, 0.34],
    [0.68, 0.67, 0.51, 0.31],
    [0.84, 0.59, 0.46, 0.42],
    [1.0, 0.93, 0.94, 0.96]
  ];
  const value = Math.max(0, Math.min(1, t));
  let i = 0;
  while (i < stops.length - 2 && value > stops[i + 1][0]) i++;
  const [t0, r0, g0, b0] = stops[i];
  const [t1, r1, g1, b1] = stops[i + 1];
  const span = t1 - t0 || 1;
  const f = (value - t0) / span;
  return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f];
}

/**
 * Build a terrain surface anchored to a GPS origin.
 *
 * The vertical datum is the terrain's own elevation AT the origin, not sea
 * level, so the surface meets y = 0 exactly where the track starts. Anchoring
 * to sea level instead would drop the whole scene hundreds of metres and leave
 * the phone hanging in the sky above it.
 */
export function buildTerrainMesh(
  field: Heightfield,
  originLat: number,
  originLon: number,
  options: TerrainMeshOptions = {}
): TerrainMesh | null {
  const resolution = Math.max(2, Math.round(options.resolution ?? 160));
  const exaggeration = options.exaggeration ?? 1;

  const aspect = field.height / Math.max(1, field.width);
  const columns = field.width >= field.height ? resolution : Math.max(2, Math.round(resolution / aspect));
  const rows = field.width >= field.height ? Math.max(2, Math.round(resolution * aspect)) : resolution;

  const origin = { latitude: originLat, longitude: originLon, altitude: 0 };
  // The ORIGIN's own pixel, not the field's centre. The tile window is
  // quantised to tile boundaries, so the two are different places — using the
  // centre put the datum 1450 m below a summit and buried the position marker
  // inside the mountain.
  const originPixel = projectToField(field, originLon, originLat);
  // A field whose origin is ocean falls back to the mean, so the surface is
  // still placed sensibly rather than at sea level.
  const at = sampleHeight(field, originPixel.x, originPixel.y);
  let datum = at;
  if (datum === null) {
    let total = 0;
    let counted = 0;
    for (let i = 0; i < field.data.length; i++) {
      if (field.data[i] <= NO_DATA + 1) continue;
      total += field.data[i];
      counted++;
    }
    datum = counted ? total / counted : 0;
  }

  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < field.data.length; i++) {
    const value = field.data[i];
    if (value <= NO_DATA + 1) continue;
    if (value < low) low = value;
    if (value > high) high = value;
  }
  if (!Number.isFinite(low)) return null;
  const relief = Math.max(1, high - low);

  const positions = new Float32Array(columns * rows * 3);
  const colors = new Float32Array(columns * rows * 3);
  const valid = new Uint8Array(columns * rows);
  let missing = 0;

  for (let row = 0; row < rows; row++) {
    const py = (row / (rows - 1)) * (field.height - 1);
    for (let column = 0; column < columns; column++) {
      const px = (column / (columns - 1)) * (field.width - 1);
      const index = row * columns + column;

      const elevation = sampleHeight(field, px, py);
      const { lon, lat } = fieldPixelToLonLat(field, px, py);
      // Through the SAME projection the GPS track uses, so the two agree by
      // construction rather than by a constant someone has to keep in step.
      const local = gpsToLocalMeters({ latitude: lat, longitude: lon, altitude: 0 }, origin);

      positions[index * 3] = local.x;
      positions[index * 3 + 1] = elevation === null ? 0 : (elevation - datum) * exaggeration;
      positions[index * 3 + 2] = local.z;

      if (elevation === null) {
        missing++;
        // Water blue, and excluded from the triangle list below so it is a
        // hole rather than a flat lid at the datum.
        colors[index * 3] = 0.09;
        colors[index * 3 + 1] = 0.17;
        colors[index * 3 + 2] = 0.27;
        continue;
      }

      valid[index] = 1;
      const [r, g, b] = hypsometric((elevation - low) / relief);
      colors[index * 3] = r;
      colors[index * 3 + 1] = g;
      colors[index * 3 + 2] = b;
    }
  }

  const triangles: number[] = [];
  for (let row = 0; row < rows - 1; row++) {
    for (let column = 0; column < columns - 1; column++) {
      const a = row * columns + column;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      // A quad is only drawn where all four corners carry data, so a coastline
      // ends at the water rather than being bridged across it.
      if (valid[a] && valid[b] && valid[c]) triangles.push(a, c, b);
      if (valid[b] && valid[c] && valid[d]) triangles.push(b, c, d);
    }
  }

  const eastWest = Math.abs(positions[(columns - 1) * 3] - positions[0]);

  return {
    positions,
    colors,
    indices: Uint32Array.from(triangles),
    columns,
    rows,
    spanMetres: eastWest,
    datumMetres: datum,
    missingVertices: missing
  };
}
