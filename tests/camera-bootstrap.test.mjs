import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const adapterSource = readFileSync(new URL('../src/sensors/camera.ts', import.meta.url), 'utf8');
const htmlSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const cameraPath = new URL('../public/camera-bootstrap.js', import.meta.url);
const cameraSource = existsSync(cameraPath) ? readFileSync(cameraPath, 'utf8') : '';

test('camera bootstrap does not statically depend on the Three.js scene', () => {
  assert.doesNotMatch(mainSource, /^import\s+\{\s*FusionScene\s*\}\s+from\s+['"]\.\/visualization\/scene\.js['"];?$/m);
  assert.match(mainSource, /import\(['"]\.\/visualization\/scene\.js['"]\)/);
});

test('plain camera engine loads before the TypeScript application', () => {
  assert.ok(cameraSource.length > 0, 'public/camera-bootstrap.js must exist');
  const cameraScript = htmlSource.indexOf('camera-bootstrap.js');
  const appScript = htmlSource.indexOf('app/main.js');
  assert.ok(cameraScript >= 0, 'camera bootstrap script must be referenced');
  assert.ok(appScript >= 0, 'TypeScript app bundle must be referenced');
  assert.ok(cameraScript < appScript, 'camera bootstrap must load before the TypeScript app');
});

test('persistent HTML camera engine owns getUserMedia while TypeScript only bridges to it', () => {
  assert.match(cameraSource, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(cameraSource, /requestProfiles/);
  assert.match(cameraSource, /video:\s*true/);
  assert.match(cameraSource, /setAttribute\(['"]playsinline['"]/);
  assert.doesNotMatch(adapterSource, /getUserMedia\(/);
  assert.match(adapterSource, /VisualCamera/);
  assert.doesNotMatch(mainSource, /getUserMedia\(/);
});

test('camera preview exposes direct live and native-photo controls', () => {
  assert.match(htmlSource, /id=["']cameraOverlayButton["']/);
  assert.match(htmlSource, /id=["']nativePhotoButton["']/);
  assert.match(htmlSource, /id=["']nativePhotoInput["']/);
  assert.match(htmlSource, /capture=["']environment["']/);
  assert.match(cameraSource, /nativePhotoInput/);
  assert.match(cameraSource, /loadNativePhoto/);
});

test('standalone camera UI hands off directly to Edge instead of opening another PWA window', () => {
  assert.match(htmlSource, /id=["']cameraBrowserFallback["']/);
  assert.match(mainSource, /cameraBrowserFallback/);
  assert.match(mainSource, /microsoft-edge-https:\/\//);
  assert.doesNotMatch(mainSource, /window\.open\(url\.toString\(\),\s*['"]_blank['"]\)/);
});