import test from 'node:test';
import assert from 'node:assert/strict';
import * as sr from '../.test-build/vision/super-resolution.js';
import * as bc from '../.test-build/vision/burst-capture.js';
import { readFileSync } from 'node:fs';

/** 1/f noise: the spectrum real scenes have. See super-resolution.test.mjs. */
function pinkScene(size, seed) {
  let a = seed >>> 0;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const p = sr.createPlane(size, size);
  p.data.fill(128);
  for (let octave = 1; octave <= 6; octave++) {
    const cells = 1 << octave;
    const amplitude = 90 / octave;
    const grid = new Float32Array((cells + 1) * (cells + 1));
    for (let i = 0; i < grid.length; i++) grid[i] = (rnd() - 0.5) * 2 * amplitude;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const gx = (x / size) * cells;
        const gy = (y / size) * cells;
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        const fx = gx - x0;
        const fy = gy - y0;
        const at = (i, j) => grid[j * (cells + 1) + i];
        const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
        const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
        p.data[y * size + x] += top * (1 - fy) + bottom * fy;
      }
    }
  }
  for (let i = 0; i < p.data.length; i++) p.data[i] = Math.max(0, Math.min(255, p.data[i]));
  return p;
}

const scene = pinkScene(128, 3);

test('the aligner recovers a known shift to the tenth of a pixel Phase 0 requires', () => {
  // Phase 0 measured the tolerance: 0.1px keeps most of the gain, 0.4px keeps
  // almost none, 0.8px is worse than not merging. So this is the bar, and an
  // aligner that cannot clear it makes the whole feature pointless.
  let worst = 0;
  for (const [dx, dy] of [[0, 0], [0.25, 0], [0.5, -0.25], [1.4, 2.7], [-2.3, 1.1], [3.75, -3.25]]) {
    const moved = sr.noisyPlane(sr.shiftPlane(scene, dx, dy), 2, 11);
    const got = bc.estimateShift(scene, moved, 6);
    worst = Math.max(worst, Math.hypot(got.shiftX - dx, got.shiftY - dy));
  }
  assert.ok(worst <= 0.1, `worst error ${worst.toFixed(3)} px exceeds the 0.1 px budget`);
});

test('the shift is NOT negated — sign errors here scatter every sample backwards', () => {
  // The first version negated the search result on the reasoning that it
  // "moves the frame back". Every estimate came out with the right magnitude
  // and the wrong sign, which a merge would have turned into a burst
  // depositing each sample on the opposite side of where it belonged — a
  // result that still looks like an image, which is why it needs a test.
  const moved = sr.shiftPlane(scene, 2.0, -1.0);
  const got = bc.estimateShift(scene, moved, 6);
  assert.ok(got.shiftX > 1, `expected about +2, got ${got.shiftX.toFixed(2)}`);
  assert.ok(got.shiftY < -0.5, `expected about -1, got ${got.shiftY.toFixed(2)}`);
});

test('a flat surface is refused rather than guessed at', () => {
  // A blank wall has nothing to match, and an argmin over noise is a confident
  // wrong answer. Measured: a flat plane scores about 0.024 here, so the floor
  // sits above it.
  const flat = sr.createPlane(128, 128);
  flat.data.fill(120);
  const got = bc.estimateShift(flat, sr.noisyPlane(flat, 2, 5), 6);
  assert.ok(got.confidence < bc.MIN_CONFIDENCE,
    `a flat wall scored ${got.confidence.toFixed(3)}, at or above the ${bc.MIN_CONFIDENCE} floor`);
  // And real texture must clear it comfortably, or the floor rejects everything.
  const real = bc.estimateShift(scene, sr.noisyPlane(sr.shiftPlane(scene, 1.5, 0.5), 2, 5), 6);
  assert.ok(real.confidence > 0.5, `textured scene scored only ${real.confidence.toFixed(2)}`);
});

test('THE FIX PHASE 0 IMPLIED: over-capture and select beats taking what you are given', () => {
  // Phase 0 concluded the capture had to be steered because random offsets
  // underperform. Selection reaches the same place from the other end: capture
  // more than you need, then discard the frames that duplicate an offset
  // already held. The hand does not have to cooperate, only wander.
  let a = 7;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const mean = (arr) => arr.reduce((x, y) => x + y, 0) / arr.length;

  const raw = [];
  const selected = [];
  for (let trial = 0; trial < 40; trial++) {
    const candidates = Array.from({ length: 32 }, () => ({
      shiftX: rnd() * 10, shiftY: rnd() * 10, confidence: 1
    }));
    raw.push(sr.offsetSpread(candidates.slice(0, 8)));
    selected.push(sr.offsetSpread(bc.selectDiverseSubset(candidates, 8).map((i) => candidates[i])));
  }
  // THE NUMBERS THAT MATTER, and the honest shape of them: taking the first
  // eight lands right ON the floor Phase 0 set — averaging about 0.53 to 0.56
  // depending on the burst, which is a coin flip on whether merging is worth
  // doing at all. Selecting from thirty-two clears it every time.
  //
  // So selection does not turn a bad burst into a good one. It turns an
  // unpredictable one into a reliable one, which is what a shipped feature
  // needs and what a gamble cannot be.
  const marginOfFloor = Math.abs(mean(raw) - bc.SPREAD_FLOOR);
  assert.ok(marginOfFloor < 0.05,
    `first-8 averaged ${mean(raw).toFixed(3)}, expected to straddle the ${bc.SPREAD_FLOOR} floor`);
  assert.ok(mean(selected) > bc.SPREAD_FLOOR + 0.05,
    `selected-8 averaged ${mean(selected).toFixed(3)}, which should clear the floor comfortably`);
  assert.ok(mean(selected) > mean(raw) + 0.08, 'and the gain should be substantial');
  // Reliability, not just the average — a feature that sometimes makes
  // pictures worse is worse than one that sometimes declines to run.
  //
  // Measured over 200 bursts, this is how the capture count was chosen:
  //   8 candidates  clear the floor 46% of the time  (a coin flip)
  //  16                              91%
  //  24                              97%
  //  32                              99.5%
  // Hence CAPTURE_CANDIDATES below: over-capture four to one, keep eight.
  const clearing = selected.filter((s) => s > bc.SPREAD_FLOOR).length / selected.length;
  assert.ok(clearing >= 0.95, `only ${(clearing * 100).toFixed(0)}% of bursts cleared the floor`);
});

test('selection cannot invent diversity that is not in the candidates', () => {
  // Eight candidates, keep eight: nothing to choose between, so the honest
  // result is no change. A selector that appeared to improve here would be
  // reporting a spread its frames do not have.
  const clustered = Array.from({ length: 8 }, (_, i) => ({
    shiftX: i * 0.02, shiftY: i * 0.01, confidence: 1
  }));
  const picked = bc.selectDiverseSubset(clustered, 8);
  assert.equal(picked.length, 8);
  assert.ok(Math.abs(sr.offsetSpread(picked.map((i) => clustered[i])) - sr.offsetSpread(clustered)) < 1e-9);
});

test('a tripod is told the truth, not given a merge', () => {
  // No motion means no second viewpoint, and no processing invents one. A
  // webcam bolted to a monitor is a legitimate way to use this app and must
  // get an honest answer rather than an upscale labelled as a merge.
  const still = Array.from({ length: 8 }, () => ({ shiftX: 0, shiftY: 0, confidence: 0.9 }));
  const verdict = bc.judgeBurst(still, 8);
  assert.equal(verdict.stationary, true);
  assert.equal(verdict.worthMerging, false);
  assert.match(verdict.reason, /tripod|fixed mount/i);
  assert.match(verdict.reason, /single frame/i);
});

test('a featureless scene is reported as unmeasurable, not as stationary', () => {
  // Two different failures with two different fixes: point somewhere with
  // detail, versus stop resting the phone on something.
  const blind = Array.from({ length: 8 }, (_, i) => ({
    shiftX: i * 0.3, shiftY: i * 0.2, confidence: 0.01
  }));
  const verdict = bc.judgeBurst(blind, 8);
  assert.equal(verdict.worthMerging, false);
  assert.match(verdict.reason, /texture/i);
});

test('a good handheld burst is approved, and says why', () => {
  const good = Array.from({ length: 8 }, (_, i) => ({
    shiftX: (i % 4) * 0.25 + Math.floor(i / 4),
    shiftY: Math.floor(i / 4) * 0.5 + (i % 2) * 0.25,
    confidence: 0.8
  }));
  const verdict = bc.judgeBurst(good, 8);
  assert.equal(verdict.worthMerging, true);
  assert.ok(verdict.selectedSpread >= bc.SPREAD_FLOOR);
  assert.match(verdict.reason, /more detail than any single frame/i);
});

test('a marginal burst is refused with the number that refused it', () => {
  // "It did not work" is not actionable. The percentage and the threshold are.
  const marginal = Array.from({ length: 8 }, (_, i) => ({
    shiftX: 0.5 + i * 0.01, shiftY: 0.5 + i * 0.01, confidence: 0.8
  }));
  const verdict = bc.judgeBurst(marginal, 8);
  assert.equal(verdict.worthMerging, false);
  assert.match(verdict.reason, /% of the sub-pixel grid/);
  assert.match(verdict.reason, /capture more frames/i);
});

test('rotation converts to pixels through the focal length, and refuses without one', () => {
  // The conversion the motion trigger runs on: a small pan moves the image by
  // focal length times the angle.
  assert.ok(Math.abs(bc.rotationToPixels(0.001, 2159) - 2.159) < 1e-6);
  // An unknown field of view means an unknown focal length, and guessing one
  // would silently mis-scale every trigger decision.
  assert.equal(bc.rotationToPixels(0.001, 0), 0);
});

/**
 * Crop two windows from a LARGER scene at different offsets.
 *
 * This is the honest harness and it replaced a misleading one. Shifting a
 * whole plane with `shiftPlane` clamps its borders, so reference and frame
 * ended up sharing identical smeared edges that matched each other — the test
 * passed at every offset while the real thing collapsed above about 13 px.
 * Cropping from a bigger scene means content entering the window is REAL,
 * exactly as it is on a camera.
 */
const bigScene = pinkScene(512, 3);
function cropAt(offsetX, offsetY, size = 256) {
  const p = sr.createPlane(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      p.data[y * size + x] = sr.samplePlane(bigScene, x + 128 + offsetX, y + 128 + offsetY);
    }
  }
  return p;
}

test('the search covers the motion a real hand actually produces', () => {
  // Joshua's bursts travelled 6 to 15 px, and above about 13 the probe reported
  // as few as 1 of 32 frames measurable — from the same patch of grass that
  // gave 32 when he held steadier. The cause was clamping, not range: samples
  // past the edge were compared against a smeared border rather than skipped.
  const reference = cropAt(0, 0);
  let worst = 0;
  for (const [dx, dy] of [[0.3, 0.2], [2.4, 1.1], [9.8, 4.1], [13.8, 2.0], [17.2, -8.4], [22.0, 6.0]]) {
    const moved = sr.noisyPlane(cropAt(-dx, -dy), 2, 11);
    const got = bc.estimateShift(reference, moved);
    assert.ok(got.confidence > bc.MIN_CONFIDENCE,
      `a ${Math.hypot(dx, dy).toFixed(1)} px shift should be measurable, `
      + `got confidence ${got.confidence.toFixed(2)}`);
    worst = Math.max(worst, Math.hypot(got.shiftX - dx, got.shiftY - dy));
  }
  assert.ok(worst <= 0.1, `worst error ${worst.toFixed(3)} px exceeds the 0.1 px budget`);
});

test('too little overlap is refused, however good the sliver looks', () => {
  // With most of the window outside the frame, the average is taken over a
  // fragment that almost any offset can make look good.
  const reference = cropAt(0, 0);
  const wayOff = sr.noisyPlane(cropAt(-31, -10), 2, 11);
  assert.equal(bc.estimateShift(reference, wayOff).confidence, 0);
});

test('a match on the edge of the search window is refused, not reported as small', () => {
  // When the frame moved further than the window covers, the best score inside
  // it sits at the boundary and the true match is outside. The estimate is not
  // "large" then, it is WRONG — and wrong in the direction that looks like a
  // small, well-behaved shift, so nothing downstream could catch it.
  //
  // Found from the device: waving the phone scored worse than holding it
  // still, partly because motion past the window read as a steady hand.
  const farMoved = sr.shiftPlane(scene, 40, 0);
  const beyond = bc.estimateShift(scene, farMoved);
  assert.equal(beyond.confidence, 0, 'a shift outside the range must not be trusted');

  // And a shift comfortably inside it still is.
  const within = bc.estimateShift(scene, sr.shiftPlane(scene, 2.25, -1.5));
  assert.ok(within.confidence > 0.5);
  assert.ok(Math.hypot(within.shiftX - 2.25, within.shiftY + 1.5) < 0.1);
});

test('the burst tab can start its own sensors and hand back a shareable log', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  // Joshua is the probe now, so the tab has to be usable without touring the
  // other tabs first — and it reuses the real enable paths rather than
  // duplicating the permission dance, which is the part that goes stale.
  assert.match(main, /on\('burstEnableCamera', 'click', \(\) => void startCamera\(\)/);
  assert.match(main, /on\('burstEnableMotion', 'click', \(\) => void enableMotion\(\)/);
  assert.match(html, /id="burstEnableCamera"/);
  assert.match(html, /id="burstEnableMotion"/);

  // The field of view is the same setting the Motion tab edits, so the two
  // controls must not be able to disagree.
  assert.match(main, /const twin = document\.getElementById\('motionFov'\)/);

  // A log that can be copied out, because six numbers in a screenshot lose the
  // run before them — and the comparison across runs is what says anything.
  assert.match(html, /id="burstLog"/);
  assert.match(main, /navigator\.clipboard\.writeText\(log\.value\)/);
  // Clipboard writes are refused outright on iOS often enough that a dead end
  // is not acceptable; selecting the text leaves a long-press to finish it.
  assert.match(main, /log\.select\(\);/);
  assert.match(main, /Copy blocked/);
});

test('every log line carries the version and the numbers that decide the verdict', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const line = main.slice(main.indexOf('function burstLogLine'), main.indexOf('async function copyBurstLog'));
  // 'gyro' is now built from a reason object rather than a bare field name.
  for (const field of ['frames', 'distinct', 'measurable', 'travel', 'raw', 'selected']) {
    assert.ok(line.includes(`${field} `), `the log line omits ${field}`);
  }
  assert.match(line, /`gyro \$\{/, 'the log line omits gyro');
  // Without the build, a pasted reading cannot be tied to the code that
  // produced it — and two readings in this project have already turned out to
  // be measuring a defect rather than the phone.
  assert.match(line, /v\$\{APP_VERSION\}/);
  // Distinct especially: a burst of 32 samples of 8 frames looks exactly like
  // a steady hand from the offsets alone.
  assert.match(main, /appendBurstLog\(burstLogLine\(verdict, distinct, renderBurstAgreement\(/);
});

test('the burst tab shows the camera, and marks the region it actually measures', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  // Joshua: "I didn't see the camera on the screen... and had to guess what I
  // was looking at." Aiming a measurement instrument blind.
  assert.match(html, /<video id="burstVideo"[^>]*playsinline>/);
  assert.match(main, /preview\.srcObject = video\.srcObject;/);

  // Released when the tab is not showing: a hidden video still decoding is a
  // decoder running for a picture nobody can see.
  assert.match(main, /if \(preview\.srcObject\) preview\.srcObject = null;/);
  assert.match(main, /activeTab === 'burst' && camera\.active/);
  // And attached the moment the tab opens, not a second later on the timer.
  assert.match(main, /activeTab = key;\s*\n(\s*\/\/[^\n]*\n)*\s*syncBurstPreview\(\);/);

  // The probe reads the CENTRE at 1:1, not the whole frame — which is a much
  // narrower instruction than "point at texture" and was invisible before.
  assert.match(html, /class="burst-target"/);
  assert.match(html, /Only what is inside the box is measured/);
});

test('the reported raw spread is a like-for-like comparison', () => {
  // Joshua's log read "raw 68% · selected 59%", which says selection made the
  // burst worse. It had not: raw was the spread of all thirty-two offsets and
  // selected of eight, and more points always cover more grid. The comparison
  // that means anything is the first eight against the selected eight — what
  // taking the burst as it came would have given, against what choosing gives.
  const shifts = Array.from({ length: 32 }, (_, i) => ({
    // First eight deliberately clustered, later ones spread: selection should
    // reach past the clump and the report should show that it did.
    shiftX: i < 8 ? i * 0.01 : (i % 4) * 0.25 + i,
    shiftY: i < 8 ? i * 0.01 : ((i >> 2) % 4) * 0.25 + i,
    confidence: 0.8
  }));
  const verdict = bc.judgeBurst(shifts, 8);
  assert.ok(verdict.selectedSpread > verdict.rawSpread,
    `selection should beat the first eight: raw ${verdict.rawSpread.toFixed(2)}, `
    + `selected ${verdict.selectedSpread.toFixed(2)}`);
  // And rawSpread must be the first eight, not all thirty-two.
  assert.ok(Math.abs(verdict.rawSpread - sr.offsetSpread(shifts.slice(0, 8))) < 1e-9);
});

test('too few measurable frames is reported as texture, not as a bad hold', () => {
  // Joshua's log showed measurable counts of 2, 8, 11, 17 and 27 out of 32.
  // Most of that was the search window, now widened — but what remains is a
  // texture problem, and it needs a different instruction from a low spread:
  // aim somewhere else, rather than hold differently.
  const sparse = Array.from({ length: 32 }, (_, i) => ({
    shiftX: i * 0.3, shiftY: i * 0.2, confidence: i < 4 ? 0.8 : 0.01
  }));
  const verdict = bc.judgeBurst(sparse, 8);
  assert.equal(verdict.worthMerging, false);
  assert.match(verdict.reason, /had enough texture to measure/);
  assert.match(verdict.reason, /gravel, foliage, brickwork/);
});

test('travel describes the frames that were believed, not the ones refused', () => {
  // A refused estimate still carries whatever numbers the search landed on.
  // Reporting those as travel describes a movement the probe explicitly
  // declined to believe in — and Joshua's log read 14 px of travel on bursts
  // where only one frame in thirty-two was measurable.
  const shifts = [
    { shiftX: 0, shiftY: 0, confidence: 0.9 },
    { shiftX: 3, shiftY: 4, confidence: 0.9 },
    { shiftX: 90, shiftY: 90, confidence: 0 }
  ];
  const verdict = bc.judgeBurst(shifts, 8);
  assert.ok(verdict.travelPixels < 6, `travel ${verdict.travelPixels.toFixed(1)} includes a refused frame`);
});

test('stillness is never claimed from measurements that were refused', () => {
  // Stationary is inferred from shifts. With nothing measurable there is no
  // basis for the claim, and "it was on a tripod" sends someone to fix their
  // grip when the problem is what they are pointing at.
  const blind = Array.from({ length: 8 }, () => ({ shiftX: 0, shiftY: 0, confidence: 0.01 }));
  const verdict = bc.judgeBurst(blind, 8);
  assert.match(verdict.reason, /texture/i);
  assert.doesNotMatch(verdict.reason, /tripod/i);
});

test('score comparability: every offset in a window samples the same region', () => {
  // Scores are only comparable when every offset averages over the same pixels.
  // A fixed margin under a wider search meant edge offsets averaged over fewer,
  // so `worst` was set by whichever overlapped least and the confidence built
  // from it became noise — Joshua saw `measurable` swing between 2 and 15 of 32
  // on bursts with the SAME travel, on the same patch of grass.
  const source = readFileSync(new URL('../src/vision/burst-capture.ts', import.meta.url), 'utf8');
  assert.match(source, /const coarseMargin = coarseRadius \+ 2;/);
  assert.match(source, /const fineMargin = Math\.abs\(seedX\) > Math\.abs\(seedY\)/);
  // And no call may fall back to a fixed margin that ignores the search radius.
  assert.doesNotMatch(source, /searchWindow\([^)]*, margin\)/);

  // Behaviourally: confidence must stay in a tight band across a burst on one
  // scene, or the measurable count is a coin flip rather than a measurement.
  const reference = cropAt(0, 0);
  const confidences = [];
  let x = 0;
  let y = 0;
  let a = 977;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  for (let i = 1; i < 24; i++) {
    x += (rnd() - 0.5) * 1.4;
    y += (rnd() - 0.5) * 1.4;
    confidences.push(bc.estimateShift(reference, sr.noisyPlane(cropAt(-x, -y), 2, i * 13)).confidence);
  }
  const lowest = Math.min(...confidences);
  const highest = Math.max(...confidences);
  assert.ok(lowest > bc.MIN_CONFIDENCE,
    `every frame of a textured burst should be measurable; lowest was ${lowest.toFixed(2)}`);
  assert.ok(highest - lowest < 0.25,
    `confidence spread ${(highest - lowest).toFixed(2)} is too wide to threshold on`);
});

test('the log says WHY the gyroscope contributed nothing', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  // Thirty rows of Joshua's log read "gyro n/a" and none said why, so the
  // record could not answer whether the sensors had been used at all. The panel
  // knew; the log — the thing he actually sends — did not.
  for (const reason of ['no-fov', 'motion-off', 'no-cam-size']) {
    assert.ok(main.includes(`'${reason}'`), `the log cannot report ${reason}`);
  }
  assert.match(main, /gyro\.travel === null \? gyro\.reason/);
});
