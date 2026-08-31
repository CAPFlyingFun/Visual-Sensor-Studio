import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cameraSource = readFileSync(new URL('../public/camera-bootstrap.js', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

const setter = cameraSource.slice(
  cameraSource.indexOf('async setFrameRate('),
  cameraSource.indexOf('async benchmarkFrameRates(')
);

test('auto does not re-constrain a freshly opened track', () => {
  // The bug this fixes: the stream opened at 3024x4032 and collapsed about
  // half a second later. Frame rate and resolution share one set of sensor
  // modes, so asking a twelve-megapixel track for 60 fps makes WebKit
  // re-select a mode that can sustain 60 — which at that size it cannot.
  assert.match(setter, /if \(requestedFrameRate === 'auto'\)/);
  assert.match(setter, /if \(!explicitRateApplied\) \{/);
  assert.match(setter, /auto keeps the negotiated mode/);
  const autoBranch = setter.slice(setter.indexOf("=== 'auto'"), setter.indexOf('const constraint'));
  assert.doesNotMatch(autoBranch, /frameRate: constraint/, 'auto must not apply a rate constraint');
});

test('returning to auto releases a rate that was actually applied', () => {
  // Otherwise the benchmark restores "auto" and leaves the last rate it tried
  // in force, which is worse than never restoring at all.
  assert.match(setter, /await track\.applyConstraints\(\{\}\)/);
  assert.match(setter, /explicitRateApplied = false/);
  assert.match(cameraSource, /let explicitRateApplied = false;/);
  // And the flag is only set when a constraint really went on.
  assert.match(setter, /explicitRateApplied = Boolean\(constraint\)/);
});

test('an explicit rate still applies — the trade is the user\'s to make', () => {
  assert.match(setter, /frameRate: constraint/);
});

test('a rate that costs resolution says so', () => {
  const fn = mainSource.slice(
    mainSource.indexOf('async function applyCameraFrameRate'),
    mainSource.indexOf('async function applyCaptureResolution')
  );
  // Measured before and after, not assumed.
  assert.match(fn, /const wasShort = Math\.min\(before\.videoWidth, before\.videoHeight\)/);
  assert.match(fn, /nowShort >= wasShort \* 0\.95/);
  assert.match(fn, /moved the camera to a mode it can sustain/);
  assert.match(fn, /set the frame rate back to/);
  // Auto is excluded: it no longer changes anything, so it can cost nothing.
  assert.match(fn, /if \(requested === 'auto' \|\| !wasShort\) return;/);
});

test('the benchmark still restores whatever was there before', () => {
  const bench = cameraSource.slice(cameraSource.indexOf('async benchmarkFrameRates('));
  assert.match(bench.slice(0, bench.indexOf('\n    get frameRateInfo')), /await this\.setFrameRate\(previous\)/);
});
