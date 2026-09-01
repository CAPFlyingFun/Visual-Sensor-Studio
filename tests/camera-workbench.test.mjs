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

test('the camera and its everyday controls are one block that stays put', () => {
  // The requirement the whole redesign exists for: the picture stays visible
  // while the controls are used.
  for (const id of ['visionStage', 'zoomSlider', 'captureStillButton', 'recordButton',
    'expandViewButton', 'mode-console'.replace('mode-console', 'visionModeLabel')]) {
    assert.ok(head.includes(`id="${id}"`), `#${id} should be in the workbench head`);
  }
  assert.match(css, /\.workbench-head \{[\s\S]{0,200}position: sticky;/);

  // And this is the line that makes sticky work: .panel sets overflow:hidden,
  // which makes the panel a scroll container and pins the head to a box that
  // never scrolls. Measured before the fix: scrolling 900px on a 430x932 screen
  // put the picture 518px above the top of the screen.
  assert.match(css, /\.vision-panel \{ overflow: clip; \}/);
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

test('nothing in the camera tab can widen the page', () => {
  // The failure this project has already shipped once: one oversized element
  // set the document's width and mobile Safari rescaled the whole app.
  assert.match(css, /\.tool-drawer \{[\s\S]{0,120}overflow-x: clip;/);
  assert.match(css, /\.tab-panel \{ min-width: 0; overflow-x: clip; \}/);
  assert.match(css, /text-size-adjust: 100%;/);
});

test('the dock sits under the full-screen viewer, not over it', () => {
  const dock = css.slice(css.indexOf('.tabbar {'), css.indexOf('}', css.indexOf('.tabbar {')));
  assert.match(dock, /position: fixed/);
  const z = Number(/z-index: (\d+)/.exec(dock)[1]);
  const viewer = css.slice(css.indexOf('.viewer {'), css.indexOf('}', css.indexOf('.viewer {')));
  assert.ok(z < Number(/z-index: (\d+)/.exec(viewer)[1]), 'the dock must not cover the viewer');
  // And the page has to end above the dock, or the last control is unreachable.
  assert.match(css, /\.app-shell \{ padding-bottom: calc\(96px \+ env\(safe-area-inset-bottom\)\); \}/);
});
