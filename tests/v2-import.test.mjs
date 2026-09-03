import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_IMPORT_PIXELS, describeImport, importFailed, stillCapable
} from '../.test-build/v2/capture/import-media.js';
import { FILTERS, filterById } from '../.test-build/v2/filters/registry.js';

/*
 * Imported pictures: the same filters over a file instead of the camera.
 * The interesting part is not the decode — it is being straight about what
 * the file already lost, and about which filters a single frame can honestly
 * feed at all.
 */

const still = (over = {}) => ({
  bitmap: null, width: 4032, height: 3024,
  fileName: 'IMG_0001.JPG', bytes: 7.35e6, type: 'image/jpeg', ...over
});

test('a single still has no past, so the temporal filters are declined', () => {
  // ChatGPT put the distinction exactly right and Joshua kept it: Relief is
  // per-pixel and renders honestly from one frame; Age and Novelty are
  // temporal and their meaning depends on live history. A filter measuring
  // CHANGE, handed one frame, renders a confident-looking field measuring
  // nothing — which is the one failure this whole module exists to prevent.
  for (const id of ['speed', 'trails', 'age', 'novelty', 'motion']) {
    const filter = filterById(id);
    if (!filter) continue;
    const verdict = stillCapable(filter);
    assert.equal(verdict.ok, false, `${id} cannot honestly render from one still`);
    assert.match(verdict.reason, /measures how the picture CHANGES/);
    assert.match(verdict.reason, /nothing at all|nothing before it/);
  }
});

test('a per-pixel filter renders from one frame exactly as honestly as from many', () => {
  for (const id of ['rgb', 'ironbow', 'edges']) {
    const filter = filterById(id);
    if (!filter) continue;
    assert.equal(stillCapable(filter).ok, true, `${id} is per-pixel`);
    assert.equal(stillCapable(filter).reason, '');
  }
});

test('the verdict is asked of the filter\'s declared nature, never an allow-list', () => {
  // Rule 10: capability metadata, not a list that drifts the moment a filter
  // is added. Every filter in the registry gets an answer, and every refusal
  // is explained by the filter's own `temporal` / `state` declaration.
  for (const filter of FILTERS) {
    const verdict = stillCapable(filter);
    assert.equal(typeof verdict.ok, 'boolean', `${filter.id} has a verdict`);
    if (!verdict.ok) {
      assert.ok(verdict.reason.length > 0, `${filter.id} says why not`);
      assert.ok(filter.temporal || filter.state || filter.unavailableReason,
        `${filter.id} is refused for a declared reason, not a hardcoded name`);
    }
  }
  // And a filter that is simply unavailable keeps its OWN reason rather than
  // being told it is temporal.
  const broken = { ...FILTERS[0], unavailableReason: 'no WebGL here' };
  assert.equal(stillCapable(broken).reason, 'no WebGL here');
});

test('the readout says what the file already lost', () => {
  // A filter cannot tell a JPEG's ringing from an edge that was really there,
  // and neither can the picture it draws. Saying so is the whole point.
  const jpeg = describeImport(still());
  assert.match(jpeg, /4032×3024/);
  assert.match(jpeg, /12\.2 MP/);
  assert.match(jpeg, /already compressed/);
  assert.match(jpeg, /amplify\s+them exactly as readily as real detail/);

  // A lossless format gets the opposite statement rather than the same
  // warning softened — they are different facts.
  const png = describeImport(still({ type: 'image/png' }));
  assert.match(png, /a lossless format/);
  assert.ok(!/already compressed/.test(png));

  // The reason an import can render bigger than the live path: no clock.
  assert.match(jpeg, /no live frame rate to keep up with/);
});

test('a refusal describes the browser or the size, never a fault in the file', () => {
  // Both failure modes here are about THIS decoder or THIS renderer. Telling
  // someone their photograph is broken when the browser simply cannot read
  // HEIC would be a different, and wrong, claim.
  assert.ok(MAX_IMPORT_PIXELS > 48e6, 'a 48 MP phone photo must go through');
  assert.equal(importFailed({ reason: 'x' }), true);
  assert.equal(importFailed(still()), false);
});
