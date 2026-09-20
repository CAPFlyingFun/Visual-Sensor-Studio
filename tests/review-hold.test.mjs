import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/*
 * THE REVIEW STEP — the shot held where it can be looked at.
 *
 * Joshua, 2026-09-20: "could add it after you take it and before you save
 * which holds to edit or save."
 *
 * What the hold DOES is measured in a browser (v2-geometry fires the real
 * shutter, changes a setting on the held shot and retakes it). What is
 * checked here is the wiring that makes that possible at all: a still can be
 * rendered from a held frame as well as a live one, both clarity rows drive
 * one setting, and the markup carries every id the code reaches for.
 */

const app = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');
const photo = readFileSync(new URL('../src/v2/capture/photo.ts', import.meta.url), 'utf8');
const renderer = readFileSync(
  new URL('../src/v2/render/gl-renderer.ts', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('a still can be rendered from a held frame as well as a live one', () => {
  // ONE capture path, two sources. A separate "re-render for review" routine
  // would be a second definition of what saving a photo means, and the two
  // would disagree the first time either was edited (Rule 4).
  assert.match(photo, /export type StillSource = HTMLVideoElement \| ImageBitmap/);
  assert.match(photo, /uploadFrame\(source\)/, 'a live frame still goes through uploadFrame');
  assert.match(photo, /uploadHeld\(source\)/, 'a held frame goes through uploadHeld');
  assert.ok(!/capturePhoto\([^)]*video: HTMLVideoElement/s.test(photo),
    'capturePhoto no longer insists on a video element');
  // The dispatch must not name a DOM constructor: this module is imported by
  // tests in environments that do not have one, and instanceof would throw
  // there — a test-only failure wearing the costume of a camera one.
  assert.ok(!/instanceof HTMLVideoElement/.test(photo));
  assert.match(photo, /'videoWidth' in source/);
});

test('the held upload refuses a closed frame instead of drawing nothing', () => {
  const held = renderer.slice(renderer.indexOf('uploadHeld('));
  assert.match(held.slice(0, 400), /frame\.width === 0/,
    'a bitmap the review has already closed reports width 0, and must be refused');
  assert.match(held.slice(0, 600), /frameSize = \{ width: frame\.width, height: frame\.height \}/,
    'the frame size comes from the bitmap, never from a video property it lacks');
});

test('the negative is grabbed inside the escalated-stream window', () => {
  const shutter = app.slice(app.indexOf('async function takePhoto()'));
  const body = shutter.slice(0, shutter.indexOf('\n}\n'));
  const grab = body.indexOf('grabNegative(video)');
  const capture = body.indexOf('capturePhoto(renderer, video');
  const restore = body.indexOf('captureAtMaxStream');
  assert.ok(grab > restore, 'the grab happens inside the shutter callback');
  assert.ok(grab < capture && grab > 0,
    'the frame is held while the camera is still in its maximum mode — a frame '
    + 'taken after the restore is a different picture at a different size');
});

test('the review re-capture reuses the geometry the shutter held', () => {
  const refresh = app.slice(app.indexOf('async function refreshReview()'));
  const body = refresh.slice(0, refresh.indexOf('\n}\n'));
  assert.match(body, /capturePhoto\(\s*renderer, shot\.negative, readState\(\)\.activeFilter, shot\.photo/,
    'the held photo geometry, not a fresh resolve against the restored stream');
  assert.match(body, /lumaRange: shot\.lumaRange/);
  assert.match(body, /background: shot\.background/);
  assert.match(body, /clarity: clarityExtras\(\)/, 'at whatever clarity now says');
  assert.match(body, /run !== reviewRun \|\| held !== shot/,
    'a later change outranks an earlier one rather than racing it');
});

test('two rows of clarity buttons, one idea of what a level means', () => {
  assert.match(app, /const CLARITY_HOLDERS = \['v2ClarityRow', 'v2ReviewClarity'\]/);
  assert.match(app, /function setClarityLevel\(id: string\): void/);
  // Exactly one place writes the level, so the two rows cannot drift.
  const writes = app.match(/^\s*clarityLevel = /gm) ?? [];
  assert.equal(writes.length, 2,
    `clarityLevel is written by setClarityLevel and by the boot read only, got ${writes.length}`);
  assert.match(app, /if \(held\) void refreshReview\(\)/,
    'changing clarity with a shot held re-runs its capture');
});

test('the review never claims a file was written, and a retake means it', () => {
  assert.match(app, /stillLine\('Held —'/, 'the review says Held, never Saved');
  assert.match(app, /nothing has been written yet/);
  assert.match(app, /Retaken — that photo was never written anywhere\./);
  // A retake that left the Captures card's Share button live would be handing
  // back the picture it just said was gone.
  const close = app.slice(app.indexOf('function closeReview('));
  assert.match(close.slice(0, close.indexOf('\n}\n')),
    /byId<HTMLButtonElement>\('v2SharePhoto'\)\.hidden = true/);
});

test('one formatter for the capture line, so the card and the review agree', () => {
  assert.match(app, /function stillLine\(verb: string, still: PhotoResult, tail = ''\)/);
  // Three callers, one formatter: the shutter, the review, and the Captures
  // card after the review is let go. Two copies would have drifted the first
  // time a field was added to the readout.
  const callers = app.match(/stillLine\('/g) ?? [];
  assert.equal(callers.length, 3, `stillLine has three callers, got ${callers.length}`);
  assert.match(app, /stillLine\('Saved', still, tail\)\}\$\{reviewing/, 'the shutter');
  assert.match(app, /setText\('v2PhotoResult', stillLine\('Saved', still, tail\)\)/, 'the card');
  // The shutter's own four-field line is spelled out nowhere else. Night and
  // Import carry DIFFERENT fields on purpose, so they are not copies of it:
  // neither reports a measured quality, and that is what this pins.
  for (const line of app.match(/`Saved \$\{still\.width\}[^;]*/g) ?? []) {
    assert.ok(!line.includes('describeQuality'),
      `a second copy of the shutter's line: ${line.slice(0, 80)}`);
  }
});

test('every element the review reaches for exists in the markup', () => {
  for (const id of ['v2Review', 'v2ReviewNote', 'v2ReviewCanvas', 'v2ReviewClarity',
    'v2ReviewRetake', 'v2ReviewKeep', 'v2ReviewSave', 'v2ReviewHold']) {
    assert.ok(html.includes(`id="${id}"`), `${id} is in index.html`);
  }
  // getElementById throughout, never byId: a fresh app.js booting against a
  // cached older index.html must cost the review and nothing else.
  const block = app.slice(app.indexOf('/* --- THE REVIEW'), app.indexOf('let capturing = false;'));
  assert.ok(!/\bbyId\(['"]v2Review/.test(block) && !/byId<[^>]*>\('v2Review/.test(block),
    'the review section reads its own markup defensively');
  assert.match(block, /function reviewEl<T extends HTMLElement>/);
});

test('the hold is a setting, because it costs time at the shutter', () => {
  assert.match(app, /const REVIEW_STORE_KEY = 'vss\.v2\.reviewHold\.v1'/);
  assert.match(app, /localStorage\.getItem\(REVIEW_STORE_KEY\) !== 'no'/,
    'held by default — the unset device gets the review');
  assert.match(app, /if \(reviewHold\) shot\.negative = await grabNegative\(video\)/,
    'and nothing is copied at all when it is off');
  assert.match(app, /if \(!reviewHold && held\) closeReview\(false\)/,
    'turning the hold off must not strand a shot behind a layer nothing reopens');
});

test('the review layer sits above the full-screen viewer', () => {
  // The shutter fires from the viewer and from the ordinary page alike; a
  // review under the viewer would be a camera that holds your shot on some
  // days and not others.
  const css = html.slice(html.indexOf('.review {'), html.indexOf('.review[hidden]'));
  assert.match(css, /position: fixed; inset: 0; z-index: 80/);
  const viewer = html.slice(html.indexOf('\n    .viewer {'));
  assert.match(viewer.slice(0, 200), /z-index: 61/, 'and the viewer is still 61');
  assert.match(html, /\.review\[hidden\] \{ display: none; \}/,
    'display:flex would otherwise beat the hidden attribute');
});
