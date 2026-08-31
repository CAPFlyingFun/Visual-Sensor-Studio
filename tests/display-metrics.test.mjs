import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  measureDisplay,
  megapixels,
  projectTiers,
  throughputMegapixelsPerSecond
} from '../.test-build/vision/display-metrics.js';

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

test('throughput is one number that predicts every tier', () => {
  // Measured on a phone: a lens drew 734x979 in 55 ms.
  const tp = throughputMegapixelsPerSecond(734 * 979, 55);
  assert.ok(Math.abs(tp - 13.1) < 0.3, `got ${tp.toFixed(1)} MP/s`);
  // And it should then predict the full-screen figure that was observed.
  const fullScreenPixels = 1290 * 1720;
  const fps = (tp * 1e6) / fullScreenPixels;
  assert.ok(fps > 4 && fps < 8, `predicted ${fps.toFixed(1)} fps, observed 7-8`);
});

test('a tier above what the screen shows is not offered as a choice', () => {
  const tiers = [
    { shortSide: 540, label: '540' },
    { shortSide: 720, label: '720' },
    { shortSide: 1080, label: '1080' },
    { shortSide: 2160, label: '2160' }
  ];
  const rows = projectTiers(tiers, 3024 / 4032, 13.1, 1290);
  assert.equal(rows.length, 3, 'the 2160 tier is the same picture with another name');
  assert.ok(rows.every((r) => r.shortSide <= 1290));
});

test('the projection matches the arithmetic done by hand', () => {
  const rows = projectTiers([{ shortSide: 720, label: '720' }], 3024 / 4032, 13.1, 4032);
  // 720 short side in a 3:4 frame is 720x960 = 0.69 MP -> about 19 fps.
  assert.ok(Math.abs(rows[0].pixels - 691200) < 2000, `pixels ${rows[0].pixels}`);
  assert.ok(Math.abs(rows[0].fps - 18.9) < 1, `fps ${rows[0].fps.toFixed(1)}`);
});

test('aspect changes the cost of the same short side', () => {
  const wide = projectTiers([{ shortSide: 720, label: 'x' }], 16 / 9, 13.1, 4032)[0];
  const tall = projectTiers([{ shortSide: 720, label: 'x' }], 3 / 4, 13.1, 4032)[0];
  assert.ok(wide.pixels > tall.pixels, 'a 16:9 frame is wider for the same short side');
});

test('no measurement yields no projection rather than a made-up one', () => {
  assert.equal(throughputMegapixelsPerSecond(0, 55), 0);
  assert.equal(throughputMegapixelsPerSecond(1000, 0), 0);
  const rows = projectTiers([{ shortSide: 720, label: 'x' }], 0.75, 0, 4032);
  assert.equal(rows[0].fps, 0);
});

test('full screen is measured on the viewer canvas, not the panel one', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  // Full screen draws to its OWN canvas — a blit of the pipeline output —
  // while the panel canvas stays laid out underneath at its small size. So
  // measuring the panel while the viewer is open sized the whole render to
  // the panel and then stretched that across the screen.
  const fn = main.slice(
    main.indexOf('function presentingElement'),
    main.indexOf('function sampleStageBox')
  );
  assert.match(fn, /if \(viewerOpen\) \{/);
  assert.match(fn, /getElementById\('viewerCanvas'\)/);
  assert.match(fn, /return visionCanvas\.hidden \? video : visionCanvas;/);
  // And the sizing must read the same element the readout does, or the two
  // disagree about the picture they are both describing.
  const measure = main.slice(
    main.indexOf('function displayedShortSide'),
    main.indexOf('/** The width that produces this short side')
  );
  assert.match(measure, /presentingElement\(\)\.getBoundingClientRect\(\)/);
  assert.doesNotMatch(measure, /visionCanvas\.getBoundingClientRect/);
});

test('the detail verdict reads render cost against the camera delivery interval', async () => {
  const { detailVerdict } = await import('../.test-build/vision/display-metrics.js');
  const keepingUp = { deliveredFps: 10, processingFps: 9 };

  // The reading that exposed the bug. A 12MP capture delivers about 10fps, so
  // the frame interval is 100ms; the panel drew 609x812 in 51ms and ran
  // smoothly. That is a settled place, not a reason to shrink the picture.
  assert.equal(detailVerdict({ renderMs: 51, ...keepingUp }), 'hold');

  // Full screen on the same device is about 4.5x the panel's area, so the same
  // rung costs about 230ms against the same 100ms interval. That is drawing
  // holding frames up, and is the one case that must step down.
  assert.equal(detailVerdict({ renderMs: 230, ...keepingUp }), 'back-off');

  // And the analysis frame at 0.3ms is not a settled answer, it is the ladder
  // sitting at the bottom with almost the whole interval unspent.
  assert.equal(detailVerdict({ renderMs: 0.3, ...keepingUp }), 'climb');
});

test('a slow camera never by itself walks the ladder down', async () => {
  const { detailVerdict } = await import('../.test-build/vision/display-metrics.js');
  // THE ORIGINAL BUG, as a test. A 12MP capture delivers 10fps and analyses 8.
  // The old rule compared 8 against a fixed 10fps target, found it short at
  // every rung, and walked to the bottom. The rate is now read as a RATIO, so
  // 8 of 10 is keeping up and a cheap render is still free to grow.
  assert.equal(
    detailVerdict({ renderMs: 2, deliveredFps: 10, processingFps: 8 }),
    'climb'
  );
  // Even at a crawl: 2 delivered, 2 analysed is keeping up perfectly, and the
  // ladder must not read the absolute rate as failure.
  assert.equal(
    detailVerdict({ renderMs: 1, deliveredFps: 2, processingFps: 2 }),
    'climb'
  );
});

test('dropped frames are only blamed on a render big enough to cause them', async () => {
  const { detailVerdict } = await import('../.test-build/vision/display-metrics.js');
  // Badly behind — 3 analysed of 10 delivered — but drawing costs a third of a
  // millisecond. A pipeline can fall behind for reasons no rung can fix (a
  // twelve-megapixel decode, a throttled phone), and shrinking a picture that
  // is not the cause is precisely the failure this rewrite removes.
  assert.equal(
    detailVerdict({ renderMs: 0.3, deliveredFps: 10, processingFps: 3 }),
    'hold'
  );
  // Behind AND drawing is a real share of the budget: now it is a plausible
  // cause, so give back a rung and see.
  assert.equal(
    detailVerdict({ renderMs: 40, deliveredFps: 10, processingFps: 3 }),
    'back-off'
  );
  // The same cost while keeping up is a settled place, not a retreat. (60ms
  // rather than 40: 40 is under the climb threshold, so it would grow — which
  // is right, and not what this assertion is about.)
  assert.equal(
    detailVerdict({ renderMs: 60, deliveredFps: 10, processingFps: 9 }),
    'hold'
  );
  // And the same 60ms while behind is a retreat.
  assert.equal(
    detailVerdict({ renderMs: 60, deliveredFps: 10, processingFps: 3 }),
    'back-off'
  );
});

test('room to grow is only spent while the pipeline is keeping up', async () => {
  const { detailVerdict } = await import('../.test-build/vision/display-metrics.js');
  // A cheap render with the interval going spare would otherwise climb. But
  // reading 95ms of "slack" off a queue that is already behind is reading it
  // off a queue that does not have it.
  assert.equal(
    detailVerdict({ renderMs: 5, deliveredFps: 10, processingFps: 4 }),
    'hold'
  );
});

test('no measurement is never read as a verdict', async () => {
  const { detailVerdict } = await import('../.test-build/vision/display-metrics.js');
  const rates = { deliveredFps: 10, processingFps: 9 };
  // A rung that has not drawn a frame yet has no cost. Guessing here is how a
  // ladder moves twice on one piece of evidence, which is what made the old
  // one walk to the bottom in a few seconds.
  assert.equal(detailVerdict({ renderMs: 0, ...rates }), 'hold');
  assert.equal(detailVerdict({ renderMs: -1, ...rates }), 'hold');
  assert.equal(detailVerdict({ renderMs: Number.NaN, ...rates }), 'hold');
  // An absent RATE is not evidence of a problem either, so it must not block a
  // climb the cost reading has earned.
  assert.equal(
    detailVerdict({ renderMs: 5, deliveredFps: 0, processingFps: 0 }),
    'climb'
  );
});

test('a stalled or very fast camera cannot drive the budget to an extreme', async () => {
  const { detailVerdict } = await import('../.test-build/vision/display-metrics.js');
  // A stalled camera reporting a near-zero rate would otherwise license an
  // unbounded render: 0.01fps is a 100-SECOND budget.
  assert.equal(
    detailVerdict({ renderMs: 400, deliveredFps: 0.01, processingFps: 0.01 }),
    'back-off'
  );
  // And 120fps delivery does not mean the render must fit in 8ms. Unclamped,
  // a 20ms render against an 8.3ms interval would back off; the 33ms floor
  // holds it instead, rather than chasing a rate no eye resolves down a
  // ladder. (30ms would still back off, and should — that is 75% of 33.)
  assert.equal(
    detailVerdict({ renderMs: 20, deliveredFps: 120, processingFps: 118 }),
    'hold'
  );
});

test('the two thresholds leave a band, or the ladder oscillates forever', async () => {
  const { DETAIL_CLIMB_SHARE, DETAIL_BACK_OFF_SHARE, detailVerdict } =
    await import('../.test-build/vision/display-metrics.js');
  assert.ok(DETAIL_CLIMB_SHARE < DETAIL_BACK_OFF_SHARE);
  // With one boundary every rung reads as both too expensive and cheap enough
  // to leave, so prove a real gap exists at a real interval.
  const interval = 100;
  const middle = interval * (DETAIL_CLIMB_SHARE + DETAIL_BACK_OFF_SHARE) / 2;
  assert.equal(
    detailVerdict({ renderMs: middle, deliveredFps: 10, processingFps: 9 }),
    'hold'
  );
});
