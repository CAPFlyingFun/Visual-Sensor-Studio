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
  assert.match(mainSource, /let autoRung = 1;/, 'start one rung above the analysis frame');
});

test('the ladder is steered by render cost, never by the achieved frame rate', () => {
  // Frame rate is the slower of two things, and only one of them is the
  // render. On a twelve-megapixel capture the camera delivers about ten
  // frames a second, so the analysis rate sat at eight whatever the render
  // size was; the old rule read that as "too slow" at every rung and walked
  // to the bottom, showing a 166px analysis frame beside a "0 ms/frame"
  // readout while an explicit Full ran 609px smoothly on the same device.
  assert.match(mainSource, /function updateAutoDetail\(renderMs: number, rates: FrameRateReport, now: number\)/);
  assert.match(mainSource, /const verdict = detailVerdict\(\{/);
  assert.match(mainSource, /renderMs,\s*\n\s*deliveredFps: rates\.deliveredFps,\s*\n\s*processingFps: rates\.processingFps/);
  // The old frame-rate thresholds must be gone, not merely unused: a leftover
  // constant is the next agent's evidence that the rate still steers this.
  assert.doesNotMatch(mainSource, /AUTO_TARGET_FPS|AUTO_HEADROOM_FPS|AUTO_LOW_RUNG_HEADROOM_FPS/);
  // The cost that is voted on has to be the one the rung produced, so a mode
  // rendering at the analysis size must not get a vote.
  assert.match(mainSource, /if \(drewLarge\) \{[\s\S]*updateAutoDetail\(lensRenderMs/);
});

test('auto never settles on the analysis frame', () => {
  // Rung 0 is a fallback for modes that cannot honestly be enlarged, not a
  // picture to choose. Reaching it on a real device produced a 166px image
  // under a setting whose whole promise is to find the best one that runs.
  assert.match(mainSource, /const AUTO_FLOOR_RUNG = 1;/);
  assert.match(mainSource, /verdict === 'back-off' && autoRung > AUTO_FLOOR_RUNG/);
});

test('a size change forgets what the previous size cost', () => {
  // The cost reading is a rolling average. Carried across a size change it
  // judges the new picture by the old one's price — and opening full screen
  // is exactly that: several times the panel's area, where a carried-over
  // reading says "room to climb" at the moment it needs to back off.
  const ensure = mainSource.slice(
    mainSource.indexOf('function ensureLensDisplay'),
    mainSource.indexOf('function renderDisplayMode')
  );
  assert.match(ensure, /lensRenderMs = 0;/);
  // And that reset must sit AFTER the early return, or every frame clears it.
  const guard = ensure.indexOf('lensDisplay.height === height) return lensDisplay');
  assert.ok(guard >= 0 && ensure.indexOf('lensRenderMs = 0;') > guard);
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
  assert.match(mainSource, /const AUTO_SETTLE_KEY = 'vss\.detail\.auto\.v2'/);
  // Never START at the bottom, whatever was remembered: that rung is the
  // analysis frame, a fallback rather than a settled answer, and restoring a
  // remembered 0 makes one bad session permanent.
  assert.match(mainSource, /autoRung = Math\.max\(AUTO_FLOOR_RUNG, stored\)/);
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
  assert.match(mainSource, /up to the point where the screen runs out of pixels to show it with/);
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
  assert.match(mainSource, /const ceiling = auto \? detailCappedShortSide\(sourceShort\) : sourceShort;/);
  assert.match(mainSource, /Math\.min\(sourceShort, ceiling, wantedShort, onScreen > 0 \? onScreen : sourceShort\)/);
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

test('an explicit tier is honoured exactly, never capped', () => {
  // Choosing "Full — sensor resolution" is an instruction, not a starting
  // point for a heuristic to argue with. Capping it produced 756x1008 from a
  // 3024 stream under a label promising the sensor's own size — the control
  // lying about what it did.
  const fn = mainSource.slice(
    mainSource.indexOf('function lensDisplayWidth'),
    mainSource.indexOf('/** Buffers for the enlarged picture')
  );
  assert.match(fn, /const ceiling = auto \? detailCappedShortSide\(sourceShort\) : sourceShort;/);
  // Full must resolve to the stream's own short side with nothing in between.
  assert.match(fn, /settings\.lensDetail === 'full' \? sourceShort/);
});

test('the cap notice only appears where the cap applies', () => {
  // Explaining an auto-only behaviour under an explicit setting would describe
  // something that is not happening.
  assert.match(mainSource, /capped && settings\.lensDetail === 'auto'/);
});

test('the screen is a hard bound at every setting, including the explicit ones', () => {
  // An iPhone 15 Plus shows about 1720x1290 device pixels full screen and
  // 1020x765 in the panel. A 3024x4032 render was putting twelve megapixels
  // through a window that can display two — which is why the small preview
  // looked better than the same mode full screen.
  //
  // This is not the detail estimator inferring an upscale. It is arithmetic
  // about a display: pixels beyond what a screen can resolve are invisible,
  // so no setting can reasonably be read as a request for them.
  assert.match(mainSource, /function displayedShortSide\(sourceAspect: number, now: number\)/);
  assert.match(mainSource, /const onScreen = displayedShortSide\(shape\.aspect, performance\.now\(\)\)/);
  // Contain and cover swap which axis limits the content box.
  assert.match(mainSource, /const heightLimited = fill \? boxAspect < sourceAspect : boxAspect > sourceAspect/);
});

test('the layout read is throttled out of the render loop', () => {
  // getBoundingClientRect every frame forces a reflow mid-render for a number
  // that only changes when something is resized.
  assert.match(mainSource, /now - lastDisplayMeasure < 400 && displayedShort > 0/);
});

test('saving is explicitly exempt from the screen bound', () => {
  // A file is zoomed into and cropped long after the screen it was framed on
  // stopped mattering.
  assert.match(mainSource, /Saving is unaffected — a file is rendered from the full capture/);
  const still = mainSource.slice(
    mainSource.indexOf('function finishStill'),
    mainSource.indexOf('function saveCanvas')
  );
  assert.doesNotMatch(still, /displayedShortSide|displayedShort/);
});

test('the label promises what the tier now delivers', () => {
  assert.match(htmlSource, /Full — all the screen can show/);
  assert.doesNotMatch(htmlSource, /Full — sensor resolution/);
});
