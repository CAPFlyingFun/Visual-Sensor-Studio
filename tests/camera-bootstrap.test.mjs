import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const cameraSource = readFileSync(new URL('../src/sensors/camera.ts', import.meta.url), 'utf8');
const htmlSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('camera bootstrap does not statically depend on the Three.js scene', () => {
  assert.doesNotMatch(mainSource, /^import\s+\{\s*FusionScene\s*\}\s+from\s+['"]\.\/visualization\/scene\.js['"];?$/m);
  assert.match(mainSource, /import\(['"]\.\/visualization\/scene\.js['"]\)/);
});

test('camera preview exposes a direct enable control', () => {
  assert.match(htmlSource, /id=["']cameraOverlayButton["']/);
  assert.match(htmlSource, />\s*Enable Camera\s*</);
});

test('camera prepares iOS inline playback before requesting media', () => {
  const playsInlineIndex = cameraSource.indexOf("setAttribute('playsinline'");
  const getUserMediaIndex = cameraSource.indexOf('getUserMedia(constraints)');
  assert.ok(playsInlineIndex >= 0, 'camera should configure playsinline');
  assert.ok(getUserMediaIndex >= 0, 'camera should request getUserMedia');
  assert.ok(playsInlineIndex < getUserMediaIndex, 'playsinline setup must happen before getUserMedia on iOS');
});
