import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RigRecorder,
  sampleKeys,
  slerp,
  tripodGait,
  waveGait
} from '../.test-build/rig/recorder.js';

/** A rotation of `angle` radians about X, which is easy to read back. */
const rot = (angle) => ({ x: Math.sin(angle / 2), y: 0, z: 0, w: Math.cos(angle / 2) });
const angleOf = (q) => 2 * Math.atan2(Math.abs(q.x) * Math.sign(q.w || 1), Math.abs(q.w));

test('slerp takes the short way round', () => {
  // q and -q are the same rotation. Without the sign check, half of all
  // interpolations go the long way and the bone spins to reach a pose next to
  // where it started.
  const a = rot(0.2);
  const b = rot(0.4);
  const negated = { x: -b.x, y: -b.y, z: -b.z, w: -b.w };
  const direct = slerp(a, b, 0.5);
  const viaNegative = slerp(a, negated, 0.5);
  const dot = Math.abs(direct.x * viaNegative.x + direct.w * viaNegative.w);
  assert.ok(dot > 0.9999, 'the same target must give the same midpoint');
});

test('slerp stays stable when the rotations nearly coincide', () => {
  // The sine terms lose all their precision there.
  const a = rot(0.30000);
  const b = rot(0.30001);
  const mid = slerp(a, b, 0.5);
  assert.ok(Number.isFinite(mid.x) && Number.isFinite(mid.w));
  assert.ok(Math.abs(Math.hypot(mid.x, mid.y, mid.z, mid.w) - 1) < 1e-6);
});

test('a cycle joins to itself across the loop boundary', () => {
  // Without wrapping, every loop snaps at the seam.
  const keys = [
    { time: 0.1, rotation: rot(0) },
    { time: 1.9, rotation: rot(1) }
  ];
  const atEnd = sampleKeys(keys, 1.95, 2);
  const atStart = sampleKeys(keys, 0.05, 2);
  // Both sit in the wrap segment, moving from rot(1) back toward rot(0).
  assert.ok(angleOf(atEnd) > angleOf(atStart),
    'the wrap must run from the last key toward the first');
});

test('an empty or single-key channel is handled without throwing', () => {
  assert.deepEqual(sampleKeys([], 0.5, 2), { x: 0, y: 0, z: 0, w: 1 });
  const single = [{ time: 0.5, rotation: rot(0.3) }];
  assert.deepEqual(sampleKeys(single, 1.7, 2), single[0].rotation);
});

test('a take does not touch the channel until it is committed', () => {
  // Abandoning a bad take has to leave the previous performance intact.
  const rig = new RigRecorder();
  rig.startRecording('head');
  rig.record(0, rot(0));
  rig.record(1, rot(1));
  rig.stopRecording();
  const first = rig.sample('head', 1);

  rig.startRecording('head');
  rig.record(0, rot(-1));
  rig.record(1, rot(-1));
  rig.cancelRecording();

  assert.deepEqual(rig.sample('head', 1), first, 'a cancelled take must change nothing');
});

test('a take of fewer than two keys is refused', () => {
  const rig = new RigRecorder();
  rig.startRecording('head');
  rig.record(0.4, rot(0.5));
  assert.equal(rig.stopRecording(), null);
  assert.equal(rig.sample('head', 0.4), null);
});

test('recording one bone leaves the others playing', () => {
  // The whole point of layering: thirteen easy takes, not thirteen at once.
  const rig = new RigRecorder();
  rig.startRecording('thorax');
  rig.record(0, rot(0));
  rig.record(1, rot(0.8));
  rig.stopRecording();

  rig.startRecording('head');
  rig.record(0, rot(0));
  rig.record(1, rot(0.2));
  assert.ok(rig.sample('thorax', 0.5), 'the committed channel keeps playing during a take');
  rig.stopRecording();
  assert.equal(rig.boneNames.length, 2);
});

test('re-recording a leg does not move it back into step', () => {
  // Phase belongs to the slot, not the take. Losing it on every re-record
  // would silently collapse a gait.
  const rig = new RigRecorder();
  rig.startRecording('legL2');
  rig.record(0, rot(0));
  rig.record(1, rot(1));
  rig.stopRecording();
  rig.setPhase('legL2', 0.5);
  rig.setMuted('legL2', true);

  rig.startRecording('legL2');
  rig.record(0, rot(0));
  rig.record(1, rot(0.4));
  rig.stopRecording();

  assert.equal(rig.channel('legL2').phase, 0.5);
  assert.equal(rig.channel('legL2').muted, true);
});

test('a phase is a position on a circle, not a clamped number', () => {
  const rig = new RigRecorder();
  rig.startRecording('leg');
  rig.record(0, rot(0));
  rig.record(1, rot(1));
  rig.stopRecording();

  rig.setPhase('leg', 1.25);
  assert.ok(Math.abs(rig.channel('leg').phase - 0.25) < 1e-9);
  rig.setPhase('leg', -0.25);
  assert.ok(Math.abs(rig.channel('leg').phase - 0.75) < 1e-9);
});

test('a take that crosses the loop point does not scramble the key order', () => {
  // Out-of-order keys make every later lookup interpolate between the wrong
  // pair, which reads as the limb jittering rather than as a bad recording.
  const rig = new RigRecorder();
  rig.loopSeconds = 2;
  rig.startRecording('leg');
  rig.record(1.6, rot(0.1));
  rig.record(1.9, rot(0.2));
  rig.record(0.2, rot(0.3));
  rig.record(0.6, rot(0.4));
  const channel = rig.stopRecording();

  for (let i = 1; i < channel.keys.length; i++) {
    assert.ok(channel.keys[i].time >= channel.keys[i - 1].time,
      `keys out of order at ${i}: ${channel.keys.map((k) => k.time)}`);
  }
});

// --- Gaits -----------------------------------------------------------------

const LEGS = ['L1', 'L2', 'L3', 'R1', 'R2', 'R3'];

test('tripod gait keeps three legs down at all times', () => {
  // Front-left, middle-right and rear-left swing together while the other
  // three hold the ground. That is what makes it stable enough to run with.
  const gait = tripodGait(LEGS);
  assert.equal(gait.length, 6);
  const groupA = gait.filter((leg) => leg.phase === 0).map((l) => l.bone);
  const groupB = gait.filter((leg) => leg.phase === 0.5).map((l) => l.bone);
  assert.equal(groupA.length, 3);
  assert.equal(groupB.length, 3);
  // The two tripods must alternate sides, never be three on one side.
  for (const group of [groupA, groupB]) {
    const left = group.filter((b) => b.startsWith('L')).length;
    assert.ok(left >= 1 && left <= 2, `a tripod of ${group} would fall over`);
  }
});

test('wave gait lifts one leg at a time', () => {
  const gait = waveGait(LEGS);
  const phases = gait.map((leg) => leg.phase).sort((a, b) => a - b);
  assert.equal(new Set(phases).size, 6, 'every leg gets its own moment');
  for (let i = 1; i < phases.length; i++) {
    assert.ok(Math.abs(phases[i] - phases[i - 1] - 1 / 6) < 1e-9, 'evenly spread');
  }
});

test('six legs come from one recorded cycle', () => {
  // The difference between an afternoon and a minute.
  const rig = new RigRecorder();
  rig.loopSeconds = 2;
  rig.startRecording('L1');
  for (let i = 0; i <= 20; i++) rig.record((i / 20) * 2, rot((i / 20) * 1.2));
  rig.stopRecording();

  const pose = rig.pose(0.5, tripodGait(LEGS), 'L1');
  assert.equal(pose.size, 6, 'one take should drive all six legs');

  // And the two tripods must genuinely be half a cycle apart.
  const a = pose.get('L1');
  const b = pose.get('L2');
  assert.ok(Math.abs(angleOf(a) - angleOf(b)) > 0.3,
    `the tripods should be out of step: ${angleOf(a)} vs ${angleOf(b)}`);
});

test('a leg with its own take keeps it rather than being overwritten', () => {
  const rig = new RigRecorder();
  rig.loopSeconds = 2;
  rig.startRecording('L1');
  rig.record(0, rot(0));
  rig.record(1.9, rot(1));
  rig.stopRecording();

  rig.startRecording('R3');
  rig.record(0, rot(-0.9));
  rig.record(1.9, rot(-0.9));
  rig.stopRecording();

  const pose = rig.pose(1, tripodGait(LEGS), 'L1');
  assert.ok(Math.abs(angleOf(pose.get('R3')) - 0.9) < 0.05,
    'a hand-animated leg must survive the gait');
});

test('a muted channel drops out of the pose', () => {
  const rig = new RigRecorder();
  rig.startRecording('head');
  rig.record(0, rot(0));
  rig.record(1, rot(1));
  rig.stopRecording();
  assert.equal(rig.pose(0.5).size, 1);
  rig.setMuted('head', true);
  assert.equal(rig.pose(0.5).size, 0);
  assert.equal(rig.sample('head', 0.5), null);
});

test('time outside the loop wraps rather than running off the end', () => {
  const rig = new RigRecorder();
  rig.loopSeconds = 2;
  rig.startRecording('head');
  for (let i = 0; i <= 10; i++) rig.record((i / 10) * 2, rot((i / 10) * 0.8));
  rig.stopRecording();

  const a = rig.sample('head', 0.7);
  const b = rig.sample('head', 0.7 + 2 * 5);
  assert.ok(Math.abs(angleOf(a) - angleOf(b)) < 1e-6, 'five loops later is the same pose');
  const negative = rig.sample('head', -1.3);
  assert.ok(Number.isFinite(negative.x), 'negative time must wrap, not produce NaN');
});
