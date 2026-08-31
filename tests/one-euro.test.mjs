import test from 'node:test';
import assert from 'node:assert/strict';
import { OneEuroFilter, QuaternionSmoother } from '../.test-build/rig/one-euro.js';

const HZ = 60;
const DT = 1 / HZ;

/** A steady hand: a held value plus tremor. */
function tremor(amplitude, samples = 240, base = 0) {
  let seed = 11;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  return Array.from({ length: samples }, () => base + rand() * amplitude * 2);
}

function spread(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
}

test('the first sample passes straight through', () => {
  // Starting from zero makes every channel swing up from the origin over its
  // first second, which reads as the model snapping into place.
  const filter = new OneEuroFilter();
  assert.equal(filter.filter(0.75, 0), 0.75);
});

test('tremor is suppressed while the hand is still', () => {
  const filter = new OneEuroFilter({ minCutoff: 0.8, beta: 0.02 });
  const input = tremor(0.05, 300, 1);
  const output = input.map((v, i) => filter.filter(v, i * DT));
  const settled = output.slice(100);

  assert.ok(spread(settled) < spread(input.slice(100)) * 0.3,
    `noise should be cut hard: ${spread(input.slice(100))} -> ${spread(settled)}`);
});

test('a deliberate movement is not left behind', () => {
  // This is the whole point of One-Euro: the same filter that kills tremor must
  // not add lag to a real gesture.
  const oneEuro = new OneEuroFilter({ minCutoff: 0.8, beta: 0.9 });
  const plain = new OneEuroFilter({ minCutoff: 0.8, beta: 0 });

  // Hold, then sweep.
  const input = [];
  for (let i = 0; i < 60; i++) input.push(0);
  for (let i = 0; i < 60; i++) input.push((i / 59) * 2);

  let euroOut = 0;
  let plainOut = 0;
  input.forEach((v, i) => {
    euroOut = oneEuro.filter(v, i * DT);
    plainOut = plain.filter(v, i * DT);
  });

  const target = 2;
  assert.ok(Math.abs(euroOut - target) < Math.abs(plainOut - target),
    `speed-adaptive should track closer: ${euroOut} vs ${plainOut} toward ${target}`);
});

test('beta zero is an ordinary low-pass, which is the comparison', () => {
  const plain = new OneEuroFilter({ minCutoff: 1, beta: 0 });
  const input = tremor(0.1, 200, 0.5);
  const output = input.map((v, i) => plain.filter(v, i * DT));
  assert.ok(spread(output.slice(80)) < spread(input.slice(80)));
});

test('an implausible time step does not change the filter strength', () => {
  // A backgrounded tab hands back a multi-second gap. Treating that as the
  // sample interval would briefly make the filter do nothing at all.
  const steady = new OneEuroFilter({ minCutoff: 1, beta: 0 });
  const jumped = new OneEuroFilter({ minCutoff: 1, beta: 0 });

  let steadyOut = 0;
  let jumpedOut = 0;
  for (let i = 0; i < 40; i++) {
    steadyOut = steady.filter(1, i * DT);
    jumpedOut = jumped.filter(1, i * DT);
  }
  // One absurd interval against one ordinary one. The loop left both at
  // 39*DT, so the ordinary step is exactly 40*DT — passing 41*DT here would
  // give the control a double-length step and compare two different things.
  jumpedOut = jumped.filter(0, 39 * DT + 9);
  steadyOut = steady.filter(0, 40 * DT);
  assert.ok(Math.abs(jumpedOut - steadyOut) < 0.05,
    `a 9 second gap should not open the filter: ${jumpedOut} vs ${steadyOut}`);
});

test('reset clears the history so the next sample starts clean', () => {
  const filter = new OneEuroFilter();
  for (let i = 0; i < 30; i++) filter.filter(5, i * DT);
  filter.reset();
  assert.equal(filter.filter(-2, 0), -2);
});

// --- Rotations -------------------------------------------------------------

const identity = { x: 0, y: 0, z: 0, w: 1 };
const isUnit = (q) => Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) < 1e-6;

test('a smoothed rotation stays a unit quaternion', () => {
  const smoother = new QuaternionSmoother();
  let seed = 3;
  for (let i = 0; i < 200; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const a = (seed / 0x7fffffff) * 0.4;
    const q = { x: Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2) };
    const out = smoother.filter(q, i * DT);
    assert.ok(isUnit(out), `not normalised: ${JSON.stringify(out)}`);
  }
});

test('a sign flip is not averaged through a full turn', () => {
  // q and -q are the SAME rotation and a device can hand you either. Filtering
  // across that flip averages a rotation with its own negation and swings the
  // bone right around — a spin that looks like a bug in the model.
  const smoother = new QuaternionSmoother();
  const a = 0.6;
  const q = { x: Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2) };
  const flipped = { x: -q.x, y: -q.y, z: -q.z, w: -q.w };

  for (let i = 0; i < 40; i++) smoother.filter(q, i * DT);
  const before = smoother.filter(q, 40 * DT);
  const after = smoother.filter(flipped, 41 * DT);

  // The two inputs are the same orientation, so the output must barely move.
  const dot = Math.abs(before.x * after.x + before.y * after.y
    + before.z * after.z + before.w * after.w);
  assert.ok(dot > 0.999, `the same rotation moved the output: dot ${dot}`);
});

test('a held rotation settles rather than shivering', () => {
  const smoother = new QuaternionSmoother();
  smoother.configure({ minCutoff: 0.6, beta: 0.01 });
  let seed = 5;
  const noisy = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const a = 0.3 + (seed / 0x7fffffff - 0.5) * 0.02;
    return { x: Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2) };
  };

  const raw = [];
  const filtered = [];
  for (let i = 0; i < 300; i++) {
    const q = noisy();
    const out = smoother.filter(q, i * DT);
    if (i > 120) {
      raw.push(q.x);
      filtered.push(out.x);
    }
  }
  assert.ok(spread(filtered) < spread(raw) * 0.4,
    `rotation noise should be cut: ${spread(raw)} -> ${spread(filtered)}`);
});

test('the first rotation is passed through, not eased into', () => {
  const smoother = new QuaternionSmoother();
  const out = smoother.filter(identity, 0);
  assert.ok(Math.abs(out.w - 1) < 1e-9);
});
