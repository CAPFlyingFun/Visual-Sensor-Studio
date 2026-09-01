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
  assert.ok(thirty > 5e6 && thirty < 80e6, `${thirty} bytes is not a plausible clip`);
  // Bit rate follows the frame size rather than being one constant.
  assert.ok(fmt.suggestedBitrate(640, 480, 30) < rate);
  // And it is bounded at both ends, so a huge or tiny frame cannot ask for an
  // absurd rate.
  assert.ok(fmt.suggestedBitrate(8000, 6000, 60) <= 12_000_000);
  assert.ok(fmt.suggestedBitrate(64, 64, 1) >= 800_000);
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
  assert.match(fn, /visionCanvas\.captureStream/);
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
  assert.match(tail, /^[\s\S]*detectClipFormat\(\);\nsyncRecordButton\(\);\nsyncGifEstimate\(\);\nvoid renderClips\(\)/m);
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
