import test from 'node:test';
import assert from 'node:assert/strict';
import { screenPitchRoll, squareToQuad, mapHomography, clampPoint, straightenQuad } from '../.test-build/v2/capture/perspective.js';

/*
 * PITCH AND ROLL COME OFF ONE VECTOR.
 *
 * Roll was fixed by projecting gravity into the screen plane; pitch was left
 * reading raw beta or gamma per screen angle — the very convention that fix
 * exists to get away from. It now comes off the same projection, so the four
 * screen orientations fall OUT of the maths instead of being special-cased.
 * These pin that they still land where the old special cases put them.
 */
test('portrait motion preserves the established pitch convention',()=>{
  const reading=screenPitchRoll(12,-7,0);
  // Beta was 12; the projected answer is 12.087, because a 7° gamma does tilt
  // the camera slightly and the Euler number did not know it. A tenth of a
  // degree is not a behaviour change — the disagreement at STEEP angles is,
  // and that is measured below.
  assert.ok(Math.abs(reading.pitch - 12) < 0.1, `got ${reading.pitch}`);
  assert.ok(Number.isFinite(reading.roll));
});
test('landscape motion preserves the established pitch-axis rotation',()=>{
  const reading=screenPitchRoll(12,-7,90);
  assert.ok(Math.abs(reading.pitch - 7) < 0.1, `got ${reading.pitch}`);
  assert.ok(Number.isFinite(reading.roll));
});
test('the screen orientations fall out of the projection, not out of a switch',()=>{
  // 90 reproduces -gamma, 270 +gamma, 180 -beta, 0 beta. No branch does this.
  assert.ok(Math.abs(screenPitchRoll(12,-7,90).pitch - 7) < 0.01);
  assert.ok(Math.abs(screenPitchRoll(12,-7,270).pitch + 7) < 0.01);
  assert.ok(Math.abs(screenPitchRoll(12,-7,180).pitch + 12.087) < 0.01);
});
test('the poses the level indicator is calibrated against are exact',()=>{
  // Upright, flat, and landscape-upright: whatever else moved, these are the
  // ones a person checks against a doorframe, and they must not have.
  assert.ok(Math.abs(screenPitchRoll(90,0,0).pitch - 90) < 1e-9);
  assert.ok(Math.abs(screenPitchRoll(0,0,0).pitch) < 1e-9);
  assert.ok(Math.abs(screenPitchRoll(0,-90,90).pitch - 90) < 1e-9);
});
test('square-to-quad maps all four corners',()=>{
 const q=[{x:.1,y:.2},{x:.9,y:.1},{x:.8,y:.85},{x:.2,y:.9}]; const h=squareToQuad(q); assert.ok(h);
 [[0,0],[1,0],[1,1],[0,1]].forEach(([x,y],i)=>{const p=mapHomography(h,x,y);assert.ok(Math.abs(p.x-q[i].x)<1e-8);assert.ok(Math.abs(p.y-q[i].y)<1e-8);});
});
test('points are clamped to image bounds',()=>assert.deepEqual(clampPoint({x:-.2,y:1.3}),{x:0,y:1}));

test('straighten quad stays inside the source at a diagonal roll',()=>{for(const p of straightenQuad(18,4/3)){assert.ok(p.x>=-1e-9&&p.x<=1+1e-9);assert.ok(p.y>=-1e-9&&p.y<=1+1e-9);}});


test('steep portrait pitch does not exaggerate camera roll OR pitch', () => {
  const reading = screenPitchRoll(108, -49.1, 0);
  // 108 was the raw Euler beta. The projected camera tilt is 102 — the same
  // kind of overstatement that made gamma unusable as roll, on the other
  // half of the same reading.
  assert.ok(Math.abs(reading.pitch - 102.01) < 0.05, `got ${reading.pitch}`);
  assert.ok(Math.abs(reading.roll) < 20, `expected visual roll below 20°, got ${reading.roll}`);
  assert.ok(Math.abs(reading.roll) > 8, `expected a real visible tilt, got ${reading.roll}`);
});

test('level portrait phone reports essentially zero roll', () => {
  const reading = screenPitchRoll(90, 0, 0);
  assert.ok(Math.abs(reading.roll) < 0.001);
});
