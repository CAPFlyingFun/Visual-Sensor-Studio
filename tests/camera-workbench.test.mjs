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

test('only the picture is pinned, and it can pin for the whole panel', () => {
  for (const id of ['visionStage', 'zoomSlider', 'captureStillButton', 'recordButton',
    'expandViewButton', 'visionModeLabel']) {
    assert.ok(head.includes(`id="${id}"`), `#${id} should be in the workbench head`);
  }

  // Two layouts were rejected on the device for the same reason: too much was
  // fixed in place. v0.39.0 pinned the whole head and the controls slid behind
  // it; v0.39.2's fixed workspace left "a small window to scroll" and a preview
  // too small to see. So the page scrolls and the ONLY sticky element is the
  // viewfinder.
  const sticky = [...css.matchAll(/([^{}]+)\{[^}]*position:\s*sticky/g)].map((m) => m[1].trim());
  assert.deepEqual(sticky, ['.vision-stage'],
    `only the viewfinder may be sticky, found: ${sticky.join(', ')}`);

  // A sticky element is confined to its containing block. While the head was a
  // real box the picture pinned only until that box had scrolled past —
  // measured, it left the screen 342px up — so the wrapper contributes no box.
  assert.match(css, /\.workbench-head \{ display: contents; \}/);

  // And this is what a sticky descendant needs from its ancestors:
  // `overflow: hidden` would make the panel a scroll container and pin the
  // picture to a box that never scrolls.
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

test('the drawer is grouping, not a scroll container', () => {
  // The page scrolls. A scroller inside a scrolling page is what makes iOS
  // momentum and rubber-banding fight each other, and the fixed-height version
  // of this drawer was the layout Joshua rejected.
  const drawer = css.slice(css.indexOf('.tool-drawer {'), css.indexOf('}', css.indexOf('.tool-drawer {')));
  assert.ok(!/overflow-y:\s*auto/.test(drawer), 'the drawer must not be its own scroller');
  assert.match(drawer, /overflow-x: clip;/);
  assert.ok(!/body \{ overflow: hidden;/.test(css), 'the page has to scroll');
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
