import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PROBE_AMPLIFY, PROBE_TOLERANCE, PROBE_VALUES, describeBytes, describeGpuPrecision, textureBytes
} from '../.test-build/v2/render/gpu-precision.js';

/*
 * The Night/GPU precision probe. Joshua, 2026-09-04: "Do not just test whether
 * an extension string exists." The GL half needs a GPU and is verified in a
 * real browser; what is tested here is the arithmetic that decides PASS/FAIL
 * and the memory maths the format choice rests on.
 */

test('the probe values are all below one 8-bit step, so RGBA8 must fail them', () => {
  // This is the property that makes the probe a discriminator rather than a
  // formality: an 8-bit target rounds every one of these to zero. Half a step
  // is 0.5/255; anything at or above it would survive RGBA8 and the control
  // would pass, proving nothing.
  const halfStep = 0.5 / 255;
  for (const value of PROBE_VALUES) {
    assert.ok(value < halfStep, `${value} must be below ${halfStep} or RGBA8 could hold it`);
    assert.equal(Math.round(value * 255), 0, 'and it must round to zero in 8 bits');
  }
  // Distinct from each other, or the readback could not tell them apart.
  assert.equal(new Set(PROBE_VALUES).size, PROBE_VALUES.length);
});

test('amplified, those values land inside 8-bit range and far apart', () => {
  // The readback is an ordinary UNSIGNED_BYTE readPixels, so the amplified
  // values have to be representable AND separated by much more than the
  // tolerance — otherwise a pass and a fail would be indistinguishable.
  const counts = PROBE_VALUES.map((v) => Math.round(v * PROBE_AMPLIFY * 255));
  for (const count of counts) {
    assert.ok(count > 0 && count <= 255, `${count} must be a readable 8-bit value`);
  }
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i] - counts[i - 1] > PROBE_TOLERANCE * 2,
      'each step must clear twice the tolerance');
  }
  // A zero read (what RGBA8 gives) must be outside tolerance of every expected
  // value, or the control could "pass" by reading black.
  for (const count of counts) {
    assert.ok(Math.abs(0 - count) > PROBE_TOLERANCE, 'black must never look like a pass');
  }
});

test('the memory maths is the real byte count, and matches the plan', () => {
  const MAX = textureBytes(3024, 4032, 4);
  assert.equal(MAX, 48771072);
  assert.equal(textureBytes(3024, 4032, 8), 97542144, 'RGBA16F is twice RGBA8');
  assert.equal(textureBytes(3024, 4032, 16), 195084288, 'RGBA32F is four times');
  // The ping-pong pair at MAX in half-float — the number that decides whether
  // Night can accumulate at full size on this phone at all.
  assert.match(describeBytes(2 * textureBytes(3024, 4032, 8)), /195\.1 MB \(186\.0 MiB\)/);
  assert.match(describeBytes(2 * MAX), /97\.5 MB \(93\.0 MiB\)/);
});

test('the report states every verdict, and never invents one', () => {
  const line = describeGpuPrecision({
    webgl: '1 (webgl2 also available)',
    checks: [
      { name: 'RGBA8 (control, expect FAIL)', verdict: 'fail', detail: 'read 0 / 0 / 0' },
      { name: 'RGBA16F half-float', verdict: 'pass', detail: 'read 64 / 128 / 191' },
      { name: 'RGBA32F float', verdict: 'unavailable', detail: 'missing OES_texture_float' }
    ],
    limits: { maxTexture: 8192, maxRenderbuffer: 8192, highp: 'available (23 bits)' },
    best: 'RGBA16F half-float',
    current: 'RGBA8 · 97.5 MB ping-pong at 3024×4032'
  });
  assert.match(line, /NIGHT \/ GPU PRECISION/);
  assert.match(line, /RGBA8 \(control, expect FAIL\)\s+FAIL/);
  assert.match(line, /RGBA16F half-float\s+PASS/);
  assert.match(line, /RGBA32F float\s+—/, 'an unavailable format is a dash, never a FAIL');
  assert.match(line, /MAX_TEXTURE_SIZE\s+8192/);
  assert.match(line, /Current Night accumulator\s+RGBA8/);

  // A context that never opened reports that, rather than a table of dashes
  // that would read as measurements.
  const dead = describeGpuPrecision({
    webgl: 'unavailable', checks: [], best: 'none', current: 'RGBA8',
    limits: { maxTexture: 0, maxRenderbuffer: 0, highp: 'unknown' },
    failure: 'This browser gave no WebGL context, so nothing could be measured.'
  });
  assert.match(dead, /nothing could be measured/);
  assert.ok(!/MAX_TEXTURE_SIZE/.test(dead), 'no invented limits when nothing ran');
});

test('the probe cannot take the live camera down with it', () => {
  // It builds its OWN canvas and context, because the last check deliberately
  // tries a full Night-sized allocation and this project has already lost a
  // context to memory pressure. On a borrowed context that would blank the
  // camera; here it costs only the probe.
  const source = readFileSync(new URL('../src/v2/render/gpu-precision.ts', import.meta.url), 'utf8');
  assert.match(source, /const canvas = document\.createElement\('canvas'\);/);
  assert.match(source, /canvas\.getContext\('webgl'/);
  assert.match(source, /WEBGL_lose_context'\)\?\.loseContext\(\)/, 'and it releases it when done');
  // Sampled NEAREST, so a missing half-float LINEAR extension cannot be
  // misread as a precision failure.
  assert.match(source, /TEXTURE_MIN_FILTER, gl\.NEAREST/);
});
