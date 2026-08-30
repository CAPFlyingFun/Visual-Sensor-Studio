import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const htmlSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const swSource = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

test('settings menu exposes update, cache, device and performance controls', () => {
  for (const id of [
    'settingsButton',
    'settingsDialog',
    'checkUpdatesButton',
    'applyUpdateButton',
    'clearCacheButton',
    'cameraPreference',
    'qualityPreference',
    'visionRatePreference',
    'gpsAccuracyPreference',
    'resetSettingsButton',
    'settingsVersion',
    'settingsCacheVersion',
    'settingsWorkerState',
    'settingsDisplayMode',
    'settingsSecureContext'
  ]) {
    assert.match(htmlSource, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
});

test('settings preferences persist locally and influence camera, vision and GPS behavior', () => {
  assert.match(mainSource, /localStorage\.getItem\(/);
  assert.match(mainSource, /localStorage\.setItem\(/);
  assert.match(mainSource, /cameraPreference/);
  assert.match(mainSource, /visionRatePreference/);
  assert.match(mainSource, /gpsAccuracyPreference/);
});

test('update controls explicitly check, activate waiting worker and clear caches', () => {
  assert.match(mainSource, /registration\.update\(\)/);
  assert.match(mainSource, /SKIP_WAITING/);
  assert.match(mainSource, /caches\.keys\(\)/);
  assert.match(mainSource, /caches\.delete\(/);
});

test('service worker accepts immediate activation request', () => {
  assert.match(swSource, /addEventListener\(['"]message['"]/);
  assert.match(swSource, /SKIP_WAITING/);
  assert.match(swSource, /skipWaiting\(\)/);
});

test('settings version is 0.8.1 everywhere it is stated', () => {
  assert.match(htmlSource, /Visual Sensor Studio v0\.8\.1/);
  assert.match(mainSource, /APP_VERSION\s*=\s*['"]0\.8\.1['"]/);
  assert.match(swSource, /visual-sensor-studio-v0\.8\.1/);
});

test('the service worker update check bypasses the HTTP cache', () => {
  // A stale sw.js served from the HTTP cache can pin an installed PWA to an
  // old build, which is one way a fixed camera bug appears not to be fixed.
  assert.match(mainSource, /updateViaCache:\s*['"]none['"]/);
  assert.doesNotMatch(mainSource, /register\(['"]\.\/sw\.js['"]\)/);
});

test('camera assets are served network-first so a stale copy cannot linger', () => {
  assert.match(swSource, /networkFirst[\s\S]*camera-bootstrap\.js/);
  // Every compiled module, not an enumerated list that goes stale as soon as a
  // module is added — a fresh main.js running against a cached older module is
  // a far worse failure than a slightly larger network-first set.
  assert.match(swSource, /url\.pathname\.includes\('\/app\/'\)/);
  assert.match(swSource, /cache:\s*['"]no-store['"]/);
  // Offline use must survive: a cached copy still answers when fetch fails.
  assert.match(swSource, /\.catch\(\(\)\s*=>\s*caches\.match\(event\.request\)\)/);
});

test('diagnostics expose the camera recovery controls and honest liveness data', () => {
  for (const id of [
    'settingsCameraState',
    'settingsCameraStage',
    'settingsTrackState',
    'settingsVideoState',
    'settingsFirstFrame',
    'settingsZoomSupport',
    'settingsProcessingFps',
    'settingsStorage',
    'hardResetCameraButton'
  ]) {
    assert.match(htmlSource, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(mainSource, /navigator\.storage/);
  assert.match(mainSource, /hardReset\(\)/);
});
test('the effective-detail measurement is wired end to end', () => {
  // The estimator is useless if the button and its readout drift apart from
  // main.ts, which is exactly how a control ends up looking functional while
  // doing nothing.
  for (const id of ['measureDetailButton', 'benchEffective']) {
    assert.match(htmlSource, new RegExp(`id=["']${id}["']`), `missing #${id}`);
    assert.match(mainSource, new RegExp(`'${id}'`), `#${id} not referenced by main.ts`);
  }
  assert.match(mainSource, /estimateEffectiveResolution/, 'estimator not imported');
});
