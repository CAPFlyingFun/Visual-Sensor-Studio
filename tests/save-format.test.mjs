import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const htmlSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('a format is only offered when the browser can encode it', async () => {
  const { supportedFormats } = await import('../.test-build/vision/save-format.js');
  // A browser asked for a type it cannot encode does NOT throw — it silently
  // returns a PNG. So the probe must check what came back, not that it came
  // back. A save writing 22MB of PNG under a .webp name is the file lying.
  const everything = supportedFormats((mime) => `data:${mime};base64,AA`);
  assert.deepEqual(everything, ['png', 'jpeg', 'webp']);

  // Safari's old behaviour: ask for webp, receive png.
  const safari = supportedFormats((mime) =>
    mime === 'image/webp' ? 'data:image/png;base64,AA' : `data:${mime};base64,AA`);
  assert.deepEqual(safari, ['png', 'jpeg']);

  // A probe that throws is a browser that cannot, not a reason to crash.
  assert.deepEqual(supportedFormats(() => { throw new Error('nope'); }), ['png']);
});

test('an unavailable format falls back to PNG, never to a silent re-encode', async () => {
  const { resolveFormat } = await import('../.test-build/vision/save-format.js');
  assert.equal(resolveFormat('webp', ['png', 'jpeg']), 'png');
  assert.equal(resolveFormat('webp', ['png', 'jpeg', 'webp']), 'webp');
  assert.equal(resolveFormat('jpeg', ['png', 'jpeg']), 'jpeg');
});

test('the file name carries the format the file actually is', async () => {
  const { fileName } = await import('../.test-build/vision/save-format.js');
  const when = new Date('2026-08-31T14:05:00.000Z');
  assert.match(fileName('lens', 'jpeg', when), /^visual-sensor-lens-.*\.jpg$/);
  assert.match(fileName('lens', 'webp', when), /\.webp$/);
  assert.match(fileName('camera', 'png', when), /\.png$/);
  // No colons: they are illegal in a filename on more than one platform.
  assert.doesNotMatch(fileName('lens', 'jpeg', when), /:/);
});

test('quality is clamped, and a missing value is not read as zero', async () => {
  const { clampQuality, DEFAULT_QUALITY } = await import('../.test-build/vision/save-format.js');
  // Number(undefined) is NaN and Number(null) is 0 — a stored setting that
  // never existed must not resolve to the worst possible quality.
  assert.equal(clampQuality(Number.NaN), DEFAULT_QUALITY);
  assert.equal(clampQuality(0), 0.3);
  assert.equal(clampQuality(5), 1);
  assert.equal(clampQuality(0.8), 0.8);
});

test('sizes are stated in units a person reads', async () => {
  const { describeBytes } = await import('../.test-build/vision/save-format.js');
  assert.equal(describeBytes(23 * 1048576), '23.0 MB');
  assert.equal(describeBytes(400 * 1024), '400 KB');
  assert.equal(describeBytes(0), '—');
});

test('quality is passed only to formats that have one', () => {
  // toBlob ignores the third argument for PNG, but passing a number there
  // implies a trade that is not being made.
  assert.match(mainSource, /\}, info\.mime, info\.lossy \? quality : undefined\);/);
});

test('the saved size is reported, because that is what surprised him', () => {
  // "both are literally full resolution at 22-23MB each" — nothing in the UI
  // said so until after the file existed.
  assert.match(mainSource, /const size = describeBytes\(blob\.size\);/);
  assert.match(mainSource, /\$\{size\} \$\{info\.extension\.toUpperCase\(\)\}/);
});

test('the quality slider is inert rather than absent under PNG', () => {
  // An unavailable action must never look functional; a control that vanishes
  // is also a control nobody can learn.
  assert.match(mainSource, /slider\.disabled = !active\.lossy;/);
  assert.match(mainSource, /PNG is lossless, so there is no quality to trade/);
  assert.match(htmlSource, /id="saveQuality"/);
  assert.match(htmlSource, /id="saveFormat"/);
});

test('the zip idea is answered where someone would look for it', () => {
  // Measured, not assumed: zipping a 22.1MB PNG produced 22.1MB. PNG already
  // uses DEFLATE, which is what a .zip would apply.
  assert.match(htmlSource, /Zipping a PNG saves almost nothing/);
});
