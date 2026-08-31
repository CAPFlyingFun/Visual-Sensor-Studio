import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { measureDisplay, megapixels } from '../.test-build/vision/display-metrics.js';

/** iPhone 15 Plus, full screen portrait, 4:3 stream, object-fit contain. */
const iphonePortrait = {
  screenWidth: 430, screenHeight: 932, devicePixelRatio: 3,
  boxWidth: 430, boxHeight: 932,
  sourceWidth: 3024, sourceHeight: 4032,
  renderWidth: 3024, renderHeight: 4032,
  fill: false
};

test('a screen in points is reported in real pixels', () => {
  // A phone reports CSS points, not pixels. An iPhone 15 Plus is 430x932
  // points at a ratio of 3, which is 1290x2796 real ones — and confusing the
  // two is most of why this took several rounds.
  const r = measureDisplay(iphonePortrait);
  assert.deepEqual(r.screenDevice, { width: 1290, height: 2796 });
});

test('the content box is smaller than the element box when the aspect differs', () => {
  // A 3:4 picture inside a 430x932 box is limited by WIDTH, so it does not
  // fill the height: the ceiling is not the screen, it is the fitted picture.
  const r = measureDisplay(iphonePortrait);
  assert.equal(r.contentDevice.width, 1290);
  assert.equal(r.contentDevice.height, 1720);
  assert.ok(r.contentDevice.height < r.boxDevice.height);
});

test('it names the overdraw that the guessing was about', () => {
  const r = measureDisplay(iphonePortrait);
  // 12.2 MP rendered into a window that can show 2.2 MP.
  assert.ok(r.sourcePixels > 12e6, `source ${r.sourcePixels}`);
  assert.ok(Math.abs(r.contentPixels - 2.22e6) < 0.1e6, `content ${r.contentPixels}`);
  assert.ok(r.overdraw > 5, `rendering ${r.overdraw.toFixed(1)}x what can be seen`);
});

test('rendering to the content box gives an overdraw of one', () => {
  const r = measureDisplay({ ...iphonePortrait, renderWidth: 1290, renderHeight: 1720 });
  assert.ok(Math.abs(r.overdraw - 1) < 0.01, `overdraw ${r.overdraw}`);
});

test('a picture smaller than the window reports under one', () => {
  const r = measureDisplay({ ...iphonePortrait, renderWidth: 645, renderHeight: 860 });
  assert.ok(r.overdraw < 0.3, `overdraw ${r.overdraw}`);
});

test('cover and contain limit on opposite axes', () => {
  const contain = measureDisplay(iphonePortrait);
  const cover = measureDisplay({ ...iphonePortrait, fill: true });
  // Filling a tall box with a 3:4 picture crops the sides, so it needs MORE
  // pixels than fitting the same picture inside it.
  assert.ok(cover.contentPixels > contain.contentPixels,
    `cover ${cover.contentPixels} should exceed contain ${contain.contentPixels}`);
  assert.equal(cover.contentDevice.height, 2796, 'cover fills the height');
});

test('the small panel preview is a much smaller ceiling than full screen', () => {
  // Which is exactly why the panel looked sharper: it was closer to showing
  // what it had been given.
  const panel = measureDisplay({ ...iphonePortrait, boxWidth: 342, boxHeight: 213 });
  const full = measureDisplay(iphonePortrait);
  assert.ok(panel.contentPixels < full.contentPixels / 2);
});

test('a landscape stream in the same box reports a different ceiling', () => {
  const portrait = measureDisplay(iphonePortrait);
  const landscape = measureDisplay({
    ...iphonePortrait, sourceWidth: 4032, sourceHeight: 3024,
    renderWidth: 4032, renderHeight: 3024
  });
  assert.notEqual(portrait.contentPixels, landscape.contentPixels);
  // The wide picture is width-limited in an upright box, so it shows less.
  assert.ok(landscape.contentPixels < portrait.contentPixels);
});

test('missing or nonsense input never produces NaN', () => {
  for (const bad of [
    { ...iphonePortrait, devicePixelRatio: 0 },
    { ...iphonePortrait, devicePixelRatio: NaN },
    { ...iphonePortrait, boxWidth: 0, boxHeight: 0 },
    { ...iphonePortrait, sourceWidth: 0, sourceHeight: 0 }
  ]) {
    const r = measureDisplay(bad);
    for (const value of [r.overdraw, r.sourceOverdraw, r.contentPixels, r.renderPixels]) {
      assert.ok(Number.isFinite(value), `got ${value} from ${JSON.stringify(bad)}`);
    }
    assert.ok(r.contentDevice.width >= 0 && r.contentDevice.height >= 0);
  }
});

test('a ratio of one is used when the browser does not report one', () => {
  const r = measureDisplay({ ...iphonePortrait, devicePixelRatio: 0 });
  assert.deepEqual(r.screenDevice, { width: 430, height: 932 });
});

test('megapixels reads as a number a person can compare', () => {
  assert.equal(megapixels(12192768), '12.19 MP');
  assert.equal(megapixels(0), '0.00 MP');
});

test('the readout separates the three sizes rather than conflating them', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(main, /function reportDisplayMetrics\(\): void/);
  for (const id of ['dispScreen', 'dispRatio', 'dispBox', 'dispContent',
                    'dispSource', 'dispRender', 'dispOverdraw', 'dispSourceOver']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} missing from the markup`);
    assert.match(main, new RegExp(`setText\\('${id}'`), `${id} never written`);
  }
});

test('the viewer chip labels which size is which', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  // It showed the camera SOURCE unlabelled and was read as the render size,
  // so a screen bound doing its job looked like one that had stopped working.
  assert.match(main, /` · cam \$\{diagnostics\.videoWidth\}×\$\{diagnostics\.videoHeight\}`/);
  assert.match(main, /` · draw \$\{visionCanvas\.width\}×\$\{visionCanvas\.height\}`/);
});

test('the tool survives being asked from a panel that hides the view', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  // The first reading came back "0x0 pt box · no picture on screen", because
  // the button lives in Settings and opening Settings covers the camera. The
  // one moment a person can ask is the one moment the answer is not visible.
  assert.match(main, /let lastStageBox/);
  assert.match(main, /function sampleStageBox\(now: number\)/);
  assert.match(main, /if \(rect\.width < 1 \|\| rect\.height < 1\) return;/);
  assert.match(main, /last seen in the \$\{lastStageBox\.where\}/);
  // Sampled from the render loop, which only runs while a view is up.
  assert.match(main, /sampleStageBox\(displayStarted\)/);
});

test('RGB is measured on the video, not on a hidden canvas', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  // In RGB there is no canvas: the video element IS the picture, so measuring
  // the canvas reports the size of something not being shown.
  assert.match(main, /function presentingElement\(\): HTMLElement/);
  assert.match(main, /return visionCanvas\.hidden \? video : visionCanvas;/);
  assert.match(main, /renderWidth: visionCanvas\.hidden \? diagnostics\.videoWidth/);
});

test('overdraw distinguishes GPU scaling from CPU work', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  // The same ratio means opposite things: the compositor scales a video for
  // nothing, while a canvas render is per-pixel CPU and IS the frame rate.
  assert.match(main, /scaled by the GPU, so free/);
  assert.match(main, /CPU work per pixel/);
});
