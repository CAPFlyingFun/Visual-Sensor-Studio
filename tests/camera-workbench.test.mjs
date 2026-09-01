import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

const camera = html.slice(html.indexOf('id="tab-camera"'), html.indexOf('id="tab-motion"'));
const head = camera.slice(camera.indexOf('class="workbench-head"'), camera.indexOf('class="tool-drawer"'));
const drawer = camera.slice(camera.indexOf('class="tool-drawer"'));

/*
 * These guard the CONTRACT the workbench rests on, not its appearance. The
 * layout is HTML and CSS only — no vision, sensor, camera, recording or
 * encoding code was touched — and that is only safe while every control is
 * still the element the app already looks up by id.
 */

test('no element the app looks up went missing or turned into a duplicate', () => {
  // The refactor MOVED elements. Moving is safe; renaming, duplicating or
  // recreating is not, because main.ts finds all of these by id.
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  const duplicates = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  assert.deepEqual(duplicates, [], 'a duplicate id makes getElementById return the wrong element');

  // A representative id from every part that moved.
  for (const id of [
    'visionStage', 'cameraVideo', 'visionCanvas', 'cameraOverlayButton', 'horizonLine',
    'zoomPresets', 'zoomSlider', 'zoomValue', 'captureStillButton', 'expandViewButton',
    'recordButton', 'recordElapsed', 'visionModeLabel', 'metricFps', 'metricZoom',
    'metricDelivered', 'metricObjects', 'metricBrightness', 'metricDropped',
    'displayDetailRow', 'motionPanel', 'layerPanel', 'nightPanel', 'lensPanel',
    'lensRow', 'manualRow', 'histogramCanvas', 'cameraButton', 'recordPanel',
    'gifButton', 'clipList', 'cameraMessage', 'cameraStage'
  ]) {
    assert.ok(ids.includes(id), `#${id} is gone`);
  }
});

test('all fourteen modes survive, grouped but unchanged', () => {
  // Grouping is a wrapper around the SAME buttons: same data-vision-mode, same
  // .segmented class, same .active handling in main.ts.
  const modes = [...camera.matchAll(/data-vision-mode="([a-z]+)"/g)].map((m) => m[1]);
  assert.equal(modes.length, 14, `expected 14 modes, found ${modes.length}`);
  assert.deepEqual([...new Set(modes)].length, 14, 'no mode may appear twice');

  const FAMILIES = {
    view: ['camera', 'relief', 'edges'],
    motion: ['motion', 'difference', 'flow', 'speed', 'motiontrails'],
    time: ['amplify', 'background', 'chrono', 'slitscan'],
    night: ['night'],
    custom: ['lens']
  };
  for (const [family, wanted] of Object.entries(FAMILIES)) {
    const start = camera.indexOf(`data-family="${family}"`);
    assert.ok(start > 0, `no row for the ${family} family`);
    const row = camera.slice(start, camera.indexOf('</div>', start));
    const found = [...row.matchAll(/data-vision-mode="([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(found, wanted, `the ${family} row holds the wrong modes`);
  }
});

test('the camera and its everyday controls are rows, not an overlay', () => {
  for (const id of ['visionStage', 'zoomSlider', 'captureStillButton', 'recordButton',
    'expandViewButton', 'visionModeLabel']) {
    assert.ok(head.includes(`id="${id}"`), `#${id} should be in the workbench head`);
  }

  // NOT STICKY, and structurally so. v0.39.0 made the head sticky and let the
  // page scroll under it; on the device the controls slid behind a large fixed
  // block and left a small window to hunt in. `display: contents` makes the
  // three head rows into rows of the workspace grid, so there is no box left to
  // give a position of its own.
  assert.ok(!/position:\s*sticky/.test(css), 'nothing in Camera Lab may be sticky');
  assert.match(css, /\.workbench-head \{ display: contents; \}/);

  // The workspace is the viewport, and the drawer takes what is left.
  assert.match(css, /\.app-shell \{[\s\S]{0,200}height: 100dvh;/);
  assert.match(css, /grid-template-rows: minmax\(\d+px, \d+%\) auto auto minmax\(0, 1fr\);/);
});

test('mode panels and clip management are in the drawer, below the controls', () => {
  for (const id of ['motionPanel', 'layerPanel', 'nightPanel', 'lensPanel', 'recordPanel',
    'histogramCanvas', 'manualRow', 'cameraButton']) {
    assert.ok(drawer.includes(`id="${id}"`), `#${id} should be in the tool drawer`);
  }
  // Starting a recording is easy; managing old clips is deeper.
  assert.ok(head.includes('id="recordButton"'));
  assert.ok(drawer.includes('id="clipList"'));
});

test('which family is showing is decided by CSS, not by a script', () => {
  // Five radios and :checked. Nothing to keep in sync, nothing to initialise,
  // and no state this stylesheet can lose.
  for (const family of ['view', 'motion', 'time', 'night', 'custom']) {
    assert.match(html, new RegExp(`id="fam-${family}"`));
    assert.match(css, new RegExp(`#fam-${family}:checked\\s+~ \\.mode-strip`));
  }
  assert.match(html, /id="fam-view"[^>]*checked/, 'one family has to start selected');
});

test('the family follows the app when the app changes the mode itself', () => {
  // The app restores the remembered mode at startup and a shared lens link
  // switches to Lens, so the chrome has to follow or it opens showing the wrong
  // family. It mirrors one way — reading the .active class the existing code
  // already sets — and lives in the page so that no application logic changed.
  const script = html.slice(html.indexOf('const FAMILY = {'));
  assert.match(script, /MutationObserver/);
  assert.match(script, /attributeFilter: \['class'\]/);
  assert.ok(!/updateVisionMode|\.click\(\)/.test(script.slice(0, 1600)),
    'the mirror must never set a mode');
});

test('the redesign did not touch application logic', () => {
  // The one thing that would turn a UI refactor into a rewrite.
  assert.ok(!main.includes('workbench-head'), 'main.ts should not know about the new chrome');
  assert.ok(!main.includes('mode-console'));
  assert.ok(!main.includes('fam-view'));
});

test('the tool drawer is the only scrolling surface in Camera Lab', () => {
  // One scroller. A drawer inside a scrolling page is the nested-scroll
  // arrangement that makes iOS momentum and rubber-banding fight each other.
  const drawer = css.slice(css.indexOf('.tool-drawer {'), css.indexOf('}', css.indexOf('.tool-drawer {')));
  assert.match(drawer, /overflow-y: auto;/);
  assert.match(drawer, /min-height: 0;/);
  assert.match(drawer, /-webkit-overflow-scrolling: touch;/);
  assert.match(drawer, /overscroll-behavior: contain;/);
  assert.match(drawer, /overflow-x: clip;/);
  assert.match(css, /body \{ overflow: hidden;/, 'the page itself must not scroll');
  assert.match(css, /text-size-adjust: 100%;/);
});

test('the dock sits under the full-screen viewer, not over it', () => {
  const dock = css.slice(css.indexOf('.tabbar {'), css.indexOf('}', css.indexOf('.tabbar {')));
  assert.match(dock, /position: fixed/);
  const z = Number(/z-index: (\d+)/.exec(dock)[1]);
  const viewer = css.slice(css.indexOf('.viewer {'), css.indexOf('}', css.indexOf('.viewer {')));
  assert.ok(z < Number(/z-index: (\d+)/.exec(viewer)[1]), 'the dock must not cover the viewer');
  // And the page has to end above the dock, or the last control is unreachable.
  // The shell reserves exactly the dock's height. A guessed 96px against a dock
  // that measures 55 wasted 41px of the workspace.
  assert.match(css, /--dock-height: calc\(\d+px \+ env\(safe-area-inset-bottom\)\);/);
  assert.match(css, /padding-bottom: var\(--dock-height\);/);
});
