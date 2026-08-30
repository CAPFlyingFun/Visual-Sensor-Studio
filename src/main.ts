import { CameraController, describeCameraError, type CameraFacing } from './sensors/camera.js';
import { MotionController } from './sensors/motion.js';
import { GpsController } from './sensors/gps.js';
import { clamp, median } from './core/math.js';
import type { GpsSample, MotionSample, SensorSnapshot, VisionMode } from './core/types.js';
import { disparityToRgba, grayToRgba, reliefFromGray, rgbaToGray, sobelEdges } from './vision/frame-processing.js';
import { computeBlockDisparity } from './vision/parallax.js';

const APP_VERSION = '0.2.0';
const SETTINGS_KEY = 'visual-sensor-settings-v1';
const CACHE_PREFIX = 'visual-sensor-studio-';

type CameraPreference = 'auto' | CameraFacing;
type QualityPreference = 'low' | 'normal' | 'high';
type VisionRatePreference = 'battery' | 'balanced' | 'fast';
type GpsAccuracyPreference = 'balanced' | 'high';

interface AppSettings {
  cameraPreference: CameraPreference;
  qualityPreference: QualityPreference;
  visionRatePreference: VisionRatePreference;
  gpsAccuracyPreference: GpsAccuracyPreference;
}

const DEFAULT_SETTINGS: AppSettings = {
  cameraPreference: 'auto',
  qualityPreference: 'normal',
  visionRatePreference: 'balanced',
  gpsAccuracyPreference: 'high'
};

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

function setText(id: string, value: string): void {
  byId(id).textContent = value;
}

function setChip(id: string, state: 'idle' | 'good' | 'warn', text: string): void {
  const chip = byId(id);
  chip.dataset.state = state;
  chip.textContent = text;
}

function format(value: number | null | undefined, digits = 1, suffix = ''): string {
  return Number.isFinite(value) ? `${Number(value).toFixed(digits)}${suffix}` : '—';
}

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

function drawImageData(canvas: HTMLCanvasElement, imageData: ImageData): void {
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.putImageData(imageData, 0, 0);
}

function frameToThumbnail(canvas: HTMLCanvasElement, frame: ImageData): void {
  drawImageData(canvas, frame);
}

function rgbaToImageData(rgba: Uint8ClampedArray, width: number, height: number): ImageData {
  const imageData = new ImageData(width, height);
  imageData.data.set(rgba);
  return imageData;
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      cameraPreference: ['auto', 'environment', 'user'].includes(String(parsed.cameraPreference))
        ? parsed.cameraPreference as CameraPreference
        : DEFAULT_SETTINGS.cameraPreference,
      qualityPreference: ['low', 'normal', 'high'].includes(String(parsed.qualityPreference))
        ? parsed.qualityPreference as QualityPreference
        : DEFAULT_SETTINGS.qualityPreference,
      visionRatePreference: ['battery', 'balanced', 'fast'].includes(String(parsed.visionRatePreference))
        ? parsed.visionRatePreference as VisionRatePreference
        : DEFAULT_SETTINGS.visionRatePreference,
      gpsAccuracyPreference: ['balanced', 'high'].includes(String(parsed.gpsAccuracyPreference))
        ? parsed.gpsAccuracyPreference as GpsAccuracyPreference
        : DEFAULT_SETTINGS.gpsAccuracyPreference
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing or storage restrictions should not stop sensor use.
  }
}

interface FusionBridge {
  setOrientation(value: MotionSample['quaternion']): void;
  setAcceleration(value: MotionSample['acceleration']): void;
  setGpsTrack(track: readonly GpsSample[]): void;
  setQuality(value: QualityPreference): void;
  resetView(): void;
}

const fallbackFusion: FusionBridge = {
  setOrientation: (_value) => undefined,
  setAcceleration: (_value) => undefined,
  setGpsTrack: (_track) => undefined,
  setQuality: (_value) => undefined,
  resetView: () => undefined
};

const video = byId<HTMLVideoElement>('cameraVideo');
const visionCanvas = byId<HTMLCanvasElement>('visionCanvas');
const visionContext = visionCanvas.getContext('2d');
if (!visionContext) throw new Error('Canvas 2D is required.');

const camera = new CameraController(video);
const motion = new MotionController();
const gps = new GpsController();
let fusion: FusionBridge = fallbackFusion;
let settings = loadSettings();
let serviceWorkerRegistration: ServiceWorkerRegistration | null = null;
let updateActivitySeen = false;

let visionMode: VisionMode = 'camera';
let latestMotion: MotionSample | null = null;
let latestGps: GpsSample | null = null;
let referenceGray: Uint8ClampedArray | null = null;
let referenceWidth = 0;
let referenceHeight = 0;
let parallaxAnalyzed = false;
let medianDisparityPx: number | null = null;
let lastVisionFrameAt = 0;
let processingVision = false;

function preferredCameraFacing(): CameraFacing {
  return settings.cameraPreference === 'user' ? 'user' : 'environment';
}

function visionIntervalMs(): number {
  if (settings.visionRatePreference === 'battery') return 220;
  if (settings.visionRatePreference === 'fast') return 45;
  return 95;
}

function setBrowserCameraFallback(visible: boolean): void {
  byId<HTMLButtonElement>('cameraBrowserFallback').hidden = !visible;
}

function openCameraInBrowser(): void {
  const url = new URL(window.location.href);
  url.searchParams.set('camera-browser', '1');
  url.searchParams.delete('refresh');
  const httpsUrl = url.toString();
  const edgeUrl = httpsUrl.replace(/^https:\/\//i, 'microsoft-edge-https://');

  if (edgeUrl === httpsUrl) {
    setText('cameraMessage', 'The Edge handoff requires the HTTPS version of Visual Sensor Studio.');
    return;
  }

  camera.stop();
  setChip('cameraChip', 'idle', 'Opening Edge…');
  setText('cameraMessage', 'Opening the live camera in Microsoft Edge browser mode…');
  window.location.href = edgeUrl;
}

async function initializeFusion(): Promise<void> {
  const container = byId('fusionScene');
  const resetButton = byId<HTMLButtonElement>('resetViewButton');
  resetButton.disabled = true;
  container.dataset.state = 'loading';
  container.textContent = 'Loading interactive 3D sensor view…';

  try {
    const { FusionScene } = await import('./visualization/scene.js');
    container.textContent = '';
    fusion = new FusionScene(container, settings.qualityPreference);
    container.dataset.state = 'ready';
    if (latestMotion) {
      fusion.setOrientation(latestMotion.quaternion);
      fusion.setAcceleration(latestMotion.acceleration);
    }
    fusion.setGpsTrack(gps.track);
    resetButton.disabled = false;
  } catch (error) {
    fusion = fallbackFusion;
    container.dataset.state = 'fallback';
    container.textContent = '3D view could not load. Camera, motion, GPS and parallax still work normally.';
    setText('sceneMessage', error instanceof Error
      ? `3D viewer unavailable: ${error.message}`
      : '3D viewer unavailable. Core sensors still work.');
  }
}

async function startCamera(): Promise<void> {
  const button = byId<HTMLButtonElement>('cameraButton');
  const overlay = byId<HTMLButtonElement>('cameraOverlayButton');
  const switchButton = byId<HTMLButtonElement>('switchCameraButton');
  const parallaxButton = byId<HTMLButtonElement>('captureParallaxButton');

  button.disabled = true;
  overlay.disabled = true;
  overlay.hidden = false;
  overlay.textContent = 'Requesting Camera…';
  switchButton.disabled = true;
  setBrowserCameraFallback(false);
  setChip('cameraChip', 'warn', 'Camera requesting…');

  try {
    await camera.start(preferredCameraFacing());
    setChip('cameraChip', 'good', `Camera ${camera.currentFacing === 'environment' ? 'rear' : 'front'}`);
    button.textContent = 'Restart Camera';
    overlay.hidden = true;
    switchButton.disabled = false;
    parallaxButton.disabled = false;
    setBrowserCameraFallback(false);
    setText('cameraMessage', isStandalone()
      ? 'Camera is live inside the installed app.'
      : 'Camera is live in browser mode.');
  } catch (error) {
    const standalone = isStandalone();
    setChip('cameraChip', 'warn', 'Camera needs attention');
    button.textContent = 'Retry Camera';
    overlay.hidden = false;
    overlay.textContent = 'Retry Camera';
    switchButton.disabled = true;
    parallaxButton.disabled = true;
    setBrowserCameraFallback(standalone);
    setText('cameraMessage', describeCameraError(error, standalone));
  } finally {
    button.disabled = false;
    overlay.disabled = false;
    void refreshSettingsDiagnostics();
  }
}

async function switchCamera(): Promise<void> {
  const button = byId<HTMLButtonElement>('switchCameraButton');
  const overlay = byId<HTMLButtonElement>('cameraOverlayButton');
  button.disabled = true;
  try {
    const facing = await camera.switchCamera();
    setChip('cameraChip', 'good', `Camera ${facing === 'environment' ? 'rear' : 'front'}`);
    overlay.hidden = true;
    setBrowserCameraFallback(false);
    setText('cameraMessage', `Switched to the ${facing === 'environment' ? 'rear' : 'front'} camera.`);
  } catch (error) {
    const standalone = isStandalone();
    setChip('cameraChip', 'warn', 'Camera needs attention');
    overlay.hidden = false;
    overlay.textContent = 'Retry Camera';
    byId<HTMLButtonElement>('captureParallaxButton').disabled = true;
    setBrowserCameraFallback(standalone);
    setText('cameraMessage', describeCameraError(error, standalone));
  } finally {
    button.disabled = !camera.active;
    void refreshSettingsDiagnostics();
  }
}

async function enableMotion(): Promise<void> {
  const button = byId<HTMLButtonElement>('motionButton');
  button.disabled = true;
  setChip('motionChip', 'warn', 'Motion requesting…');
  try {
    const granted = await motion.requestPermission();
    if (!granted) throw new Error('Motion/orientation permission was denied.');
    motion.start(onMotionSample);
    setChip('motionChip', 'good', 'Motion live');
    button.textContent = 'Motion Enabled';
  } catch (error) {
    setChip('motionChip', 'warn', 'Motion unavailable');
    setText('motionMessage', error instanceof Error ? error.message : 'Unable to enable motion sensors.');
    button.disabled = false;
  }
}

function onMotionSample(sample: MotionSample): void {
  latestMotion = sample;
  fusion.setOrientation(sample.quaternion);
  fusion.setAcceleration(sample.acceleration);
  setText('alphaValue', format(sample.alpha, 1, '°'));
  setText('betaValue', format(sample.beta, 1, '°'));
  setText('gammaValue', format(sample.gamma, 1, '°'));
  setText('accelValue', `${format(sample.acceleration.x, 2)}, ${format(sample.acceleration.y, 2)}, ${format(sample.acceleration.z, 2)} m/s²`);
  setText('rotationValue', `${format(sample.rotationRate.alpha, 1)}, ${format(sample.rotationRate.beta, 1)}, ${format(sample.rotationRate.gamma, 1)} °/s`);

  const roll = sample.gamma ?? 0;
  const pitch = sample.beta ?? 0;
  const horizon = byId('horizonLine');
  horizon.style.transform = `translate(-50%, ${clamp(pitch * 0.7, -42, 42)}px) rotate(${-roll}deg)`;
}

function startGps(): void {
  const button = byId<HTMLButtonElement>('gpsButton');
  setChip('gpsChip', 'warn', 'GPS requesting…');
  gps.start(
    (sample, track) => {
      latestGps = sample;
      setChip('gpsChip', 'good', `GPS ±${Math.round(sample.accuracy)}m`);
      setText('latValue', sample.latitude.toFixed(6));
      setText('lonValue', sample.longitude.toFixed(6));
      setText('altValue', format(sample.altitude, 1, ' m'));
      setText('speedValue', format(sample.speed, 1, ' m/s'));
      setText('trackValue', String(track.length));
      fusion.setGpsTrack(track);
    },
    (message) => {
      setChip('gpsChip', 'warn', 'GPS unavailable');
      setText('gpsMessage', message);
    },
    settings.gpsAccuracyPreference === 'high'
  );
  button.textContent = 'Pause GPS Track';
}

function toggleGps(): void {
  const button = byId<HTMLButtonElement>('gpsButton');
  if (gps.active) {
    gps.stop();
    setChip('gpsChip', 'idle', 'GPS paused');
    button.textContent = 'Start GPS Track';
    return;
  }
  startGps();
}

function resetGps(): void {
  gps.reset();
  latestGps = null;
  fusion.setGpsTrack([]);
  setText('trackValue', '0');
  setText('gpsMessage', 'Track cleared. The next GPS sample becomes the new local origin.');
}

function updateVisionMode(mode: VisionMode): void {
  visionMode = mode;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-vision-mode]')) {
    button.classList.toggle('active', button.dataset.visionMode === mode);
  }
  const processed = mode !== 'camera';
  visionCanvas.hidden = !processed;
  video.hidden = processed;
  setText('visionModeLabel', mode === 'camera'
    ? 'RGB camera'
    : mode === 'relief'
      ? 'Image relief • not physical depth'
      : 'Edge map');
}

async function visionLoop(timestamp: number): Promise<void> {
  requestAnimationFrame((time) => void visionLoop(time));
  if (!camera.active || visionMode === 'camera' || processingVision || timestamp - lastVisionFrameAt < visionIntervalMs()) return;
  lastVisionFrameAt = timestamp;
  processingVision = true;
  try {
    const frame = camera.captureFrame(settings.visionRatePreference === 'fast' ? 320 : settings.visionRatePreference === 'battery' ? 192 : 256);
    const gray = rgbaToGray(frame.imageData.data);
    const output = visionMode === 'relief'
      ? reliefFromGray(gray, frame.width, frame.height)
      : grayToRgba(sobelEdges(gray, frame.width, frame.height));
    drawImageData(visionCanvas, rgbaToImageData(output, frame.width, frame.height));
  } catch {
    // A camera can briefly report no frame while switching; the next animation tick recovers.
  } finally {
    processingVision = false;
  }
}

function captureParallaxReference(): void {
  try {
    const frame = camera.captureFrame(160);
    referenceGray = rgbaToGray(frame.imageData.data);
    referenceWidth = frame.width;
    referenceHeight = frame.height;
    parallaxAnalyzed = false;
    medianDisparityPx = null;
    frameToThumbnail(byId<HTMLCanvasElement>('referenceCanvas'), frame.imageData);
    setText('parallaxMessage', 'Reference captured. Move the phone sideways about 5–10 cm without rotating much, then tap Analyze B.');
    byId<HTMLButtonElement>('analyzeParallaxButton').disabled = false;
  } catch (error) {
    setText('parallaxMessage', error instanceof Error ? error.message : 'Unable to capture a reference frame.');
  }
}

function analyzeParallax(): void {
  if (!referenceGray) return;
  const button = byId<HTMLButtonElement>('analyzeParallaxButton');
  button.disabled = true;
  setText('parallaxMessage', 'Comparing blocks…');
  window.setTimeout(() => {
    try {
      const frame = camera.captureFrame(referenceWidth);
      if (frame.width !== referenceWidth || frame.height !== referenceHeight) {
        throw new Error('Camera geometry changed. Capture A again before analyzing.');
      }
      frameToThumbnail(byId<HTMLCanvasElement>('currentCanvas'), frame.imageData);
      const currentGray = rgbaToGray(frame.imageData.data);
      const maxDisparity = 16;
      const result = computeBlockDisparity(referenceGray!, currentGray, referenceWidth, referenceHeight, {
        blockSize: 6,
        patchRadius: 2,
        maxDisparity,
        verticalSearch: 2,
        textureThreshold: 12
      });
      const valid = [...result.disparity].filter((value, index) =>
        Number.isFinite(value) && value > 0.25 && result.confidence[index] > 0.015
      );
      medianDisparityPx = valid.length ? median(valid) : null;
      const rgba = disparityToRgba(result.disparity, result.confidence, maxDisparity);
      drawImageData(byId<HTMLCanvasElement>('parallaxCanvas'), rgbaToImageData(rgba, result.width, result.height));
      parallaxAnalyzed = true;
      setText(
        'parallaxMessage',
        medianDisparityPx === null
          ? 'Not enough textured matches. Try a scene with more detail and a steadier sideways move.'
          : `Relative disparity median: ${medianDisparityPx.toFixed(1)} px. Larger disparity generally means nearer structure. This is not calibrated distance.`
      );
    } catch (error) {
      setText('parallaxMessage', error instanceof Error ? error.message : 'Parallax analysis failed.');
    } finally {
      button.disabled = false;
    }
  }, 20);
}

function downloadSnapshot(): void {
  const snapshot: SensorSnapshot = {
    capturedAt: new Date().toISOString(),
    cameraFacing: camera.currentFacing,
    motion: latestMotion,
    gps: latestGps,
    gpsTrackPoints: gps.track.length,
    parallax: {
      capturedReference: Boolean(referenceGray),
      analyzed: parallaxAnalyzed,
      medianDisparityPx
    }
  };
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `visual-sensor-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function syncSettingsControls(): void {
  byId<HTMLSelectElement>('cameraPreference').value = settings.cameraPreference;
  byId<HTMLSelectElement>('qualityPreference').value = settings.qualityPreference;
  byId<HTMLSelectElement>('visionRatePreference').value = settings.visionRatePreference;
  byId<HTMLSelectElement>('gpsAccuracyPreference').value = settings.gpsAccuracyPreference;
}

async function refreshSettingsDiagnostics(): Promise<void> {
  setText('settingsVersion', APP_VERSION);
  setText('settingsDisplayMode', isStandalone() ? 'Standalone PWA' : 'Browser tab');
  setText('settingsSecureContext', window.isSecureContext ? 'Secure ✓' : 'Needs HTTPS');

  if ('caches' in window) {
    try {
      const keys = await caches.keys();
      const appCaches = keys.filter((key) => key.startsWith(CACHE_PREFIX));
      setText('settingsCacheVersion', appCaches.length ? appCaches.join(', ') : 'No app cache');
    } catch {
      setText('settingsCacheVersion', 'Unavailable');
    }
  } else {
    setText('settingsCacheVersion', 'Unsupported');
  }

  const registration = serviceWorkerRegistration;
  if (!('serviceWorker' in navigator)) {
    setText('settingsWorkerState', 'Unsupported');
  } else if (registration?.waiting) {
    setText('settingsWorkerState', `Waiting • ${registration.waiting.state}`);
  } else if (registration?.installing) {
    setText('settingsWorkerState', `Installing • ${registration.installing.state}`);
  } else if (registration?.active) {
    const controlled = navigator.serviceWorker.controller ? 'controlled' : 'not controlling';
    setText('settingsWorkerState', `${controlled} • ${registration.active.state}`);
  } else {
    setText('settingsWorkerState', navigator.serviceWorker.controller ? 'Controlled' : 'Not registered');
  }

  const mediaDevices = (navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices;
  setText('settingsCameraApi', mediaDevices ? 'getUserMedia available' : 'Unavailable');

  if (mediaDevices) {
    const supported = mediaDevices.getSupportedConstraints();
    const useful = ['facingMode', 'width', 'height', 'frameRate', 'aspectRatio']
      .filter((key) => Boolean((supported as Record<string, boolean | undefined>)[key]));
    setText('settingsCameraConstraints', useful.length ? useful.join(', ') : 'None reported');

    try {
      const devices = await mediaDevices.enumerateDevices();
      const cameras = devices.filter((device) => device.kind === 'videoinput');
      const labeled = cameras.filter((device) => Boolean(device.label)).length;
      setText('settingsCameraDevices', `${cameras.length} video input${cameras.length === 1 ? '' : 's'} • ${labeled} labeled`);
    } catch {
      setText('settingsCameraDevices', 'Enumeration blocked');
    }
  } else {
    setText('settingsCameraConstraints', 'Not reported');
    setText('settingsCameraDevices', 'Enumeration unavailable');
  }

  setText('settingsCameraStream', camera.active
    ? `Live • ${video.videoWidth || '?'}×${video.videoHeight || '?'} • ${camera.currentFacing}`
    : 'Idle / no live track');
  setText('settingsImageCapture', 'ImageCapture' in window ? 'Available' : 'Not exposed');
}

function openSettings(): void {
  syncSettingsControls();
  void refreshSettingsDiagnostics();
  const dialog = byId<HTMLDialogElement>('settingsDialog');
  if (!dialog.open) dialog.showModal();
}

function saveSettingFromControls(): void {
  settings = {
    cameraPreference: byId<HTMLSelectElement>('cameraPreference').value as CameraPreference,
    qualityPreference: byId<HTMLSelectElement>('qualityPreference').value as QualityPreference,
    visionRatePreference: byId<HTMLSelectElement>('visionRatePreference').value as VisionRatePreference,
    gpsAccuracyPreference: byId<HTMLSelectElement>('gpsAccuracyPreference').value as GpsAccuracyPreference
  };
  saveSettings();
  fusion.setQuality(settings.qualityPreference);
}

function handleCameraPreferenceChange(): void {
  saveSettingFromControls();
  setText('cameraMessage', camera.active
    ? 'Camera preference saved. Tap Restart Camera to apply it.'
    : 'Camera preference saved. It will be used on the next camera start.');
}

function handleQualityChange(): void {
  saveSettingFromControls();
  setText('sceneMessage', `3D quality set to ${settings.qualityPreference}.`);
}

function handleVisionRateChange(): void {
  saveSettingFromControls();
  setText('visionModeLabel', visionMode === 'camera'
    ? `RGB camera • ${settings.visionRatePreference}`
    : `${visionMode === 'relief' ? 'Image relief' : 'Edge map'} • ${settings.visionRatePreference}`);
}

function handleGpsAccuracyChange(): void {
  const wasActive = gps.active;
  if (wasActive) gps.stop();
  saveSettingFromControls();
  if (wasActive) startGps();
  setText('gpsMessage', settings.gpsAccuracyPreference === 'high'
    ? 'GPS set to high accuracy. This can use more battery.'
    : 'GPS set to balanced accuracy for lower battery use.');
}

function resetSettings(): void {
  settings = { ...DEFAULT_SETTINGS };
  saveSettings();
  syncSettingsControls();
  fusion.setQuality(settings.qualityPreference);
  setText('updateStatus', 'Settings reset to defaults.');
}

function setUpdateButton(enabled: boolean, label = 'Install Update & Restart'): void {
  const button = byId<HTMLButtonElement>('applyUpdateButton');
  button.disabled = !enabled;
  button.textContent = label;
}

function observeServiceWorkerRegistration(registration: ServiceWorkerRegistration): void {
  serviceWorkerRegistration = registration;
  if (registration.waiting) {
    updateActivitySeen = true;
    setText('updateStatus', 'An update is ready to install.');
    setUpdateButton(true);
  }

  registration.addEventListener('updatefound', () => {
    updateActivitySeen = true;
    const worker = registration.installing;
    setText('updateStatus', 'Downloading a new app version…');
    setUpdateButton(false);
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') {
        if (registration.waiting) {
          setText('updateStatus', 'Update downloaded and ready.');
          setUpdateButton(true);
        } else {
          setText('updateStatus', 'Update installed. Reload Latest Version to finish.');
          setUpdateButton(true, 'Reload Latest Version');
        }
      }
      void refreshSettingsDiagnostics();
    });
  });
}

async function checkForUpdates(): Promise<void> {
  const button = byId<HTMLButtonElement>('checkUpdatesButton');
  button.disabled = true;
  setText('updateStatus', 'Checking GitHub Pages for a newer build…');
  updateActivitySeen = false;

  try {
    if (!('serviceWorker' in navigator)) throw new Error('Service workers are unavailable in this browser context.');
    let registration = serviceWorkerRegistration ?? await navigator.serviceWorker.getRegistration();
    if (!registration) {
      registration = await navigator.serviceWorker.register('./sw.js');
      observeServiceWorkerRegistration(registration);
    }

    await registration.update();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 900));

    if (registration.waiting) {
      setText('updateStatus', 'Update available and ready to install.');
      setUpdateButton(true);
    } else if (registration.installing) {
      setText('updateStatus', 'Update found and still installing…');
    } else if (updateActivitySeen) {
      setText('updateStatus', 'A newer worker was found. Reload Latest Version to use it.');
      setUpdateButton(true, 'Reload Latest Version');
    } else {
      setText('updateStatus', `No newer waiting update found. Current app: v${APP_VERSION}.`);
      setUpdateButton(true, 'Reload Latest Version');
    }
    await refreshSettingsDiagnostics();
  } catch (error) {
    setText('updateStatus', error instanceof Error ? error.message : 'Update check failed.');
  } finally {
    button.disabled = false;
  }
}

function reloadLatestVersion(): void {
  const url = new URL(window.location.href);
  url.searchParams.set('refresh', Date.now().toString());
  window.location.replace(url.toString());
}

function applyUpdate(): void {
  const waiting = serviceWorkerRegistration?.waiting;
  if (waiting) {
    setText('updateStatus', 'Activating update…');
    const reload = (): void => {
      navigator.serviceWorker.removeEventListener('controllerchange', reload);
      reloadLatestVersion();
    };
    navigator.serviceWorker.addEventListener('controllerchange', reload);
    waiting.postMessage({ type: 'SKIP_WAITING' });
    window.setTimeout(reloadLatestVersion, 1800);
    return;
  }
  reloadLatestVersion();
}

async function clearAppCache(): Promise<void> {
  const button = byId<HTMLButtonElement>('clearCacheButton');
  button.disabled = true;
  setText('updateStatus', 'Clearing Visual Sensor Studio caches…');
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys
        .filter((key) => key.startsWith(CACHE_PREFIX))
        .map((key) => caches.delete(key)));
    }
    setText('updateStatus', 'Cache cleared. Reloading from the network…');
    reloadLatestVersion();
  } catch (error) {
    setText('updateStatus', error instanceof Error ? error.message : 'Could not clear app cache.');
    button.disabled = false;
  }
}

byId<HTMLButtonElement>('cameraButton').addEventListener('click', () => void startCamera());
byId<HTMLButtonElement>('cameraOverlayButton').addEventListener('click', () => void startCamera());
byId<HTMLButtonElement>('cameraBrowserFallback').addEventListener('click', openCameraInBrowser);
byId<HTMLButtonElement>('switchCameraButton').addEventListener('click', () => void switchCamera());
byId<HTMLButtonElement>('motionButton').addEventListener('click', () => void enableMotion());
byId<HTMLButtonElement>('gpsButton').addEventListener('click', toggleGps);
byId<HTMLButtonElement>('resetGpsButton').addEventListener('click', resetGps);
byId<HTMLButtonElement>('captureParallaxButton').addEventListener('click', captureParallaxReference);
byId<HTMLButtonElement>('analyzeParallaxButton').addEventListener('click', analyzeParallax);
byId<HTMLButtonElement>('resetViewButton').addEventListener('click', () => fusion.resetView());
byId<HTMLButtonElement>('downloadButton').addEventListener('click', downloadSnapshot);
byId<HTMLButtonElement>('settingsButton').addEventListener('click', openSettings);
byId<HTMLButtonElement>('checkUpdatesButton').addEventListener('click', () => void checkForUpdates());
byId<HTMLButtonElement>('applyUpdateButton').addEventListener('click', applyUpdate);
byId<HTMLButtonElement>('clearCacheButton').addEventListener('click', () => void clearAppCache());
byId<HTMLButtonElement>('resetSettingsButton').addEventListener('click', resetSettings);
byId<HTMLSelectElement>('cameraPreference').addEventListener('change', handleCameraPreferenceChange);
byId<HTMLSelectElement>('qualityPreference').addEventListener('change', handleQualityChange);
byId<HTMLSelectElement>('visionRatePreference').addEventListener('change', handleVisionRateChange);
byId<HTMLSelectElement>('gpsAccuracyPreference').addEventListener('change', handleGpsAccuracyChange);

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-vision-mode]')) {
  button.addEventListener('click', () => updateVisionMode(button.dataset.visionMode as VisionMode));
}

const browserCameraMode = new URL(window.location.href).searchParams.get('camera-browser') === '1';
setText('secureContextValue', window.isSecureContext ? 'Secure ✓' : 'Needs HTTPS');
setChip('pwaChip', 'good', isStandalone() ? 'PWA installed' : browserCameraMode ? 'Browser camera mode' : 'PWA ready');
syncSettingsControls();
updateVisionMode('camera');
requestAnimationFrame((time) => void visionLoop(time));
void initializeFusion();
void refreshSettingsDiagnostics();

if (browserCameraMode && !isStandalone()) {
  setText('cameraMessage', 'Browser compatibility mode is active. Tap Enable Camera. This uses the browser camera path that works outside the installed PWA.');
}

if (!window.isSecureContext) {
  setChip('cameraChip', 'warn', 'Camera needs HTTPS');
  setText('cameraMessage', 'Camera access requires a secure HTTPS context.');
} else if (!navigator.mediaDevices?.getUserMedia) {
  const standalone = isStandalone();
  setChip('cameraChip', 'warn', 'Camera API unavailable');
  setBrowserCameraFallback(standalone);
  setText('cameraMessage', standalone
    ? 'This installed iOS web-app context is not exposing getUserMedia. Use Open Live Camera in Edge.'
    : 'This browser context is not exposing getUserMedia.');
}

if ('serviceWorker' in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) {
      updateActivitySeen = true;
      setText('updateStatus', 'New service worker active. Reload Latest Version to finish.');
      setUpdateButton(true, 'Reload Latest Version');
    }
    void refreshSettingsDiagnostics();
  });

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').then((registration) => {
      observeServiceWorkerRegistration(registration);
      return registration.update();
    }).then(() => refreshSettingsDiagnostics()).catch(() => {
      setChip('pwaChip', 'warn', 'PWA cache unavailable');
      setText('settingsWorkerState', 'Registration failed');
    });
  });
}
