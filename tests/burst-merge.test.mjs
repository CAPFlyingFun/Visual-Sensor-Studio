import test from 'node:test';
import assert from 'node:assert/strict';
import * as sr from '../.test-build/vision/super-resolution.js';
import * as bm from '../.test-build/vision/burst-merge.js';

function edgeScene(size, angleDegrees) {
  const p = sr.createPlane(size, size);
  const slope = Math.tan(angleDegrees * Math.PI / 180);
  for (let y = 0; y < size; y++) {
    const at = size / 2 + slope * (y - size / 2);
    for (let x = 0; x < size; x++) p.data[y * size + x] = x < at ? 40 : 210;
  }
  return p;
}

function capture(scene, shifts, { psf = 0.8, noise = 2 } = {}) {
  const frames = sr.synthesiseBurst(scene, shifts, {
    binFactor: 2, psfSigma: psf, noiseSigma: noise, seed: 7
  });
  return frames.map((f) => ({
    plane: f.plane,
    shift: { shiftX: f.shiftX, shiftY: f.shiftY, confidence: 0.8 }
  }));
}

const SPREAD = Array.from({ length: 12 }, (_, i) => ({
  shiftX: (i % 4) * 0.25 + Math.floor(i / 4),
  shiftY: Math.floor(i / 4) * 0.5 + (i % 2) * 0.25
}));
const CLUSTERED = Array.from({ length: 12 }, (_, i) => ({ shiftX: i * 0.02, shiftY: i * 0.01 }));

const scene = edgeScene(512, 5);

test('THE CONTROL THAT DECIDES WHAT THIS IS: sharpening is separated from merging', async () => {
  // refineBurst inverts a blur, and inverting a blur sharpens — on one frame as
  // readily as on eight. MTF50 rises whether contrast was recovered or merely
  // amplified, so an unsharp mask would score well on it too.
  //
  // Measured before this control existed: CLUSTERED offsets, which Phase 0
  // established carry no new information at all, scored 1.29x against a plain
  // upscale while spread offsets scored 1.32x. Without the single-frame
  // control that 1.32x would have shipped as super-resolution.
  const report = await bm.mergeAndCompare(capture(scene, SPREAD), 8);
  assert.ok(report !== null);
  assert.ok(report.deconvolved !== null, 'the single-frame control must be computed');
  assert.ok(report.deconvolvedMtf.mtf50 !== null);

  // It must actually be doing the work the report attributes to it.
  assert.ok(report.deconvolvedMtf.mtf50 > report.controlMtf.mtf50,
    'sharpening one frame should beat a plain upscale, which is the whole point');
});

test('a burst that adds nothing is reported as adding nothing', async () => {
  // The verdict has to survive the case where the honest answer is "no".
  const clustered = await bm.mergeAndCompare(capture(scene, CLUSTERED), 8);
  assert.match(clustered.verdict, /contrast, not resolution|added almost nothing/i);
  // And it must not quietly claim the sharpening as a multi-frame result.
  if (clustered.multiFrameGain !== null) {
    assert.ok(clustered.multiFrameGain < 1.1,
      `clustered offsets claimed ${clustered.multiFrameGain.toFixed(2)}x from the burst`);
  }
});

test('detail beyond the single-frame Nyquist is the claim that cannot be faked', async () => {
  // Sharpening amplifies what is present; it cannot put signal above the
  // sampling limit. On the 2x grid a single frame's Nyquist is 0.25 cycles/px,
  // so anything above that had to come from more than one frame.
  const report = await bm.mergeAndCompare(capture(scene, SPREAD), 8);
  const best = Math.max(
    report.controlMtf.mtf50 ?? 0,
    report.splatMtf.mtf50 ?? 0,
    report.refinedMtf.mtf50 ?? 0
  );
  assert.equal(report.beyondSingleFrame, best > 0.25);
  // And the wording must follow the flag rather than the headline ratio.
  if (report.gain !== null && report.multiFrameGain !== null && report.multiFrameGain > 1.05) {
    assert.match(report.verdict, report.beyondSingleFrame
      ? /recovered detail rather than amplified contrast/
      : /sharper rendering rather than as new detail/);
  }
});

test('the control is built from the same frame everything aligned to', async () => {
  // A control upscaled from a different frame would be sharper or softer for
  // reasons that have nothing to do with merging.
  const source = readFileSync(new URL('../src/vision/burst-merge.ts', import.meta.url), 'utf8');
  assert.match(source, /const control = upscaleFrame\(reference, MERGE_SCALE\)/);
  assert.match(source, /refineBurst\(\[reference\]/);
});

test('one usable frame is not dressed up as a merge', async () => {
  const single = await bm.mergeAndCompare(capture(scene, [{ shiftX: 0, shiftY: 0 }]), 8);
  assert.equal(single.splat, null);
  assert.equal(single.best, 'control');
  assert.match(single.verdict, /nothing to merge/);
});

test('a scene with no edge yields no number, and says so', async () => {
  // Grass and brickwork have no straight edge, so most real shots cannot be
  // measured this way. Reporting a figure anyway would be worse than none.
  let a = 5;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const textured = sr.createPlane(512, 512);
  for (let i = 0; i < textured.data.length; i++) textured.data[i] = 60 + rnd() * 120;
  const report = await bm.mergeAndCompare(capture(textured, SPREAD), 8);
  assert.equal(report.controlMtf.mtf50, null);
  assert.equal(report.gain, null);
  assert.match(report.verdict, /No straight edge to measure with/);
  assert.match(report.verdict, /compared by eye/);
});

test('the blur inverted is derived from the picture, not assumed', async () => {
  // refineBurst inverts a forward model, so a wrong sigma inverts a different
  // camera. Deriving it from the control's own edge beats a constant.
  const report = await bm.mergeAndCompare(capture(scene, SPREAD, { psf: 1.6 }), 8);
  const sharper = await bm.mergeAndCompare(capture(scene, SPREAD, { psf: 0.6 }), 8);
  assert.ok(report.psfSigma > sharper.psfSigma,
    `a blurrier capture should infer a larger sigma: ${report.psfSigma.toFixed(2)} vs ${sharper.psfSigma.toFixed(2)}`);
});

test('the comparison figure carries every version at full size', async () => {
  const report = await bm.mergeAndCompare(capture(scene, SPREAD), 8);
  const layout = bm.comparisonLayout(report);
  const figure = bm.comparisonStrip(report);

  assert.equal(layout.panels.length, 4, 'all four versions should be present');
  assert.equal(figure.width, layout.width);
  assert.equal(figure.height, layout.height);
  // Full size, not fitted: shrinking the panels to make them fit is the one
  // thing that would destroy the differences the figure exists to show.
  for (const panel of layout.panels) {
    assert.equal(panel.plane.width, report.control.width);
    assert.equal(panel.plane.height, report.control.height);
  }
  // Every panel lands inside the figure, and no two overlap.
  const seen = new Set();
  for (const panel of layout.panels) {
    assert.ok(panel.x + panel.plane.width <= figure.width);
    assert.ok(panel.y + panel.plane.height <= figure.height);
    assert.ok(!seen.has(`${panel.x},${panel.y}`), 'panels must not be stacked');
    seen.add(`${panel.x},${panel.y}`);
  }
});

test('the figure fits a phone screen at one output pixel per device pixel', async () => {
  // The regression this guards: four 512px panels in a row are 2060px wide,
  // which set the DOCUMENT's width on Joshua's phone and made mobile Safari
  // rescale the whole app. A 430pt screen at 3x is 1290 device pixels across,
  // so the figure has to come in under that with no scaling applied.
  const report = await bm.mergeAndCompare(capture(scene, SPREAD), 8);
  const layout = bm.comparisonLayout(report);
  assert.ok(layout.columns <= 2, `${layout.columns} columns is wider than a phone`);
  assert.ok(layout.width <= 1290,
    `${layout.width} output pixels will not fit 1290 device pixels`);
});

test('the panel labels cannot come apart from the panels', async () => {
  // main.ts draws each name at the layout's own coordinates rather than
  // re-deriving them, so a change to the arrangement moves the labels with it.
  const report = await bm.mergeAndCompare(capture(scene, SPREAD), 8);
  const keys = bm.comparisonLayout(report).panels.map((p) => p.key);
  assert.deepEqual(keys, ['control', 'deconvolved', 'splat', 'refined']);

  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /comparisonLayout\(report\)\.panels/,
    'labelPanels should place labels from the shared layout');
});

import { readFileSync } from 'node:fs';

test('the merge yields between stages rather than freezing the page', async () => {
  // Two seconds on a desktop is six to ten on a phone. Run as one synchronous
  // block that is a frozen interface with no sign of life, which reads as a
  // crash rather than as work.
  const stages = [];
  await bm.mergeAndCompare(capture(scene, SPREAD), 8, (label) => { stages.push(label); });
  assert.ok(stages.length >= 3, `only ${stages.length} stages reported progress`);
  assert.ok(stages.some((s) => /Merging/.test(s)));
  assert.ok(stages.some((s) => /Measuring/.test(s)));

  // The hook must be optional, or every test and future caller has to supply one.
  assert.ok(await bm.mergeAndCompare(capture(scene, SPREAD), 8) !== null);
});

test('the tab merges the frames it just measured, not a fresh burst', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  // A second capture would be measured by a verdict describing the first, and
  // the numbers on screen would belong to different frames than the pictures.
  assert.match(main, /lastBurst = \{ planes, shifts \}/);
  assert.match(main, /plane, shift: lastBurst!\.shifts\[index\]/);
  // Merge stays disabled until there is something to merge.
  assert.match(main, /burstMergeButton'\)\.disabled = verdict\.confident < 2/);
  // And the progress label has to reach the screen before the thread blocks.
  assert.match(main, /setText\('burstProgress', label\)/);
  assert.match(main, /requestAnimationFrame\(resolve\)/);
});

test('the comparison figure can never be wider than the screen', () => {
  // Two regressions, in opposite directions, and the rule has to survive both:
  //
  //   1. `.burst-figure canvas` (width 100%, aspect-ratio 1/1) was written for
  //      the square scatter and captured this canvas too, squeezing the figure
  //      into a square and scaling it down 2.4x — which destroyed exactly the
  //      fine differences it exists to show.
  //   2. Undoing that with `max-width: none` let a 2060px canvas set the
  //      DOCUMENT's width, and mobile Safari rescaled the whole app around it.
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const rule = css.slice(css.indexOf('#burstCompareFigure canvas,'));
  assert.match(rule, /aspect-ratio: auto;/);      // not squeezed
  assert.match(rule, /max-width: 100%;/);         // and not wider than the page
  assert.ok(!/max-width: none/.test(rule), 'max-width: none is what broke the layout');
  assert.match(css, /#burstCompareFigure \{ max-width: 100%;/);
  // Nearest-neighbour, so what is judged is the merge rather than the
  // browser's resampling of it.
  assert.match(rule, /image-rendering: pixelated;/);
});

test('nothing in a tab can rescale the app by being too wide', () => {
  // iOS derives the page's zoom scale from the document's width and inflates
  // text inside blocks wider than the viewport, so one oversized element
  // rescales the whole app — and it stays rescaled after you scroll away.
  // Joshua, on v0.36.1: "It works, but the size changes... it shouldn't."
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /text-size-adjust: 100%;/);
  assert.match(css, /\.tab-panel \{ min-width: 0; overflow-x: clip; \}/);
});

test('the figure is shown at one output pixel per device pixel', () => {
  // A canvas with no CSS width is laid out one backing-store pixel to one CSS
  // pixel, which on a 3x display magnifies it threefold — that is what "zoomed
  // way in" was. Dividing by the pixel ratio undoes that and nothing else.
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const fn = main.slice(main.indexOf('function fitToScreen'));
  assert.match(fn, /devicePixelRatio/);
  assert.match(fn, /canvas\.width \/ ratio/);
  assert.match(main, /fitToScreen\(canvas\)/, 'the merge report should call it');
});

test('each panel is named on the picture, not only in a caption', () => {
  // Four grey squares are indistinguishable, and a caption in reading order is
  // one mis-read away from crediting the merge with the control's result.
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const fn = main.slice(main.indexOf('function labelPanels'), main.indexOf('function mergeLogLine'));
  for (const name of ['upscaled', 'sharpened 1 frame', 'merged', 'merged + back-projected']) {
    assert.ok(fn.includes(name), `the figure does not label "${name}"`);
  }
  // A plate behind the text: it sits over whatever the camera saw.
  assert.match(fn, /context\.fillRect\(x - 4, y - 3,/);
});

test('nothing sits between the preview and the shutter', () => {
  // Joshua: "there is a large black gap between the camera and where you
  // capture — you can't see what you're taking." The scatter plot and two rows
  // of readouts were in that gap, which put the button off the bottom of the
  // screen whenever the preview was on it.
  const html = readFileSync(new URL('../public/legacy.html', import.meta.url), 'utf8');
  const stage = html.indexOf('id="burstStage"');
  const shutter = html.indexOf('id="burstCaptureButton"');
  assert.ok(stage > 0 && shutter > stage, 'the shutter should follow the preview');

  const between = html.slice(html.indexOf('</div>', html.indexOf('id="burstStage"')), shutter);
  for (const intruder of ['metric-strip', 'burstScatter', 'figcaption']) {
    assert.ok(!between.includes(intruder),
      `${intruder} is between the preview and the shutter`);
  }
  // And the readouts still exist — they moved below, they were not dropped.
  for (const id of ['burstScatter', 'burstFrames', 'burstAgreement', 'burstFov']) {
    assert.ok(html.includes(`id="${id}"`), `${id} was lost in the rearrangement`);
  }
  // The scatter is capped rather than filling the column, or it becomes the
  // black gap again lower down the page.
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.burst-scatter-figure \{ max-width: \d+px; \}/);
});

test('the merged result can be saved, and as PNG', () => {
  // A lossy codec adds its own ringing to exactly the edges the merge is being
  // judged on. At this size there is nothing to trade away for it.
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const fn = main.slice(main.indexOf('async function saveMergedImage'),
    main.indexOf('async function shareMergedImage'));
  assert.match(fn, /pickBest\(lastMerge\)/, 'the result saved should be the chosen output');
  assert.match(fn, /comparisonStrip\(lastMerge\)/, 'the comparison should be savable too');
  assert.match(main, /canvas\.toBlob\(resolve, 'image\/png'\)/);
  assert.ok(!/burstSave[\s\S]{0,400}image\/jpeg/.test(main), 'the merge must not be saved lossy');

  const html = readFileSync(new URL('../public/legacy.html', import.meta.url), 'utf8');
  assert.match(html, /id="burstSaveRow"[^>]*hidden/, 'saving should appear only after a merge');
  assert.match(main, /byId\('burstSaveRow'\)\.hidden = false;/);
});

test('sharing is offered only where the browser can actually take the file', () => {
  // canShare with a file is narrower than share, and narrower than a version
  // table would suggest. Asking is the only honest test, and the share sheet is
  // what reaches Photos — a download reaches Files, which is not where a
  // picture is looked for.
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /navigator\.canShare\(\{ files: \[probe\] \}\)/);
  assert.match(main, /byId\('burstShareMerged'\)\.hidden = !canShareImages\(\);/);
  // The verdict travels with the picture: a merged frame alone says nothing
  // about whether merging helped, which is the whole claim.
  assert.match(main, /text: lastMerge\.verdict/);
  // A dismissed share sheet rejects, and that is not a failure to report.
  assert.match(main, /AbortError/);
});
