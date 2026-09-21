import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/*
 * THE IMPORT EDITOR — an imported picture is held on the SAME screen a
 * capture is.
 *
 * Joshua, 2026-09-20: "change the import options so you can apply filters to
 * photos or enhance it". They always could; the controls were nowhere near
 * the picture. The filter strip sits at the top of the Camera tab and Import
 * at the bottom, so choosing a lens scrolled the picture off the screen.
 *
 * The answer is the editor that already exists rather than a second one
 * beside the import: a held frame, its own census, the capture re-run on
 * every change, and the real file on screen.
 */

const app = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function body(source, start, from = app) {
  const at = from.indexOf(start);
  assert.ok(at > -1, `${start} exists`);
  const rest = from.slice(at);
  return rest.slice(0, rest.indexOf('\n}\n'));
}

test('one review, two kinds of picture', () => {
  assert.match(app, /kind: 'shot' \| 'import'/);
  // The words are the ONLY thing that differs: you cannot retake a picture
  // the camera never took.
  assert.match(app, /shot: \{ drop: 'Retake', keep: 'Keep' \}/);
  assert.match(app, /import: \{ drop: 'Discard', keep: 'Done' \}/);
  // And there is exactly one re-render routine serving both.
  assert.equal((app.match(/async function refreshReview\(/g) ?? []).length, 1);
  assert.equal((app.match(/function openReview\(/g) ?? []).length, 1);
});

test('an import is held with ITS OWN census and its own full size', () => {
  const open = body(app, 'async function openImportReview()');
  assert.match(open, /const census = importExposure \?\? emptyExposure\(\)/,
    'the picture measured against itself, never the camera');
  assert.match(open, /lumaRange: census\.range/);
  assert.match(open, /background: census\.mode/);
  // The phrase moved into importReason() when a picture too big for the GPU
  // began being brought down to what it carries — because at that point
  // "at its own full size" is not always true, and a readout that said it
  // anyway would be describing a file that does not exist.
  assert.match(open, /reason: importReason\(\)/);
  const reason = body(app, 'function importReason()');
  assert.match(reason, /'an imported picture at its own full size'/,
    'and it still says exactly that when nothing was given up');
  assert.match(reason, /brought down to what this GPU carries/,
    'and says so plainly when something was');
  assert.match(open, /still: null/, 'no file yet — refreshReview makes the first one');
  // THE PICTURE ITSELF, not a decode of it. Decoding a second copy cost
  // another 128 MB on a 36 MP photograph, standing beside the GL canvas, the
  // encoder's copy-out and the picture, at the moment the encoder wanted
  // room — and unlike a camera frame there is nothing to preserve, because
  // an opened picture does not move on the way a live stream does.
  assert.match(open, /negative: image/);
  assert.ok(!/createImageBitmap\(image\)/.test(open),
    'the opened picture is not decoded a second time');
});

test('the import editor declines rather than half-works', () => {
  const open = body(app, 'async function openImportReview()');
  // No createImageBitmap, a size that will not resolve, a bitmap the GPU
  // refuses: the inline canvas under the Import section is still there and
  // still saveable, so the editor is a better road, never the only one.
  assert.match(open, /typeof createImageBitmap !== 'function'\) return/);
  assert.match(open, /if \(!size\) return/);
  // NOTHING IS RELEASED HERE ANY MORE, and that is the correct shape rather
  // than a leak: the frame handed to the review IS the opened picture, which
  // the import owns and clearImport lets go. Closing it here would take the
  // panel's picture away along with the review.
  assert.ok(!/negative\.close\(\)/.test(open),
    'an import does not close a frame it does not own');
  const release = body(app, 'function releaseHeld()');
  assert.match(release, /frame instanceof ImageBitmap/,
    'and only a capture\'s own bitmap is ever closed');
});

test('a held frame is ONE frame, so a sequence filter is refused', () => {
  // The same condition importRefusal already describes — reused rather than
  // given a second opinion.
  const refusal = body(app, 'function heldRefusal(');
  assert.match(refusal, /return importRefusal\(filterId\)/);
  assert.match(refusal, /supportsPhoto \?\? true/,
    'and a filter that declines stills declines this one too');
  // Refused BEFORE the held file is touched.
  // refreshReview renders the PREVIEW now and leaves the encode to a timer,
  // so the thing the refusal must come before is the render.
  const refresh = body(app, 'async function refreshReview()');
  const guard = refresh.indexOf('const refusal = heldRefusal(');
  assert.ok(guard > -1 && guard < refresh.indexOf('renderStill('),
    'the refusal is checked before anything is re-rendered');
  assert.match(refresh, /if \(refusal\) \{\s*\n\s*reviewText\('v2ReviewNote', refusal\);\s*\n\s*return;/,
    'and the held file is left exactly as it was');
});

test('the review strip disables what a single frame cannot feed', () => {
  const sync = body(app, 'function syncStrip(');
  assert.match(sync, /strip\.id === 'v2ReviewFilters' && held !== null/);
  assert.match(sync, /button\.disabled = rec \|\| \(single && heldRefusal\(id\) !== ''\)/,
    'an unavailable action must never look functional');
  // ONE definition of a button's state, used for both strips.
  const render = body(app, 'function renderFilterStrip()');
  assert.match(render, /for \(const strip of filterHolders\(\)\) syncStrip\(/);
  assert.match(render, /\|\$\{held \? 'held' : '-'\}`/,
    'and the throttled key moves when a picture is taken up or let go');
});

test('the review strip is right even when the preview loop is not running', () => {
  // renderFilterStrip runs from the PREVIEW LOOP. Open the app, decline the
  // camera, import a photograph, and that loop never runs — so leaving the
  // disabling to it left Speed and Trails tappable on a single frame. A
  // browser caught this; every static assertion above it passed.
  const open = body(app, 'function openReview(');
  assert.match(open, /syncReviewStrip\(\)/, 'the review syncs its own strip when it opens');
  const hide = body(app, 'function hideReviewLayer()');
  assert.match(hide, /syncReviewStrip\(\)/, 'and again when it closes, so the strip comes back');
  // And it does so through the SAME function the loop uses.
  const sync = body(app, 'function syncReviewStrip()');
  assert.match(sync, /syncStrip\(strip, readState\(\)\.activeFilter/);
});

test('two filter strips, one definition of a filter button', () => {
  assert.match(app, /const FILTER_HOLDERS = \['v2FilterStrip', 'v2ReviewFilters'\]/);
  assert.match(app, /function filterButton\(/);
  // Both builders go through it: no third copy of a button's shape or its tap.
  const built = body(app, 'function buildFilterStrip()');
  assert.match(built, /strip\.appendChild\(filterButton\(/);
  const lenses = body(app, 'function rebuildLensEntries()');
  assert.match(lenses, /strip\.appendChild\(filterButton\(/);
  assert.equal((app.match(/updateState\(\{ activeFilter: id \}\)/g) ?? []).length, 1,
    'exactly one place sets the active filter from a strip tap');
});

test('changing the filter re-renders a held picture', () => {
  const button = body(app, 'function filterButton(');
  assert.match(button, /if \(held\) void refreshReview\(\);\s*\n\s*else renderPreview/,
    'a held picture is re-rendered, not merely re-previewed behind the layer');
  assert.match(button, /showToast\(unavailableReason\)/,
    'and an unavailable lens still explains itself rather than choosing');
});

test('Custom + is not offered where it could not work', () => {
  // It opens the lens workbench, which lives on the page UNDER the review.
  const lenses = body(app, 'function rebuildLensEntries()');
  assert.match(lenses, /if \(strip\.id === 'v2ReviewFilters'\) continue;/);
});

test('discarding an imported picture lets the picture go, without a loop', () => {
  const close = body(app, 'function closeReview(');
  assert.match(close, /if \(!keep && kind === 'import'\) clearImport\(\)/);
  // releaseHeld runs FIRST, so clearImport sees no held import and cannot
  // call back into closeReview.
  assert.ok(close.indexOf('releaseHeld()') < close.indexOf('clearImport()'));
  const clear = body(app, 'function clearImport()');
  assert.match(clear, /if \(held\?\.kind === 'import'\) \{\s*\n\s*releaseHeld\(\);\s*\n\s*hideReviewLayer\(\);/);
  // The CALL, not the word: the comment in there explains why there isn't one.
  const code = clear.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/closeReview\(/.test(code), 'clearImport never calls back into closeReview');
  // And the discard line does not claim anything happened to the original.
  assert.match(app, /the picture you chose is untouched/);
});

test('the markup carries the review strip', () => {
  assert.ok(html.includes('id="v2ReviewFilters"'));
  assert.match(html, /\.review-filters \.filter \{ flex: 0 0 64px/,
    'shorter than the page strip — on the review the picture is the point');
});
