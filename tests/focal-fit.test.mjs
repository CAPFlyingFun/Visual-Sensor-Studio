import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as ff from '../.test-build/vision/focal-fit.js';

/** An iPhone-ish main camera: 3024 px across a ~70° field. */
const WIDTH = 3024;
const TRUE_FOCAL = WIDTH / (2 * Math.tan((70 / 2) * Math.PI / 180));

function burst(count, { noisePixels = 0, focal = TRUE_FOCAL, seed = 5 } = {}) {
  let a = seed >>> 0;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  return Array.from({ length: count }, (_, i) => {
    const rotationRadians = 0.002 + (i / count) * 0.02;
    return {
      rotationRadians,
      imagePixels: focal * rotationRadians + (rnd() - 0.5) * 2 * noisePixels
    };
  });
}

test('the focal length falls out of the burst, with no prior estimate', () => {
  // The point of the whole module: nothing is being refined here. The number is
  // produced from displacement and rotation alone, which is why it needs no
  // field of view to start from — the browser has none to give.
  const fit = ff.fitFocalLength(burst(20), WIDTH);
  assert.ok(fit.focalPixels !== null);
  assert.ok(Math.abs(fit.fovDegrees - 70) < 0.5, `got ${fit.fovDegrees?.toFixed(2)}°`);
  assert.ok(fit.quality > 0.98);
  assert.match(fit.reason, /Measured from 20 frames/);
});

test('it survives the noise a real aligner leaves behind', () => {
  // The aligner is good to about 0.05 px; this is twenty times that.
  const fit = ff.fitFocalLength(burst(20, { noisePixels: 1 }), WIDTH);
  assert.ok(Math.abs(fit.fovDegrees - 70) < 3, `got ${fit.fovDegrees?.toFixed(1)}°`);
});

test('a still hand is refused rather than divided by', () => {
  // The estimate divides by rotation, so near-zero rotation turns sensor noise
  // into an arbitrarily large focal length — a confident, meaningless answer.
  const still = Array.from({ length: 20 }, () => ({
    rotationRadians: 0.00001, imagePixels: 0.4
  }));
  const fit = ff.fitFocalLength(still, WIDTH);
  assert.equal(fit.focalPixels, null);
  assert.match(fit.reason, /rotated enough/);
});

test('a fit that is not describing one motion is discarded, not reported', () => {
  // Scene motion, or the phone sliding rather than turning: the gyroscope and
  // the picture then describe different things and the line through them means
  // nothing, however tidy the arithmetic.
  let a = 3;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const incoherent = Array.from({ length: 20 }, () => ({
    rotationRadians: 0.002 + rnd() * 0.02,
    imagePixels: rnd() * 200
  }));
  const fit = ff.fitFocalLength(incoherent, WIDTH);
  assert.equal(fit.fovDegrees, null);
  assert.match(fit.reason, /disagree about how the phone moved/);
});

test('an impossible lens is refused, never rounded into range', () => {
  // Clamping would turn a detectable failure into a plausible wrong number
  // that everything downstream would then trust.
  const tooWide = ff.fitFocalLength(burst(20, { focal: WIDTH / 40 }), WIDTH);
  assert.equal(tooWide.fovDegrees, null);
  assert.match(tooWide.reason, /which no phone has/);
  const tooNarrow = ff.fitFocalLength(burst(20, { focal: WIDTH * 12 }), WIDTH);
  assert.equal(tooNarrow.fovDegrees, null);
});

test('the fit has no intercept — zero rotation must mean zero movement', () => {
  // A free intercept lets the line absorb a constant drift and report a focal
  // length fitted to the residue rather than to the physics.
  const source = readFileSync(new URL('../src/vision/focal-fit.ts', import.meta.url), 'utf8');
  assert.match(source, /numerator \/ denominator/);
  assert.doesNotMatch(source, /intercept =/);

  // Behaviourally: a constant offset added to every displacement must show up
  // as a worse fit, not be quietly absorbed.
  const drifted = burst(20).map((s) => ({ ...s, imagePixels: s.imagePixels + 25 }));
  const fit = ff.fitFocalLength(drifted, WIDTH);
  assert.ok(fit.quality < 0.999, 'a constant drift should degrade the fit');
});

test('unmeasurable is never silently a number', () => {
  for (const bad of [[], burst(2)]) {
    const fit = ff.fitFocalLength(bad, WIDTH);
    assert.equal(fit.focalPixels, null);
    assert.equal(fit.fovDegrees, null);
  }
  assert.equal(ff.fitFocalLength(burst(20), 0).focalPixels, null);
});

test('the burst measures the lens and only adopts it when nothing was typed', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  // Both halves of the relation come from the burst that just ran.
  assert.match(main, /imagePixels: Math\.hypot\(shifts\[i\]\.shiftX, shifts\[i\]\.shiftY\)/);
  assert.match(main, /rotationRadians: Math\.hypot\(gyro\[i\]\.x, gyro\[i\]\.y\)/);
  // Refused frames must not vote: their shift is a number the probe declined
  // to believe, and feeding it to a fit launders it into a measurement.
  assert.match(main, /if \(shifts\[i\]\.confidence < MIN_CONFIDENCE\) continue;/);

  // A typed value is a deliberate choice and a measurement must not overwrite
  // it — the same rule the live-detail setting follows.
  assert.match(main, /if \(!\(settings\.motionFovDegrees > 0\)\) \{/);
  // And the placeholder should invite measuring rather than demand a number.
  assert.match(html, /id="burstFov"[^>]*placeholder="measured"/);
  assert.match(html, /measured from the burst, not looked up/);
});

test('rotation is integrated at the sensor rate, not at the capture rate', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

  // THE BUG THIS RECORDS. The burst first integrated rotation itself, reading
  // latestMotion once per captured frame — about ten times a second. Hand
  // tremor is 8 to 12 Hz, so that samples a signal at roughly its own
  // frequency and aliases nearly all of it away. Measured consequence on
  // Joshua's phone: gyro travel 2.1-2.3 px against 7-9.5 px of image travel,
  // a lens fit of 126 degrees for a 70 degree camera, and "unfit" on four
  // bursts out of five.
  //
  // onMotionSample is the only place the full signal exists.
  const handler = main.slice(main.indexOf('function onMotionSample'),
    main.indexOf('function onMotionSample') + 1200);
  assert.match(handler, /rotationTotal\.x \+=/);
  assert.match(handler, /rotationTotal\.y \+=/);
  // A gap means the app was backgrounded; multiplying a stale rate across it
  // invents a rotation that never happened.
  assert.match(handler, /Math\.min\(0\.1,/);

  // And the burst must SNAPSHOT that total rather than re-derive it.
  const probe = main.slice(main.indexOf('async function runBurstProbe'),
    main.indexOf('function countDistinctFrames'));
  assert.match(probe, /rotationTotal\.x - rotationAtStart\.x/);
  assert.doesNotMatch(probe, /rotationRate\.(gamma|beta)/,
    'the burst must not integrate rotation itself');
});
