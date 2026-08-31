import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const mainSource = read('../src/main.ts');
const htmlSource = read('../public/index.html');
const swSource = read('../public/sw.js');
const cssSource = read('../public/styles.css');
const typesSource = read('../src/core/types.ts');

test('the lens is a mode the camera row can reach', () => {
  assert.match(htmlSource, /data-vision-mode="lens"/);
  assert.match(typesSource, /\|\s*'lens'/);
  assert.match(mainSource, /lens: 'Custom lens/);
});

test('the coverage readout is guarded by its own panel, not the motion one', () => {
  // This exact bug shipped for a moment: the figure was set inside
  // renderMotionReadouts, which returns early while the motion panel is
  // hidden — and in lens mode it always is, so the readout never moved off
  // its placeholder. A browser probe caught what no unit test could.
  const fn = mainSource.slice(
    mainSource.indexOf('function renderLensReadouts'),
    mainSource.indexOf('function renderMotionReadouts')
  );
  assert.match(fn, /byId\('lensPanel'\)\.hidden/);
  assert.doesNotMatch(fn, /motionPanel/);
  const motion = mainSource.slice(
    mainSource.indexOf('function renderMotionReadouts'),
    mainSource.indexOf('function setTrailFrozen')
  );
  assert.doesNotMatch(motion, /lensCoverage/, 'the lens readout must not sit behind the motion guard');
  assert.match(mainSource, /renderLensReadouts\(\);/);
});

test('a lens only pays for the channels it is bound to', () => {
  // A lens reading edges must not start the speed field, the trail buffer or
  // the background model. Each of those is per-pixel work every frame.
  assert.match(mainSource, /function lensChannels\(/);
  assert.match(mainSource, /const wantsSpeedField = visionMode === 'speed'/);
  assert.match(mainSource, /\|\| lensNeeds\('speed'\)/);
  assert.match(mainSource, /\|\| lensNeeds\('age'\)/);
  assert.match(mainSource, /needed\.has\('novelty'\)/);
  assert.match(mainSource, /needed\.has\('relief'\)/);
});

test('an unmeasurable channel is left out rather than zero-filled', () => {
  // Supplying zeroes would paint the bottom of the ramp across the frame,
  // which looks like a confident reading instead of an absent one.
  const builder = mainSource.slice(
    mainSource.indexOf('function buildLensSources'),
    mainSource.indexOf('function processVisionFrame')
  );
  assert.match(builder, /needed\.has\('change'\) && buffers\.hasPrevious/);
  assert.match(builder, /backgroundModel\.warmedUp/);
  assert.match(builder, /state\[i\] === UNRESOLVED \? 0 : 1/);
});

test('the exported still is the picture that was on screen', () => {
  const still = mainSource.slice(mainSource.indexOf('function renderStill'));
  const lensCase = still.slice(still.indexOf("case 'lens'"), still.indexOf("case 'night'"));
  assert.match(lensCase, /upscaleRgba\(/, 'render at analysis size, then enlarge');
  assert.doesNotMatch(lensCase, /rgbaToGray\(frame\.data\)/);
});

test('the editor is wired through the boot-safe helper', () => {
  const wiring = mainSource.slice(
    mainSource.indexOf('function wireLensEditor'),
    mainSource.indexOf('async function initialiseLenses')
  );
  // A bare addEventListener on a missing id throws and takes the rest of the
  // wiring with it, which is the "button does nothing" failure this codebase
  // has already had once.
  assert.doesNotMatch(wiring, /\.addEventListener\(/);
  assert.match(wiring, /on\('lensSaveButton', 'click'/);
});

test('every control the editor drives exists in the markup', () => {
  const wiring = mainSource.slice(
    mainSource.indexOf('function wireLensEditor'),
    mainSource.indexOf('async function initialiseLenses')
  );
  const ids = new Set([...wiring.matchAll(/on\('(\w+)',/g)].map((m) => m[1]));
  assert.ok(ids.size >= 12, `expected the editor to wire a full panel, saw ${ids.size}`);
  for (const id of ids) {
    assert.match(htmlSource, new RegExp(`id="${id}"`), `#${id} is wired but not in the markup`);
  }
});

test('every element the editor reads by id exists in the markup', () => {
  const section = mainSource.slice(
    mainSource.indexOf('const LENS_SELECTION_KEY'),
    mainSource.indexOf('function resizeVisionCanvas')
  );
  const ids = new Set([...section.matchAll(/byId(?:<[^>]+>)?\('(lens\w*)'\)/g)].map((m) => m[1]));
  const texts = new Set([...section.matchAll(/setText\('(lens\w*)'/g)].map((m) => m[1]));
  for (const id of [...ids, ...texts]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`), `#${id} is read but not in the markup`);
  }
});

test('a shared lens in the address bar is added but does not silently persist', () => {
  const init = mainSource.slice(mainSource.indexOf('async function initialiseLenses'));
  assert.match(init, /lensFromLocation\(location\.hash, location\.search\)/);
  // Re-adding the same lens on every reload would fill the list with copies.
  assert.match(init, /history\.replaceState/);
});

test('the gallery and its modules are cached so lenses work offline', () => {
  assert.match(swSource, /'\.\/lenses\/index\.json'/);
  assert.match(swSource, /'\.\/app\/vision\/lens\.js'/);
  assert.match(swSource, /'\.\/app\/vision\/lens-store\.js'/);
});

test('the panel explains what a lens can and cannot do', () => {
  const panel = htmlSource.slice(
    htmlSource.indexOf('id="lensPanel"'),
    htmlSource.indexOf('id="motionPanel"')
  );
  assert.match(panel, /cannot add/i, 'say plainly that a lens recolours rather than measures');
  assert.match(panel, /stay on this device/i);
  const importBlock = htmlSource.slice(htmlSource.indexOf('id="lensImport"'));
  assert.match(importBlock, /Nothing is uploaded/i);
});

test('the editor has styles rather than inheriting a broken layout', () => {
  for (const selector of ['.lens-chip', '.lens-stop', '.lens-swatch', '.lens-actions']) {
    assert.ok(cssSource.includes(selector), `${selector} needs styling`);
  }
});
