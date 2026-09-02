import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const htmlSource = readFileSync(new URL('../public/legacy.html', import.meta.url), 'utf8');

const ladder = mainSource.slice(
  mainSource.indexOf('async function compareCaptureResolutions'),
  mainSource.indexOf('function measureEffectiveDetail')
);

test('the ladder only steps down', () => {
  // applyConstraints narrows a live track reliably and routinely refuses to
  // widen one, so descending is the only order that gives trustworthy
  // readings without restarting the camera between every rung.
  assert.match(ladder, /\[10000, 2160, 1440, 1080, 720\]/);
  const tiers = [10000, 2160, 1440, 1080, 720];
  for (let i = 1; i < tiers.length; i++) {
    assert.ok(tiers[i] < tiers[i - 1], 'the ladder must descend');
  }
});

test('the ladder waits for the track to renegotiate before reading', () => {
  // Measuring immediately reads the previous mode and reports it under the
  // new tier's name, which is worse than not measuring at all.
  assert.match(ladder, /setTimeout\(resolve, 1100\)/);
  const applyAt = ladder.indexOf('setCaptureHeight(tier)');
  const waitAt = ladder.indexOf('setTimeout(resolve, 1100)');
  const readAt = ladder.indexOf('readEffectiveDetail()');
  assert.ok(applyAt < waitAt && waitAt < readAt, 'apply, then settle, then read');
});

test('the ladder puts the original setting back', () => {
  assert.match(ladder, /const original = Number\(settings\.captureResolution\)/);
  assert.match(ladder, /await camera\.setCaptureHeight\(original\)/);
  const restore = ladder.lastIndexOf('setCaptureHeight(original)');
  const loopEnd = ladder.indexOf('setText(\'benchEffective\', rows.length');
  assert.ok(restore < loopEnd, 'restore before reporting, so a read cannot leave it changed');
});

test('the comparable number is real detail, not the reported size', () => {
  // Reporting only the reported size would make every tier look like a win,
  // which is the exact confusion this tool exists to end.
  assert.match(ladder, /px real/);
  assert.match(ladder, /Real detail on the short side is the comparable number/);
  assert.match(ladder, /the extra ones are interpolation/);
});

test('a pegged rung is marked as a bound, not an equality', () => {
  assert.match(ladder, /reading\.pegged \? '≤' : '≈'/);
});

test('a flat scene is refused rather than scored', () => {
  assert.match(ladder, /too flat to judge/);
  assert.match(ladder, /a blank wall has nothing to measure/);
});

test('the ladder has a control and the readings are structured', () => {
  assert.match(htmlSource, /id="compareResolutionsButton"/);
  assert.match(mainSource, /interface DetailReading/);
  assert.match(mainSource, /function readEffectiveDetail\(\): DetailReading \| null/);
  // The single-shot readout and the ladder must share one measurement, or the
  // two can disagree about the same frame.
  assert.match(mainSource, /const report = estimateEffectiveResolution\(gray, size, size\)/);
});

test('the advice is to pick the smallest tier that reaches the maximum', () => {
  // More pixels that carry no more information cost every frame and buy
  // nothing, so the honest recommendation is not "set it as high as it goes".
  assert.match(ladder, /pick the smallest tier that reaches the maximum/);
});
