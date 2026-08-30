import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameRateMeter } from '../.test-build/vision/frame-rate.js';

test('delivered rate is measured from distinct frames only', () => {
  const meter = new FrameRateMeter();
  // 60 fps: one frame every 16.67 ms, each with a new mediaTime.
  for (let i = 0; i < 30; i++) {
    meter.recordDelivered({ now: i * (1000 / 60), mediaTime: i * 0.0166, presentedFrames: i + 1 });
  }
  const report = meter.report;
  assert.ok(Math.abs(report.deliveredFps - 60) < 1, `expected ~60, got ${report.deliveredFps}`);
  assert.equal(report.uniqueFrames, 30);
  assert.equal(report.repeatedFrames, 0);
});

test('a repeated mediaTime is not counted as a new frame', () => {
  const meter = new FrameRateMeter();
  // A 30 fps camera on a 60 Hz compositor: every frame presented twice.
  for (let i = 0; i < 40; i++) {
    const isRepeat = i % 2 === 1;
    const mediaTime = Math.floor(i / 2) * 0.0333;
    const fresh = meter.recordDelivered({ now: i * (1000 / 60), mediaTime, presentedFrames: i + 1 });
    assert.equal(fresh, !isRepeat, `frame ${i} freshness`);
  }
  const report = meter.report;
  assert.equal(report.uniqueFrames, 20);
  assert.equal(report.repeatedFrames, 20);
  // The measured rate must be the camera's 30, not the compositor's 60.
  assert.ok(Math.abs(report.deliveredFps - 30) < 1.5, `expected ~30, got ${report.deliveredFps}`);
});

test('gaps in presentedFrames are counted as drops', () => {
  const meter = new FrameRateMeter();
  meter.recordDelivered({ now: 0, mediaTime: 0, presentedFrames: 1 });
  meter.recordDelivered({ now: 16, mediaTime: 1, presentedFrames: 2 });
  // Four presented, only the fourth delivered: two frames never arrived.
  meter.recordDelivered({ now: 32, mediaTime: 2, presentedFrames: 5 });
  assert.equal(meter.report.droppedFrames, 2);
});

test('processing rate is independent of delivery rate', () => {
  const meter = new FrameRateMeter();
  for (let i = 0; i < 60; i++) {
    meter.recordDelivered({ now: i * (1000 / 60), mediaTime: i, presentedFrames: i + 1 });
    // Analyse every third frame; skip the rest.
    if (i % 3 === 0) meter.recordProcessed(i * (1000 / 60), 4);
    else meter.recordSkipped();
  }
  const report = meter.report;
  assert.ok(Math.abs(report.deliveredFps - 60) < 1.5, `delivered ${report.deliveredFps}`);
  assert.ok(Math.abs(report.processingFps - 20) < 1.5, `processing ${report.processingFps}`);
  assert.equal(report.skippedFrames, 40);
});

test('processing cost reports average and peak', () => {
  const meter = new FrameRateMeter();
  for (const [i, ms] of [2, 4, 12, 4].entries()) meter.recordProcessed(i * 20, ms);
  const report = meter.report;
  assert.equal(report.peakProcessingMs, 12);
  assert.ok(Math.abs(report.averageProcessingMs - 5.5) < 0.001);
  meter.resetPeak();
  assert.equal(meter.report.peakProcessingMs, 0);
});

test('a meter with fewer than two samples reports zero rather than guessing', () => {
  const meter = new FrameRateMeter();
  assert.equal(meter.report.deliveredFps, 0);
  meter.recordDelivered({ now: 5, mediaTime: 0 });
  assert.equal(meter.report.deliveredFps, 0);
});

test('a frozen mediaTime cannot stall the pipeline', () => {
  // Some WebKit builds hand the callback no metadata, or a mediaTime that
  // never advances. De-duplicating on a signal that never changes marked
  // every frame after the first as a repeat, and a repeat is not analysed —
  // so the whole vision pipeline stopped on a camera delivering perfectly.
  const meter = new FrameRateMeter();
  const results = [];
  for (let i = 0; i < 40; i++) {
    // mediaTime pinned at 0, no presentedFrames — the observed failure.
    results.push(meter.recordDelivered({ now: i * (1000 / 60), mediaTime: 0 }));
  }

  assert.equal(results[0], true, 'the first frame is always new');
  assert.ok(results.slice(-20).every(Boolean), 'the meter must recover and accept frames');

  const report = meter.report;
  assert.equal(report.identitySignal, 'none', 'a useless signal must be abandoned');
  assert.ok(report.uniqueFrames > 25, `expected most frames counted, got ${report.uniqueFrames}`);
  assert.ok(report.deliveredFps > 40, `rate must be measurable again, got ${report.deliveredFps}`);
});

test('presentedFrames takes over as identity once mediaTime proves useless', () => {
  // presentedFrames counts compositions, not decoded frames, so it is only
  // the right identity signal after mediaTime has been abandoned.
  const meter = new FrameRateMeter();
  for (let i = 0; i < 40; i++) {
    meter.recordDelivered({ now: i * (1000 / 60), mediaTime: 0, presentedFrames: i + 1 });
  }
  const report = meter.report;
  assert.equal(report.identitySignal, 'presentedFrames');
  assert.ok(report.uniqueFrames > 25, `a stuck mediaTime must not hide real frames, got ${report.uniqueFrames}`);
  assert.ok(report.deliveredFps > 40, `rate must be measurable, got ${report.deliveredFps}`);
});

test('genuine duplicates are still recognised while the signal works', () => {
  const meter = new FrameRateMeter();
  // A 30 fps camera on a 60 Hz compositor: alternating, never a long run.
  for (let i = 0; i < 40; i++) {
    meter.recordDelivered({ now: i * (1000 / 60), mediaTime: Math.floor(i / 2) * 0.0333 });
  }
  const report = meter.report;
  assert.equal(report.identitySignal, 'mediaTime', 'a working signal must stay trusted');
  assert.equal(report.uniqueFrames, 20);
  assert.equal(report.repeatedFrames, 20);
});
