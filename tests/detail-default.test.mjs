import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const htmlSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('live detail defaults to measuring rather than to any fixed cap', () => {
  // Both fixed guesses were wrong in opposite directions: 540p threw away
  // detail the device had, and full resolution on a twelve-megapixel stream
  // produced one to two frames a second and took the camera down. The device
  // is the only thing that knows, so the default asks it.
  assert.match(mainSource, /lensDetail: 'auto',/);
  assert.doesNotMatch(mainSource, /lensDetail: '540',/);
  assert.doesNotMatch(mainSource, /lensDetail: 'full',/);
});

test('auto climbs the ladder and never starts at the top', () => {
  // Starting high and backing off is NOT equivalent: the first measurement at
  // a level too expensive is taken while the device is already failing, and on
  // a phone that can mean the tab is reclaimed before any adjustment happens.
  assert.match(mainSource, /const AUTO_LADDER = \[0, 540, 720, 1080, Number\.POSITIVE_INFINITY\] as const/);
  // The two thresholds must differ, or every rung is both too slow and fast
  // enough and the ladder oscillates forever.
  assert.match(mainSource, /const AUTO_TARGET_FPS = 10;/);
  assert.match(mainSource, /const AUTO_HEADROOM_FPS = 20;/);
  // And the bottom rungs climb on less evidence, or the ladder is trapped
  // there: any rate inside the dead band held it at the analysis frame
  // forever, so a phone that could manage 540 sat at 166.
  assert.match(mainSource, /const AUTO_LOW_RUNG_HEADROOM_FPS = 14;/);
  assert.match(mainSource, /autoRung <= 1 \? AUTO_LOW_RUNG_HEADROOM_FPS : AUTO_HEADROOM_FPS/);
  assert.match(mainSource, /let autoRung = 1;/, 'start one rung above the analysis frame');
  assert.match(mainSource, /function updateAutoDetail\(processingFps: number, now: number\)/);
});

test('auto needs a run of agreeing measurements, and more to climb than to fall', () => {
  const fn = mainSource.slice(
    mainSource.indexOf('function updateAutoDetail'),
    mainSource.indexOf('/** Target width for the live processed picture')
  );
  assert.match(fn, /now - autoLastCheck < 1000/, 'it rate-limits itself');
  assert.match(fn, /autoVotes <= -AUTO_VOTES/);
  assert.match(fn, /autoVotes >= AUTO_VOTES \* 2/, 'climbing needs more agreement than backing off');
  // A move must invalidate the cached buffers or the next frame draws at the
  // old size into a canvas sized for the new one.
  assert.match(fn, /lensDisplay = null/);
});

test('the settled rung is remembered so a device learns this once', () => {
  assert.match(mainSource, /const AUTO_SETTLE_KEY = 'vss\.detail\.auto\.v1'/);
  assert.match(mainSource, /function loadAutoRung/);
  assert.match(mainSource, /function saveAutoRung/);
  assert.match(mainSource, /loadAutoRung\(\);/);
});

test('a corrected default reaches installs that never had an opinion', () => {
  // Otherwise a bad default is frozen into stored settings forever: every
  // install that never touched the control keeps the guess.
  assert.match(mainSource, /lensDetailChosen: boolean;/);
  assert.match(mainSource, /lensDetailChosen: false,/);
  assert.match(mainSource, /parsed\.lensDetailChosen === true/);
});

test('a deliberate choice is never overridden by a default', () => {
  assert.match(mainSource, /settings\.lensDetailChosen = true;/);
  const at = mainSource.indexOf('lensDetail: parsed.lensDetailChosen === true');
  const loader = mainSource.slice(at, at + 400);
  // Chosen -> the stored value; unchosen -> the current default.
  assert.match(loader, /\? parsed\.lensDetail as LensDetail/);
  assert.match(loader, /: DEFAULT_SETTINGS\.lensDetail/);
});

test('the note points at the measured cost rather than urging caution', () => {
  assert.match(mainSource, /Full matches the camera; drop it only if the frame rate beside it says you should/);
});

test('Fill is a display crop and the save says so', () => {
  // A shot framed in Fill contains more than was on screen. Finding that out
  // later, after the moment has gone, is worse than reading one clause now.
  assert.match(mainSource, /Fill crops the screen, not the file/);
  assert.match(mainSource, /dataset\.fit === 'fill'/);
  // And the toggle itself says it, so it need not be learned by saving one.
  assert.match(mainSource, /Saving always writes the whole frame/);
  assert.match(mainSource, /Saving still writes the whole frame/);
});

test('the saved frame is never cropped to the view', () => {
  // Extra frame can be cropped afterwards; a frame cropped at capture cannot
  // be got back, so the file keeps everything the sensor gave.
  const still = mainSource.slice(
    mainSource.indexOf('function finishStill'),
    mainSource.indexOf('function saveCanvas')
  );
  assert.match(still, /source\.width = frame\.width/);
  assert.match(still, /source\.height = frame\.height/);
  assert.doesNotMatch(still, /dataset\.fit/, 'the display setting must not reach the file');
});

test('a saved-shape crop is taken after the mode renders, never before', () => {
  // Cropping first would change what the edge and relief filters see at the
  // new border, so the same scene would render differently depending on a
  // setting about the file's shape.
  const still = mainSource.slice(
    mainSource.indexOf('function finishStill'),
    mainSource.indexOf('function saveCanvas')
  );
  const rendered = still.indexOf('renderStill(visionMode');
  const cropped = still.indexOf('cropToAspect(');
  assert.ok(rendered >= 0 && cropped > rendered, 'render at full frame, then crop');
  // And the cost of the crop is stated in the confirmation.
  assert.match(still, /% of the \$\{frame\.width\}×\$\{frame\.height\} frame/);
});

test('the display size is capped by measured detail, not by the reported size', () => {
  // Same build, same "Full" setting, two containers on one phone: 3024x4032
  // at 289 ms/frame and 1080x1440 at 35, and the two pictures looked the
  // same. They looked the same because they were: the larger stream carries
  // about as much real detail, so eight times the pixels bought eight times
  // the cost and nothing else.
  assert.match(mainSource, /function detailCappedShortSide\(sourceShort: number\)/);
  assert.match(mainSource, /const DETAIL_CAP_MARGIN = 4;/);
  assert.match(mainSource, /const DETAIL_CAP_FLOOR = 720;/);
  assert.match(mainSource, /Math\.min\(sourceShort, detailCappedShortSide\(sourceShort\), wantedShort\)/);
});

test('the cap only acts on a confident, textured reading', () => {
  // A flat scene has nothing to measure. Treating that as "upscaled" would
  // shrink the picture because someone pointed the camera at a wall.
  const fn = mainSource.slice(
    mainSource.indexOf('function sampleDetailForCap'),
    mainSource.indexOf('function detailCappedWidth')
  );
  assert.match(fn, /if \(!reading \|\| reading\.flat \|\| reading\.scale === null\) return;/);
  assert.match(fn, /now - lastDetailSample < DETAIL_SAMPLE_INTERVAL_MS/, 'and it is rate-limited');
});

test('the margin errs towards rendering too much rather than too little', () => {
  // The estimator is a coarse halving search. Rendering somewhat more than
  // necessary costs a little speed; rendering less than the frame holds
  // costs detail that cannot be got back.
  const block = mainSource.slice(
    mainSource.indexOf('const DETAIL_CAP_MARGIN'),
    mainSource.indexOf('function sampleDetailForCap')
  );
  assert.match(mainSource, /Math\.max\(DETAIL_CAP_FLOOR, Math\.round\(real \* DETAIL_CAP_MARGIN\)\)/);
  assert.ok(block.length > 0);
});

test('a capped picture explains itself', () => {
  // Smaller than the setting asked for reads as the setting being ignored,
  // unless it says why.
  assert.match(mainSource, /px of real detail,/);
  assert.match(mainSource, /pixels that are interpolation/);
  assert.match(htmlSource, /id="lensDetailCap"/);
  // And a pegged reading is reported as a bound, never as a figure. Both of
  // the readings that exposed this were exactly 1/16 — the floor of a
  // four-level search — quoted as though they had been measured.
  assert.match(mainSource, /let measuredDetailPegged = false;/);
  assert.match(mainSource, /measuredDetailPegged \? ' at most about' : ' about'/);
});
