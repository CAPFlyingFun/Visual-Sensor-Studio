import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const htmlSource = readFileSync(new URL('../public/legacy.html', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

test('RGB full screen shows the camera, it does not repaint it', () => {
  // Joshua: "RGB small size has no lag, full screen yes." The panel hides the
  // vision canvas in RGB and lets the video element show through, so the
  // browser composites at the camera's own rate and none of our code runs per
  // frame. Full screen had no video element, so the same mode was blitted
  // through our loop and inherited its rate — about 8fps on his device.
  assert.match(htmlSource, /<video id="viewerVideo"[^>]*playsinline[^>]*hidden>/);
  assert.match(mainSource, /function presentViewerVideo\(\): boolean/);
  assert.match(mainSource, /const wanted = viewerOpen && visionCanvas\.hidden;/);
  // And when it is carrying the picture, painting must be skipped entirely.
  assert.match(mainSource, /if \(presentViewerVideo\(\)\) \{\s*\n\s*renderViewerBadges\(\);\s*\n\s*return;/);
});

test('the stage is handed over only once frames are arriving', () => {
  // A browser that dislikes two elements on one MediaStream must degrade to
  // the old blit, not to a black screen.
  assert.match(mainSource, /const live = viewerVideo\.videoWidth > 0 && viewerVideo\.readyState >= 2;/);
  assert.match(mainSource, /viewerVideo\.hidden = !live;/);
  assert.match(mainSource, /canvas\.hidden = live;/);
});

test('closing the viewer releases the stream from the second element', () => {
  // paintViewer returns early once the viewer is closed, so its own cleanup
  // never runs; a second element left holding the stream is a decoder still
  // being fed for a picture nobody can see.
  assert.match(mainSource, /if \(!open\) presentViewerVideo\(\);/);
  assert.match(mainSource, /viewerVideo\.srcObject = null;/);
});

test('a filter still goes through the canvas', () => {
  // A filter's picture only exists because we computed it, so it has no video
  // to fall back on. This is also why no filter can feel like RGB in the
  // panel: that is the one mode which never touches our code.
  const fn = mainSource.slice(
    mainSource.indexOf('function presentViewerVideo'),
    mainSource.indexOf('function paintViewer')
  );
  assert.match(fn, /if \(!wanted\) \{/);
  assert.match(fn, /canvas\.hidden = false;\s*\n\s*return false;/);
});

test('the video scales like the canvas, fit toggle included', () => {
  // Without this the video sits at its intrinsic size in the middle of a black
  // screen — the same bug the canvas rule was written for.
  assert.match(cssSource, /\.viewer-stage canvas,\s*\n\.viewer-stage video \{/);
  assert.match(cssSource, /\.viewer\[data-fit="fill"\] \.viewer-stage video \{ object-fit: cover; \}/);
});

test('the viewer canvas is bounded by the screen, never by the sensor', () => {
  // Before this the canvas was sized to video.videoWidth: a 3024x4032 capture
  // meant a 48MB backing store and a 12MP copy per frame to fill a 430x932pt
  // window. A filter arrives already bounded, so only RGB changes.
  assert.match(mainSource, /const capped = budgetedShortSide\(\s*\n\s*sourceShort,/);
  assert.doesNotMatch(mainSource, /const width = visionCanvas\.hidden \? video\.videoWidth/);
});

test('the capture canvas is not reset on every frame', () => {
  // Assigning to canvas.width or .height resets the backing store and clears
  // the bitmap EVEN WHEN THE VALUE IS UNCHANGED — that is what the setter
  // does, not an optimisation a browser may skip. Measured: the bitmap really
  // is cleared by a same-value assign.
  const fn = mainSource.slice(
    mainSource.indexOf('function grabFullFrame'),
    mainSource.indexOf('function grabFullFrame') + 2000
  );
  assert.match(fn, /if \(stillCanvas\.width !== width\) stillCanvas\.width = width;/);
  assert.match(fn, /if \(stillCanvas\.height !== height\) stillCanvas\.height = height;/);
});
