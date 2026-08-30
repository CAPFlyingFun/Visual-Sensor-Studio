import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectTracker, findBlobs } from '../.test-build/vision/tracking.js';

const W = 64;
const H = 48;

/** A motion mask with filled rectangles. */
function mask(rects) {
  const m = new Uint8ClampedArray(W * H);
  for (const { x, y, w, h, v = 255 } of rects) {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const px = Math.round(x) + dx;
        const py = Math.round(y) + dy;
        if (px >= 0 && px < W && py >= 0 && py < H) m[py * W + px] = v;
      }
    }
  }
  return m;
}

test('findBlobs isolates separate regions', () => {
  const blobs = findBlobs(mask([
    { x: 5, y: 5, w: 6, h: 6 },
    { x: 40, y: 30, w: 8, h: 4 }
  ]), W, H);
  assert.equal(blobs.length, 2);
  const sorted = [...blobs].sort((a, b) => a.centerX - b.centerX);
  assert.ok(Math.abs(sorted[0].centerX - 7.5) < 1);
  assert.equal(sorted[0].area, 36);
  assert.equal(sorted[1].area, 32);
  assert.equal(sorted[1].maxX - sorted[1].minX + 1, 8);
});

test('regions touching only at a diagonal stay separate', () => {
  // Four-connectivity: a corner touch is usually noise, not one object.
  const blobs = findBlobs(mask([
    { x: 10, y: 10, w: 3, h: 3 },
    { x: 13, y: 13, w: 3, h: 3 }
  ]), W, H, { minBlobArea: 4 });
  assert.equal(blobs.length, 2);
});

test('sub-threshold and tiny regions are rejected as noise', () => {
  assert.equal(findBlobs(mask([{ x: 5, y: 5, w: 6, h: 6, v: 10 }]), W, H, { threshold: 26 }).length, 0);
  assert.equal(findBlobs(mask([{ x: 5, y: 5, w: 1, h: 1 }]), W, H, { minBlobArea: 6 }).length, 0);
});

test('a large region does not overflow the fill stack', () => {
  // An iterative fill is required: a recursive one dies on a big region,
  // which is exactly when the tracker matters most.
  const blobs = findBlobs(mask([{ x: 0, y: 0, w: W, h: H }]), W, H);
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0].area, W * H);
});

test('a moving object keeps one id and reports plausible speed', () => {
  const tracker = new ObjectTracker();
  let now = 0;
  // 4 px per 100 ms step = 40 px/sec.
  for (let step = 0; step < 10; step++) {
    tracker.update(mask([{ x: 5 + step * 4, y: 20, w: 6, h: 6 }]), W, H, now);
    now += 100;
  }
  const objects = tracker.objects;
  assert.equal(objects.length, 1, 'one object must remain one track');
  assert.equal(objects[0].id, 1, 'the id must be stable across frames');
  assert.ok(Math.abs(objects[0].speedPxPerSec - 40) < 12, `speed ${objects[0].speedPxPerSec}`);
  // Moving right: direction near 0 degrees.
  assert.ok(Math.abs(objects[0].directionDeg) < 20, `direction ${objects[0].directionDeg}`);
  assert.ok(objects[0].confidence > 0.6);
  assert.ok(objects[0].ageSec > 0.8);
});

test('two objects get separate ids and separate trails', () => {
  const tracker = new ObjectTracker();
  let now = 0;
  for (let step = 0; step < 6; step++) {
    tracker.update(mask([
      { x: 4 + step * 3, y: 8, w: 5, h: 5 },
      { x: 50 - step * 3, y: 34, w: 5, h: 5 }
    ]), W, H, now);
    now += 100;
  }
  const objects = tracker.objects;
  assert.equal(objects.length, 2);
  assert.notEqual(objects[0].id, objects[1].id);
  // One travels right, the other left.
  const directions = objects.map((o) => Math.abs(o.directionDeg) < 90).sort();
  assert.deepEqual(directions, [false, true]);
  for (const object of objects) assert.ok(object.trail.length > 1);
});

test('a track survives a brief disappearance without changing id', () => {
  const tracker = new ObjectTracker();
  let now = 0;
  for (let step = 0; step < 5; step++) {
    tracker.update(mask([{ x: 5 + step * 4, y: 20, w: 6, h: 6 }]), W, H, now);
    now += 100;
  }
  const id = tracker.objects[0].id;
  // Occluded for two updates.
  tracker.update(mask([]), W, H, now); now += 100;
  tracker.update(mask([]), W, H, now); now += 100;
  assert.equal(tracker.objects.length, 1, 'a brief occlusion must not drop the track');
  // Reappears where the velocity predicted.
  tracker.update(mask([{ x: 5 + 7 * 4, y: 20, w: 6, h: 6 }]), W, H, now);
  assert.equal(tracker.objects[0].id, id, 'the id must survive the occlusion');
});

test('a track is dropped once it stays missing', () => {
  const tracker = new ObjectTracker({ maxMissedFrames: 3 });
  let now = 0;
  for (let step = 0; step < 5; step++) {
    tracker.update(mask([{ x: 5 + step * 4, y: 20, w: 6, h: 6 }]), W, H, now);
    now += 100;
  }
  for (let i = 0; i < 12; i++) {
    tracker.update(mask([]), W, H, now);
    now += 100;
  }
  assert.equal(tracker.objects.length, 0, 'a vanished object must eventually be dropped');
});

test('trails are bounded so history cannot grow without limit', () => {
  const tracker = new ObjectTracker({ trailLength: 8 });
  let now = 0;
  for (let step = 0; step < 40; step++) {
    tracker.update(mask([{ x: 5 + (step % 10) * 3, y: 20, w: 5, h: 5 }]), W, H, now);
    now += 50;
  }
  for (const object of tracker.objects) {
    assert.ok(object.trail.length <= 8, `trail grew to ${object.trail.length}`);
  }
});

test('the number of simultaneous tracks is capped', () => {
  const tracker = new ObjectTracker({ maxObjects: 3, minBlobArea: 4 });
  const rects = [];
  for (let i = 0; i < 10; i++) rects.push({ x: 2 + i * 6, y: 5, w: 4, h: 4 });
  tracker.update(mask(rects), W, H, 0);
  assert.ok(tracker.objects.length <= 3, `got ${tracker.objects.length} tracks`);
});

test('fastestSpeed reports the quickest current track', () => {
  const tracker = new ObjectTracker();
  let now = 0;
  for (let step = 0; step < 8; step++) {
    tracker.update(mask([
      { x: 2 + step * 1, y: 8, w: 5, h: 5 },
      { x: 20 + step * 5, y: 34, w: 5, h: 5 }
    ]), W, H, now);
    now += 100;
  }
  assert.ok(tracker.fastestSpeed > 30, `fastest ${tracker.fastestSpeed}`);
});

test('speed is derived from elapsed time, not from a frame count', () => {
  // The analysis rate is adaptive, so frames are not evenly spaced. The same
  // travel over twice the time must read as half the speed.
  const quick = new ObjectTracker();
  const slow = new ObjectTracker();
  let a = 0;
  let b = 0;
  for (let step = 0; step < 8; step++) {
    quick.update(mask([{ x: 5 + step * 4, y: 20, w: 6, h: 6 }]), W, H, a);
    slow.update(mask([{ x: 5 + step * 4, y: 20, w: 6, h: 6 }]), W, H, b);
    a += 100;
    b += 200;
  }
  const ratio = quick.objects[0].speedPxPerSec / slow.objects[0].speedPxPerSec;
  assert.ok(Math.abs(ratio - 2) < 0.35, `expected a 2x ratio, got ${ratio}`);
});
