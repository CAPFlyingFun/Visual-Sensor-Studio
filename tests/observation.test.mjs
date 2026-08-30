import test from 'node:test';
import assert from 'node:assert/strict';
import { EventDetector, degreesPerSecond } from '../.test-build/vision/observation.js';

const EPOCH = 1_700_000_000_000;

/** Drive the detector for a span, returning every update it produced. */
function run(detector, steps, thresholds) {
  const updates = [];
  let now = 0;
  for (const [fraction, speed, dt] of steps) {
    now += dt;
    updates.push(detector.update(fraction, speed, now, EPOCH + now, thresholds));
  }
  return updates;
}

const FAST = { startFraction: 0.01, endFraction: 0.005, minDurationMs: 100, quietMs: 300 };

test('a single noisy frame never opens an event', () => {
  // Otherwise an unattended overnight run fills up with sensor noise.
  const detector = new EventDetector();
  const updates = run(detector, [
    [0, 0, 33], [0.2, 0.5, 33], [0, 0, 33], [0, 0, 33]
  ], FAST);
  assert.ok(!updates.some((u) => u.started), 'one frame is not an event');
  assert.equal(detector.currentPhase, 'idle');
});

test('sustained motion opens an event and quiet closes it', () => {
  const detector = new EventDetector();
  const updates = run(detector, [
    [0, 0, 33],
    ...Array.from({ length: 8 }, () => [0.2, 0.4, 33]),
    ...Array.from({ length: 15 }, () => [0, 0, 33])
  ], FAST);

  const started = updates.filter((u) => u.started);
  const ended = updates.filter((u) => u.ended);
  assert.equal(started.length, 1, 'exactly one start');
  assert.equal(ended.length, 1, 'exactly one end');
  assert.ok(ended[0].completed);
  assert.ok(ended[0].completed.endedAt > ended[0].completed.startedAt);
});

test('a subject hovering at the threshold does not chatter', () => {
  // This is why the closing threshold is separate from the opening one. With a
  // single level, motion sitting right on it opens and closes every few frames.
  const detector = new EventDetector();
  const updates = run(detector, [
    ...Array.from({ length: 6 }, () => [0.02, 0.3, 33]),
    // Now oscillate between just above and just below the START threshold,
    // while staying above the END threshold throughout.
    ...Array.from({ length: 30 }, (_, i) => [i % 2 ? 0.012 : 0.008, 0.3, 33])
  ], FAST);

  assert.equal(updates.filter((u) => u.started).length, 1, 'one event, not many');
  assert.equal(updates.filter((u) => u.ended).length, 0, 'and it should not have closed');
});

test('an event records when it peaked, not merely how fast', () => {
  const detector = new EventDetector();
  const updates = run(detector, [
    ...Array.from({ length: 5 }, () => [0.2, 0.1, 33]),
    [0.2, 0.9, 33],
    ...Array.from({ length: 5 }, () => [0.2, 0.1, 33]),
    ...Array.from({ length: 15 }, () => [0, 0, 33])
  ], FAST);

  const done = updates.find((u) => u.ended).completed;
  assert.equal(done.peakWidthsPerSecond, 0.9);
  assert.ok(done.peakAt > done.startedAt, 'the peak came after the start');
  assert.ok(done.meanWidthsPerSecond < done.peakWidthsPerSecond, 'mean below peak');
  assert.ok(done.meanWidthsPerSecond > 0);
});

test('the quiet period used to detect the end is not counted as part of it', () => {
  // The event ended when the motion stopped, not when the detector noticed.
  const detector = new EventDetector();
  const updates = run(detector, [
    ...Array.from({ length: 10 }, () => [0.2, 0.4, 100]),
    ...Array.from({ length: 6 }, () => [0, 0, 100])
  ], FAST);

  const done = updates.find((u) => u.ended).completed;
  // Motion ran for about a second; the 300ms of quiet must not inflate that.
  assert.ok(done.durationMs >= 900 && done.durationMs <= 1100,
    `duration ${done.durationMs}ms should be about 1000`);
});

test('the start time is backdated to when motion actually began', () => {
  // The duration floor is a filter against noise, not the start of the event.
  const detector = new EventDetector();
  const updates = run(detector, [
    ...Array.from({ length: 6 }, () => [0.2, 0.4, 50]),
    ...Array.from({ length: 10 }, () => [0, 0, 100])
  ], FAST);

  const started = updates.find((u) => u.started);
  // Motion began on the first step, at now=50.
  assert.ok(Math.abs(started.current.startedAt - (EPOCH + 50)) < 30,
    `start ${started.current.startedAt - EPOCH} should be near 50`);
});

test('an end threshold above the start one cannot close an event instantly', () => {
  const detector = new EventDetector();
  const updates = run(detector, [
    ...Array.from({ length: 10 }, () => [0.05, 0.4, 33])
  ], { startFraction: 0.01, endFraction: 0.5, minDurationMs: 50, quietMs: 100 });

  assert.equal(updates.filter((u) => u.started).length, 1);
  assert.equal(updates.filter((u) => u.ended).length, 0, 'a bad threshold must not end it');
});

test('reset abandons an event in progress', () => {
  const detector = new EventDetector();
  run(detector, Array.from({ length: 8 }, () => [0.2, 0.4, 33]), FAST);
  assert.ok(detector.active);
  detector.reset();
  assert.equal(detector.active, null);
  assert.equal(detector.currentPhase, 'idle');
});

test('angular speed requires a field of view and never invents one', () => {
  // WebKit exposes no lens geometry, so with nothing entered there is no
  // honest answer and the function says so instead of guessing.
  assert.equal(degreesPerSecond(0.5, 0), null);
  assert.equal(degreesPerSecond(0.5, Number.NaN), null);
  assert.equal(degreesPerSecond(0.5, 70, 0), null);
});

test('angular speed scales with the field of view and with zoom', () => {
  // Half a frame width per second across a 70 degree field is 35 deg/sec.
  assert.equal(degreesPerSecond(0.5, 70), 35);
  // Zooming in halves the field, so the same image speed is half the angle.
  assert.equal(degreesPerSecond(0.5, 70, 2), 17.5);
});
