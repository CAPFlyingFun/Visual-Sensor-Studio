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

test('settings version is 0.2.0', () => {
  assert.match(htmlSource, /Visual Sensor Studio v0\.2\.0/);
  assert.match(mainSource, /APP_VERSION\s*=\s*['"]0\.2\.0['"]/);
  assert.match(swSource, /visual-sensor-studio-v0\.2\.0/);
});