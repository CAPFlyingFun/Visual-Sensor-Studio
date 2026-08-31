import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as cc from '../.test-build/vision/camera-capabilities.js';

test('a camera that can be commanded offers a real bracket', () => {
  const report = cc.readCapabilities(
    { exposureMode: ['manual', 'continuous'], exposureTime: { min: 10, max: 10000, step: 10 },
      iso: { min: 50, max: 3200 }, width: { min: 320, max: 4032 } },
    { exposureMode: 'continuous', exposureTime: 500, iso: 125 }
  );
  assert.equal(report.hdrPath, 'bracketed');
  assert.match(report.summary, /real bracket/);
  const exposureTime = report.controls.find((c) => c.name === 'exposureTime');
  assert.equal(exposureTime.supported, true);
  assert.equal(exposureTime.range, '10…10000 step 10');
  assert.equal(exposureTime.current, '500');
});

test('exposureMode alone is not enough to command an exposure', () => {
  // Knowing the camera is in continuous mode does not let us choose a value.
  // Treating that as bracketing support would promise a feature that cannot be
  // built, which is exactly what this readout exists to prevent.
  const report = cc.readCapabilities({ exposureMode: ['continuous'], zoom: { min: 1, max: 5 } }, {});
  assert.equal(report.hdrPath, 'opportunistic');
  assert.match(report.summary, /cannot be set/);
});

test('no capability data at all means tone mapping, and says it is not HDR', () => {
  // The likely WebKit answer, and the one that decides the whole feature.
  for (const empty of [null, {}]) {
    const report = cc.readCapabilities(empty, null);
    assert.equal(report.hdrPath, 'tone-map-only');
    assert.equal(report.available, false);
    assert.match(report.summary, /not HDR/);
  }
});

test('a key present but empty is not support', () => {
  // A browser answering with an empty option list is saying the control exists
  // and offers nothing. Counting that as support would light up a control that
  // cannot move.
  const report = cc.readCapabilities({ exposureMode: [], exposureTime: undefined }, {});
  assert.equal(report.controls.find((c) => c.name === 'exposureMode').supported, false);
  assert.equal(report.controls.find((c) => c.name === 'exposureTime').supported, false);
});

test('the log line names the path and the controls, for pasting back', () => {
  const report = cc.readCapabilities({ zoom: { min: 1, max: 5 }, torch: [true, false] }, {});
  const line = cc.capabilityLogLine(report);
  assert.match(line, /caps opportunistic/);
  assert.match(line, /zoom/);
  assert.match(line, /torch/);
  assert.match(cc.capabilityLogLine(cc.readCapabilities(null, null)), /none reported/);
});

test('the readout asks the live track and survives the methods being absent', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  // getCapabilities and getSettings are both optional in the standard and
  // missing in some WebKit builds. An absent method is a real answer.
  assert.match(main, /typeof track\.getCapabilities === 'function'/);
  assert.match(main, /typeof track\.getSettings === 'function'/);
  assert.match(main, /appendBurstLog\(capabilityLogLine\(report\)\)/);
  // An unsupported control must not render as one with an empty range.
  assert.match(main, /if \(!control\.supported\) row\.className = 'cap-no';/);
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.cap-no \.cap-range::before \{ content: 'not supported'; \}/);
});
