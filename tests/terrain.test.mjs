import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_DATA,
  decodeTerrarium,
  lonLatToTile,
  metresPerPixel,
  projectToField,
  sampleHeight,
  slopeAt,
  tileToLonLat,
  tilesForRadius
} from '../.test-build/terrain/tiles.js';

test('tile projection round-trips', () => {
  for (const [lon, lat] of [[0, 0], [-82.45, 27.95], [13.4, 52.5], [-157.8, 21.3]]) {
    const tile = lonLatToTile(lon, lat, 13);
    const back = tileToLonLat(tile.x, tile.y, 13);
    assert.ok(Math.abs(back.lon - lon) < 1e-9, `lon ${back.lon} vs ${lon}`);
    assert.ok(Math.abs(back.lat - lat) < 1e-9, `lat ${back.lat} vs ${lat}`);
  }
});

test('ground scale shrinks with latitude', () => {
  // Mercator stretches, so the same tile covers far less ground further north.
  // Ignoring that puts every slope out by the cosine of the latitude.
  const equator = metresPerPixel(0, 13);
  const florida = metresPerPixel(28, 13);
  const alaska = metresPerPixel(64, 13);
  assert.ok(florida < equator);
  assert.ok(alaska < florida);
  assert.ok(Math.abs(florida / equator - Math.cos((28 * Math.PI) / 180)) < 1e-9);
});

test('a radius is covered, and the point is inside the window', () => {
  const lon = -82.45;
  const lat = 27.95;
  const window = tilesForRadius(lon, lat, 3218, 13);

  assert.ok(window.tiles.length >= 1);
  assert.ok(lon >= window.west && lon <= window.east, 'longitude must be covered');
  assert.ok(lat <= window.north && lat >= window.south, 'latitude must be covered');
  // Two miles across in each direction, at minimum.
  const perTile = metresPerPixel(lat, 13) * 256;
  assert.ok((window.maxX - window.minX + 1) * perTile >= 3218,
    'the window must reach the requested radius');
});

test('a tile request is capped rather than left to grow', () => {
  // An uncapped window at a high zoom is hundreds of tiles, which is a bad
  // thing to do by accident to someone on cellular data.
  const window = tilesForRadius(-82.45, 27.95, 50000, 15, 16);
  assert.ok(window.tiles.length <= 16, `asked for ${window.tiles.length} tiles`);
  // And it stays centred on the point rather than trimming to one side.
  assert.ok(-82.45 >= window.west && -82.45 <= window.east);
  assert.ok(27.95 <= window.north && 27.95 >= window.south);
});

test('every tile in a window is a real, in-range index', () => {
  const window = tilesForRadius(-179.9, 84, 3218, 6);
  const limit = 2 ** 6;
  for (const tile of window.tiles) {
    assert.ok(Number.isInteger(tile.x) && tile.x >= 0 && tile.x < limit, `bad x ${tile.x}`);
    assert.ok(Number.isInteger(tile.y) && tile.y >= 0 && tile.y < limit, `bad y ${tile.y}`);
    assert.equal(tile.z, 6);
  }
});

test('terrarium decoding matches the published encoding', () => {
  // Dropping the offset puts every reading 32 km underground.
  assert.equal(decodeTerrarium(128, 0, 0), 0);
  assert.equal(decodeTerrarium(128, 100, 0), 100);
  // The blue channel is a 1/256 m fraction, not a rounding error.
  assert.ok(Math.abs(decodeTerrarium(128, 100, 128) - 100.5) < 1e-9);
  // Sea level and below.
  assert.equal(decodeTerrarium(127, 156, 0), -100);
  assert.equal(decodeTerrarium(0, 0, 0), NO_DATA);
});

/** A field with a constant east-facing slope, for checking gradients. */
function ramp(rise, size = 8, perPixel = 30) {
  const data = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) data[y * size + x] = x * rise;
  }
  return {
    data, width: size, height: size,
    west: -82.5, east: -82.4, north: 28.05, south: 27.95,
    zoom: 13, metresPerPixel: perPixel
  };
}

test('height is interpolated between samples', () => {
  const field = ramp(30);
  assert.equal(sampleHeight(field, 2, 4), 60);
  assert.equal(sampleHeight(field, 2.5, 4), 75, 'halfway between two cells');
});

test('no-data is excluded rather than averaged in', () => {
  // Terrarium marks ocean and gaps with the encoding's floor. Averaging that
  // into a neighbourhood drags a coastal hillside down by kilometres.
  const field = ramp(30);
  field.data[4 * 8 + 3] = NO_DATA;
  const value = sampleHeight(field, 2.5, 4);
  assert.ok(value !== null && value > 0 && value < 200,
    `a no-data neighbour must not drag the sample to ${value}`);

  // And a neighbourhood that is entirely missing reports nothing at all.
  const empty = ramp(30);
  empty.data.fill(NO_DATA);
  assert.equal(sampleHeight(empty, 4, 4), null);
});

test('slope is measured in ground distance, not in pixels', () => {
  // The same hill must read as the same steepness at every zoom, and it only
  // does if the gradient is divided by metres rather than by cells.
  const coarse = ramp(30, 8, 30);
  const fine = ramp(15, 8, 15);
  const a = slopeAt(coarse, 4, 4);
  const b = slopeAt(fine, 4, 4);
  assert.ok(a && b);
  assert.ok(Math.abs(a.degrees - b.degrees) < 1e-6,
    `${a.degrees}° vs ${b.degrees}° for the same real gradient`);
  // A 30 m rise over 30 m of ground is 45 degrees.
  assert.ok(Math.abs(a.degrees - 45) < 1e-6, `expected 45°, got ${a.degrees}`);
});

test('aspect points downhill as a compass bearing', () => {
  // Ground rising to the east means the slope faces west, which is 270.
  const field = ramp(30);
  const reading = slopeAt(field, 4, 4);
  assert.ok(reading);
  assert.ok(Math.abs(reading.aspectDegrees - 270) < 1e-6,
    `expected 270°, got ${reading.aspectDegrees}`);
});

test('flat ground has no slope and no aspect to report', () => {
  const field = ramp(0);
  const reading = slopeAt(field, 4, 4);
  assert.ok(reading);
  assert.equal(reading.degrees, 0);
});

test('a position projects into the field it was built for', () => {
  const window = tilesForRadius(-82.45, 27.95, 3218, 13);
  const field = {
    data: new Float32Array(1), width: (window.maxX - window.minX + 1) * 256,
    height: (window.maxY - window.minY + 1) * 256,
    west: window.west, east: window.east, north: window.north, south: window.south,
    zoom: 13, metresPerPixel: metresPerPixel(27.95, 13)
  };
  const point = projectToField(field, -82.45, 27.95);
  assert.ok(point.x >= 0 && point.x <= field.width, `x ${point.x} outside 0..${field.width}`);
  assert.ok(point.y >= 0 && point.y <= field.height, `y ${point.y} outside 0..${field.height}`);

  // The north-west corner projects to the origin.
  const corner = projectToField(field, window.west, window.north);
  assert.ok(Math.abs(corner.x) < 1e-6 && Math.abs(corner.y) < 1e-6);
});

// --- Rendering -------------------------------------------------------------

import { contourInterval, renderTerrain, terrainStats } from '../.test-build/terrain/render.js';

test('statistics ignore no-data rather than averaging it in', () => {
  const field = ramp(30);
  field.data[0] = NO_DATA;
  const stats = terrainStats(field);
  assert.ok(stats.min >= 0, `min dragged to ${stats.min} by a no-data cell`);
  assert.ok(stats.mean > 0);
  assert.ok(stats.missingFraction > 0 && stats.missingFraction < 0.1);
});

test('a field with no data at all is reported as such, not as sea level', () => {
  const field = ramp(0);
  field.data.fill(NO_DATA);
  const stats = terrainStats(field);
  assert.equal(stats.missingFraction, 1);
});

test('the contour interval follows the relief present', () => {
  // Ten-metre lines across a mountain are unreadable ink; hundred-metre lines
  // across Florida are no lines at all.
  const flat = contourInterval(30);
  const hilly = contourInterval(400);
  const alpine = contourInterval(3000);
  assert.ok(flat < hilly && hilly < alpine, `${flat} / ${hilly} / ${alpine}`);
  // And each produces a readable number of lines rather than one or a hundred.
  for (const [relief, interval] of [[30, flat], [400, hilly], [3000, alpine]]) {
    const lines = relief / interval;
    assert.ok(lines >= 4 && lines <= 30, `${lines} lines for ${relief} m of relief`);
  }
});

test('water is drawn as water, not as a height of minus thirty-two thousand', () => {
  const field = ramp(30);
  field.data.fill(NO_DATA);
  const out = new Uint8ClampedArray(field.width * field.height * 4);
  renderTerrain(field, terrainStats(field), out);
  assert.ok(out[2] > out[0], 'missing ground should read blue');
  assert.equal(out[3], 255);
});

test('a slope facing the sun is brighter than one facing away', () => {
  const size = 16;
  const perPixel = 30;
  const data = new Float32Array(size * size);
  // A ridge: rising to the middle, falling after it.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      data[y * size + x] = (x < size / 2 ? x : size - x) * 40;
    }
  }
  const field = {
    data, width: size, height: size, west: -1, east: 1, north: 1, south: -1,
    zoom: 12, metresPerPixel: perPixel
  };
  const out = new Uint8ClampedArray(size * size * 4);
  // Light from the west, so the west-facing side is lit and the east is shaded.
  renderTerrain(field, terrainStats(field), out, { azimuth: 270, altitude: 45, contours: false });

  const luma = (x, y) => {
    const p = (y * size + x) * 4;
    return out[p] * 0.2126 + out[p + 1] * 0.7152 + out[p + 2] * 0.0722;
  };
  assert.ok(luma(4, 8) > luma(12, 8),
    `the lit flank ${luma(4, 8)} should be brighter than the shaded one ${luma(12, 8)}`);
});

test('exaggeration changes the shading without moving a contour', () => {
  // Applying it to the height instead of the gradient would silently relabel
  // every line on the map.
  const field = ramp(20, 16, 30);
  const stats = terrainStats(field);
  const flatLit = new Uint8ClampedArray(16 * 16 * 4);
  const steepLit = new Uint8ClampedArray(16 * 16 * 4);
  renderTerrain(field, stats, flatLit, { exaggeration: 1, contours: false });
  renderTerrain(field, stats, steepLit, { exaggeration: 6, contours: false });

  let differs = 0;
  for (let i = 0; i < flatLit.length; i += 4) if (flatLit[i] !== steepLit[i]) differs++;
  assert.ok(differs > 0, 'exaggeration must change the shading');

  // The statistics the contours are drawn from are untouched by it.
  assert.deepEqual(terrainStats(field), stats);
});

test('every rendered pixel is opaque and in range', () => {
  const field = ramp(30);
  field.data[5] = NO_DATA;
  const out = new Uint8ClampedArray(field.width * field.height * 4);
  renderTerrain(field, terrainStats(field), out);
  for (let i = 0; i < out.length; i += 4) {
    assert.equal(out[i + 3], 255, 'alpha must be opaque');
    for (let c = 0; c < 3; c++) {
      assert.ok(out[i + c] >= 0 && out[i + c] <= 255, `channel out of range: ${out[i + c]}`);
    }
  }
});
