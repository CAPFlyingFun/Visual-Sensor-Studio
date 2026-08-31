import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CHANNELS,
  buildRampLut,
  channelInfo,
  parseHex,
  rampToCss,
  renderLens,
  toHex,
  upscaleChannel
} from '../.test-build/vision/lens.js';
import {
  decodeLensShare,
  deleteLens,
  encodeLensShare,
  lensFromLocation,
  loadGallery,
  loadLenses,
  sanitiseLens,
  saveLens,
  shareLink
} from '../.test-build/vision/lens-store.js';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, value)
  };
}

function baseLens(overrides = {}) {
  return sanitiseLens({
    name: 'Test',
    color: { channel: 'speed', low: 0, high: 1, gamma: 1 },
    stops: [
      { at: 0, color: '#000000' },
      { at: 1, color: '#ffffff' }
    ],
    base: 'black',
    sceneBlend: 0,
    ...overrides
  });
}

/* ---------------------------------------------------------------- *
 * Ramps
 * ---------------------------------------------------------------- */

test('a two-stop ramp hits both ends exactly', () => {
  const lut = buildRampLut([
    { at: 0, color: '#102030' },
    { at: 1, color: '#a0b0c0' }
  ]);
  assert.deepEqual([lut[0], lut[1], lut[2]], [0x10, 0x20, 0x30]);
  assert.deepEqual([lut[255 * 3], lut[255 * 3 + 1], lut[255 * 3 + 2]], [0xa0, 0xb0, 0xc0]);
});

test('the ramp interpolates the way a CSS gradient does', () => {
  // The editor draws its swatch with a CSS gradient from these same stops, so
  // any other interpolation would make the swatch disagree with the picture.
  const lut = buildRampLut([
    { at: 0, color: '#000000' },
    { at: 1, color: '#ffffff' }
  ]);
  const mid = lut[128 * 3];
  assert.ok(Math.abs(mid - 128) <= 1, `midpoint should be the average, got ${mid}`);
});

test('stops are honoured out of order and off the ends', () => {
  const lut = buildRampLut([
    { at: 1, color: '#ff0000' },
    { at: 0, color: '#0000ff' },
    { at: 0.5, color: '#00ff00' }
  ]);
  assert.equal(lut[2], 255, 'position 0 should be the blue stop');
  assert.ok(lut[128 * 3 + 1] >= 250, 'the middle should be essentially the green stop');
  assert.equal(lut[255 * 3], 255, 'position 1 should be the red stop');
});

test('two stops at the same position make an edge, not a crash', () => {
  const lut = buildRampLut([
    { at: 0, color: '#000000' },
    { at: 0.5, color: '#ffffff' },
    { at: 0.5, color: '#ff0000' },
    { at: 1, color: '#ff0000' }
  ]);
  assert.ok(Number.isFinite(lut[128 * 3]));
  assert.equal(lut[255 * 3], 255);
});

test('a single stop fills the whole ramp', () => {
  const lut = buildRampLut([{ at: 0.3, color: '#123456' }]);
  assert.deepEqual([lut[0], lut[1], lut[2]], [0x12, 0x34, 0x56]);
  assert.deepEqual([lut[255 * 3], lut[255 * 3 + 1], lut[255 * 3 + 2]], [0x12, 0x34, 0x56]);
});

test('hex parsing round-trips and rejects nonsense safely', () => {
  assert.deepEqual(parseHex('#4080c0'), [0x40, 0x80, 0xc0]);
  assert.deepEqual(parseHex('4080c0'), [0x40, 0x80, 0xc0]);
  assert.deepEqual(parseHex('not a colour'), [0, 0, 0]);
  assert.equal(toHex([0x40, 0x80, 0xc0]), '#4080c0');
  assert.equal(toHex([-20, 999, 12.6]), '#00ff0d');
});

test('the CSS swatch lists every stop as a percentage', () => {
  const css = rampToCss([
    { at: 0, color: '#000000' },
    { at: 0.5, color: '#ff0000' },
    { at: 1, color: '#ffffff' }
  ]);
  assert.match(css, /linear-gradient\(90deg/);
  assert.match(css, /#ff0000 50\.0%/);
});

/* ---------------------------------------------------------------- *
 * Rendering
 * ---------------------------------------------------------------- */

test('an unresolved pixel never receives a colour', () => {
  // The whole point of the valid mask. A speed field cannot resolve a moving
  // edge seen along its own length, and colouring it would invent a reading
  // that the palette would make look confident.
  const lens = baseLens({ base: 'grey' });
  const values = new Float32Array([1, 1, 1, 1]);
  const valid = new Uint8Array([1, 0, 1, 0]);
  const gray = new Uint8ClampedArray([200, 200, 200, 200]);
  const out = new Uint8ClampedArray(4 * 4);
  const report = renderLens(lens, { speed: { values, valid } }, gray, 2, 2, out);
  assert.equal(out[0], 255, 'the resolved pixel takes the top of the ramp');
  assert.equal(out[4], 28, 'the unresolved pixel takes the base');
  assert.equal(out[12], 28);
  assert.equal(report.coverage, 0.5);
});

test('a channel the frame did not produce renders as empty, not as zero', () => {
  // Binding a lens to a field that is not being computed must look blank. If
  // it rendered the bottom of the ramp it would look like a confident
  // measurement of nothing.
  const lens = baseLens({
    color: { channel: 'novelty', low: 0, high: 1, gamma: 1 },
    stops: [
      { at: 0, color: '#ff0000' },
      { at: 1, color: '#ffffff' }
    ]
  });
  const gray = new Uint8ClampedArray([10, 10, 10, 10]);
  const out = new Uint8ClampedArray(4 * 4);
  const report = renderLens(lens, {}, gray, 2, 2, out);
  assert.equal(out[0], 0, 'no source means the base, not the ramp floor');
  assert.equal(report.coverage, 0);
});

test('a range can be inverted by putting high below low', () => {
  const lens = baseLens({ color: { channel: 'speed', low: 1, high: 0, gamma: 1 } });
  const values = new Float32Array([0, 1]);
  const gray = new Uint8ClampedArray([0, 0]);
  const out = new Uint8ClampedArray(2 * 4);
  renderLens(lens, { speed: { values } }, gray, 2, 1, out);
  assert.equal(out[0], 255, 'the low raw value now reads as the top of the ramp');
  assert.equal(out[4], 0);
});

test('gamma bends the mapping without moving the ends', () => {
  const values = new Float32Array([0, 0.5, 1]);
  const gray = new Uint8ClampedArray([0, 0, 0]);
  const read = (gamma) => {
    const lens = baseLens({ color: { channel: 'speed', low: 0, high: 1, gamma } });
    const out = new Uint8ClampedArray(3 * 4);
    renderLens(lens, { speed: { values } }, gray, 3, 1, out);
    return [out[0], out[4], out[8]];
  };
  const linear = read(1);
  const bent = read(2.5);
  assert.equal(linear[0], bent[0], 'the low end is fixed');
  assert.equal(linear[2], bent[2], 'the high end is fixed');
  assert.ok(bent[1] < linear[1], 'a gamma above one pushes the midpoint down');
});

test('a second channel modulates brightness', () => {
  const lens = baseLens({
    stops: [
      { at: 0, color: '#ffffff' },
      { at: 1, color: '#ffffff' }
    ],
    brightness: { channel: 'age', low: 0, high: 1, gamma: 1 }
  });
  const speed = new Float32Array([1, 1]);
  const age = new Float32Array([1, 0]);
  const gray = new Uint8ClampedArray([0, 0]);
  const out = new Uint8ClampedArray(2 * 4);
  renderLens(lens, { speed: { values: speed }, age: { values: age } }, gray, 2, 1, out);
  assert.equal(out[0], 255, 'full on the brightness channel keeps the colour');
  assert.equal(out[4], 0, 'zero on the brightness channel darkens it away');
});

test('scene blend lets the picture through without losing the colour', () => {
  const lens = baseLens({ sceneBlend: 0.5 });
  const values = new Float32Array([1]);
  const gray = new Uint8ClampedArray([100]);
  const out = new Uint8ClampedArray(4);
  renderLens(lens, { speed: { values } }, gray, 1, 1, out);
  // 255 at half weight against a 100 scene.
  assert.ok(Math.abs(out[0] - 177) <= 2, `expected a mix, got ${out[0]}`);
});

test('every rendered pixel is opaque', () => {
  const lens = baseLens();
  const values = new Float32Array([0.2, 0.4, 0.6, 0.8]);
  const valid = new Uint8Array([1, 0, 1, 1]);
  const gray = new Uint8ClampedArray([1, 2, 3, 4]);
  const out = new Uint8ClampedArray(4 * 4);
  renderLens(lens, { speed: { values, valid } }, gray, 2, 2, out);
  for (let i = 0; i < 4; i++) assert.equal(out[i * 4 + 3], 255);
});

/* ---------------------------------------------------------------- *
 * Enlarging a channel for a full-resolution still
 * ---------------------------------------------------------------- */

test('enlarging a channel interpolates rather than repeating blocks', () => {
  const source = { values: new Float32Array([0, 1]) };
  const out = upscaleChannel(source, 2, 1, 8, 1);
  // A repeated-pixel enlargement gives four 0s then four 1s. A real one
  // climbs, which is the difference between a blocky still and a smooth one.
  const distinct = new Set([...out.values].map((v) => v.toFixed(3)));
  assert.ok(distinct.size > 2, `expected a gradient, got ${[...distinct].join(', ')}`);
  for (let i = 1; i < out.values.length; i++) {
    assert.ok(out.values[i] >= out.values[i - 1], 'the ramp must be monotonic');
  }
});

test('enlarging never puts a value outside the source range', () => {
  // Half-pixel centring puts the first sample below zero, and an unclamped
  // negative fraction extrapolates past the data instead of interpolating
  // within it — which is how borders acquire impossible readings.
  const values = new Float32Array([2, 5, 9, 4, 7, 1]);
  const out = upscaleChannel({ values }, 3, 2, 31, 17);
  const min = Math.min(...values);
  const max = Math.max(...values);
  for (const value of out.values) {
    assert.ok(value >= min - 1e-6 && value <= max + 1e-6, `${value} escaped [${min}, ${max}]`);
  }
});

test('an enlarged pixel is measured only if every sample feeding it was', () => {
  // Interpolating across the boundary between measured and unmeasured would
  // invent a reading in a place that never had one, and the palette would
  // make it look as confident as any other.
  const values = new Float32Array([1, 1, 1, 1]);
  const valid = new Uint8Array([1, 0, 1, 1]);
  const out = upscaleChannel({ values, valid }, 2, 2, 8, 8);
  assert.ok(out.valid, 'the mask must survive enlargement');
  // The one unmeasured corner has to contaminate everything it touches, so
  // the enlarged mask can never claim more coverage than the source did.
  const claimed = [...out.valid].filter((v) => v !== 0).length / out.valid.length;
  const sourceClaimed = [...valid].filter((v) => v !== 0).length / valid.length;
  assert.ok(claimed <= sourceClaimed + 1e-6,
    `enlarging claimed ${claimed.toFixed(2)} from a source of ${sourceClaimed.toFixed(2)}`);
});

test('a channel with no mask stays maskless when enlarged', () => {
  const out = upscaleChannel({ values: new Float32Array([1, 2, 3, 4]) }, 2, 2, 4, 4);
  assert.equal(out.valid, null);
});

test('enlarging a degenerate field does not throw', () => {
  for (const [sw, sh] of [[0, 0], [1, 1], [0, 4]]) {
    assert.doesNotThrow(() => upscaleChannel({ values: new Float32Array(sw * sh) }, sw, sh, 4, 4));
  }
});

test('an enlarged channel renders through a lens unchanged in character', () => {
  // The end-to-end point: enlarging feeds the same renderLens, and an
  // unmeasured region still refuses to take a colour on the way out.
  const lens = baseLens({ base: 'grey' });
  const values = new Float32Array([1, 1, 1, 1]);
  const valid = new Uint8Array([1, 1, 0, 1]);
  const big = upscaleChannel({ values, valid }, 2, 2, 6, 6);
  const gray = new Uint8ClampedArray(36).fill(200);
  const out = new Uint8ClampedArray(36 * 4);
  const report = renderLens(lens, { speed: big }, gray, 6, 6, out);
  assert.ok(report.coverage < 1, 'the unmeasured corner must survive to the picture');
  let base = 0;
  for (let i = 0; i < 36; i++) if (out[i * 4] === 28) base++;
  assert.ok(base > 0, 'unmeasured pixels should be painted the base');
});

/* ---------------------------------------------------------------- *
 * Channels
 * ---------------------------------------------------------------- */

test('there is no depth channel, and relief does not claim to be one', () => {
  // A browser gets camera frames and nothing else on iOS: no depth buffer, no
  // disparity, no LiDAR. Offering a "depth" channel would make every lens
  // built on it a false claim, so the honest field is named for what it reads.
  const ids = CHANNELS.map((c) => c.id);
  assert.ok(!ids.includes('depth'), 'no depth channel may exist');
  const relief = channelInfo('relief');
  assert.match(relief.meaning, /not distance/i);
  assert.doesNotMatch(relief.label, /depth/i);
});

test('every channel states its unit and its meaning', () => {
  for (const channel of CHANNELS) {
    assert.ok(channel.meaning.length > 10, `${channel.id} needs a meaning`);
    assert.ok(channel.unit.length > 0, `${channel.id} needs a unit`);
    assert.ok(channel.high !== channel.low, `${channel.id} needs a usable default range`);
  }
});

test('image speed is labelled as image motion rather than object speed', () => {
  assert.match(channelInfo('speed').meaning, /Not the object/i);
});

/* ---------------------------------------------------------------- *
 * Sanitising imported documents
 * ---------------------------------------------------------------- */

test('nonsense sanitises into a working lens instead of throwing', () => {
  for (const junk of [null, undefined, 42, 'lens', [], {}, { stops: 'red' }]) {
    const lens = sanitiseLens(junk);
    assert.equal(lens.version, 1);
    assert.ok(lens.stops.length >= 2);
    assert.ok(lens.gamma === undefined);
    const out = new Uint8ClampedArray(4);
    // The real proof: whatever came out can be rendered.
    renderLens(lens, {}, new Uint8ClampedArray([0]), 1, 1, out);
  }
});

test('an unknown channel falls back rather than reaching the renderer', () => {
  const lens = sanitiseLens({ color: { channel: 'lidar', low: 0, high: 1, gamma: 1 } });
  assert.equal(lens.color.channel, 'speed');
});

test('a zero or negative gamma is clamped away from dividing by zero', () => {
  assert.equal(sanitiseLens({ color: { channel: 'luma', gamma: 0 } }).color.gamma, 0.1);
  assert.equal(sanitiseLens({ color: { channel: 'luma', gamma: -3 } }).color.gamma, 0.1);
  assert.equal(sanitiseLens({ color: { channel: 'luma', gamma: 500 } }).color.gamma, 6);
});

test('NaN and infinity never survive into a binding', () => {
  const lens = sanitiseLens({
    color: { channel: 'speed', low: NaN, high: Infinity, gamma: NaN },
    sceneBlend: NaN
  });
  assert.ok(Number.isFinite(lens.color.low));
  assert.ok(Number.isFinite(lens.color.high));
  assert.ok(Number.isFinite(lens.color.gamma));
  assert.ok(Number.isFinite(lens.sceneBlend));
});

test('an enormous stop list is capped', () => {
  const stops = Array.from({ length: 400 }, (_, i) => ({ at: i / 400, color: '#ff0000' }));
  assert.ok(sanitiseLens({ stops }).stops.length <= 8);
});

test('a runaway name cannot break the list layout', () => {
  const lens = sanitiseLens({ name: 'x'.repeat(5000), note: 'y'.repeat(5000) });
  assert.ok(lens.name.length <= 40);
  assert.ok((lens.note ?? '').length <= 140);
});

test('a bad colour becomes black rather than reaching the parser', () => {
  const lens = sanitiseLens({ stops: [{ at: 0, color: 'javascript:alert(1)' }, { at: 1, color: '#FFAA00' }] });
  assert.equal(lens.stops[0].color, '#000000');
  assert.equal(lens.stops[1].color, '#ffaa00');
});

/* ---------------------------------------------------------------- *
 * Local storage
 * ---------------------------------------------------------------- */

test('a lens saves and loads back', () => {
  const storage = memoryStorage();
  const lens = baseLens({ name: 'Cold trails' });
  const result = saveLens(storage, [], lens);
  assert.ok(result.saved);
  const loaded = loadLenses(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, 'Cold trails');
});

test('saving an existing id replaces rather than duplicates', () => {
  const storage = memoryStorage();
  const lens = baseLens({ name: 'First' });
  const once = saveLens(storage, [], lens);
  const twice = saveLens(storage, once.lenses, { ...lens, name: 'Second' });
  assert.equal(twice.lenses.length, 1);
  assert.equal(twice.lenses[0].name, 'Second');
});

test('there is no slot limit', () => {
  // A lens is a few hundred bytes against a multi-megabyte quota, so a cap
  // would be a rule invented for its own sake.
  const storage = memoryStorage();
  let lenses = [];
  for (let i = 0; i < 60; i++) {
    lenses = saveLens(storage, lenses, baseLens({ name: `Lens ${i}` })).lenses;
  }
  assert.equal(lenses.length, 60);
  assert.equal(loadLenses(storage).length, 60);
});

test('a corrupt store opens empty instead of stopping the app', () => {
  const storage = memoryStorage({ 'vss.lenses.v1': '{ not json' });
  assert.deepEqual(loadLenses(storage), []);
});

test('a store holding junk entries still yields renderable lenses', () => {
  const storage = memoryStorage({ 'vss.lenses.v1': JSON.stringify([null, 7, { name: 'ok' }]) });
  const lenses = loadLenses(storage);
  assert.equal(lenses.length, 3);
  for (const lens of lenses) assert.ok(lens.stops.length >= 2);
});

test('a full quota is reported rather than thrown', () => {
  const storage = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError: the quota has been exceeded');
    }
  };
  const result = saveLens(storage, [], baseLens());
  assert.equal(result.saved, false);
  assert.match(result.error ?? '', /storage/i);
});

test('deleting removes only the named lens', () => {
  const storage = memoryStorage();
  let lenses = saveLens(storage, [], baseLens({ name: 'A' })).lenses;
  lenses = saveLens(storage, lenses, baseLens({ name: 'B' })).lenses;
  const remaining = deleteLens(storage, lenses, lenses[0].id);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].name, 'B');
});

/* ---------------------------------------------------------------- *
 * Sharing
 * ---------------------------------------------------------------- */

test('a lens survives a share round trip', () => {
  const lens = baseLens({
    name: 'Ember',
    note: 'Warm on fast movement',
    color: { channel: 'speed', low: 0.02, high: 0.4, gamma: 1.6 },
    stops: [
      { at: 0, color: '#0a0a2a' },
      { at: 0.6, color: '#ff6600' },
      { at: 1, color: '#fff2c0' }
    ],
    brightness: { channel: 'age', low: 4, high: 0, gamma: 1 },
    base: 'black',
    sceneBlend: 0.15
  });
  const decoded = decodeLensShare(encodeLensShare(lens));
  assert.ok(decoded);
  assert.equal(decoded.name, 'Ember');
  assert.equal(decoded.note, 'Warm on fast movement');
  assert.deepEqual(decoded.stops, lens.stops);
  assert.deepEqual(decoded.color, lens.color);
  assert.deepEqual(decoded.brightness, lens.brightness);
  assert.equal(decoded.sceneBlend, lens.sceneBlend);
});

test('an imported lens gets a new id so it cannot overwrite your own', () => {
  const lens = baseLens({ name: 'Mine' });
  const decoded = decodeLensShare(encodeLensShare(lens));
  assert.notEqual(decoded.id, lens.id);
});

test('a share code carrying unicode survives', () => {
  const lens = baseLens({ name: 'Ánts 🐜 fast' });
  assert.equal(decodeLensShare(encodeLensShare(lens)).name, 'Ánts 🐜 fast');
});

test('a share code is url-safe', () => {
  const lens = baseLens({ name: 'x'.repeat(40), note: 'y'.repeat(140) });
  const code = encodeLensShare(lens);
  assert.doesNotMatch(code, /[+/=]/, 'the code must survive being put in a link');
  assert.equal(encodeURIComponent(code), code);
});

test('junk share codes are refused without throwing', () => {
  for (const junk of ['', '   ', 'not-base64!!', 'YWJj', '#lens=', 'eyJhIjox']) {
    assert.doesNotThrow(() => decodeLensShare(junk));
  }
  assert.equal(decodeLensShare('not base64 at all $$$'), null);
});

test('a whole share link can be pasted, not just the code', () => {
  const lens = baseLens({ name: 'Pasted' });
  const link = shareLink(lens, 'https://example.com/app/#already=here');
  assert.match(link, /^https:\/\/example\.com\/app\/#lens=/);
  assert.equal(decodeLensShare(link).name, 'Pasted');
});

test('a lens in the address bar is found in hash or query', () => {
  const code = encodeLensShare(baseLens({ name: 'Linked' }));
  assert.equal(lensFromLocation(`#lens=${code}`, '').name, 'Linked');
  assert.equal(lensFromLocation(`#tab=camera&lens=${code}`, '').name, 'Linked');
  assert.equal(lensFromLocation('', `?lens=${code}`).name, 'Linked');
  assert.equal(lensFromLocation('#tab=camera', '?scene=x'), null);
});

/* ---------------------------------------------------------------- *
 * Gallery
 * ---------------------------------------------------------------- */

test('the gallery loads shipped lenses', async () => {
  const entries = await loadGallery(async () => ({
    ok: true,
    json: async () => ({ lenses: [{ name: 'Shipped', author: 'VSS' }] })
  }));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].lens.name, 'Shipped');
  assert.equal(entries[0].author, 'VSS');
});

test('a missing or broken gallery is not an error', async () => {
  assert.deepEqual(await loadGallery(async () => ({ ok: false })), []);
  assert.deepEqual(await loadGallery(async () => { throw new Error('offline'); }), []);
  assert.deepEqual(await loadGallery(async () => ({ ok: true, json: async () => 'nope' })), []);
});

test('the shipped gallery file is valid and every lens in it renders', async () => {
  const raw = JSON.parse(readFileSync(new URL('../public/lenses/index.json', import.meta.url), 'utf8'));
  const entries = await loadGallery(async () => ({ ok: true, json: async () => raw }));
  assert.ok(entries.length >= 3, 'ship a few lenses so the feature is discoverable');
  for (const entry of entries) {
    const out = new Uint8ClampedArray(4);
    const values = new Float32Array([0.5]);
    renderLens(entry.lens, {
      speed: { values }, luma: { values }, change: { values },
      edges: { values }, relief: { values }, age: { values }, novelty: { values }
    }, new Uint8ClampedArray([120]), 1, 1, out);
    assert.equal(out[3], 255, `${entry.lens.name} should render`);
    assert.ok(entry.lens.name.length > 0);
  }
});

test('no shipped lens claims to measure distance', () => {
  const raw = readFileSync(new URL('../public/lenses/index.json', import.meta.url), 'utf8');
  assert.doesNotMatch(raw, /\bdepth\b/i);
  assert.doesNotMatch(raw, /lidar/i);
});
