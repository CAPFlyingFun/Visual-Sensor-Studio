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

test('an exported lens still carries full-resolution detail', () => {
  // A saved PNG was full SIZE but analysis-resolution CONTENT: the picture
  // was rendered small and then repeated into blocks, so a brightness lens
  // saved at max resolution came out visibly chunky.
  const still = mainSource.slice(mainSource.indexOf('function renderStill'));
  const lensCase = still.slice(still.indexOf("case 'lens'"), still.indexOf("case 'night'"));
  assert.match(lensCase, /new Uint8ClampedArray\(width \* height \* 4\)/);
  assert.match(lensCase, /buildStillLensSources\(/);
  assert.doesNotMatch(lensCase, /upscaleRgba/, 'the block enlargement must be gone');
  assert.doesNotMatch(mainSource, /function upscaleRgba/);
});

test('the still recomputes every channel it can at full size', () => {
  const builder = mainSource.slice(
    mainSource.indexOf('function buildStillLensSources'),
    mainSource.indexOf('function renderStill')
  );
  // Four of the seven need no enlargement at all.
  assert.match(builder, /sources\.luma = \{ values: gray \}/);
  assert.match(builder, /sobelEdges\(gray, width, height\)/);
  assert.match(builder, /reliefField\(gray, width, height/);
  assert.match(builder, /absoluteDifference\(gray, rgbaToGray\(previous\.data\)\)/);
  // Only the accumulated temporal ones are enlarged, and smoothly.
  assert.match(builder, /\['speed', 'age', 'novelty'\] as const/);
  assert.match(builder, /upscaleChannel\(channel, analysis\.width, analysis\.height, width, height\)/);
});

test('a lens bound to change captures the second frame it needs', () => {
  // Without it the difference channel has nothing to compare against and the
  // still comes out empty.
  assert.match(mainSource, /const lensWantsChange = visionMode === 'lens'/);
  assert.match(mainSource, /lensChannels\(activeLens\)\.has\('change'\)/);
  assert.match(mainSource, /\|\| lensWantsChange\) \{/);
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

test('the preview module is cached so the editor works offline', () => {
  assert.match(swSource, /'\.\/app\/vision\/lens-preview\.js'/);
});

test('the editor leads with the choice, not with a dropdown', () => {
  // The colour channel decides what the lens is ABOUT, and a dropdown hides
  // every option but the chosen one — so the list of things this app can
  // measure, which is the interesting part, was invisible until it opened.
  assert.match(htmlSource, /id="lensColorChannels"/);
  assert.doesNotMatch(htmlSource, /id="lensColorChannel"[^s]/);
  assert.match(mainSource, /function renderChannelButtons/);
  assert.match(mainSource, /function renderRampPresets/);
});

test('the preview stops when nobody is looking at it', () => {
  // A full vision pipeline running behind a closed panel is a battery cost
  // with no viewer.
  assert.match(mainSource, /function stopLensPreview/);
  assert.match(mainSource, /byId\('lensPanel'\)\.hidden \|\| byId\('lensEditor'\)\.hidden \|\| document\.hidden/);
  assert.match(mainSource, /else stopLensPreview\(\);/);
});

test('the preview scales through a scratch canvas, not from itself', () => {
  // Using a canvas as its own drawImage source while writing to it reads a
  // surface mid-write, and the artefacts look exactly like a lens bug.
  const loop = mainSource.slice(
    mainSource.indexOf('function startLensPreview'),
    mainSource.indexOf('function stopLensPreview')
  );
  assert.match(loop, /lensPreviewScratchContext\.putImageData/);
  assert.match(loop, /drawImage\(\s*lensPreviewScratch/);
  assert.doesNotMatch(loop, /drawImage\(\s*lensPreviewContext\.canvas/);
});

test('the explanation appears once and then gets out of the way', () => {
  assert.match(htmlSource, /id="lensIntro"/);
  assert.match(mainSource, /LENS_INTRO_KEY/);
  assert.match(mainSource, /intro\.open = localStorage\.getItem\(LENS_INTRO_KEY\) !== 'read'/);
});

test('the live picture can be drawn larger than the analysis frame', () => {
  assert.match(htmlSource, /id="lensDetail"/);
  assert.match(mainSource, /export type LensDetail = 'analysis' \| '540' \| '720' \| 'full'/);
  assert.match(mainSource, /function lensDisplayWidth\(\)/);
  assert.match(mainSource, /function renderLensFrame\(/);
  // Never more pixels than the sensor actually delivered.
  assert.match(mainSource, /Math\.max\(analysis, Math\.min\(source, wanted\)\)/);
});

test('the enlarged live path does not go through the 960px capture clamp', () => {
  // cameraSource.captureFrame clamps to 960 for the analysis pipeline it was
  // written for, which silently made 720p and Full both come back at 960.
  const fn = mainSource.slice(
    mainSource.indexOf('function renderLensFrame'),
    mainSource.indexOf('function processVisionFrame')
  );
  assert.match(fn, /grabFullFrame\(target\)/);
  assert.doesNotMatch(fn, /cameraSource\.captureFrame/);
  assert.match(mainSource, /function grabFullFrame\(targetWidth\?: number\)/);
});

test('the panel reports the cost measured on this device', () => {
  // The trade is real and its size depends on the phone, the lens and the
  // camera, so the number shown is measured here rather than asserted from a
  // table written on a laptop.
  assert.match(mainSource, /lensRenderMs \+= \(performance\.now\(\) - started - lensRenderMs\) \* 0\.2/);
  assert.match(mainSource, /ms\/frame/);
  assert.match(htmlSource, /id="lensCostValue"/);
  // And it must not imply a sharper picture is a better measurement.
  assert.match(mainSource, /detail does not improve the reading/);
});

test('the detail setting survives a reload', () => {
  assert.match(mainSource, /lensDetail: LensDetail;/);
  assert.match(mainSource, /\['analysis', '540', '720', 'full'\]\.includes\(String\(parsed\.lensDetail\)\)/);
  assert.match(mainSource, /detail\.value = settings\.lensDetail/);
});

test('only one line in the app may reveal the overlay canvas', () => {
  // Two painters now draw it, and a second reveal site is how a black
  // rectangle ends up covering a working preview.
  const reveals = [...mainSource.matchAll(/visionCanvas\.hidden = false/g)];
  assert.equal(reveals.length, 1, 'only paintVisionCanvas may reveal the overlay');
  assert.match(mainSource, /function paintVisionCanvas\(/);
  assert.match(mainSource, /paintVisionCanvas\(display\.width, display\.height/);
});

test('the editor has styles rather than inheriting a broken layout', () => {
  for (const selector of ['.lens-chip', '.lens-stop', '.lens-swatch', '.lens-actions',
    '.lens-channel', '.lens-preset', '.lens-preview canvas', '.lens-step']) {
    assert.ok(cssSource.includes(selector), `${selector} needs styling`);
  }
});
