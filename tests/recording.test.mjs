import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fmt = await import('../.test-build/vision/clip-format.js');
const rec = await import('../.test-build/vision/clip-recorder.js');
const lib = await import('../.test-build/vision/clip-library.js');

/* --- What the browser can write ----------------------------------------- */

test('the format is asked for, never assumed', () => {
  // Safari records MP4 and nothing else; every other browser records WebM and
  // may or may not do MP4. A version table would claim capabilities a given
  // phone may not have.
  const safari = fmt.supportedClipFormats((mime) => mime.startsWith('video/mp4'));
  assert.equal(fmt.preferredClipFormat(safari).extension, 'mp4');

  const chrome = fmt.supportedClipFormats((mime) => mime.includes('webm'));
  assert.equal(fmt.preferredClipFormat(chrome).extension, 'webm');

  // A browser with no MediaRecorder at all throws from isTypeSupported. That
  // is an answer, not a crash.
  const broken = fmt.supportedClipFormats(() => { throw new Error('no such thing'); });
  assert.deepEqual(broken, []);
  assert.equal(fmt.preferredClipFormat(broken), null);
});

test('MP4 wins wherever both are offered', () => {
  // Not a taste preference: a WebM saved to an iPhone opens in nothing the
  // phone ships with, so recording one produces a file its owner cannot watch.
  const both = fmt.supportedClipFormats(() => true);
  assert.equal(fmt.preferredClipFormat(both).extension, 'mp4');
});

test('the size of a clip is stated before it is recorded, not after', () => {
  const rate = fmt.suggestedBitrate(1920, 1080, 30);
  const thirty = fmt.estimateClipBytes(rate, 30);
  // A thirty-second 1080p clip is tens of megabytes. The exact figure is the
  // encoder's business; the order of magnitude is the user's.
  assert.ok(thirty > 5e6 && thirty < 120e6, `${thirty} bytes is not a plausible clip`);
  // Bit rate follows the frame size rather than being one constant.
  assert.ok(fmt.suggestedBitrate(640, 480, 30) < rate);
  // And it is bounded at both ends, so a huge or tiny frame cannot ask for an
  // absurd rate.
  assert.ok(fmt.suggestedBitrate(8000, 6000, 60) <= 16_000_000);
  assert.ok(fmt.suggestedBitrate(64, 64, 1) >= 1_500_000);
});

test('the rate suits a FILTERED picture, which is the hard case', () => {
  // An Ironbow ramp or an edge map is high-contrast, noise-like detail across
  // the whole frame — the hardest thing to encode and the first thing a tight
  // rate control smears. A camera frame of a wall compresses; a false-colour
  // speed field does not.
  const recorded = fmt.suggestedBitrate(548, 732, 30);
  // At the eight frames a second a heavy filter really produces, this is what
  // each frame gets: enough that a still stops looking obviously compressed.
  const bitsPerPixel = recorded / 8 / (548 * 732);
  assert.ok(bitsPerPixel > 0.6,
    `${bitsPerPixel.toFixed(2)} bits per pixel per frame is where smearing starts`);
});

/* --- Cutting the recording into clips ------------------------------------ */

function trace() {
  const events = [];
  const recorder = new rec.RollingRecorder({
    beginSegment: (index) => events.push(`begin ${index}`),
    endSegment: (index, reason) => events.push(`end ${index} ${reason}`)
  }, 30_000);
  return { events, recorder };
}

test('a clip is cut every thirty seconds, and each one is finished', () => {
  const { events, recorder } = trace();
  recorder.start(0);
  recorder.tick(29_999);
  assert.deepEqual(events, ['begin 0'], 'nothing should be cut before the limit');

  recorder.tick(30_000);
  assert.deepEqual(events, ['begin 0', 'end 0 full', 'begin 1']);
  // The clock restarts with the segment, not with the recording — otherwise
  // every later cut would fire on the same tick.
  recorder.tick(45_000);
  assert.equal(events.length, 3);
  recorder.tick(60_000);
  assert.deepEqual(events.slice(3), ['end 1 full', 'begin 2']);
});

test('stopping ends the clip in hand and starts no other', () => {
  const { events, recorder } = trace();
  recorder.start(0);
  recorder.stop(12_000);
  assert.deepEqual(events, ['begin 0', 'end 0 stopped']);
  assert.equal(recorder.recording, false);

  // Ticks after a stop must do nothing at all: the app's animation loop keeps
  // running, and a tick that restarted a recorder would record without asking.
  recorder.tick(90_000);
  recorder.tick(120_000);
  assert.equal(events.length, 2);
});

test('start and stop are idempotent', () => {
  const { events, recorder } = trace();
  recorder.start(0);
  recorder.start(1_000);
  assert.deepEqual(events, ['begin 0'], 'a second start must not open a second recorder');
  recorder.stop(2_000);
  recorder.stop(3_000);
  assert.deepEqual(events, ['begin 0', 'end 0 stopped']);
});

test('elapsed time is reported per clip and overall', () => {
  const { recorder } = trace();
  recorder.start(1_000);
  assert.equal(recorder.totalElapsedMs(11_000), 10_000);
  assert.equal(recorder.segmentElapsedMs(11_000), 10_000);
  assert.equal(recorder.segmentFraction(16_000), 0.5);
  recorder.tick(31_000);
  assert.equal(recorder.totalElapsedMs(41_000), 40_000, 'the total spans clips');
  assert.equal(recorder.segmentElapsedMs(41_000), 10_000, 'the clip clock restarts');
  assert.equal(recorder.segmentFraction(91_000), 1, 'the fraction cannot exceed one');
});

/* --- What is held, and what is dropped ----------------------------------- */

const clip = (id, startedAt, bytes, savedAt = null) =>
  ({ id, startedAt, bytes, seconds: 30, label: 'camera', savedAt });

test('the newest clip is never dropped', () => {
  // It is the one just recorded, and the reason the camera was pointed at
  // anything. Dropping it to satisfy a budget would be absurd.
  const plan = lib.planRetention([clip('a', 1, 900e6)], { maxClips: 0, maxBytes: 0 });
  assert.deepEqual(plan.evict, []);
  assert.equal(plan.keep.length, 1);
});

test('exported clips are dropped before ones that exist only here', () => {
  // An exported clip has a copy the phone will not delete on its own, so
  // losing this one costs nothing. An unexported clip is the only copy.
  const clips = [
    clip('newest', 500, 20e6),
    clip('old-unsaved', 100, 20e6),
    clip('newer-saved', 400, 20e6, 450),
    clip('older-saved', 200, 20e6, 250)
  ];
  const plan = lib.planRetention(clips, { maxClips: 2, maxBytes: 100e6 });
  assert.deepEqual(plan.evict.map((c) => c.id), ['older-saved', 'newer-saved'],
    'both exported copies should go before the unexported one');
  assert.deepEqual(plan.keep.map((c) => c.id), ['newest', 'old-unsaved']);
});

test('among equals the oldest goes first, and the byte budget bites too', () => {
  const clips = [clip('c', 300, 30e6), clip('b', 200, 30e6), clip('a', 100, 30e6)];
  const plan = lib.planRetention(clips, { maxClips: 99, maxBytes: 70e6 });
  assert.deepEqual(plan.evict.map((c) => c.id), ['a']);
  assert.equal(plan.bytes, 60e6);
});

test('dropping is never silent, and says what was destroyed', () => {
  // A recorder that quietly deletes yesterday's clip is indistinguishable from
  // a bug.
  const clips = [clip('new', 300, 30e6), clip('gone', 100, 30e6)];
  const plan = lib.planRetention(clips, { maxClips: 1, maxBytes: 1e9 });
  assert.match(plan.reason, /dropped 1 oldest/);
  assert.match(plan.reason, /never been exported/);

  const exported = lib.planRetention(
    [clip('new', 300, 30e6), clip('gone', 100, 30e6, 150)],
    { maxClips: 1, maxBytes: 1e9 }
  );
  assert.match(exported.reason, /already exported/);
});

test('the budget is a share of what is free, and never the whole phone', () => {
  const roomy = lib.budgetFromQuota(20e9, 1e9);
  assert.ok(roomy.maxBytes <= lib.MAX_BUDGET_BYTES,
    'the app must not take a gigabyte of someone’s phone for held clips');
  assert.ok(roomy.maxClips > 0);

  // A full phone yields no budget rather than a negative one.
  const full = lib.budgetFromQuota(1e9, 1.2e9);
  assert.equal(full.maxBytes, 0);
  assert.equal(full.maxClips, 0);

  // And a missing quota is not invented — that is the caller's job, and it
  // cannot be derived from nothing here.
  const nothing = lib.budgetFromQuota(NaN, 0);
  assert.equal(nothing.maxBytes, 0);
});

test('the budget is also stated as recording time, not only megabytes', () => {
  // Megabytes mean nothing while pointing a camera at something. Minutes do.
  const seconds = lib.budgetSeconds({ maxBytes: 300e6, maxClips: 10 }, 6_000_000);
  assert.equal(seconds, 400);
  assert.equal(lib.budgetSeconds({ maxBytes: 300e6, maxClips: 10 }, 0), 0);
});

/* --- The wiring ---------------------------------------------------------- */

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('the recorder records what is on screen, filters included', () => {
  // A recording of the raw camera would be a worse copy of what the phone's
  // own camera app already does. The processing is the reason to record here.
  const fn = main.slice(main.indexOf('function recordSource'), main.indexOf('function beginSegment'));
  // Through the recording canvas, which carries the overlay at the size it is
  // displayed rather than the size it is computed at — see recordTargetSize.
  assert.match(fn, /recordCanvas\.captureStream/);
  // But only while the overlay is actually painting — a hidden or stale canvas
  // would record a black rectangle.
  assert.match(fn, /overlayPainted/);
  assert.match(fn, /video\.srcObject as MediaStream/);
});

test('stopping a recording never stops the camera', () => {
  // The camera's own tracks are borrowed, not owned. Stopping them here would
  // switch the camera off as a side effect of stopping a recording.
  assert.match(main, /if \(recordStreamIsOurs\) recordStream\?\.getTracks\(\)/);
});

test('the clip clock is driven by the animation loop, not a timer', () => {
  // A setTimeout in a backgrounded tab is throttled or deferred, and a clip
  // that ran long because the phone was in a pocket is exactly the oversized
  // file the limit exists to prevent.
  assert.match(main, /tickRecording\(timestamp\);/);
  assert.ok(!/setTimeout\([^)]*endSegment/.test(main));
  // And leaving the app finishes the clip in hand rather than losing it.
  const hidden = main.slice(main.indexOf("document.visibilityState === 'hidden'"));
  assert.match(hidden.slice(0, 400), /stopRecording\(\)/);
});

test('held clips are described as temporary, because they are', () => {
  // Origin storage on iOS is evictable and Safari discards it after weeks
  // without a visit. Implying an archive would be a lie the browser tells for
  // us.
  assert.match(html, /temporary/i);
  assert.match(html, /never uploaded/i);
  assert.match(html, /Export anything worth keeping/i);
});

/* --- The iPhone that "could not record" ---------------------------------- */

test('the recording subsystem actually starts up', () => {
  // The bug this exists for: these four lines were inserted after `void
  // applyAutoStart()`, and there are four of those — three inside change
  // handlers in the settings panel. They landed in the FIRST one, so recording
  // only initialised if you toggled "start the camera automatically". The
  // format was never detected and the badge sat on "checking…" forever, which
  // the app reported as "this browser cannot record video from a web page".
  //
  // At the END of the file it cannot be nested inside anything: a handler would
  // have to close after it. That is what makes this a real check rather than an
  // indentation convention — the misplaced copy was at column zero too.
  assert.match(main.trimEnd(), /\n\}\);$/, 'the file should end with the startup block');
  const tail = main.trimEnd().slice(-400);
  assert.match(tail, /detectClipFormat\(\);\n(?:sync\w+\(\);\n)+void renderClips\(\)/,
    'the startup calls must be the last statements in the file');
});

test('a browser that names no format can still record', () => {
  // Joshua's iPhone: isTypeSupported matched nothing at all, and the app told a
  // phone that records video perfectly well that it could not. A MediaRecorder
  // built with NO mimeType uses the browser's own default and reports it back —
  // a browser cannot be wrong about the format it just chose for itself.
  const named = fmt.preferredClipFormat(fmt.supportedClipFormats(() => false));
  assert.equal(named, null, 'nothing is named in this case');
  assert.ok(fmt.BROWSER_DEFAULT, 'and there has to be something to fall back to');

  assert.match(main, /clipFormat = named \?\? BROWSER_DEFAULT;/);
  // Asking for an empty mimeType is not the same as asking for none.
  assert.match(main, /new MediaRecorder\(recordStream, \{ videoBitsPerSecond: clipBitrate \}\)/);
  // And "cannot record" is now reachable only when MediaRecorder is absent.
  const detect = main.slice(main.indexOf('function detectClipFormat'), main.indexOf('function recordSource'));
  assert.match(detect, /typeof MediaRecorder === 'undefined'/);
  assert.ok(!/isTypeSupported[\s\S]{0,200}clipFormat = null/.test(detect),
    'a browser that names nothing must not be written off');
});

test('the file is named from what the recorder produced, not what was asked for', () => {
  // A .mp4 holding WebM would be the file lying about what it is.
  assert.equal(fmt.formatFromMime('video/mp4;codecs=avc1.42E01E').extension, 'mp4');
  assert.equal(fmt.formatFromMime('video/webm;codecs=vp8').extension, 'webm');
  assert.equal(fmt.formatFromMime('video/quicktime').extension, 'mov');
  assert.equal(fmt.formatFromMime('video/x-matroska;codecs=avc1').extension, 'mkv');
  // An unfamiliar container keeps its own subtype rather than a generic
  // extension that nothing would offer to open.
  assert.equal(fmt.formatFromMime('video/ogg').extension, 'ogg');
  assert.equal(fmt.formatFromMime('').extension, 'mp4');

  assert.match(main, /clipFormat = formatFromMime\(mediaRecorder\.mimeType\)/);
});

/* --- Long side, not width ------------------------------------------------ */

test('a size choice means the same pixels however the phone is held', () => {
  // "480" in portrait gave 480x640: in portrait a fixed WIDTH makes the frame
  // TALLER rather than smaller, so the memory followed the grip instead of the
  // choice.
  const landscape = fmt.fitLongSide(1280, 960, 480);
  const portrait = fmt.fitLongSide(960, 1280, 480);
  assert.deepEqual(landscape, { width: 480, height: 360 });
  assert.deepEqual(portrait, { width: 360, height: 480 });
  assert.equal(landscape.width * landscape.height, portrait.width * portrait.height);

  // Even dimensions both ways: odd sizes upset some players.
  const odd = fmt.fitLongSide(1000, 563, 321);
  assert.equal(odd.width % 2, 0);
  assert.equal(odd.height % 2, 0);
  // A square source stays square, and nothing collapses to zero.
  assert.deepEqual(fmt.fitLongSide(720, 720, 240), { width: 240, height: 240 });
  const sliver = fmt.fitLongSide(1000, 1, 240);
  assert.ok(sliver.height >= 2, 'a dimension must never round away to nothing');
});

test('every size the interface offers actually fits in memory', () => {
  // Frames are raw RGBA while capturing. The refusal should be a guard against
  // something unforeseen, not the routine answer to a normal choice.
  const budget = Number(/GIF_MEMORY_BUDGET = (\d+) \* 1024 \* 1024/.exec(main)[1]) * 1024 * 1024;
  for (const longSide of [240, 320, 480]) {
    for (const seconds of [2, 4, 6]) {
      for (const fps of [8, 10, 12.5]) {
        const { width, height } = fmt.fitLongSide(1280, 960, longSide);
        const held = width * height * 4 * Math.round(seconds * fps);
        assert.ok(held <= budget,
          `${longSide}px ${seconds}s at ${fps}/s needs ${(held / 1e6).toFixed(0)}MB`);
      }
    }
  }
});

test('a filter is recorded at the size it is shown, not the size it is computed', () => {
  // A ten-second clip came out 382kB because the overlay canvas IS 166x221:
  // several modes compute at the analysis size for speed, and recording that
  // canvas directly recorded the analysis frame rather than the picture on
  // screen.
  const fn = main.slice(main.indexOf('function recordTargetSize'), main.indexOf('function blitRecordFrame'));
  assert.match(fn, /budgetedShortSide/, 'the size should follow the display budget');
  assert.match(fn, /Math\.max\(short,/, 'and never end up smaller than what was computed');

  // The recording canvas is what is captured, refreshed once per frame.
  assert.match(main, /recordCanvas\.captureStream\(30\)/);
  const tick = main.slice(main.indexOf('function tickRecording'), main.indexOf('function canShareFile'));
  assert.match(tick, /blitRecordFrame\(\);/);

  // And the bit rate aims at the frame being encoded, not at the analysis one.
  assert.match(main, /recordStreamIsOurs && recordCanvas \? recordCanvas\.width : 1280/);
});

test('upscaling is called upscaling', () => {
  // It adds no detail, and a recording that quietly implied otherwise would be
  // the app overstating what it measured.
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /scaled up from it to the size you actually see/);
  assert.match(html, /not\s+extra detail/);
  assert.match(main, /\+ ' not more detail';/);
});

test('the storage figure is the browser’s allowance, not the phone’s free space', () => {
  // Joshua's iPhone had 192.95GB free of 512GB while the app reported
  // "41.23GB free on this device". storage.estimate() reports the quota this
  // browser allows this one website — a fraction of the disk, deliberately
  // coarsened, and nothing to do with what Settings shows.
  assert.match(main, /this browser allows this site/);
  assert.ok(!/free on this device/.test(main), 'the app must not claim to know the phone’s free space');

  // The cap is stated in the same units it is displayed in, or a "600MB"
  // ceiling prints as 629.1MB and looks like a different number.
  assert.equal(lib.MAX_BUDGET_BYTES, 600e6);
  assert.equal(lib.describeSize(lib.MAX_BUDGET_BYTES), '600.0 MB');
});

test('a clip carries the rate it was actually written at', () => {
  // Joshua's lens clip came back at 7.52 fps and the reasonable guess was that
  // the counter was wrong. It was not: the recorded rate IS the rate the app
  // managed to redraw a filtered picture. Measuring it and saying so beats
  // leaving someone to infer it from a file's properties in Photos.
  assert.match(main, /segmentFrames \+= 1;/, 'frames written must be counted');
  assert.match(main, /recordedFps = seconds > 0 \? frames \/ seconds : 0;/);
  assert.match(main, /fps: recordedFps,/, 'and stored on the clip');

  const described = lib.describeClip({
    id: 'a', startedAt: Date.now(), seconds: 7, bytes: 318_000,
    label: 'lens 548x732', savedAt: null, fps: 7.52
  });
  assert.match(described, /7\.5 fps/);
  // Clips recorded before this was measured simply do not claim a rate.
  const older = lib.describeClip({
    id: 'b', startedAt: Date.now(), seconds: 7, bytes: 318_000,
    label: 'lens', savedAt: null
  });
  assert.ok(!/fps/.test(older), 'an unmeasured clip must not invent a rate');
});

test('all three rates are shown while recording, and named apart', () => {
  // The camera delivers at one rate, the pipeline analyses at another, and the
  // recording gets a frame only when a picture is redrawn. Showing one number
  // called "Processing" was what made the other two look wrong.
  const tick = main.slice(main.indexOf('function tickRecording'), main.indexOf('function canShareFile'));
  assert.match(tick, /deliveredFps/);
  assert.match(tick, /processingFps/);
  assert.match(tick, /recording \$\{writtenFps\.toFixed\(1\)\} fps/);

  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /Three rates, and they are three different things/);
  // And it says where the lever is, since it is not in the recorder.
  assert.match(html, /cannot invent\s+frames the pipeline never drew/);
});

/* --- Recording detail ---------------------------------------------------- */

test('the render budget is raised only while recording', () => {
  // The screen's logical pixel count is the right budget for a PREVIEW —
  // drawing more than the screen can show costs frame rate and shows nothing,
  // which is the measurement that fixed the lag. It is the wrong budget for a
  // FILE, which is watched full screen long after the preview is gone.
  const fn = main.slice(main.indexOf('function renderPixelBudget'),
    main.indexOf('/** The width that produces this short side'));
  assert.match(fn, /const base = logicalScreenPixels\(\);/);
  assert.match(fn, /settings\.recordDetail === 'preview'\) return base;/);
  assert.match(fn, /return base \* 2;/, "'higher' should double the budget");
  assert.match(fn, /Number\.POSITIVE_INFINITY/, "'full' should remove the cap");
  // Not while merely idle: the preview must be unaffected when nothing is
  // being recorded.
  assert.match(fn, /!rolling\.recording && !armingDetail/);
});

test('the bigger render lands before the recorder captures the canvas', () => {
  // Raising the budget only changes what the NEXT analysed frame renders at,
  // and a heavy filter analyses a few times a second. Capturing first would
  // record the preview's size and quietly ignore the setting.
  const fn = main.slice(main.indexOf('async function awaitRecordDetail'),
    main.indexOf('const source = recordSource();'));
  assert.match(fn, /armingDetail = true;/);
  assert.match(fn, /lastDisplayMeasure = 0;/, 'the memoised size is stale the moment the budget changes');
  assert.match(fn, /visionCanvas\.width !== was/);
  // And it gives up rather than refusing to record.
  assert.match(fn, /Timed out: record anyway/);
});

test('what the choice costs is stated in numbers, not adjectives', () => {
  // "Higher" and "full" both mean more pixels per frame, and pixels per frame
  // is exactly what the frame rate is spent on.
  const fn = main.slice(main.indexOf('function syncRecordDetailNote'), main.indexOf('function syncRecordButton'));
  assert.match(fn, /devicePixelRatio \|\| 1\) \*\* 2/, 'full costs the pixel ratio squared');
  assert.match(fn, /the frame rate to fall by roughly the same factor/);
  // The control follows the stored choice, so a reload cannot show one thing
  // and record another.
  assert.match(fn, /control\.value = settings\.recordDetail/);

  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="recordDetail"/);
  for (const value of ['preview', 'higher', 'full']) {
    assert.match(html, new RegExp(`value="${value}"`));
  }
  // Default is the preview's own size: a setting that costs frame rate should
  // be chosen, not inherited.
  assert.match(main, /recordDetail: 'preview',/);
});

/* --- Recording by taking stills ------------------------------------------ */

test('a recording can be made of full-resolution stills', () => {
  // Joshua: "why can't the recording basically keep taking stills of the video
  // feed?" It can — the still path already renders every mode it can re-derive
  // at the camera's own resolution, which is how Save Frame works.
  const loop = main.slice(main.indexOf('async function stillsRecordingLoop'),
    main.indexOf('/**\n * The surface to record'));
  assert.match(loop, /grabFullFrame\(width\)/);
  assert.match(loop, /renderStill\(visionMode, frame, stillsPrevious\)/);
  assert.match(loop, /stillsTrack\.requestFrame\?\.\(\)/);
  // Manual frames, so every frame in the file is one that was rendered rather
  // than a duplicate of a slow one.
  assert.match(main, /recordCanvas\.captureStream\(0\)/);
  // And it yields, or the interface is frozen for the whole recording.
  assert.match(loop, /setTimeout\(resolve, 0\)/);
  // The preview blit must not overwrite a still.
  assert.match(main, /if \(!stillsTrack\) blitRecordFrame\(\);/);
});

test('the modes that cannot be re-derived are refused, not faked', () => {
  // Trails, amplify, the learned background, chronochrome and slit scan
  // accumulate over time ON THE ANALYSIS FRAME. There is no full-resolution
  // history to redraw them from, so a "still" of one is the camera frame with
  // the filter missing — a large file of the wrong picture.
  const set = main.slice(main.indexOf('const STILL_RENDERABLE_MODES'),
    main.indexOf('const STILLS_MAX_SHORT_SIDE'));
  for (const mode of ['relief', 'edges', 'motion', 'difference', 'flow', 'speed', 'lens', 'night']) {
    assert.match(set, new RegExp(`'${mode}'`), `${mode} can be re-derived at full size`);
  }
  for (const mode of ['motiontrails', 'amplify', 'background', 'chrono', 'slitscan']) {
    assert.ok(!new RegExp(`'${mode}'`).test(set), `${mode} cannot be, and must not be offered`);
  }
  // And the interface says which it is, rather than silently recording small.
  assert.match(main, /accumulates over frames on the analysis picture/);
});

test('the frame size stays inside what an H.264 encoder accepts', () => {
  // H.264 levels are specified in macroblocks and top out near 36,864 — about
  // 8.3 MP. A 3024x4032 sensor frame is 47,628, which no level allows.
  const cap = Number(/const STILLS_MAX_SHORT_SIDE = (\d+);/.exec(main)[1]);
  assert.ok(cap <= 2160, `${cap} on the short side asks the encoder for too much`);
  const macroblocks = (cap / 16) * ((cap * 16 / 9) / 16);
  assert.ok(macroblocks < 36864, `${Math.round(macroblocks)} macroblocks exceeds every level`);
});

test('what a recording actually did is reported, not inferred', () => {
  // Three different things decide the size, and "it is still 548x732" is
  // impossible to diagnose from outside without the app saying which applied.
  const fn = main.slice(main.indexOf('SAY WHAT WAS ACTUALLY DONE'), main.indexOf("a new clip every ${MAX_CLIP_SECONDS}s"));
  assert.match(fn, /full-resolution stills at/);
  assert.match(fn, /full-resolution version of it to save/);
  assert.match(fn, /scaled up to/);
});

/* --- The codec question -------------------------------------------------- */

test('the level-pinned candidate can be skipped, for an A/B', () => {
  // avc1.42E01E is Constrained Baseline LEVEL 3.0, whose frame ceiling is 1620
  // macroblocks. 548x732 is 35x46 = 1610 — ten short — and every larger
  // setting this app offers is over it. If an encoder honours the level it is
  // handed, that one string caps recordings at almost exactly the size that
  // kept appearing.
  const auto = fmt.candidatesFor('auto');
  const noLevel = fmt.candidatesFor('no-level');
  const browser = fmt.candidatesFor('default');
  assert.ok(auto.some((f) => /avc1\.42E01E/.test(f.mime)), 'auto keeps the shipped order');
  assert.ok(!noLevel.some((f) => /avc1\.[0-9a-f]{6}/i.test(f.mime)),
    'no-level must drop every codec-parameterised string');
  assert.ok(noLevel.some((f) => f.mime === 'video/mp4'), 'and keep plain MP4');
  assert.deepEqual(browser, [], 'default asks for nothing at all');

  // The switch changes what is offered, so the answer has to be re-asked.
  assert.match(main, /candidatesFor\(settings\.recordCodec\)/);
  assert.match(main, /settings\.recordCodec = \[/);
});

test('the macroblock arithmetic behind the suspicion', () => {
  // Level 3.0: MaxFS = 1620 macroblocks. Kept as a test because it is the
  // whole reason the switch above exists, and it is checkable.
  const mbs = (w, h) => Math.ceil(w / 16) * Math.ceil(h / 16);
  assert.equal(mbs(548, 732), 1610);
  assert.ok(mbs(548, 732) <= 1620, 'the size that keeps appearing just fits Level 3.0');
  for (const [w, h] of [[1033, 775], [1119, 1492], [1280, 720], [1920, 1080], [2880, 2160]]) {
    assert.ok(mbs(w, h) > 1620, `${w}x${h} exceeds Level 3.0 and would have to be refused or resized`);
  }
});

test('what the encoder actually wrote is measured, not assumed', () => {
  // Everything else in the app knows the size it ASKED for. Only the file
  // knows the size it got, and an encoder that downscales to fit the level it
  // was handed would be invisible to every other readout here.
  const fn = main.slice(main.indexOf('function measureEncodedSize'), main.indexOf('async function finishSegment'));
  assert.match(fn, /probe\.videoWidth, probe\.videoHeight/);
  assert.match(fn, /setTimeout\(\(\) => done/, 'a file that never reports metadata must not stall a recording');
  assert.match(main, /encodedWidth: encoded\.width \|\| undefined/);
  assert.match(main, /recorderMime: mediaRecorder\?\.mimeType/);
});

test('the diagnostic line carries every ceiling, including the camera stream', () => {
  // Five ceilings are in play and each is invisible from the others. The
  // camera stream is the one nobody had counted: Capture resolution defaults
  // to 1080 on the short side, so no recording can exceed that whatever the
  // recording detail says.
  const fn = main.slice(main.indexOf('function recordDiagnosticLine'), main.indexOf('function appendRecordLog'));
  for (const part of ['stream ', 'render ', 'canvas ', 'encoded ', 'asked ', 'detail ', 'codec ']) {
    assert.ok(fn.includes(part), `the line should carry "${part}"`);
  }
  assert.match(fn, /ENCODER RESIZED/, 'a downscale by the encoder must be called out');
  assert.match(main, /captureResolution: '1080'/, 'the default this line exists to expose');
});
