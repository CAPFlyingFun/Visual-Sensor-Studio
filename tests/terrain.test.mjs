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

// --- 3D mesh ---------------------------------------------------------------

import { buildTerrainMesh } from '../.test-build/terrain/mesh.js';
import { gpsToLocalMeters } from '../.test-build/core/math.js';
import { fieldPixelToLonLat } from '../.test-build/terrain/tiles.js';

/** A field built around a real place, so the projection has something to bite on. */
function fieldAround(lat, lon, size = 32, filler = (x, y) => 100 + x * 5) {
  const window = tilesForRadius(lon, lat, 3218, 12);
  const data = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data[y * size + x] = filler(x, y);
  return {
    data, width: size, height: size,
    west: window.west, east: window.east, north: window.north, south: window.south,
    zoom: 12, metresPerPixel: metresPerPixel(lat, 12)
  };
}

test('field pixels and coordinates round-trip', () => {
  const field = fieldAround(46.85, -121.76);
  for (const [px, py] of [[0, 0], [15.5, 9.25], [31, 31]]) {
    const { lon, lat } = fieldPixelToLonLat(field, px, py);
    const back = projectToField(field, lon, lat);
    assert.ok(Math.abs(back.x - px) < 1e-6, `x ${back.x} vs ${px}`);
    assert.ok(Math.abs(back.y - py) < 1e-6, `y ${back.y} vs ${py}`);
  }
});

test('the mesh is built in the same space the GPS track uses', () => {
  // A mesh in its own coordinates would sit beside the track rather than under
  // it, and that error is invisible until the path floats off the hillside.
  const lat = 46.85;
  const lon = -121.76;
  const field = fieldAround(lat, lon);
  const mesh = buildTerrainMesh(field, lat, lon, { resolution: 8 });
  assert.ok(mesh);

  // Every vertex must match what gpsToLocalMeters would give for its own
  // coordinate, through the same projection rather than a parallel one.
  for (const [column, row] of [[0, 0], [3, 5], [7, 7]]) {
    const index = row * mesh.columns + column;
    const px = (column / (mesh.columns - 1)) * (field.width - 1);
    const py = (row / (mesh.rows - 1)) * (field.height - 1);
    const { lon: vlon, lat: vlat } = fieldPixelToLonLat(field, px, py);
    const expected = gpsToLocalMeters(
      { latitude: vlat, longitude: vlon, altitude: 0 },
      { latitude: lat, longitude: lon, altitude: 0 }
    );
    assert.ok(Math.abs(mesh.positions[index * 3] - expected.x) < 0.01, 'east must match');
    assert.ok(Math.abs(mesh.positions[index * 3 + 2] - expected.z) < 0.01, 'north must match');
  }
});

test('the surface meets zero where the track starts, not at the field centre', () => {
  // A tile window is quantised to tile boundaries, so the requested point and
  // the middle of the fetched block are DIFFERENT places. Anchoring to the
  // centre put the datum 1450 m below a summit and buried the position marker
  // inside the mountain — and a constant-elevation fixture cannot catch that,
  // because both places read the same.
  const lat = 46.8523;
  const lon = -121.7603;
  // A steep field, so centre and origin differ sharply.
  const size = 64;
  const field = fieldAround(lat, lon, size, (x, y) => 500 + x * 60 + y * 40);
  const origin = projectToField(field, lon, lat);
  const truth = sampleHeight(field, origin.x, origin.y);
  const mesh = buildTerrainMesh(field, lat, lon, { resolution: 16 });
  assert.ok(mesh && truth !== null);

  assert.ok(Math.abs(mesh.datumMetres - truth) < 1,
    `datum ${mesh.datumMetres} should be the elevation at the ORIGIN, ${truth}`);

  const middlePixel = sampleHeight(field, (size - 1) / 2, (size - 1) / 2);
  assert.ok(Math.abs(truth - middlePixel) > 50,
    'the fixture must actually distinguish the two, or the test proves nothing');

  // And a vertex at the origin's own position must sit at y = 0.
  const local = gpsToLocalMeters(
    { latitude: lat, longitude: lon, altitude: 0 },
    { latitude: lat, longitude: lon, altitude: 0 }
  );
  assert.equal(local.x, 0);
  let nearest = 0;
  let best = Infinity;
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    const d = Math.hypot(mesh.positions[i * 3], mesh.positions[i * 3 + 2]);
    if (d < best) { best = d; nearest = i; }
  }
  const metresPerVertex = mesh.spanMetres / mesh.columns;
  const rise = Math.abs(mesh.positions[nearest * 3 + 1]);
  assert.ok(rise < metresPerVertex * 2,
    `the vertex nearest the origin should be near y=0, got ${rise} m`);
});

test('exaggeration scales relief without moving the datum', () => {
  const lat = 46.85;
  const lon = -121.76;
  const field = fieldAround(lat, lon);
  const plain = buildTerrainMesh(field, lat, lon, { resolution: 8, exaggeration: 1 });
  const tall = buildTerrainMesh(field, lat, lon, { resolution: 8, exaggeration: 4 });

  assert.equal(plain.datumMetres, tall.datumMetres);
  let scaled = 0;
  for (let i = 1; i < plain.positions.length; i += 3) {
    if (Math.abs(plain.positions[i]) < 0.01) continue;
    assert.ok(Math.abs(tall.positions[i] / plain.positions[i] - 4) < 1e-4,
      `expected 4x, got ${tall.positions[i] / plain.positions[i]}`);
    scaled++;
  }
  assert.ok(scaled > 0, 'something should have been scaled');
});

test('water is a hole, not a flat lid at the datum', () => {
  // Bridging a quad across missing data would draw a plateau over the sea.
  const lat = 27.95;
  const lon = -82.45;
  const size = 16;
  const field = fieldAround(lat, lon, size, (x) => (x < 8 ? NO_DATA : 40));
  const mesh = buildTerrainMesh(field, lat, lon, { resolution: 8 });
  assert.ok(mesh);
  assert.ok(mesh.missingVertices > 0, 'the ocean half should be missing');

  // No triangle may reference a vertex that had no elevation.
  const hasData = new Uint8Array(mesh.columns * mesh.rows);
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    hasData[i] = mesh.colors[i * 3] > 0.12 ? 1 : 0;
  }
  for (const index of mesh.indices) {
    assert.equal(hasData[index], 1, `triangle uses no-data vertex ${index}`);
  }
});

test('a field with no elevation anywhere builds nothing', () => {
  const field = fieldAround(0, 0, 16, () => NO_DATA);
  assert.equal(buildTerrainMesh(field, 0, 0, { resolution: 8 }), null);
});

test('mesh arrays are consistent and in range', () => {
  const field = fieldAround(46.85, -121.76, 32);
  const mesh = buildTerrainMesh(field, 46.85, -121.76, { resolution: 12 });
  assert.equal(mesh.positions.length, mesh.columns * mesh.rows * 3);
  assert.equal(mesh.colors.length, mesh.positions.length);
  assert.equal(mesh.indices.length % 3, 0);
  for (const index of mesh.indices) {
    assert.ok(index >= 0 && index < mesh.columns * mesh.rows, `index ${index} out of range`);
  }
  for (const c of mesh.colors) assert.ok(c >= 0 && c <= 1, `colour ${c} out of range`);
  for (const v of mesh.positions) assert.ok(Number.isFinite(v), 'positions must be finite');
  assert.ok(mesh.spanMetres > 1000, `a two-mile field should span metres, got ${mesh.spanMetres}`);
});

// --- Survey noise ----------------------------------------------------------

import { estimateRoughness, smoothField } from '../.test-build/terrain/render.js';

/** A field whose lower half carries survey noise and whose upper half does not. */
function mixedSurveyField(size = 32, noise = 3) {
  const data = new Float32Array(size * size);
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ground = 30 + x * 0.4 + y * 0.3;
      data[y * size + x] = y < size / 2 ? ground : ground + rand() * noise;
    }
  }
  return {
    data, width: size, height: size,
    west: -87.5, east: -87.4, north: 30.55, south: 30.45,
    zoom: 12, metresPerPixel: 30
  };
}

test('roughness measures curvature, not slope', () => {
  // A hillside has a large gradient and is perfectly smooth. Measuring slope
  // would call every mountain noisy.
  const steep = ramp(60);
  assert.ok(estimateRoughness(steep).mean < 0.01,
    `a smooth ramp must read as smooth, got ${estimateRoughness(steep).mean}`);
});

test('a mosaic of two surveys is detected and reported', () => {
  // A hard seam along a tile edge is the dataset, not the renderer — it
  // mosaics national and satellite sources with different noise.
  const mixed = estimateRoughness(mixedSurveyField());
  assert.ok(mixed.mean > 0.5, `noise should register, got ${mixed.mean}`);
  assert.ok(mixed.variation > 1.8,
    `an uneven field should report variation, got ${mixed.variation}`);

  const even = estimateRoughness(mixedSurveyField(32, 0));
  assert.ok(even.variation < 1.8, `a uniform field should not, got ${even.variation}`);
});

test('the contour interval stays clear of the survey noise', () => {
  // An interval near the noise floor draws contours OF the noise, which is what
  // turned a flat coastal plain into speckle.
  const relief = 60;
  assert.equal(contourInterval(relief, 0), 5);
  assert.ok(contourInterval(relief, 1.3) > 5,
    'more than a metre of jitter must push the interval up');
  assert.ok(contourInterval(relief, 1.3) >= 1.3 * 4);
});

test('smoothing never touches the survey data itself', () => {
  // The elevation readout has to report what the survey said, not what looks
  // tidy.
  const field = mixedSurveyField();
  const before = Float32Array.from(field.data);
  const smoothed = smoothField(field, 2);
  assert.deepEqual(field.data, before, 'the field must be left alone');
  assert.notDeepEqual(smoothed, before, 'and the copy must actually be smoother');

  const roughBefore = estimateRoughness(field).mean;
  const roughAfter = estimateRoughness({ ...field, data: smoothed }).mean;
  assert.ok(roughAfter < roughBefore * 0.6,
    `smoothing should cut noise: ${roughBefore} -> ${roughAfter}`);
});

test('smoothing does not bleed the ocean into the land', () => {
  const field = mixedSurveyField(16, 0);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 6; x++) field.data[y * 16 + x] = NO_DATA;
  const smoothed = smoothField(field, 2);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 6; x++) {
      assert.ok(smoothed[y * 16 + x] <= NO_DATA + 1, 'no-data must stay no-data');
    }
    // And the first land cell must not have been dragged toward -32768.
    assert.ok(smoothed[y * 16 + 6] > 0, `land next to the sea got ${smoothed[y * 16 + 6]}`);
  }
});
