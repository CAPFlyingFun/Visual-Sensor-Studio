/**
 * Real elevation data, from public terrain tiles.
 *
 * The source is the Terrarium tile set: ordinary PNGs where each pixel's RGB
 * encodes a height rather than a colour. They are free, keyless and global, and
 * derived largely from SRTM and national surveys, so the underlying resolution
 * is around 30 m — good for a hillside, useless for a kerb.
 *
 * PRIVACY, because this is the first thing in the app that touches the network
 * with anything derived from where you are. A tile request carries only a zoom
 * and two integer tile indices; it never carries a latitude or longitude. Those
 * indices name a square kilometres across, so the server learns roughly which
 * few-kilometre square was asked about and nothing finer. That is a real
 * disclosure and the UI says so plainly rather than burying it.
 */

/** Web Mercator, the projection every slippy tile scheme uses. */
const EARTH_CIRCUMFERENCE = 40075016.686;

export interface TileCoord {
  x: number;
  y: number;
  z: number;
}

export interface TileWindow {
  zoom: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  tiles: TileCoord[];
  /** Geographic bounds actually covered, which is at least the radius asked for. */
  west: number;
  east: number;
  north: number;
  south: number;
}

/** Fractional tile position of a coordinate, so a point can be located inside one. */
export function lonLatToTile(lon: number, lat: number, zoom: number): { x: number; y: number } {
  const scale = 2 ** zoom;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const radians = (clampedLat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * scale,
    y: ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * scale
  };
}

export function tileToLonLat(x: number, y: number, zoom: number): { lon: number; lat: number } {
  const scale = 2 ** zoom;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  return {
    lon: (x / scale) * 360 - 180,
    lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
  };
}

/**
 * Ground distance one tile pixel covers, in metres.
 *
 * Shrinks with latitude, because Mercator stretches: the same tile covers far
 * less ground in Alaska than at the equator. Ignoring that would put the scale
 * bar and every slope out by the cosine of the latitude.
 */
export function metresPerPixel(lat: number, zoom: number, tileSize = 256): number {
  return (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / (2 ** zoom * tileSize);
}

/**
 * The tiles needed to cover a radius around a point.
 *
 * Capped, and deliberately: an uncapped window at a high zoom is a request for
 * hundreds of tiles on a phone connection, which is a bad thing to do by
 * accident to someone on cellular data.
 */
export function tilesForRadius(
  lon: number,
  lat: number,
  radiusMetres: number,
  zoom: number,
  maxTiles = 16
): TileWindow {
  // From the real geographic bounds of the radius, not from a symmetric reach
  // in tile units. Rounding the reach up to a whole tile first asked for three
  // tiles across where one would do — 26 km of download for a 6 km question.
  const metresPerDegreeLat = 111320;
  const metresPerDegreeLon = metresPerDegreeLat * Math.cos((lat * Math.PI) / 180);
  const dLat = radiusMetres / metresPerDegreeLat;
  const dLon = metresPerDegreeLon > 1 ? radiusMetres / metresPerDegreeLon : 180;

  const centre = lonLatToTile(lon, lat, zoom);
  const scale = 2 ** zoom;
  const limit = scale - 1;

  // North is a SMALLER tile y, so the north edge gives the minimum.
  const westEdge = lonLatToTile(lon - dLon, lat, zoom);
  const eastEdge = lonLatToTile(lon + dLon, lat, zoom);
  const northEdge = lonLatToTile(lon, Math.min(85, lat + dLat), zoom);
  const southEdge = lonLatToTile(lon, Math.max(-85, lat - dLat), zoom);

  let minX = Math.max(0, Math.floor(westEdge.x));
  let maxX = Math.min(limit, Math.floor(eastEdge.x));
  let minY = Math.max(0, Math.floor(northEdge.y));
  let maxY = Math.min(limit, Math.floor(southEdge.y));

  // Trim symmetrically from the outside in, so the centre stays the centre.
  while ((maxX - minX + 1) * (maxY - minY + 1) > maxTiles) {
    if (maxX - minX >= maxY - minY) {
      if (centre.x - minX > maxX + 1 - centre.x) minX++;
      else maxX--;
    } else if (centre.y - minY > maxY + 1 - centre.y) minY++;
    else maxY--;
  }

  const tiles: TileCoord[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) tiles.push({ x, y, z: zoom });
  }

  const northWest = tileToLonLat(minX, minY, zoom);
  const southEast = tileToLonLat(maxX + 1, maxY + 1, zoom);

  return {
    zoom,
    minX,
    maxX,
    minY,
    maxY,
    tiles,
    west: northWest.lon,
    north: northWest.lat,
    east: southEast.lon,
    south: southEast.lat
  };
}

/**
 * Height in metres from one Terrarium pixel.
 *
 * The encoding packs a signed height into three unsigned bytes with a fixed
 * offset, and the blue channel carries a fractional part. Dropping blue as a
 * rounding error costs 1/256 m of precision; dropping the 32768 offset puts
 * every reading 32 km underground.
 */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/**
 * The value known to mean "no data", not a height of that value.
 *
 * Terrarium marks ocean and gaps with the encoding's floor. Averaging it into a
 * neighbourhood would drag a coastal hillside down by kilometres.
 */
export const NO_DATA = -32768;

export interface Heightfield {
  /** Metres above sea level, row-major, north to south. */
  data: Float32Array;
  width: number;
  height: number;
  west: number;
  east: number;
  north: number;
  south: number;
  zoom: number;
  metresPerPixel: number;
}

/** Bilinear height at a fractional pixel position, ignoring no-data corners. */
export function sampleHeight(field: Heightfield, px: number, py: number): number | null {
  const { data, width, height } = field;
  if (!(width > 0 && height > 0)) return null;

  const x = Math.max(0, Math.min(width - 1, px));
  const y = Math.max(0, Math.min(height - 1, py));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;

  let total = 0;
  let weight = 0;
  const corners: Array<[number, number, number]> = [
    [x0, y0, (1 - fx) * (1 - fy)],
    [x1, y0, fx * (1 - fy)],
    [x0, y1, (1 - fx) * fy],
    [x1, y1, fx * fy]
  ];
  for (const [cx, cy, w] of corners) {
    const value = data[cy * width + cx];
    if (value <= NO_DATA + 1) continue;
    total += value * w;
    weight += w;
  }
  return weight > 0 ? total / weight : null;
}

/**
 * The tile-space extent a field covers, derived from its own declared bounds.
 *
 * Deliberately NOT "256 pixels per tile". That is true of a field the loader
 * assembled and false of any other, and the failure is silent: every position
 * lands somewhere plausible but wrong, scaled by whatever the real ratio was.
 */
function fieldTileSpan(field: Heightfield): { corner: { x: number; y: number }; spanX: number; spanY: number } {
  const corner = lonLatToTile(field.west, field.north, field.zoom);
  const far = lonLatToTile(field.east, field.south, field.zoom);
  return {
    corner,
    spanX: far.x - corner.x || 1,
    spanY: far.y - corner.y || 1
  };
}

/** Where a coordinate falls inside a heightfield, in fractional pixels. */
export function projectToField(
  field: Heightfield,
  lon: number,
  lat: number
): { x: number; y: number } {
  const { corner, spanX, spanY } = fieldTileSpan(field);
  const here = lonLatToTile(lon, lat, field.zoom);
  return {
    x: ((here.x - corner.x) / spanX) * field.width,
    y: ((here.y - corner.y) / spanY) * field.height
  };
}

/**
 * The coordinate a field pixel sits at — the inverse of projectToField.
 *
 * Needed to place terrain in the same local metre space the GPS track uses: a
 * vertex has to know its longitude and latitude before it can be turned into
 * a position relative to the track's origin.
 */
export function fieldPixelToLonLat(
  field: Heightfield,
  px: number,
  py: number
): { lon: number; lat: number } {
  const { corner, spanX, spanY } = fieldTileSpan(field);
  return tileToLonLat(
    corner.x + (px / Math.max(1, field.width)) * spanX,
    corner.y + (py / Math.max(1, field.height)) * spanY,
    field.zoom
  );
}

export interface SlopeReading {
  /** Steepest downhill gradient, in degrees from horizontal. */
  degrees: number;
  /** Compass direction that steepest descent faces, in degrees from north. */
  aspectDegrees: number;
}

/**
 * Slope and aspect from the surrounding cells.
 *
 * Central differences over one cell either side, divided by the GROUND distance
 * those cells span — which is why metresPerPixel has to be right. Using pixels
 * instead of metres would make the same hill read as a different steepness at
 * every zoom level.
 */
export function slopeAt(field: Heightfield, px: number, py: number): SlopeReading | null {
  const step = 1;
  const left = sampleHeight(field, px - step, py);
  const right = sampleHeight(field, px + step, py);
  const up = sampleHeight(field, px, py - step);
  const down = sampleHeight(field, px, py + step);
  if (left === null || right === null || up === null || down === null) return null;

  const spacing = field.metresPerPixel * step * 2;
  if (!(spacing > 0)) return null;

  const dzdx = (right - left) / spacing;
  // North is DECREASING pixel y, so the sign is flipped to make the aspect a
  // compass bearing rather than a screen direction.
  const dzdy = (up - down) / spacing;

  const degrees = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
  let aspect = (Math.atan2(-dzdx, -dzdy) * 180) / Math.PI;
  if (aspect < 0) aspect += 360;
  return { degrees, aspectDegrees: aspect };
}
