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

test('the comparison strip carries every version at the same size', async () => {
  const report = await bm.mergeAndCompare(capture(scene, SPREAD), 8);
  const strip = bm.comparisonStrip(report);
  assert.equal(strip.height, report.control.height);
  assert.ok(strip.width >= report.control.width * 4, 'all four panels should be present');
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

test('the comparison strip is shown at its own size, not squeezed into a square', () => {
  // The `.burst-figure canvas` rule was written for the square scatter plot and
  // captured this canvas too: width 100% plus aspect-ratio 1/1 put a 2060x512
  // strip into a square box at about 860px, scaling it down 2.4x and
  // letterboxing it. That destroyed exactly the fine differences the strip
  // exists to show — on the device the four panels looked identical because
  // they had been shrunk past the point where they could differ.
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const rule = css.slice(css.indexOf('#burstCompareFigure canvas,'));
  assert.match(rule, /width: auto;/);
  assert.match(rule, /aspect-ratio: auto;/);
  assert.match(rule, /max-width: none;/);
  // And the figure has to scroll, or natural size just overflows the page.
  assert.match(css, /#burstCompareFigure \{ overflow-x: auto; \}/);
  // Nearest-neighbour, so what is judged is the merge rather than the
  // browser's resampling of it.
  assert.match(rule, /image-rendering: pixelated;/);
});

test('each panel is named on the picture, not only in a caption', () => {
  // The strip is wider than the screen and scrolls, so a caption listing four
  // names in order stops describing what is visible as soon as it moves.
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const fn = main.slice(main.indexOf('function labelPanels'), main.indexOf('function mergeLogLine'));
  for (const name of ['upscaled', 'sharpened 1 frame', 'merged', 'merged + back-projected']) {
    assert.ok(fn.includes(name), `the strip does not label "${name}"`);
  }
  // A plate behind the text: it sits over whatever the camera saw.
  assert.match(fn, /context\.fillRect\(x - 4, 4,/);
});
