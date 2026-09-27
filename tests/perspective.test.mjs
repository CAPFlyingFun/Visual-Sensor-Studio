import test from 'node:test';
import assert from 'node:assert/strict';
import { screenPitchRoll, squareToQuad, mapHomography, clampPoint, straightenQuad } from '../.test-build/v2/capture/perspective.js';

test('portrait motion preserves the established pitch convention',()=>{
  const reading=screenPitchRoll(12,-7,0);
  assert.equal(reading.pitch,12);
  assert.ok(Number.isFinite(reading.roll));
});
test('landscape motion preserves the established pitch-axis rotation',()=>{
  const reading=screenPitchRoll(12,-7,90);
  assert.equal(reading.pitch,7);
  assert.ok(Number.isFinite(reading.roll));
});
test('square-to-quad maps all four corners',()=>{
 const q=[{x:.1,y:.2},{x:.9,y:.1},{x:.8,y:.85},{x:.2,y:.9}]; const h=squareToQuad(q); assert.ok(h);
 [[0,0],[1,0],[1,1],[0,1]].forEach(([x,y],i)=>{const p=mapHomography(h,x,y);assert.ok(Math.abs(p.x-q[i].x)<1e-8);assert.ok(Math.abs(p.y-q[i].y)<1e-8);});
});
test('points are clamped to image bounds',()=>assert.deepEqual(clampPoint({x:-.2,y:1.3}),{x:0,y:1}));

test('straighten quad stays inside the source at a diagonal roll',()=>{for(const p of straightenQuad(18,4/3)){assert.ok(p.x>=-1e-9&&p.x<=1+1e-9);assert.ok(p.y>=-1e-9&&p.y<=1+1e-9);}});


test('steep portrait pitch does not exaggerate camera roll', () => {
  const reading = screenPitchRoll(108, -49.1, 0);
  assert.equal(Math.round(reading.pitch), 108);
  assert.ok(Math.abs(reading.roll) < 20, `expected visual roll below 20°, got ${reading.roll}`);
  assert.ok(Math.abs(reading.roll) > 8, `expected a real visible tilt, got ${reading.roll}`);
});

test('level portrait phone reports essentially zero roll', () => {
  const reading = screenPitchRoll(90, 0, 0);
  assert.ok(Math.abs(reading.roll) < 0.001);
});
