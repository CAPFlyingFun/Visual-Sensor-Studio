import {
  BrowserCameraSource,
  CameraController,
  describeCameraError,
  type CameraFacing,
  type CameraAttempt,
  type CameraStatus,
  type CameraZoomState
} from './sensors/camera.js';
import { MotionController } from './sensors/motion.js';
import { GpsController } from './sensors/gps.js';
import { zoomPresetStops } from './sensors/zoom.js';
import { clamp, median } from './core/math.js';
import type { GpsSample, MotionSample, SensorSnapshot, VisionMetrics, VisionMode } from './core/types.js';
import {
  absoluteDifference,
  differenceToRgba,
  dimGrayToRgba,
  disparityToRgba,
  edgeDensity,
  grayToRgba,
  luminanceStats,
  motionMaskToRgba,
  motionScore,
  reliefFromGray,
  rgbaToGray,
  sobelEdges
} from './vision/frame-processing.js';
import { computeBlockFlow, flowVectorColor, type FlowField } from './vision/optical-flow.js';
import { FrameRateMeter, type PresentedFrame } from './vision/frame-rate.js';
import { AdaptiveGovernor, type AdaptiveState } from './vision/adaptive.js';
import { ObjectTracker, type TrackedObject } from './vision/tracking.js';
import { FrameIntegrator, type StackMode } from './vision/integration.js';
import { computeHistogram, createHistogram } from './vision/histogram.js';
import {
  applyFocusPeaking,
  applyLightBoost,
  applyPalette,
  applyZebra,
  type NightPalette
} from './vision/overlays.js';
import { StabilityMonitor } from './sensors/stability.js';
import { computeBlockDisparity } from './vision/parallax.js';

const APP_VERSION = '0.4.0';
const SETTINGS_KEY = 'visual-sensor-settings-v1';
const CACHE_PREFIX = 'visual-sensor-studio-';

type CameraPreference = 'auto' | CameraFacing;
type QualityPreference = 'low' | 'normal' | 'high';
type VisionRatePreference = 'battery' | 'balanced' | 'fast' | 'adaptive';
type CameraFrameRatePreference = 'auto' | '30' | '60' | '120' | '240';
type TrailPreference = 'off' | 'short' | 'medium' | 'long';
type GpsAccuracyPreference = 'balanced' | 'high';

interface AppSettings {
  cameraPreference: CameraPreference;
  qualityPreference: QualityPreference;
  visionRatePreference: VisionRatePreference;
  gpsAccuracyPreference: GpsAccuracyPreference;
  cameraFrameRate: CameraFrameRatePreference;
  trackingEnabled: boolean;
  trailPreference: TrailPreference;
  zebraEnabled: boolean;
  focusPeakingEnabled: boolean;
  nightPalette: NightPalette;
  nightStackMode: StackMode;
  nightIntegrationSeconds: number;
  nightGain: number;
  nightGamma: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  cameraPreference: 'auto',
  qualityPreference: 'normal',
  // Adaptive is the default: it idles lower than Balanced on a still scene and
  // climbs far above it when something actually moves, which is the whole point.
  visionRatePreference: 'adaptive',
  gpsAccuracyPreference: 'high',
  cameraFrameRate: 'auto',
  trackingEnabled: true,
  trailPreference: 'medium',
  zebraEnabled: false,
  focusPeakingEnabled: false,
  nightPalette: 'natural',
  nightStackMode: 'clean',
  nightIntegrationSeconds: 4,
  nightGain: 1,
  nightGamma: 1
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
      visionRatePreference: ['battery', 'balanced', 'fast', 'adaptive'].includes(String(parsed.visionRatePreference))
        ? parsed.visionRatePreference as VisionRatePreference
        : DEFAULT_SETTINGS.visionRatePreference,
      gpsAccuracyPreference: ['balanced', 'high'].includes(String(parsed.gpsAccuracyPreference))
        ? parsed.gpsAccuracyPreference as GpsAccuracyPreference
        : DEFAULT_SETTINGS.gpsAccuracyPreference,
      cameraFrameRate: ['auto', '30', '60', '120', '240'].includes(String(parsed.cameraFrameRate))
        ? parsed.cameraFrameRate as CameraFrameRatePreference
        : DEFAULT_SETTINGS.cameraFrameRate,
      trackingEnabled: typeof parsed.trackingEnabled === 'boolean'
        ? parsed.trackingEnabled
        : DEFAULT_SETTINGS.trackingEnabled,
      trailPreference: ['off', 'short', 'medium', 'long'].includes(String(parsed.trailPreference))
        ? parsed.trailPreference as TrailPreference
        : DEFAULT_SETTINGS.trailPreference,
      zebraEnabled: typeof parsed.zebraEnabled === 'boolean' ? parsed.zebraEnabled : DEFAULT_SETTINGS.zebraEnabled,
      focusPeakingEnabled: typeof parsed.focusPeakingEnabled === 'boolean'
        ? parsed.focusPeakingEnabled
        : DEFAULT_SETTINGS.focusPeakingEnabled,
      nightPalette: ['natural', 'monochrome', 'green', 'falsecolor'].includes(String(parsed.nightPalette))
        ? parsed.nightPalette as NightPalette
        : DEFAULT_SETTINGS.nightPalette,
      nightStackMode: ['clean', 'brighten', 'trails'].includes(String(parsed.nightStackMode))
        ? parsed.nightStackMode as StackMode
        : DEFAULT_SETTINGS.nightStackMode,
      nightIntegrationSeconds: Number.isFinite(parsed.nightIntegrationSeconds)
        ? clamp(Number(parsed.nightIntegrationSeconds), 0.5, 30)
        : DEFAULT_SETTINGS.nightIntegrationSeconds,
      nightGain: Number.isFinite(parsed.nightGain) ? clamp(Number(parsed.nightGain), 1, 6) : DEFAULT_SETTINGS.nightGain,
      nightGamma: Number.isFinite(parsed.nightGamma) ? clamp(Number(parsed.nightGamma), 0.3, 2) : DEFAULT_SETTINGS.nightGamma
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

function requireVisionContext(): CanvasRenderingContext2D {
  const context = visionCanvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D is required.');
  return context;
}

const visionContext = requireVisionContext();

const camera = new CameraController(video);
const cameraSource = new BrowserCameraSource(camera);
const motion = new MotionController();
const gps = new GpsController();
let fusion: FusionBridge = fallbackFusion;
let settings = loadSettings();
let serviceWorkerRegistration: ServiceWorkerRegistration | null = null;
let updateActivitySeen = false;

/** Wiring problems found during boot, surfaced to the user rather than thrown. */
const bootProblems: string[] = [];

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

/**
 * Vision pipeline scratch space.
 *
 * Every buffer here is allocated once per analysis-frame geometry and then
 * reused, because a 20 fps preview that allocates frame-sized typed arrays
 * hands the phone a garbage-collection pause several times a second.
 */
interface VisionBuffers {
  width: number;
  height: number;
  gray: Uint8ClampedArray;
  previousGray: Uint8ClampedArray;
  edges: Uint8ClampedArray;
  difference: Uint8ClampedArray;
  rgba: Uint8ClampedArray;
  imageData: ImageData;
  hasPrevious: boolean;
}

let visionBuffers: VisionBuffers | null = null;
let latestMetrics: VisionMetrics | null = null;
let smoothedFps = 0;
let lastProcessedAt = 0;
let latestFlow: FlowField | null = null;
let zoomState: CameraZoomState = { value: 1, min: 1, max: 1, step: 0.1, kind: 'none' };
const frameRateMeter = new FrameRateMeter();
const governor = new AdaptiveGovernor();
const tracker = new ObjectTracker();
const integrator = new FrameIntegrator();
const histogram = createHistogram();
const stability = new StabilityMonitor();

let nightModeActive = false;
let trackedObjects: readonly TrackedObject[] = [];
let adaptiveState: AdaptiveState = 'idle';
let lastDeliveredAt = 0;
let deliveryDriven = false;
let boostLut: Uint8ClampedArray | undefined;
let overlayPhase = 0;

let zoomPointers = new Map<number, { x: number; y: number }>();
let pinchStartDistance = 0;
let pinchStartZoom = 1;
let zoomWriteInFlight = false;
let pendingZoom: number | null = null;

function preferredCameraFacing(): CameraFacing {
  return settings.cameraPreference === 'user' ? 'user' : 'environment';
}

/**
 * Analysis interval for the fixed presets. Adaptive ignores this and asks the
 * governor instead.
 */
function visionIntervalMs(): number {
  if (settings.visionRatePreference === 'adaptive') return 1000 / Math.max(1, governor.targetFps);
  if (settings.visionRatePreference === 'battery') return 220;
  if (settings.visionRatePreference === 'fast') return 45;
  return 95;
}

/** Analysis rate ceiling per preset, in frames per second. */
function maxAnalysisFps(): number {
  if (settings.visionRatePreference === 'battery') return 12;
  if (settings.visionRatePreference === 'balanced') return 24;
  if (settings.visionRatePreference === 'fast') return 60;
  return 60;
}

function trailLengthForPreference(): number {
  if (settings.trailPreference === 'off') return 0;
  if (settings.trailPreference === 'short') return 16;
  if (settings.trailPreference === 'long') return 96;
  return 40;
}

/**
 * True when a mode needs per-frame motion analysis. Tracking and the Motion
 * metric both need the frame difference, so it is computed whenever either is
 * wanted and skipped entirely when neither is.
 */
function needsMotionAnalysis(): boolean {
  return settings.trackingEnabled
    || visionMode === 'motion'
    || visionMode === 'difference'
    || visionMode === 'flow';
}

/**
 * Analysis width per processing preset. Everything downstream works on this
 * downsampled frame, never on the full camera resolution.
 *
 * The width does not vary by mode. It was tempting to shrink it for optical
 * flow, but measured per-frame cost at this width says flow is the cheapest
 * stage in the pipeline, not the most expensive: about 0.16 ms for the sparse
 * three-step search against 1.6 ms for the shared metrics pass and 2.0 ms for
 * the relief render. Shrinking the frame for flow bought nothing measurable
 * and made Brightness, Contrast, Detail and Motion read differently in Flow
 * mode than in every other mode, purely because they were sampled at a
 * different resolution.
 */
function analysisWidth(): number {
  if (settings.visionRatePreference === 'battery') return 176;
  if (settings.visionRatePreference === 'fast') return 384;
  return 256;
}

/**
 * Flow grid density per preset. Cost scales with the number of cells, so the
 * spacing - not the frame size - is the dial that keeps flow cheap.
 */
function flowOptionsForPreset(): { cellSize: number; patchRadius: number; maxShift: number } {
  if (settings.visionRatePreference === 'battery') return { cellSize: 20, patchRadius: 3, maxShift: 5 };
  if (settings.visionRatePreference === 'fast') return { cellSize: 14, patchRadius: 4, maxShift: 8 };
  return { cellSize: 16, patchRadius: 3, maxShift: 6 };
}

function ensureVisionBuffers(width: number, height: number): VisionBuffers {
  if (visionBuffers && visionBuffers.width === width && visionBuffers.height === height) return visionBuffers;
  const count = width * height;
  visionBuffers = {
    width,
    height,
    gray: new Uint8ClampedArray(count),
    previousGray: new Uint8ClampedArray(count),
    edges: new Uint8ClampedArray(count),
    difference: new Uint8ClampedArray(count),
    rgba: new Uint8ClampedArray(count * 4),
    imageData: new ImageData(width, height),
    hasPrevious: false
  };
  return visionBuffers;
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

  // There is no way to confirm that a custom-scheme handoff succeeded. If the
  // app is still here shortly afterwards, Edge almost certainly is not
  // installed, and saying so is better than leaving a hopeful message up.
  window.setTimeout(() => {
    if (document.visibilityState !== 'visible') return;
    setChip('cameraChip', 'warn', 'Camera needs attention');
    setText('cameraMessage', 'Microsoft Edge did not open, so it is probably not installed. Open '
      + `${httpsUrl} in Safari instead — the camera works there even when this installed app cannot start it.`);
  }, 2500);
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

/**
 * Render whatever state the camera engine reports.
 *
 * The engine is the single source of camera truth, including the transitions
 * this app never asked for - a track the system muted, a background/foreground
 * cycle, a stream that opened but delivered no frames. Driving the UI from its
 * notifications is what stops the panel claiming "Camera live" over a frozen
 * or black preview.
 */
function applyCameraStatus(status: CameraStatus): void {
  const button = byId<HTMLButtonElement>('cameraButton');
  const overlay = byId<HTMLButtonElement>('cameraOverlayButton');
  const switchButton = byId<HTMLButtonElement>('switchCameraButton');
  const parallaxButton = byId<HTMLButtonElement>('captureParallaxButton');

  zoomState = status.zoom;
  const facingLabel = status.facing === 'environment' ? 'rear' : 'front';
  const live = status.state === 'live';

  // A visible stage trace, so a stalled request can be seen without digging
  // into Settings. If a tap leaves this blank, the request never started; if
  // it sticks on "getUserMedia", WebKit took the call and never answered.
  const trace = byId('cameraStage');
  trace.hidden = status.state === 'idle' || status.state === 'live';
  trace.textContent = `stage: ${status.stage}`;

  switchButton.disabled = !live;
  parallaxButton.disabled = !live;
  syncZoomControls();

  switch (status.state) {
    case 'requesting':
      setChip('cameraChip', 'warn', 'Camera requesting…');
      overlay.hidden = false;
      overlay.disabled = true;
      overlay.textContent = 'Requesting Camera…';
      button.disabled = true;
      break;

    case 'live':
      setChip('cameraChip', 'good', `Camera ${facingLabel}`);
      overlay.hidden = true;
      overlay.disabled = false;
      button.disabled = false;
      button.textContent = 'Restart Camera';
      setBrowserCameraFallback(false);
      break;

    case 'suspended':
      setChip('cameraChip', 'warn', 'Camera suspended');
      overlay.hidden = false;
      overlay.disabled = false;
      overlay.textContent = 'Resume Camera';
      button.disabled = false;
      button.textContent = 'Resume Camera';
      resetVisionState();
      if (status.reason) setText('cameraMessage', status.reason);
      break;

    case 'error':
      setChip('cameraChip', 'warn', 'Camera needs attention');
      overlay.hidden = false;
      overlay.disabled = false;
      overlay.textContent = 'Retry Camera';
      button.disabled = false;
      button.textContent = 'Retry Camera';
      setBrowserCameraFallback(isStandalone());
      resetVisionState();
      if (status.reason) setText('cameraMessage', status.reason);
      break;

    default:
      setChip('cameraChip', 'idle', 'Camera idle');
      overlay.hidden = false;
      overlay.disabled = false;
      overlay.textContent = 'Enable Camera';
      button.disabled = false;
      button.textContent = 'Enable Camera';
      resetVisionState();
      break;
  }
}

async function startCamera(): Promise<void> {
  setBrowserCameraFallback(false);
  resetVisionState();

  try {
    // Nothing is awaited before this call, so the tap's transient activation
    // is still live when WebKit decides whether to show a permission prompt.
    await camera.start(preferredCameraFacing());
    await applyCameraFrameRate();
    startFrameDelivery();
    setText('cameraMessage', isStandalone()
      ? 'Camera is live inside the installed app. If it stops after backgrounding, tap Resume Camera — iOS releases the stream and it cannot be revived in place.'
      : 'Camera is live in browser mode.');
  } catch (error) {
    setText('cameraMessage', describeCameraError(error, isStandalone()));
  } finally {
    void refreshSettingsDiagnostics();
  }
}

/** Ask the engine for the configured rate and report what it negotiated. */
async function applyCameraFrameRate(): Promise<void> {
  const requested = settings.cameraFrameRate === 'auto' ? 'auto' : Number(settings.cameraFrameRate);
  try {
    await camera.setFrameRate(requested);
  } catch {
    // A refused rate leaves the previous one in force; the camera keeps running.
  }
}

function startFrameDelivery(): void {
  frameRateMeter.reset();
  governor.reset();
  tracker.reset();
  trackedObjects = [];
  deliveryDriven = camera.startFrameDelivery(onFrameDelivered);
}

function setNightMode(active: boolean): void {
  nightModeActive = active;
  if (!active) integrator.reset();
  byId('nightPanel').hidden = !active;
}

async function switchCamera(): Promise<void> {
  const button = byId<HTMLButtonElement>('switchCameraButton');
  button.disabled = true;
  resetVisionState();
  try {
    const facing = await camera.switchCamera();
    setText('cameraMessage', `Switched to the ${facing === 'environment' ? 'rear' : 'front'} camera.`);
  } catch (error) {
    setText('cameraMessage', describeCameraError(error, isStandalone()));
  } finally {
    void refreshSettingsDiagnostics();
  }
}

function hardResetCamera(): void {
  camera.hardReset();
  resetVisionState();
  setText('cameraMessage', 'Camera media state was fully torn down. Tap Enable Camera to request a completely new stream.');
  setText('updateStatus', 'Camera hard reset complete.');
  void refreshSettingsDiagnostics();
}

// --- Zoom ------------------------------------------------------------------

function buildZoomPresets(): void {
  const container = byId('zoomPresets');
  const stops = zoomState.kind === 'none' ? [] : zoomPresetStops(zoomState.min, zoomState.max);
  const signature = stops.join(',');
  if (container.dataset.signature === signature) return;

  container.dataset.signature = signature;
  container.textContent = '';
  for (const stop of stops) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'zoom-preset';
    button.dataset.zoom = String(stop);
    button.textContent = `${stop % 1 === 0 ? stop.toFixed(0) : stop.toFixed(1)}×`;
    button.addEventListener('click', () => void requestZoom(stop));
    container.appendChild(button);
  }
}

function syncZoomControls(): void {
  const slider = byId<HTMLInputElement>('zoomSlider');
  const readout = byId('zoomValue');
  const available = zoomState.kind !== 'none' && camera.active;

  buildZoomPresets();

  slider.disabled = !available;
  slider.min = String(zoomState.min);
  slider.max = String(zoomState.max);
  slider.step = String(Math.max(0.05, zoomState.step));
  if (document.activeElement !== slider) slider.value = String(zoomState.value);

  readout.dataset.kind = zoomState.kind;
  readout.innerHTML = `${zoomState.value.toFixed(1)}&times; <em>${zoomKindLabel(zoomState.kind)}</em>`;

  for (const button of document.querySelectorAll<HTMLButtonElement>('.zoom-preset')) {
    const stop = Number(button.dataset.zoom);
    button.disabled = !available;
    button.classList.toggle('active', Math.abs(stop - zoomState.value) < 0.05);
  }

  renderZoomMetric();
}

/**
 * Apply a zoom value, coalescing bursts.
 *
 * A pinch produces a pointer event per frame and `applyConstraints()` is
 * asynchronous, so only one write is ever in flight and the newest requested
 * value wins. Without this a fast pinch queues dozens of constraint writes.
 */
async function requestZoom(value: number): Promise<void> {
  if (zoomState.kind === 'none') return;
  const clamped = clamp(value, zoomState.min, zoomState.max);

  if (zoomWriteInFlight) {
    pendingZoom = clamped;
    return;
  }

  zoomWriteInFlight = true;
  try {
    zoomState = await camera.setZoom(clamped);
  } catch {
    // The engine already falls back to a digital crop when a track refuses.
  } finally {
    zoomWriteInFlight = false;
    syncZoomControls();
  }

  if (pendingZoom !== null) {
    const next = pendingZoom;
    pendingZoom = null;
    await requestZoom(next);
  }
}

function pinchDistance(): number {
  const points = [...zoomPointers.values()];
  if (points.length < 2) return 0;
  return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
}

/**
 * Pinch-to-zoom on the preview, sharing one zoom value with the slider.
 *
 * The stage sets `touch-action: pan-y`, so a vertical drag still scrolls the
 * page normally and only a genuine two-finger pinch is claimed here.
 */
function installPinchZoom(): void {
  const stage = byId('visionStage');

  stage.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch') return;
    zoomPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (zoomPointers.size === 2) {
      pinchStartDistance = pinchDistance();
      pinchStartZoom = zoomState.value;
    }
  });

  stage.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'touch' || !zoomPointers.has(event.pointerId)) return;
    zoomPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (zoomPointers.size !== 2 || pinchStartDistance <= 0) return;

    event.preventDefault();
    const scale = pinchDistance() / pinchStartDistance;
    if (!Number.isFinite(scale) || scale <= 0) return;
    void requestZoom(pinchStartZoom * scale);
  }, { passive: false });

  const release = (event: PointerEvent): void => {
    zoomPointers.delete(event.pointerId);
    if (zoomPointers.size < 2) pinchStartDistance = 0;
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);
  stage.addEventListener('pointerleave', release);

  // WebKit-only gesture events would otherwise pinch-zoom the whole page.
  for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
    stage.addEventListener(name, (event) => event.preventDefault());
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
  // The IMU is already running, so stacking stability is measured rather than
  // assumed. A multi-second exposure is only meaningful if the camera held still.
  stability.update({ rotationRate: sample.rotationRate, acceleration: sample.acceleration });
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

const MODE_LABELS: Record<VisionMode, string> = {
  camera: 'RGB camera',
  relief: 'Image relief • not physical depth',
  edges: 'Edge map',
  motion: 'Motion mask • thresholded change',
  difference: 'Frame difference • raw change',
  flow: 'Optical flow • relative image motion',
  night: 'Night • computational low-light, not infrared'
};

function updateVisionMode(mode: VisionMode): void {
  visionMode = mode;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-vision-mode]')) {
    button.classList.toggle('active', button.dataset.visionMode === mode);
  }

  // The processed canvas is layered over the video rather than swapped with
  // it: hiding a <video> with display:none can stop WebKit decoding frames,
  // and the camera then never recovers when the mode is switched back.
  visionCanvas.hidden = mode === 'camera' && !settings.zebraEnabled && !settings.focusPeakingEnabled;
  latestFlow = null;
  setNightMode(mode === 'night');
  setText('visionModeLabel', `${MODE_LABELS[mode]} • ${settings.visionRatePreference}`);
}

function resizeVisionCanvas(width: number, height: number): void {
  if (visionCanvas.width !== width) visionCanvas.width = width;
  if (visionCanvas.height !== height) visionCanvas.height = height;
}

function putBuffer(buffers: VisionBuffers, rgba: Uint8ClampedArray): void {
  resizeVisionCanvas(buffers.width, buffers.height);
  buffers.imageData.data.set(rgba);
  visionContext.putImageData(buffers.imageData, 0, 0);
}

function drawFlowOverlay(buffers: VisionBuffers, field: FlowField): void {
  putBuffer(buffers, dimGrayToRgba(buffers.gray, 0.42, buffers.rgba));
  if (!field.vectors.length) return;

  const reference = Math.max(1, field.maxMagnitude);
  // Short vectors are hard to read at analysis resolution, so they are drawn
  // with a gain. The Motion metric uses the raw magnitudes, not this gain.
  const gain = 2.2;

  visionContext.lineWidth = Math.max(1, buffers.width / 220);
  visionContext.lineCap = 'round';

  for (const vector of field.vectors) {
    const tipX = vector.x + vector.dx * gain;
    const tipY = vector.y + vector.dy * gain;
    visionContext.strokeStyle = flowVectorColor(vector, reference);
    visionContext.beginPath();
    visionContext.moveTo(vector.x, vector.y);
    visionContext.lineTo(tipX, tipY);
    visionContext.stroke();

    // A small head so direction reads without drawing a full arrowhead path.
    const angle = Math.atan2(vector.dy, vector.dx);
    const head = Math.max(2, field.cellSize * 0.22);
    visionContext.beginPath();
    visionContext.moveTo(tipX, tipY);
    visionContext.lineTo(tipX - head * Math.cos(angle - 0.5), tipY - head * Math.sin(angle - 0.5));
    visionContext.moveTo(tipX, tipY);
    visionContext.lineTo(tipX - head * Math.cos(angle + 0.5), tipY - head * Math.sin(angle + 0.5));
    visionContext.stroke();
  }
}

/** Render the accumulated night exposure, or the live frame before any stacking. */
function renderNightFrame(buffers: VisionBuffers, source: Uint8ClampedArray): void {
  const rgba = integrator.framesIntegrated > 0
    ? integrator.render(buffers.rgba)
    : (buffers.rgba.set(source), buffers.rgba);

  applyLightBoost(rgba, settings.nightGain, settings.nightGamma, boostLut ??= new Uint8ClampedArray(256));
  applyPalette(rgba, settings.nightPalette);
  if (settings.focusPeakingEnabled) applyFocusPeaking(rgba, buffers.edges, 90);
  if (settings.zebraEnabled) applyZebra(rgba, buffers.width, buffers.height, 0.95, overlayPhase);
  putBuffer(buffers, rgba);
}

/** Paint the live frame so zebra and peaking can be shown over plain RGB. */
function drawOverlaysOverRgb(buffers: VisionBuffers, source: Uint8ClampedArray): void {
  buffers.rgba.set(source);
  if (settings.focusPeakingEnabled) applyFocusPeaking(buffers.rgba, buffers.edges, 90);
  if (settings.zebraEnabled) applyZebra(buffers.rgba, buffers.width, buffers.height, 0.95, overlayPhase);
  putBuffer(buffers, buffers.rgba);
  visionCanvas.hidden = false;
}

/** Re-apply overlays to whatever a processed mode already drew. */
function applyCanvasOverlays(buffers: VisionBuffers): void {
  const image = visionContext.getImageData(0, 0, buffers.width, buffers.height);
  if (settings.focusPeakingEnabled) applyFocusPeaking(image.data, buffers.edges, 90);
  if (settings.zebraEnabled) applyZebra(image.data, buffers.width, buffers.height, 0.95, overlayPhase);
  visionContext.putImageData(image, 0, 0);
}

/**
 * Bounding boxes, ids and trails for tracked objects.
 *
 * Labels stay strictly descriptive — an id, a speed in px/sec and a direction.
 * The tracker has no idea what any of these are, and the overlay must not
 * suggest otherwise.
 */
function drawTrackingOverlay(buffers: VisionBuffers): void {
  const trailLength = trailLengthForPreference();
  visionContext.lineWidth = Math.max(1, buffers.width / 320);
  visionContext.font = `${Math.max(7, Math.round(buffers.width / 34))}px ui-monospace, monospace`;
  visionContext.textBaseline = 'bottom';

  for (const object of trackedObjects) {
    const alpha = clamp(object.confidence, 0.2, 1);
    const halfW = object.width / 2;
    const halfH = object.height / 2;

    if (trailLength > 0 && object.trail.length > 1) {
      visionContext.strokeStyle = `rgba(118, 209, 255, ${alpha * 0.7})`;
      visionContext.beginPath();
      const start = Math.max(0, object.trail.length - trailLength);
      for (let i = start; i < object.trail.length; i++) {
        const point = object.trail[i];
        if (i === start) visionContext.moveTo(point.x, point.y);
        else visionContext.lineTo(point.x, point.y);
      }
      visionContext.stroke();
    }

    visionContext.strokeStyle = `rgba(115, 229, 173, ${alpha})`;
    visionContext.strokeRect(object.centerX - halfW, object.centerY - halfH, object.width, object.height);

    if (object.speedPxPerSec > 1) {
      visionContext.fillStyle = `rgba(234, 255, 255, ${alpha})`;
      visionContext.fillText(
        `${object.id} · ${Math.round(object.speedPxPerSec)}px/s`,
        object.centerX - halfW,
        object.centerY - halfH - 2
      );
    }
  }
}

function recordProcessingFps(timestamp: number): number {
  if (lastProcessedAt > 0) {
    const delta = timestamp - lastProcessedAt;
    if (delta > 0 && delta < 4000) {
      const instant = 1000 / delta;
      // Exponential moving average so the readout is steady enough to read
      // while still responding to a genuine rate change within a second.
      smoothedFps = smoothedFps > 0 ? smoothedFps * 0.8 + instant * 0.2 : instant;
    }
  }
  lastProcessedAt = timestamp;
  return smoothedFps;
}

/**
 * One pass of the vision pipeline.
 *
 * This runs in every mode, including plain RGB, because the instrument
 * readouts are the point of the panel - but it always works on a downsampled
 * analysis frame, and optical flow is computed only while the Flow mode is
 * actually selected. Motion elsewhere comes from the much cheaper frame
 * difference that Motion and Difference already need.
 */
function processVisionFrame(timestamp: number): void {
  const frame = cameraSource.captureFrame(analysisWidth());
  if (!frame) return;

  const buffers = ensureVisionBuffers(frame.width, frame.height);
  buffers.previousGray.set(buffers.gray);
  const hadPrevious = buffers.hasPrevious;
  rgbaToGray(frame.data, buffers.gray);
  buffers.hasPrevious = true;

  const stats = luminanceStats(buffers.gray);
  sobelEdges(buffers.gray, buffers.width, buffers.height, buffers.edges);
  const detail = edgeDensity(buffers.edges, 48);

  // The Motion metric always comes from the frame difference, in every mode.
  // Deriving it from flow magnitude while Flow is selected made the same
  // scene read 8% in one mode and 0% in another, which is a worse readout
  // than a slightly cruder one that stays comparable as modes change.
  let motionValue = 0;
  const wantsMotion = needsMotionAnalysis();
  if (hadPrevious && wantsMotion) {
    absoluteDifference(buffers.gray, buffers.previousGray, buffers.difference);
    motionValue = motionScore(buffers.difference, 18);
  } else {
    buffers.difference.fill(0);
  }

  // Tracking consumes the motion mask, making it a generic consumer of
  // analysis output rather than anything wired to the camera.
  if (settings.trackingEnabled && hadPrevious) {
    trackedObjects = tracker.update(buffers.difference, buffers.width, buffers.height, timestamp);
  } else if (!settings.trackingEnabled && trackedObjects.length) {
    tracker.reset();
    trackedObjects = [];
  }

  const flowOptions = flowOptionsForPreset();
  if (visionMode === 'flow' && hadPrevious) {
    latestFlow = computeBlockFlow(buffers.previousGray, buffers.gray, buffers.width, buffers.height, flowOptions);
  } else if (visionMode !== 'flow') {
    latestFlow = null;
  }

  // Night integration folds the frame in and discards it, so a longer
  // exposure costs no extra memory.
  if (nightModeActive) {
    integrator.setMode(settings.nightStackMode);
    integrator.setTarget(settings.nightIntegrationSeconds * 1000);
    integrator.addFrame(frame.data, buffers.width, buffers.height, timestamp);
  }

  switch (visionMode) {
    case 'relief':
      putBuffer(buffers, reliefFromGray(buffers.gray, buffers.width, buffers.height));
      break;
    case 'edges':
      putBuffer(buffers, grayToRgba(buffers.edges));
      break;
    case 'motion':
      putBuffer(buffers, motionMaskToRgba(
        buffers.gray,
        buffers.difference,
        buffers.width,
        buffers.height,
        18,
        buffers.rgba
      ));
      break;
    case 'difference':
      putBuffer(buffers, differenceToRgba(buffers.difference, 3.2, buffers.rgba));
      break;
    case 'flow':
      drawFlowOverlay(buffers, latestFlow ?? {
        vectors: [], cellSize: flowOptions.cellSize, width: buffers.width, height: buffers.height,
        meanMagnitude: 0, maxMagnitude: 0, coverage: 0
      });
      break;
    case 'night':
      renderNightFrame(buffers, frame.data);
      break;
    default:
      break;
  }

  // Overlays annotate whatever the mode drew. In RGB the canvas is hidden, so
  // the frame has to be painted for them to be visible at all.
  const wantsOverlay = settings.zebraEnabled || settings.focusPeakingEnabled;
  if (wantsOverlay && visionMode === 'camera') {
    drawOverlaysOverRgb(buffers, frame.data);
  } else if (wantsOverlay && visionMode !== 'night') {
    applyCanvasOverlays(buffers);
  }

  computeHistogram(frame.data, histogram);

  if (settings.trackingEnabled && trackedObjects.length && visionMode !== 'camera') {
    drawTrackingOverlay(buffers);
  }
  overlayPhase = (overlayPhase + 1) % 10;

  // Feed the governor from what the scene is actually doing.
  if (settings.visionRatePreference === 'adaptive') {
    const rates = frameRateMeter.report;
    governor.update({
      motionScore: motionValue * 4,
      fastestObjectPxPerSec: settings.trackingEnabled ? tracker.fastestSpeed : 0,
      objectCount: trackedObjects.length,
      flowMagnitudePx: latestFlow?.meanMagnitude ?? 0,
      processingCostMs: rates.averageProcessingMs,
      deliveredFps: rates.deliveredFps,
      droppedFrames: rates.droppedFrames
    }, timestamp);
    adaptiveState = governor.state;
  }

  latestMetrics = {
    brightness: clamp(stats.mean / 255, 0, 1),
    // A standard deviation of ~64 already looks like a high-contrast scene,
    // so that is treated as full scale rather than the theoretical 127.5.
    contrast: clamp(stats.standardDeviation / 64, 0, 1),
    detail: clamp(detail * 3.5, 0, 1),
    motion: clamp(motionValue * 4, 0, 1),
    processingFps: recordProcessingFps(timestamp),
    analysisWidth: buffers.width
  };
  renderMetrics();
  renderObservationMetrics();
  drawHistogram();
}

/**
 * Decide whether a delivered frame should be analysed.
 *
 * Rate limiting happens per DELIVERED frame rather than on a wall clock, so a
 * skipped frame is a frame we chose not to analyse and can be counted as such.
 * The old loop could not tell a skipped frame from a repeated one.
 */
function shouldAnalyse(now: number): boolean {
  const interval = settings.visionRatePreference === 'adaptive'
    ? 1000 / Math.max(1, Math.min(governor.targetFps, maxAnalysisFps()))
    : visionIntervalMs();
  // A small tolerance keeps a 60 fps target from dropping every other frame
  // when delivery jitters either side of the interval.
  return now - lastVisionFrameAt >= interval * 0.92;
}

function analyseDeliveredFrame(now: number): void {
  if (!camera.active || processingVision) return;
  if (!shouldAnalyse(now)) {
    frameRateMeter.recordSkipped();
    return;
  }

  lastVisionFrameAt = now;
  processingVision = true;
  const startedAt = performance.now();
  try {
    processVisionFrame(now);
    frameRateMeter.recordProcessed(now, performance.now() - startedAt);
  } catch {
    // A camera can briefly report no frame while switching; the next delivered
    // frame recovers without the loop stopping.
  } finally {
    processingVision = false;
  }
}

/**
 * Frame delivery from requestVideoFrameCallback.
 *
 * This is the honest driver: it fires once per presented video frame, so the
 * pipeline runs at the camera's rate rather than the display's. A repeated
 * mediaTime means the same image again and is not analysed — re-running the
 * pipeline on it would inflate the processing rate while adding nothing.
 */
function onFrameDelivered(frame: PresentedFrame): void {
  deliveryDriven = true;
  lastDeliveredAt = frame.now;
  const isNew = frameRateMeter.recordDelivered(frame);
  if (!isNew) return;
  analyseDeliveredFrame(frame.now);
}

/**
 * Fallback loop for browsers without requestVideoFrameCallback.
 *
 * It cannot know whether the video holds a new frame, so it measures the
 * display and is explicitly reported as an estimate rather than a measurement.
 */
function fallbackVisionLoop(timestamp: number): void {
  requestAnimationFrame(fallbackVisionLoop);
  // Once real frame delivery is running this loop must not also analyse, or
  // every frame would be processed twice.
  if (deliveryDriven && timestamp - lastDeliveredAt < 1000) return;
  if (!camera.active) return;
  analyseDeliveredFrame(timestamp);
}

function percent(value: number): string {
  return `${Math.round(clamp(value, 0, 1) * 100)}%`;
}

function renderMetrics(): void {
  if (!latestMetrics) {
    for (const id of ['metricBrightness', 'metricContrast', 'metricDetail', 'metricMotion', 'metricFps']) {
      setText(id, '—');
    }
    renderZoomMetric();
    return;
  }

  setText('metricBrightness', percent(latestMetrics.brightness));
  setText('metricContrast', percent(latestMetrics.contrast));
  setText('metricDetail', percent(latestMetrics.detail));
  setText('metricMotion', percent(latestMetrics.motion));
  setText('metricFps', `${Math.round(latestMetrics.processingFps)} FPS`);
  renderZoomMetric();
}

function zoomKindLabel(kind: CameraZoomState['kind']): string {
  if (kind === 'camera') return 'Camera';
  if (kind === 'digital') return 'Digital';
  return 'None';
}

function renderZoomMetric(): void {
  setText('metricZoom', zoomState.kind === 'none'
    ? '—'
    : `${zoomState.value.toFixed(1)}× ${zoomKindLabel(zoomState.kind)}`);
}

function resetVisionState(): void {
  visionBuffers = null;
  latestMetrics = null;
  latestFlow = null;
  smoothedFps = 0;
  lastProcessedAt = 0;
  visionContext.clearRect(0, 0, visionCanvas.width, visionCanvas.height);
  renderMetrics();
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
    },
    vision: {
      mode: visionMode,
      metrics: latestMetrics,
      zoom: zoomState.value,
      zoomKind: zoomState.kind
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
  byId<HTMLSelectElement>('cameraFrameRate').value = settings.cameraFrameRate;
  byId<HTMLInputElement>('trackingToggle').checked = settings.trackingEnabled;
  byId<HTMLInputElement>('zebraToggle').checked = settings.zebraEnabled;
  byId<HTMLInputElement>('focusPeakToggle').checked = settings.focusPeakingEnabled;
  byId<HTMLSelectElement>('trailPreference').value = settings.trailPreference;
  byId<HTMLSelectElement>('nightStackMode').value = settings.nightStackMode;
  byId<HTMLSelectElement>('nightIntegration').value = String(settings.nightIntegrationSeconds);
  byId<HTMLSelectElement>('nightPalette').value = settings.nightPalette;
  byId<HTMLInputElement>('nightGain').value = String(settings.nightGain);
  byId<HTMLInputElement>('nightGamma').value = String(settings.nightGamma);
  setText('nightGainValue', `${settings.nightGain.toFixed(1)}×`);
  setText('nightGammaValue', settings.nightGamma.toFixed(2));
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

  const diagnostics = camera.diagnostics;

  setText('settingsCameraStream', camera.active
    ? `Live • ${diagnostics.videoWidth || '?'}×${diagnostics.videoHeight || '?'} • ${diagnostics.facing}`
    : 'Idle / no live track');
  setText('settingsCameraState', diagnostics.reason
    ? `${diagnostics.state} • ${diagnostics.reason}`
    : diagnostics.state);
  setText('settingsCameraStage', diagnostics.stage);
  setText('settingsCameraLabel', diagnostics.trackLabel || 'Not exposed by WebKit');
  setText('settingsTrackState', `${diagnostics.trackState}${diagnostics.trackMuted ? ' • muted' : ''}${diagnostics.trackEnabled ? '' : ' • disabled'}`);
  setText('settingsVideoState', `readyState ${diagnostics.readyState} • ${diagnostics.videoWidth}×${diagnostics.videoHeight} • ${diagnostics.paused ? 'paused' : 'playing'}`);

  // The honest liveness signal: a stream that resolves but never presents a
  // decoded frame is a WebKit failure, not a working camera.
  setText('settingsFirstFrame', diagnostics.frameEvidence && diagnostics.firstFrameMs !== null
    ? `${diagnostics.firstFrameMs} ms via ${diagnostics.firstFrameVia}`
    : diagnostics.state === 'live'
      ? 'Waiting for evidence'
      : 'No decoded frame observed');

  setText('settingsZoomSupport', diagnostics.zoomKind === 'camera'
    ? `Hardware zoom ${diagnostics.zoomMin.toFixed(1)}–${diagnostics.zoomMax.toFixed(1)}× • now ${diagnostics.zoomValue.toFixed(1)}×`
    : diagnostics.zoomKind === 'digital'
      ? `Not exposed • digital crop 1.0–${diagnostics.zoomMax.toFixed(1)}× • now ${diagnostics.zoomValue.toFixed(1)}×`
      : 'Unavailable until the camera is live');

  setText('settingsProcessingFps', latestMetrics
    ? `${Math.round(latestMetrics.processingFps)} FPS • ${latestMetrics.analysisWidth}px analysis`
    : 'Not processing');

  setText('settingsImageCapture', 'ImageCapture' in window ? 'Available' : 'Not exposed');
  setText('settingsLastAttempt', describeAttempt(camera.attempts[0]));
  setText('settingsPermission', await camera.permissionState());

  const rates = frameRateMeter.report;
  const info = camera.frameRateInfo;
  setText('benchCapability', info.capability
    ? `${info.capability.min}–${info.capability.max} FPS`
    : 'Not exposed');
  setText('benchRequested', info.requested === 'auto' ? 'Auto Max' : `${info.requested} FPS`);
  setText('benchReported', info.reported > 0 ? `${info.reported} FPS` : 'Not reported');
  setText('benchMeasured', rates.deliveredFps > 0
    ? `${rates.deliveredFps.toFixed(1)} FPS${deliveryDriven ? '' : ' (estimated)'}`
    : 'Not measured');
  setText('benchProcessing', `${rates.processingFps.toFixed(1)} FPS`);
  setText('benchAvgMs', `${rates.averageProcessingMs.toFixed(2)} ms`);
  setText('benchPeakMs', `${rates.peakProcessingMs.toFixed(2)} ms`);
  setText('benchSkipped', `${rates.skippedFrames} skipped / ${rates.droppedFrames} dropped`);
  setText('benchAnalysis', latestMetrics
    ? `${latestMetrics.analysisWidth} px wide`
    : 'Not processing');
  setText('benchResolution', diagnostics.videoWidth
    ? `${diagnostics.videoWidth} × ${diagnostics.videoHeight}`
    : 'Not live');

  setText('settingsAdaptive', settings.visionRatePreference === 'adaptive'
    ? `${adaptiveState} · target ${Math.round(governor.targetFps)} FPS`
    : `Fixed · ${settings.visionRatePreference}`);
  setText('settingsTracking', settings.trackingEnabled
    ? `${trackedObjects.length} tracked · fastest ${Math.round(tracker.fastestSpeed)} px/s`
    : 'Disabled');
  const nightReport = integrator.report(performance.now());
  setText('settingsNight', nightModeActive
    ? `${nightReport.mode} · ${nightReport.framesIntegrated} frames · ${(nightReport.elapsedMs / 1000).toFixed(1)} s · stability ${Math.round(stability.report.score * 100)}%`
    : 'Inactive');
  renderCapabilityTable();
  await renderVideoInputs();
  await refreshStorageEstimate();
}

/**
 * One-line summary of a recorded camera attempt.
 *
 * `pending` is called out explicitly because it is the one outcome the live
 * state can never show: getUserMedia was entered and never came back.
 */
function describeAttempt(attempt: CameraAttempt | undefined): string {
  if (!attempt) return 'No camera attempt recorded yet';

  const when = attempt.at.replace('T', ' ').replace(/\..*$/, 'Z');
  const where = attempt.standalone ? 'standalone' : 'browser';

  if (attempt.outcome === 'pending') {
    return `${when} • ${where} • getUserMedia never settled — no prompt, no resolve, no reject`;
  }
  if (attempt.outcome === 'live') {
    return `${when} • ${where} • live after ${attempt.elapsedMs} ms, first frame ${attempt.firstFrameMs} ms via ${attempt.firstFrameVia}`;
  }
  if (attempt.outcome === 'unsupported') {
    return `${when} • ${where} • getUserMedia not exposed in this context`;
  }

  const reason = attempt.errorName || 'failure';
  return `${when} • ${where} • ${reason} at stage "${attempt.stage}" after ${attempt.elapsedMs} ms`
    + ` • track ${attempt.trackState}${attempt.trackMuted ? ' (muted)' : ''}`
    + ` • video ${attempt.videoWidth}×${attempt.videoHeight}`;
}

/**
 * Copy the full diagnostic report, including the cross-reload attempt log,
 * so it can be pasted somewhere useful instead of retyped from a screenshot.
 */
async function copyDiagnostics(): Promise<void> {
  const diagnostics = camera.diagnostics;
  const report = {
    app: APP_VERSION,
    capturedAt: new Date().toISOString(),
    displayMode: isStandalone() ? 'standalone' : 'browser',
    secureContext: window.isSecureContext,
    userAgent: navigator.userAgent,
    getUserMedia: Boolean(navigator.mediaDevices?.getUserMedia),
    supportedConstraints: navigator.mediaDevices?.getSupportedConstraints?.() ?? null,
    camera: diagnostics,
    permissionState: await camera.permissionState(),
    settings,
    metrics: latestMetrics,
    bootProblems,
    attempts: camera.attempts
  };
  const text = JSON.stringify(report, null, 2);

  try {
    await navigator.clipboard.writeText(text);
    setText('updateStatus', 'Diagnostics copied to the clipboard.');
  } catch {
    // Clipboard access can be refused; a download still gets the data out.
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `visual-sensor-diagnostics-${Date.now()}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setText('updateStatus', 'Clipboard was blocked, so diagnostics were downloaded instead.');
  }
}

/**
 * Storage headroom, where the browser reports it.
 *
 * Deliberately not asserting any fixed iOS quota: the old 50 MB figure is out
 * of date and the real allowance is dynamic, so the reported estimate is shown
 * as-is rather than compared against a hard-coded limit.
 */
async function refreshStorageEstimate(): Promise<void> {
  const storage = navigator.storage as StorageManager | undefined;
  if (!storage || typeof storage.estimate !== 'function') {
    setText('settingsStorage', 'Estimate unavailable');
    return;
  }

  try {
    const estimate = await storage.estimate();
    const usedMb = (estimate.usage ?? 0) / (1024 * 1024);
    const quotaMb = (estimate.quota ?? 0) / (1024 * 1024);
    let persisted = '';
    if (typeof storage.persisted === 'function') {
      persisted = (await storage.persisted()) ? ' • persistent' : ' • best-effort';
    }
    setText('settingsStorage', quotaMb > 0
      ? `${usedMb.toFixed(1)} MB used of ${quotaMb.toFixed(0)} MB${persisted}`
      : `${usedMb.toFixed(1)} MB used${persisted}`);
  } catch {
    setText('settingsStorage', 'Estimate blocked');
  }
}

/** Live histogram, drawn as a compact luminance plot. */
function drawHistogram(): void {
  const canvas = byId<HTMLCanvasElement>('histogramCanvas');
  const context = canvas.getContext('2d');
  if (!context) return;

  const { width, height } = canvas;
  context.clearRect(0, 0, width, height);
  context.fillStyle = 'rgba(5, 12, 19, 0.75)';
  context.fillRect(0, 0, width, height);

  const peak = histogram.peakLuminanceBin || 1;
  context.fillStyle = 'rgba(118, 209, 255, 0.75)';
  for (let bin = 0; bin < 256; bin++) {
    // Square root compresses the tall midtone peak so shadow and highlight
    // detail stay visible instead of being flattened against the axis.
    const value = Math.sqrt(histogram.luminance[bin] / peak);
    const barHeight = value * height;
    context.fillRect(bin, height - barHeight, 1, barHeight);
  }

  if (histogram.clippedFraction > 0.001) {
    context.fillStyle = 'rgba(255, 90, 120, 0.9)';
    context.fillRect(width - 3, 0, 3, height);
  }
  if (histogram.crushedFraction > 0.02) {
    context.fillStyle = 'rgba(255, 196, 107, 0.75)';
    context.fillRect(0, 0, 3, height);
  }
}

function renderObservationMetrics(): void {
  const rates = frameRateMeter.report;
  const info = camera.frameRateInfo;

  setText('metricDelivered', rates.deliveredFps > 0
    ? `${rates.deliveredFps.toFixed(1)} fps`
    : deliveryDriven ? '—' : 'estimated');
  setText('metricAnalysis', `${rates.processingFps.toFixed(1)} fps`);
  setText('metricAdaptive', settings.visionRatePreference === 'adaptive'
    ? `${adaptiveState} ${Math.round(governor.targetFps)}`
    : settings.visionRatePreference);
  setText('metricObjects', settings.trackingEnabled ? String(trackedObjects.length) : 'off');
  setText('metricFastest', settings.trackingEnabled && tracker.fastestSpeed > 0
    ? `${Math.round(tracker.fastestSpeed)} px/s`
    : '—');
  setText('metricDropped', `${rates.droppedFrames}/${rates.skippedFrames}`);

  if (nightModeActive) {
    const report = integrator.report(performance.now());
    const stabilityReport = stability.report;
    setText('nightIntegrationState', report.complete
      ? `Complete · ${(report.elapsedMs / 1000).toFixed(1)} s`
      : `${(report.elapsedMs / 1000).toFixed(1)} / ${settings.nightIntegrationSeconds} s`);
    setText('nightFrames', String(report.framesIntegrated));
    setText('nightStability', latestMotion
      ? `${Math.round(stabilityReport.score * 100)}% ${stabilityReport.tripod ? '· tripod' : stabilityReport.disturbed ? '· moving' : ''}`
      : 'Enable motion sensors');
  }

  void info;
}

/**
 * Run the frame-rate benchmark.
 *
 * The camera keeps running throughout: each rate is applied to the live track
 * with applyConstraints, never with a fresh getUserMedia call, so this cannot
 * re-prompt for permission or drop the stream.
 */
async function runBenchmark(): Promise<void> {
  const button = byId<HTMLButtonElement>('runBenchmarkButton');
  const results = byId('benchmarkResults');
  if (!camera.active) {
    setText('benchmarkStatus', 'Enable the camera before benchmarking.');
    return;
  }

  button.disabled = true;
  results.textContent = '';
  setText('benchmarkStatus', 'Testing frame rates on the live track…');

  try {
    const report = await camera.benchmarkFrameRates([30, 60, 120, 240], 1200, (progress) => {
      setText('benchmarkStatus', `Testing ${progress.rate} FPS…`);
    });

    if (!report.supported) {
      setText('benchmarkStatus', report.reason ?? 'Benchmarking is unavailable in this browser.');
      return;
    }

    for (const row of report.results) {
      const line = document.createElement('div');
      line.className = `benchmark-row ${row.verdict}`;
      const detail = row.verdict === 'unsupported'
        ? row.reason || 'refused'
        : `reports ${row.reported || '?'} · measured ${row.measuredFps} fps`;
      line.textContent = `${row.requested} FPS · ${row.verdict} · ${detail}`;
      results.appendChild(line);
    }

    const best = report.results
      .filter((row) => row.verdict === 'accepted' || row.verdict === 'negotiated')
      .reduce<number>((max, row) => Math.max(max, row.measuredFps), 0);
    setText('benchmarkStatus', best > 0
      ? `Highest rate this device actually delivered: ${best.toFixed(1)} FPS. Requested rates above that were negotiated down or refused.`
      : 'No requested rate produced measurable frames.');
  } catch (error) {
    setText('benchmarkStatus', error instanceof Error ? error.message : 'Benchmark failed.');
  } finally {
    button.disabled = false;
    await applyCameraFrameRate();
  }
}

/**
 * List the video inputs WebKit reports.
 *
 * On an iPhone the ultrawide is a separate physical camera, so a genuine 0.5x
 * is only reachable if it appears here as its own input (or if the track
 * advertises a zoom capability with a min below 1). A digital crop cannot
 * widen the field of view, so it can never produce 0.5x however the range is
 * configured.
 */
async function renderVideoInputs(): Promise<void> {
  const container = byId('videoInputs');
  const report = await camera.videoInputs();
  container.textContent = '';

  if (!report.available) {
    container.textContent = 'Device enumeration is unavailable in this context.';
    return;
  }
  if (!report.devices.length) {
    container.textContent = 'No video inputs reported.';
    return;
  }

  for (const [index, device] of report.devices.entries()) {
    const row = document.createElement('div');
    row.className = 'capability-row';
    const label = document.createElement('span');
    label.textContent = device.label || `Camera ${index + 1} (label hidden)`;
    const value = document.createElement('strong');
    value.dataset.state = device.label ? 'supported' : 'not exposed';
    value.textContent = device.label ? 'Labelled' : 'Needs permission';
    row.append(label, value);
    container.appendChild(row);
  }

  if (report.devices.length === 1) {
    const note = document.createElement('p');
    note.className = 'helper';
    note.textContent = 'Only one video input is exposed, so the ultrawide cannot be selected separately here and zoom below 1× is not available.';
    container.appendChild(note);
  }
}

/** Render whatever WebKit exposes about the live track, without inventing any of it. */
function renderCapabilityTable(): void {
  const container = byId('capabilityTable');
  const report = camera.capabilityReport;
  container.textContent = '';

  if (!report.available) {
    container.textContent = camera.active
      ? 'This browser exposes no track capabilities at all.'
      : 'Enable the camera to read capabilities.';
    return;
  }

  const labels: Record<string, string> = {
    zoom: 'Zoom', torch: 'Torch', focusMode: 'Focus Mode', focusDistance: 'Focus Distance',
    exposureMode: 'Exposure Mode', exposureCompensation: 'Exposure Compensation',
    exposureTime: 'Exposure Time', iso: 'ISO', whiteBalanceMode: 'White Balance',
    frameRate: 'Frame Rate', width: 'Width', height: 'Height'
  };

  for (const [name, field] of Object.entries(report.fields)) {
    const row = document.createElement('div');
    row.className = 'capability-row';
    const label = document.createElement('span');
    label.textContent = labels[name] ?? name;
    const value = document.createElement('strong');
    value.dataset.state = field.state;

    if (field.state !== 'supported') {
      value.textContent = field.state === 'unsupported' ? 'Unsupported' : 'Not exposed';
    } else if (field.min !== undefined && field.max !== undefined) {
      value.textContent = `Supported · ${field.min}–${field.max}`;
    } else if (field.options) {
      value.textContent = `Supported · ${field.options.join(', ')}`;
    } else {
      value.textContent = `Supported · ${String(field.value)}`;
    }

    row.append(label, value);
    container.appendChild(row);
  }
}

function openSettings(): void {
  syncSettingsControls();
  void refreshSettingsDiagnostics();
  const dialog = byId<HTMLDialogElement>('settingsDialog');
  if (!dialog.open) dialog.showModal();
}

function saveSettingFromControls(): void {
  // Spread the existing settings rather than rebuilding the object: the Night
  // and overlay preferences live outside this dialog, and listing only the
  // dialog's own fields here would silently reset them on every change.
  settings = {
    ...settings,
    cameraPreference: byId<HTMLSelectElement>('cameraPreference').value as CameraPreference,
    qualityPreference: byId<HTMLSelectElement>('qualityPreference').value as QualityPreference,
    visionRatePreference: byId<HTMLSelectElement>('visionRatePreference').value as VisionRatePreference,
    gpsAccuracyPreference: byId<HTMLSelectElement>('gpsAccuracyPreference').value as GpsAccuracyPreference,
    cameraFrameRate: byId<HTMLSelectElement>('cameraFrameRate').value as CameraFrameRatePreference
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
  // The analysis width changes with the preset, so the frame buffers must be
  // rebuilt rather than reused at the old geometry.
  resetVisionState();
  setText('visionModeLabel', `${MODE_LABELS[visionMode]} • ${settings.visionRatePreference}`);
  // The diagnostics panel reports the analysis width and processing rate, and
  // neither is true until a few frames have run at the new preset - the rate
  // is a moving average and needs at least two. Wait for three of the new
  // preset's intervals, so Battery Saver gets the same treatment as Fast.
  window.setTimeout(() => void refreshSettingsDiagnostics(), visionIntervalMs() * 3 + 100);
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
  camera.clearAttempts();
  settings = { ...DEFAULT_SETTINGS };
  saveSettings();
  syncSettingsControls();
  fusion.setQuality(settings.qualityPreference);
  setText('updateStatus', 'Settings reset to defaults and the camera attempt log was cleared.');
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
      registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
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

/**
 * Wire one listener without letting a missing element kill the rest of boot.
 *
 * These were previously a run of bare `byId(...).addEventListener(...)`
 * statements at module top level. A single missing id threw, and because
 * everything below is also top-level, the throw silently skipped the rest of
 * the wiring - including `camera.subscribe(applyCameraStatus)`, which is what
 * makes the camera UI respond at all. The visible symptom of that is a button
 * that appears to do nothing, with no error anywhere the user can see. One
 * missing id should cost one control, not the whole panel.
 */
function on<K extends keyof HTMLElementEventMap>(
  id: string,
  event: K,
  handler: (event: HTMLElementEventMap[K]) => void
): void {
  const element = document.getElementById(id);
  if (!element) {
    bootProblems.push(`#${id} is missing, so its control does nothing`);
    return;
  }
  element.addEventListener(event, handler as EventListener);
}

on('cameraButton', 'click', () => void startCamera());
on('cameraOverlayButton', 'click', () => void startCamera());
on('cameraBrowserFallback', 'click', openCameraInBrowser);
on('switchCameraButton', 'click', () => void switchCamera());
on('motionButton', 'click', () => void enableMotion());
on('gpsButton', 'click', toggleGps);
on('resetGpsButton', 'click', resetGps);
on('captureParallaxButton', 'click', captureParallaxReference);
on('analyzeParallaxButton', 'click', analyzeParallax);
on('resetViewButton', 'click', () => fusion.resetView());
on('downloadButton', 'click', downloadSnapshot);
on('settingsButton', 'click', openSettings);
on('checkUpdatesButton', 'click', () => void checkForUpdates());
on('applyUpdateButton', 'click', applyUpdate);
on('clearCacheButton', 'click', () => void clearAppCache());
on('resetSettingsButton', 'click', resetSettings);
on('hardResetCameraButton', 'click', hardResetCamera);
on('refreshDiagnosticsButton', 'click', () => void refreshSettingsDiagnostics());
on('copyDiagnosticsButton', 'click', () => void copyDiagnostics());
on('zoomSlider', 'input', (event) => {
  void requestZoom(Number((event.target as HTMLInputElement).value));
});
on('runBenchmarkButton', 'click', () => void runBenchmark());
on('resetPeakButton', 'click', () => {
  frameRateMeter.resetPeak();
  void refreshSettingsDiagnostics();
});
on('nightRestartButton', 'click', () => {
  integrator.reset();
  setText('nightIntegrationState', 'Restarted');
});
on('trackingToggle', 'change', (event) => {
  settings.trackingEnabled = (event.target as HTMLInputElement).checked;
  if (!settings.trackingEnabled) {
    tracker.reset();
    trackedObjects = [];
  }
  saveSettings();
});
on('zebraToggle', 'change', (event) => {
  settings.zebraEnabled = (event.target as HTMLInputElement).checked;
  saveSettings();
  updateVisionMode(visionMode);
});
on('focusPeakToggle', 'change', (event) => {
  settings.focusPeakingEnabled = (event.target as HTMLInputElement).checked;
  saveSettings();
  updateVisionMode(visionMode);
});
on('trailPreference', 'change', (event) => {
  settings.trailPreference = (event.target as HTMLSelectElement).value as TrailPreference;
  saveSettings();
});
on('nightStackMode', 'change', (event) => {
  settings.nightStackMode = (event.target as HTMLSelectElement).value as StackMode;
  integrator.setMode(settings.nightStackMode);
  saveSettings();
});
on('nightIntegration', 'change', (event) => {
  settings.nightIntegrationSeconds = Number((event.target as HTMLSelectElement).value) || 4;
  integrator.reset();
  saveSettings();
});
on('nightPalette', 'change', (event) => {
  settings.nightPalette = (event.target as HTMLSelectElement).value as NightPalette;
  saveSettings();
});
on('nightGain', 'input', (event) => {
  settings.nightGain = Number((event.target as HTMLInputElement).value) || 1;
  setText('nightGainValue', `${settings.nightGain.toFixed(1)}×`);
  saveSettings();
});
on('nightGamma', 'input', (event) => {
  settings.nightGamma = Number((event.target as HTMLInputElement).value) || 1;
  setText('nightGammaValue', settings.nightGamma.toFixed(2));
  saveSettings();
});
on('cameraFrameRate', 'change', () => {
  saveSettingFromControls();
  void applyCameraFrameRate().then(() => refreshSettingsDiagnostics());
  setText('cameraMessage', settings.cameraFrameRate === 'auto'
    ? 'Requesting the highest frame rate this camera configuration will negotiate. The Camera Performance panel reports what it actually delivered.'
    : `Requested ${settings.cameraFrameRate} FPS. WebKit may negotiate a different rate — the measured value is what counts.`);
});
on('cameraPreference', 'change', handleCameraPreferenceChange);
on('qualityPreference', 'change', handleQualityChange);
on('visionRatePreference', 'change', handleVisionRateChange);
on('gpsAccuracyPreference', 'change', handleGpsAccuracyChange);

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-vision-mode]')) {
  button.addEventListener('click', () => updateVisionMode(button.dataset.visionMode as VisionMode));
}

const bootUrl = new URL(window.location.href);
const browserCameraMode = bootUrl.searchParams.get('camera-browser') === '1';

/**
 * Drop our own cache-busting parameter from the address bar before the camera
 * is ever requested.
 *
 * WebKit binds a capture grant to the top frame document's current URL, so an
 * installed PWA left sitting on `?refresh=1724983…` after an update is running
 * on a different URL from its `start_url`, and a later URL change can tear the
 * media environment down mid-capture. One replaceState at boot, before any
 * getUserMedia call, keeps the document on a stable URL for the whole session.
 */
if (bootUrl.searchParams.has('refresh') && typeof history.replaceState === 'function') {
  bootUrl.searchParams.delete('refresh');
  try {
    history.replaceState(null, '', bootUrl.toString());
  } catch {
    // A blocked history write is harmless; the app just keeps the parameter.
  }
}

setText('secureContextValue', window.isSecureContext ? 'Secure ✓' : 'Needs HTTPS');
setChip('pwaChip', 'good', isStandalone() ? 'PWA installed' : browserCameraMode ? 'Browser camera mode' : 'PWA ready');
syncSettingsControls();
updateVisionMode('camera');
installPinchZoom();
camera.subscribe(applyCameraStatus);
renderMetrics();
requestAnimationFrame(fallbackVisionLoop);
void initializeFusion();
void refreshSettingsDiagnostics();

// A control that silently does nothing is the hardest kind of bug to report,
// so say so rather than leaving the user to guess.
if (bootProblems.length) {
  setText('cameraMessage', `App wiring problem: ${bootProblems.join('; ')}. Reload, or use Clear App Cache & Reload in Settings.`);
  setChip('cameraChip', 'warn', 'App wiring problem');
}

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
    // `updateViaCache: 'none'` keeps the HTTP cache out of the worker's own
    // update check, so a stale sw.js cannot pin the app to an old build.
    void navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((registration) => {
      observeServiceWorkerRegistration(registration);
      return registration.update();
    }).then(() => refreshSettingsDiagnostics()).catch(() => {
      setChip('pwaChip', 'warn', 'PWA cache unavailable');
      setText('settingsWorkerState', 'Registration failed');
    });
  });
}
