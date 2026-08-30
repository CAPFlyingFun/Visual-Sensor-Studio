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
import { estimateEffectiveResolution } from './vision/sharpness.js';
import {
  EventDetector,
  degreesPerSecond,
  type EventPhase,
  type ObservationEvent
} from './vision/observation.js';
import {
  MotionSpeedField,
  MotionTrailBuffer,
  renderMotionIronbow,
  upscaleSpeedField,
  ironbowColor,
  UNRESOLVED_COLOR,
  type MotionSpeedReport,
  type MotionTrailReport
} from './vision/motion-ironbow.js';
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

const APP_VERSION = '0.8.2';
const SETTINGS_KEY = 'visual-sensor-settings-v1';
const CACHE_PREFIX = 'visual-sensor-studio-';

type CameraPreference = 'auto' | CameraFacing;
type QualityPreference = 'low' | 'normal' | 'high';
type VisionRatePreference = 'battery' | 'balanced' | 'fast' | 'adaptive';
type CameraFrameRatePreference = 'auto' | '30' | '60' | '120' | '240';
type TrailPreference = 'off' | 'short' | 'medium' | 'long';
type CaptureResolution = '720' | '1080' | '1440' | '2160';
type GpsAccuracyPreference = 'balanced' | 'high';

interface AppSettings {
  cameraPreference: CameraPreference;
  qualityPreference: QualityPreference;
  visionRatePreference: VisionRatePreference;
  gpsAccuracyPreference: GpsAccuracyPreference;
  cameraFrameRate: CameraFrameRatePreference;
  captureResolution: CaptureResolution;
  trackingEnabled: boolean;
  trailPreference: TrailPreference;
  zebraEnabled: boolean;
  focusPeakingEnabled: boolean;
  nightPalette: NightPalette;
  nightStackMode: StackMode;
  nightIntegrationSeconds: number;
  nightGain: number;
  nightGamma: number;
  motionExposureSeconds: number;
  motionSensitivity: number;
  motionKeepFastest: boolean;
  motionFadeTrails: boolean;
  motionEventTrigger: boolean;
  /** Horizontal field of view in degrees, entered by hand. 0 means unknown. */
  motionFovDegrees: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  cameraPreference: 'auto',
  qualityPreference: 'normal',
  // Adaptive is the default: it idles lower than Balanced on a still scene and
  // climbs far above it when something actually moves, which is the whole point.
  visionRatePreference: 'adaptive',
  gpsAccuracyPreference: 'high',
  cameraFrameRate: 'auto',
  captureResolution: '1080',
  trackingEnabled: true,
  trailPreference: 'medium',
  zebraEnabled: false,
  focusPeakingEnabled: false,
  nightPalette: 'natural',
  nightStackMode: 'clean',
  nightIntegrationSeconds: 4,
  nightGain: 1,
  nightGamma: 1,
  motionExposureSeconds: 5,
  motionSensitivity: 18,
  motionKeepFastest: true,
  motionFadeTrails: true,
  motionEventTrigger: false,
  motionFovDegrees: 0
};

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

function setText(id: string, value: string): void {
  // Assigning undefined to textContent yields an empty element rather than a
  // visible error, so a field that has gone missing looks like a blank readout
  // instead of the version mismatch it actually is.
  byId(id).textContent = value === undefined || value === null ? '—' : value;
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
      captureResolution: ['720', '1080', '1440', '2160'].includes(String(parsed.captureResolution))
        ? parsed.captureResolution as CaptureResolution
        : DEFAULT_SETTINGS.captureResolution,
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
      nightGamma: Number.isFinite(parsed.nightGamma) ? clamp(Number(parsed.nightGamma), 0.3, 2) : DEFAULT_SETTINGS.nightGamma,
      motionExposureSeconds: Number.isFinite(parsed.motionExposureSeconds)
        ? clamp(Number(parsed.motionExposureSeconds), 1, 60)
        : DEFAULT_SETTINGS.motionExposureSeconds,
      motionSensitivity: Number.isFinite(parsed.motionSensitivity)
        ? clamp(Number(parsed.motionSensitivity), 4, 60)
        : DEFAULT_SETTINGS.motionSensitivity,
      motionKeepFastest: typeof parsed.motionKeepFastest === 'boolean'
        ? parsed.motionKeepFastest
        : DEFAULT_SETTINGS.motionKeepFastest,
      motionFadeTrails: typeof parsed.motionFadeTrails === 'boolean'
        ? parsed.motionFadeTrails
        : DEFAULT_SETTINGS.motionFadeTrails,
      motionEventTrigger: typeof parsed.motionEventTrigger === 'boolean'
        ? parsed.motionEventTrigger
        : DEFAULT_SETTINGS.motionEventTrigger,
      motionFovDegrees: Number.isFinite(parsed.motionFovDegrees)
        ? clamp(Number(parsed.motionFovDegrees), 0, 180)
        : DEFAULT_SETTINGS.motionFovDegrees
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
let latestSpeed: MotionSpeedReport | null = null;
let latestTrail: MotionTrailReport | null = null;
/** When the previous analysed frame was captured, for per-second speeds. */
let lastAnalysisAt = 0;
/** Holds the trail for inspection. The camera keeps running underneath. */
let trailFrozen = false;
let eventPhase: EventPhase = 'idle';
let activeEvent: ObservationEvent | null = null;
let lastCompletedEvent: ObservationEvent | null = null;
let zoomState: CameraZoomState = { value: 1, min: 1, max: 1, step: 0.1, kind: 'none' };
const frameRateMeter = new FrameRateMeter();
const governor = new AdaptiveGovernor();
const tracker = new ObjectTracker();
const integrator = new FrameIntegrator();
const speedField = new MotionSpeedField();
const motionTrails = new MotionTrailBuffer();
const eventDetector = new EventDetector();
const histogram = createHistogram();
const stability = new StabilityMonitor();

let nightModeActive = false;
let trackedObjects: readonly TrackedObject[] = [];
let adaptiveState: AdaptiveState = 'idle';
let lastDeliveredAt = 0;
/**
 * When analysis last actually produced a frame.
 *
 * Distinct from lastDeliveredAt on purpose. A delivered callback that is then
 * discarded downstream — as a duplicate, by the rate governor, or by a failed
 * capture — is not progress, and must not count as the pipeline working.
 */
let lastAnalysedAt = 0;
/**
 * When frame DELIVERY last produced an analysed frame.
 *
 * Separate from lastAnalysedAt because the fallback loop updates that one
 * too, and would then see it fresh and switch itself off — running at two
 * frames a second instead of taking over properly.
 */
let lastDeliveryAnalysedAt = 0;
let deliveryDriven = false;
let boostLut: Uint8ClampedArray | undefined;
let overlayPhase = 0;
/**
 * Whether the overlay canvas currently holds a painted frame.
 *
 * The canvas is opaque and sits on top of the video, so revealing it before
 * anything has been drawn covers a perfectly good preview with a black
 * rectangle — which is exactly what happened when focus peaking was enabled
 * and the pipeline stalled. It stays hidden until it has real content.
 */
let overlayPainted = false;

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
    || visionMode === 'flow'
    || visionMode === 'speed'
    || visionMode === 'motiontrails';
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
/**
 * Pixel budget per analysed frame, by preset.
 *
 * A budget rather than a width, because the width alone does not bound the
 * work. A phone held upright delivers 720x1280, and a fixed 256-wide analysis
 * frame becomes 256x455 — 116k pixels against the 36k a 256x144 landscape
 * frame costs. Every stage then does three times the work for no extra
 * information, on the orientation the device is most often in.
 */
function analysisBudget(): number {
  if (settings.visionRatePreference === 'battery') return 176 * 99;
  if (settings.visionRatePreference === 'fast') return 384 * 216;
  return 256 * 144;
}

function analysisWidth(): number {
  const budget = analysisBudget();
  const diagnostics = camera.diagnostics;
  const sourceWidth = diagnostics.videoWidth;
  const sourceHeight = diagnostics.videoHeight;
  if (!sourceWidth || !sourceHeight) return Math.round(Math.sqrt(budget * (16 / 9)));

  // width * height = budget, with height = width / aspect.
  const aspect = sourceWidth / sourceHeight;
  return Math.max(96, Math.round(Math.sqrt(budget * aspect)));
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
  const parallaxButton = byId<HTMLButtonElement>('captureParallaxButton');

  zoomState = status.zoom;
  if (viewerOpen) buildViewerControls();
  const facingLabel = status.facing === 'environment' ? 'rear' : 'front';
  const live = status.state === 'live';

  // A visible stage trace, so a stalled request can be seen without digging
  // into Settings. If a tap leaves this blank, the request never started; if
  // it sticks on "getUserMedia", WebKit took the call and never answered.
  const trace = byId('cameraStage');
  trace.hidden = status.state === 'idle' || status.state === 'live';
  trace.textContent = `stage: ${status.stage}`;

  // Re-label on every status change, so both toggles stay correct when the side
  // changes for a reason other than the button — a lens pick, a restart.
  syncCameraSwitchLabel(status.facing, live);
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
      syncManualControls();
      void renderLensPicker();
      break;

    case 'suspended':
      setChip('cameraChip', 'warn', 'Camera suspended');
      overlay.hidden = false;
      overlay.disabled = false;
      overlay.textContent = 'Resume Camera';
      button.disabled = false;
      button.textContent = 'Resume Camera';
      resetVisionState();
      if (viewerOpen) setViewerOpen(false);
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
    await applyCaptureResolution();
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

/**
 * Apply the capture resolution, then report what was actually negotiated and
 * what it cost in frame rate — the trade is the point of the control.
 */
async function applyCaptureResolution(): Promise<void> {
  try {
    await camera.setCaptureHeight(Number(settings.captureResolution));
  } catch {
    // A refused resolution leaves the previous one in force.
  }
  window.setTimeout(() => {
    const diagnostics = camera.diagnostics;
    const info = camera.frameRateInfo;
    if (!diagnostics.videoWidth) return;
    setText('cameraMessage', `Camera negotiated ${diagnostics.videoWidth}×${diagnostics.videoHeight}`
      + `${info.reported ? ` at ${info.reported} FPS` : ''}. Higher resolutions usually cost frame rate —`
      + ' the Camera Performance panel shows what is actually delivered.');
    void refreshSettingsDiagnostics();
  }, 700);
}

function startFrameDelivery(): void {
  frameRateMeter.reset();
  governor.reset();
  tracker.reset();
  trackedObjects = [];
  deliveryDriven = camera.startFrameDelivery(onFrameDelivered);
}

/**
 * Show the motion panel and title it for whichever of the two modes is live.
 *
 * The legend swatches are filled from the SAME lookup table the pixels use
 * rather than from CSS colours typed to match. A hand-copied legend is a
 * legend that silently stops describing the picture the first time the ramp
 * is touched.
 */
function setMotionPanel(active: boolean, mode: VisionMode): void {
  byId('motionPanel').hidden = !active;
  if (!active) return;

  setText('motionPanelTitle', mode === 'motiontrails' ? 'Motion Trails' : 'Motion Ironbow');
  byId('motionTrailControls').querySelectorAll<HTMLElement>('label').forEach((label) => {
    // Trail length, keep-fastest and fade only mean anything to the trail
    // buffer; showing them in Speed would be three controls that do nothing.
    const trailOnly = label.querySelector('#motionExposure, #motionKeepFastest, #motionFadeTrails') !== null;
    label.hidden = trailOnly && mode !== 'motiontrails';
  });

  for (const swatch of document.querySelectorAll<HTMLElement>('#speedLegend .swatch')) {
    if (swatch.classList.contains('unresolved')) {
      swatch.style.background = `rgb(${UNRESOLVED_COLOR.join(',')})`;
      continue;
    }
    const [r, g, b] = ironbowColor(Number(swatch.dataset.speed ?? 0));
    swatch.style.background = `rgb(${r},${g},${b})`;
  }
}

/**
 * Everything the app can honestly say about this instant.
 *
 * The point of writing it down is that a screenshot on its own is unusable
 * later: two trails look identical whether one was a 5 second window and the
 * other 60, and a colour means nothing without the scale it was mapped
 * against. Fields the app does not actually know are omitted rather than
 * filled with a plausible value.
 */
interface ObservationSnapshot {
  capturedAt: string;
  app: string;
  mode: VisionMode;
  motion?: {
    trailWindowSeconds?: number;
    trailFrozen: boolean;
    peakWidthsPerSecond: number;
    meanWidthsPerSecond: number;
    peakPixelsPerSecond: number;
    fullScaleWidthsPerSecond: number;
    movingPercent: number;
    measuredPercent: number;
    inferredPercent: number;
    unknownPercent: number;
    angular?: {
      peakDegreesPerSecond: number;
      assumedHorizontalFovDegrees: number;
      note: string;
    };
  };
  event?: {
    state: EventPhase;
    startedAt: string;
    peakAt: string;
    endedAt: string | null;
    durationMs: number;
    peakWidthsPerSecond: number;
    meanWidthsPerSecond: number;
    frames: number;
  };
  camera: {
    resolution: string;
    analysisWidth: number;
    zoom: string;
    processingFps: number;
    deliveredFps: number;
  };
  position?: {
    latitude: number;
    longitude: number;
    accuracyMetres: number;
    altitudeMetres: number | null;
    headingDegrees: number | null;
  };
  orientation?: {
    compassDegrees: number | null;
    pitchDegrees: number | null;
    rollDegrees: number | null;
  };
  limits: string[];
}

function buildSnapshot(): ObservationSnapshot {
  const diagnostics = camera.diagnostics;
  const rates = frameRateMeter.report;
  const event = activeEvent ?? lastCompletedEvent;

  const snapshot: ObservationSnapshot = {
    capturedAt: new Date().toISOString(),
    app: `Visual Sensor Studio ${APP_VERSION}`,
    mode: visionMode,
    camera: {
      resolution: `${diagnostics.videoWidth}×${diagnostics.videoHeight}`,
      analysisWidth: latestMetrics?.analysisWidth ?? 0,
      zoom: `${zoomState.value.toFixed(1)}× ${zoomState.kind}`,
      processingFps: Number((latestMetrics?.processingFps ?? 0).toFixed(1)),
      deliveredFps: Number(rates.deliveredFps.toFixed(1))
    },
    // Written into the file itself, because a record that travels without its
    // caveats is a record that will eventually be read without them.
    limits: [
      'Colour maps image speed, not temperature. This camera has no infrared sensitivity.',
      'Speeds are image speeds. Nothing here measures distance, size or real-world velocity.',
      'No object identification of any kind is performed.'
    ]
  };

  if (latestSpeed) {
    const measured = 1 - latestSpeed.unresolvedFraction - latestSpeed.inferredFraction;
    snapshot.motion = {
      trailWindowSeconds: visionMode === 'motiontrails' ? settings.motionExposureSeconds : undefined,
      trailFrozen,
      peakWidthsPerSecond: Number(latestSpeed.peakWidthsPerSecond.toFixed(4)),
      meanWidthsPerSecond: Number(latestSpeed.meanWidthsPerSecond.toFixed(4)),
      peakPixelsPerSecond: Math.round(latestSpeed.peakPixelsPerSecond),
      fullScaleWidthsPerSecond: Number(latestSpeed.fullScale.toFixed(4)),
      movingPercent: Number((latestSpeed.movingFraction * 100).toFixed(2)),
      measuredPercent: Number((measured * 100).toFixed(1)),
      inferredPercent: Number((latestSpeed.inferredFraction * 100).toFixed(1)),
      unknownPercent: Number((latestSpeed.unresolvedFraction * 100).toFixed(1))
    };

    const angular = degreesPerSecond(
      latestSpeed.peakWidthsPerSecond,
      settings.motionFovDegrees,
      zoomState.value
    );
    if (angular !== null) {
      snapshot.motion.angular = {
        peakDegreesPerSecond: Number(angular.toFixed(3)),
        assumedHorizontalFovDegrees: settings.motionFovDegrees,
        note: 'Derived from a field of view entered by hand. WebKit exposes no lens '
          + 'geometry, so this figure is exactly as good as that number.'
      };
    }
  }

  if (event) {
    snapshot.event = {
      state: eventPhase,
      startedAt: new Date(event.startedAt).toISOString(),
      peakAt: new Date(event.peakAt).toISOString(),
      endedAt: event.endedAt ? new Date(event.endedAt).toISOString() : null,
      durationMs: Math.round(event.durationMs),
      peakWidthsPerSecond: Number(event.peakWidthsPerSecond.toFixed(4)),
      meanWidthsPerSecond: Number(event.meanWidthsPerSecond.toFixed(4)),
      frames: event.frames
    };
  }

  if (latestGps) {
    snapshot.position = {
      latitude: latestGps.latitude,
      longitude: latestGps.longitude,
      accuracyMetres: latestGps.accuracy,
      altitudeMetres: latestGps.altitude,
      headingDegrees: latestGps.heading
    };
  }

  if (latestMotion) {
    snapshot.orientation = {
      compassDegrees: latestMotion.alpha,
      pitchDegrees: latestMotion.beta,
      rollDegrees: latestMotion.gamma
    };
  }

  return snapshot;
}

/** The overlay lines, shortest useful form, for burning onto a saved frame. */
function snapshotOverlayLines(snapshot: ObservationSnapshot): string[] {
  const lines = [`${snapshot.app} · ${MODE_LABELS[snapshot.mode]}`];
  lines.push(new Date(snapshot.capturedAt).toLocaleString());

  if (snapshot.motion) {
    const m = snapshot.motion;
    if (m.trailWindowSeconds) lines.push(`Trail ${m.trailWindowSeconds}s${m.trailFrozen ? ' · FROZEN' : ''}`);
    lines.push(`Peak ${m.peakWidthsPerSecond.toFixed(2)} w/s · mean ${m.meanWidthsPerSecond.toFixed(2)} w/s`);
    if (m.angular) {
      lines.push(`Peak ${m.angular.peakDegreesPerSecond.toFixed(2)}°/s (assumes ${m.angular.assumedHorizontalFovDegrees}° FOV)`);
    }
    lines.push(`Measured ${m.measuredPercent}% · inferred ${m.inferredPercent}% · unknown ${m.unknownPercent}%`);
    lines.push(`Full scale ${m.fullScaleWidthsPerSecond.toFixed(2)} w/s = white`);
  }
  if (snapshot.event) {
    lines.push(`Event ${snapshot.event.state} · ${(snapshot.event.durationMs / 1000).toFixed(1)}s · ${snapshot.event.frames} frames`);
  }
  lines.push(`${snapshot.camera.resolution} · analysis ${snapshot.camera.analysisWidth}px · ${snapshot.camera.zoom}`);
  lines.push(`Proc ${snapshot.camera.processingFps} fps · delivered ${snapshot.camera.deliveredFps} fps`);
  if (snapshot.position) {
    lines.push(`${snapshot.position.latitude.toFixed(5)}, ${snapshot.position.longitude.toFixed(5)} ±${Math.round(snapshot.position.accuracyMetres)}m`);
  }
  if (snapshot.orientation?.compassDegrees !== null && snapshot.orientation?.compassDegrees !== undefined) {
    lines.push(`Compass ${snapshot.orientation.compassDegrees.toFixed(0)}°`);
  }
  lines.push('Speed, not temperature. No object identification.');
  return lines;
}

/**
 * Burn the overlay into a copy of the frame.
 *
 * Scaled from the image's own width so a 256px trail and a 4032px still both
 * come out readable; a fixed point size is unreadable on one and absurd on the
 * other.
 */
function drawObservationOverlay(canvas: HTMLCanvasElement, lines: string[]): void {
  const context = canvas.getContext('2d');
  if (!context) return;

  const size = Math.max(9, Math.round(canvas.width / 46));
  const pad = Math.round(size * 0.7);
  const lineHeight = Math.round(size * 1.42);
  context.font = `600 ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  context.textBaseline = 'top';

  const boxWidth = Math.min(
    canvas.width - pad * 2,
    Math.max(...lines.map((line) => context.measureText(line).width)) + pad * 2
  );
  const boxHeight = lines.length * lineHeight + pad * 2;

  context.fillStyle = 'rgba(4, 8, 14, 0.72)';
  context.fillRect(pad, pad, boxWidth, boxHeight);
  context.fillStyle = '#eaf3ff';
  lines.forEach((line, index) => {
    context.fillText(line, pad * 2, pad * 2 + index * lineHeight, boxWidth - pad * 2);
  });
}

function saveSnapshot(): void {
  if (!camera.active) {
    setText('cameraMessage', 'Enable the camera before saving a snapshot.');
    return;
  }

  const snapshot = buildSnapshot();
  const stamp = snapshot.capturedAt.replace(/[:.]/g, '-');

  // The JSON is the record and the image is the illustration. Saving only the
  // image would lose every number that makes it interpretable later.
  const json = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const jsonUrl = URL.createObjectURL(json);
  const anchor = document.createElement('a');
  anchor.href = jsonUrl;
  anchor.download = `visual-sensor-observation-${stamp}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(jsonUrl), 1000);

  const source = overlayPainted && !visionCanvas.hidden ? visionCanvas : null;
  if (!source) {
    setText('cameraMessage', 'Saved the observation record. Select a processed mode to save the frame too.');
    return;
  }

  const output = document.createElement('canvas');
  output.width = source.width;
  output.height = source.height;
  const context = output.getContext('2d');
  if (!context) return;
  context.drawImage(source, 0, 0);
  drawObservationOverlay(output, snapshotOverlayLines(snapshot));
  saveCanvas(output, `${output.width}×${output.height} annotated observation`);
}

function renderMotionReadouts(): void {
  if (byId('motionPanel').hidden) return;

  if (!latestSpeed) {
    setText('motionPeakSpeed', '—');
    setText('motionFullScale', '—');
    setText('motionMovingFraction', '—');
    setText('motionUnresolved', '—');
  } else {
    // Both units, because neither is enough on its own: widths/sec is what the
    // colour actually maps and stays comparable as the pipeline retunes, while
    // px/sec is what the object tracker reports beside it.
    setText('motionPeakSpeed', latestSpeed.peakWidthsPerSecond > 0
      ? `${latestSpeed.peakWidthsPerSecond.toFixed(2)} w/s · ${Math.round(latestSpeed.peakPixelsPerSecond)} px/s`
      : 'still');
    setText('motionFullScale', `${latestSpeed.fullScale.toFixed(2)} w/s = white`);
    setText('motionMovingFraction', `${(latestSpeed.movingFraction * 100).toFixed(1)}%`);
    // Measured, inherited from a neighbouring cell, and not established at all
    // are three different claims, and the panel says which is which rather than
    // letting an inference pass for a measurement.
    setText('motionUnresolved', latestSpeed.movingFraction > 0
      ? `${Math.round((1 - latestSpeed.unresolvedFraction - latestSpeed.inferredFraction) * 100)}% measured`
        + ` · ${Math.round(latestSpeed.inferredFraction * 100)}% inferred`
        + ` · ${Math.round(latestSpeed.unresolvedFraction * 100)}% unknown`
      : '—');
  }

  setText('motionTrailCoverage', latestTrail
    ? `${(latestTrail.coverage * 100).toFixed(1)}% · ${latestTrail.framesAccumulated} frames`
      + (trailFrozen ? ' · FROZEN' : '')
    : trailFrozen ? 'FROZEN' : '—');

  const angular = latestSpeed
    ? degreesPerSecond(latestSpeed.peakWidthsPerSecond, settings.motionFovDegrees, zoomState.value)
    : null;
  // Without an entered field of view there is no honest angular figure, and the
  // readout says which rather than showing a dash that looks like a zero.
  setText('motionAngular', angular === null
    ? 'needs a FOV'
    : `${angular.toFixed(2)}°/s · assumes ${settings.motionFovDegrees}°`);

  if (!settings.motionEventTrigger) {
    setText('motionEventState', 'Trigger off');
  } else if (activeEvent) {
    setText('motionEventState', `${eventPhase} · ${(activeEvent.durationMs / 1000).toFixed(1)}s`
      + ` · peak ${activeEvent.peakWidthsPerSecond.toFixed(2)} w/s · ${activeEvent.frames} frames`);
  } else if (lastCompletedEvent) {
    const ended = lastCompletedEvent.endedAt ?? Date.now();
    setText('motionEventState', `Last event ${(lastCompletedEvent.durationMs / 1000).toFixed(1)}s`
      + ` · peak ${lastCompletedEvent.peakWidthsPerSecond.toFixed(2)} w/s`
      + ` · ended ${new Date(ended).toLocaleTimeString()}`);
  } else {
    setText('motionEventState', 'Watching · nothing yet');
  }
}

function setTrailFrozen(frozen: boolean): void {
  trailFrozen = frozen;
  byId<HTMLButtonElement>('motionFreezeButton').textContent = frozen ? 'Resume Trail' : 'Freeze Trail';
  byId('motionFreezeButton').classList.toggle('active', frozen);
}

function setNightMode(active: boolean): void {
  nightModeActive = active;
  if (!active) integrator.reset();
  byId('nightPanel').hidden = !active;
}

/**
 * Label the switch with where it will GO, not with what it is.
 *
 * "Switch Camera" gives no way to tell which side is live, so a press that
 * silently failed looks the same as one that worked.
 */
function syncCameraSwitchLabel(
  facing: CameraFacing = camera.diagnostics.facing,
  live = camera.active
): void {
  // Both taken as parameters so a status callback can pass the state it was
  // handed rather than re-reading a getter that may not have caught up yet.
  const onFront = facing === 'user';
  const destination = onFront ? 'rear' : 'front';

  const button = byId<HTMLButtonElement>('switchCameraButton');
  button.textContent = onFront ? 'Use Rear Camera' : 'Use Front Camera';
  button.disabled = !live;

  // The viewer's swap has to say the same thing. Two controls for one action
  // disagreeing about which side is live is worse than having only one.
  const viewerButton = byId<HTMLButtonElement>('viewerSwitchButton');
  viewerButton.setAttribute('aria-label', `Use ${destination} camera`);
  viewerButton.title = `Use ${destination} camera`;
  viewerButton.disabled = !live;
  setText('viewerSwitchLabel', destination === 'rear' ? 'Rear' : 'Front');
}

async function switchCamera(): Promise<void> {
  const button = byId<HTMLButtonElement>('switchCameraButton');
  const before = camera.diagnostics.facing;
  button.disabled = true;
  resetVisionState();
  try {
    const facing = await camera.switchCamera();
    setText('cameraMessage', facing === before
      // The engine reports the track's real facing, so this is a genuine
      // "it did not move", not a guess.
      ? `This device reports only one ${facing === 'environment' ? 'rear' : 'front'} camera, so the view did not change.`
      : `Switched to the ${facing === 'environment' ? 'rear' : 'front'} camera.`);
  } catch (error) {
    setText('cameraMessage', describeCameraError(error, isStandalone()));
  } finally {
    syncCameraSwitchLabel();
    void renderLensPicker();
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
  const beforeWidth = camera.diagnostics.videoWidth;
  try {
    zoomState = await camera.setZoom(clamped);
    // A virtual multi-lens device can answer a zoom request by scaling one
    // sensor rather than switching lenses, and the track keeps reporting the
    // same resolution while the image softens. Say so when the geometry moves.
    window.setTimeout(() => {
      const afterWidth = camera.diagnostics.videoWidth;
      if (afterWidth && beforeWidth && afterWidth !== beforeWidth) {
        setText('cameraMessage', `Zoom changed the capture size to ${afterWidth}×${camera.diagnostics.videoHeight}.`);
      }
    }, 500);
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

  // A tap on the preview opens the full-screen view. Guarded so a pinch, a
  // drag, or a press on the Enable Camera overlay is not mistaken for one.
  let tapStart = 0;
  let tapX = 0;
  let tapY = 0;
  stage.addEventListener('pointerdown', (event) => {
    tapStart = event.timeStamp;
    tapX = event.clientX;
    tapY = event.clientY;
  });
  stage.addEventListener('pointerup', (event) => {
    if (zoomPointers.size > 0) return;
    if (event.timeStamp - tapStart > 400) return;
    if (Math.hypot(event.clientX - tapX, event.clientY - tapY) > 12) return;
    if ((event.target as HTMLElement).closest('button')) return;
    if (!camera.active) return;
    setViewerOpen(true);
  });
}

/** Also open the viewer from the pinch-zoom stage on non-touch pointers. */
function installViewerGestures(): void {
  const viewer = byId('cameraViewer');
  for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
    viewer.addEventListener(name, (event) => event.preventDefault());
  }

  // Pinch inside the viewer drives the same zoom value as everywhere else.
  const stage = byId('viewerStage');
  const points = new Map<number, { x: number; y: number }>();
  let startDistance = 0;
  let startZoom = 1;

  const distance = (): number => {
    const list = [...points.values()];
    return list.length < 2 ? 0 : Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y);
  };

  stage.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch') return;
    points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (points.size === 2) {
      startDistance = distance();
      startZoom = zoomState.value;
    }
  });
  stage.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'touch' || !points.has(event.pointerId)) return;
    points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (points.size !== 2 || startDistance <= 0) return;
    event.preventDefault();
    const scale = distance() / startDistance;
    if (Number.isFinite(scale) && scale > 0) void requestZoom(startZoom * scale);
  }, { passive: false });

  const release = (event: PointerEvent): void => {
    points.delete(event.pointerId);
    if (points.size < 2) startDistance = 0;
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);

  // Escape closes it, matching every other full-screen surface.
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && viewerOpen) setViewerOpen(false);
  });
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
  speed: 'Motion Ironbow • image speed, not temperature',
  motiontrails: 'Motion trails • hue = speed, fade = age',
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
  // Any mode change invalidates what is on the canvas, so it goes back to
  // hidden until the pipeline paints it again. Showing the live video is
  // always better than showing a stale or empty overlay.
  overlayPainted = false;
  visionCanvas.hidden = true;
  latestFlow = null;
  // Trails accumulated in another mode are not this mode's picture, and the
  // speed mapper's auto scale was tuned to a scene it may no longer be looking
  // at. Both start clean.
  motionTrails.reset();
  speedField.reset();
  eventDetector.reset();
  latestSpeed = null;
  latestTrail = null;
  activeEvent = null;
  eventPhase = 'idle';
  setTrailFrozen(false);
  lastAnalysisAt = 0;
  setNightMode(mode === 'night');
  setMotionPanel(mode === 'speed' || mode === 'motiontrails', mode);
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
  // Only now is it safe to show: the canvas holds a real frame.
  overlayPainted = true;
  if (visionCanvas.hidden) visionCanvas.hidden = false;
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
function processVisionFrame(timestamp: number): boolean {
  const frame = cameraSource.captureFrame(analysisWidth());
  if (!frame) return false;

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

  // Speed and Trails colour by measured velocity, so they need the same flow
  // field Flow mode draws — the difference mask alone says only that something
  // changed, never how fast.
  const wantsFlow = visionMode === 'flow' || visionMode === 'speed' || visionMode === 'motiontrails';
  const flowOptions = flowOptionsForPreset();
  if (wantsFlow && hadPrevious) {
    latestFlow = computeBlockFlow(buffers.previousGray, buffers.gray, buffers.width, buffers.height, flowOptions);
  } else if (!wantsFlow) {
    latestFlow = null;
  }

  // Elapsed time between the two frames being compared, which is what turns a
  // per-frame displacement into a speed. Guarded against the first frame and
  // against a resumed tab handing us a multi-second gap.
  const analysisDt = lastAnalysisAt ? (timestamp - lastAnalysisAt) / 1000 : 0;
  lastAnalysisAt = timestamp;
  const usableDt = analysisDt > 0 && analysisDt < 1 ? analysisDt : 0;

  if (visionMode === 'speed' || visionMode === 'motiontrails') {
    latestSpeed = speedField.update(
      buffers.difference,
      latestFlow,
      buffers.width,
      buffers.height,
      usableDt,
      { motionThreshold: settings.motionSensitivity }
    );
    // The detector runs in BOTH motion modes, so Speed can arm a tripod watch
    // without the trail buffer being the thing that notices.
    if (settings.motionEventTrigger) {
      const update = eventDetector.update(
        latestSpeed.movingFraction,
        latestSpeed.peakWidthsPerSecond,
        timestamp,
        Date.now()
      );
      eventPhase = update.phase;
      activeEvent = update.current;
      if (update.started) {
        // The trail should hold THIS event, not a smear of everything since the
        // mode was chosen, so a new event starts from a clean buffer.
        motionTrails.reset();
        setTrailFrozen(false);
      }
      if (update.ended && update.completed) {
        lastCompletedEvent = update.completed;
        // Freeze on the way out, so an unattended watch still has the event on
        // screen when it is picked up rather than a buffer already fading.
        setTrailFrozen(true);
      }
    }

    if (visionMode === 'motiontrails' && !trailFrozen) {
      latestTrail = motionTrails.update(
        speedField.speed,
        speedField.state,
        buffers.width,
        buffers.height,
        usableDt,
        {
          exposureSeconds: settings.motionExposureSeconds,
          keepFastest: settings.motionKeepFastest
        }
      );
    }
  } else {
    latestSpeed = null;
    latestTrail = null;
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
    case 'speed':
      putBuffer(buffers, renderMotionIronbow(
        buffers.gray,
        speedField.speed,
        speedField.state,
        buffers.rgba
      ));
      break;
    case 'motiontrails':
      putBuffer(buffers, motionTrails.render(buffers.gray, buffers.rgba, {
        fade: settings.motionFadeTrails
      }));
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
  renderMotionReadouts();
  drawHistogram();
  paintViewer();
  return true;
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

function analyseDeliveredFrame(now: number, source: 'delivery' | 'fallback'): void {
  if (!camera.active || processingVision) return;
  if (!shouldAnalyse(now)) {
    frameRateMeter.recordSkipped();
    return;
  }

  lastVisionFrameAt = now;
  processingVision = true;
  const startedAt = performance.now();
  try {
    // Only a frame that was really captured and rendered counts as analysis.
    // A failed capture must leave the safety net armed, not satisfied.
    if (processVisionFrame(now)) {
      lastAnalysedAt = now;
      if (source === 'delivery') lastDeliveryAnalysedAt = now;
      frameRateMeter.recordProcessed(now, performance.now() - startedAt);
    }
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
  analyseDeliveredFrame(frame.now, 'delivery');
}

/**
 * Fallback loop for browsers without requestVideoFrameCallback.
 *
 * It cannot know whether the video holds a new frame, so it measures the
 * display and is explicitly reported as an estimate rather than a measurement.
 */
/**
 * Unconditional safety net.
 *
 * Before the delivery-driven loop existed, this ran on every animation frame
 * and nothing could stop it but an inactive camera — which is why the vision
 * modes were reliable. The delivery loop then made processing conditional on
 * a chain of steps (a callback arrives, the frame is judged new, the governor
 * allows it, the capture succeeds), and any one of them failing silently
 * killed every filter.
 *
 * So this defers to frame delivery only while DELIVERY is actually producing
 * analysed frames. It keys off lastDeliveryAnalysedAt for two reasons:
 * callbacks that arrive and are then discarded kept the old lastDeliveredAt
 * check satisfied forever, so the net could never catch anything; and using
 * the shared lastAnalysedAt made this loop switch itself off after each of
 * its own frames, limping along at two frames a second instead of taking
 * over. Once it does take over, the rate governor alone decides the pace.
 */
function fallbackVisionLoop(timestamp: number): void {
  requestAnimationFrame(fallbackVisionLoop);

  // A stale overlay is worse than none: if nothing has been painted for a
  // while, uncover the live video rather than leaving a frozen frame — or a
  // black rectangle — over a camera that is working perfectly.
  if (overlayPainted && !visionCanvas.hidden && timestamp - lastAnalysedAt > 2000) {
    overlayPainted = false;
    visionCanvas.hidden = true;
  }

  if (!camera.active) return;

  const deliveryIsWorking = deliveryDriven
    && lastDeliveryAnalysedAt > 0
    && timestamp - lastDeliveryAnalysedAt < 500;
  if (deliveryIsWorking) return;

  analyseDeliveredFrame(timestamp, 'fallback');
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
  overlayPainted = false;
  visionCanvas.hidden = true;
  lastAnalysedAt = 0;
  lastDeliveryAnalysedAt = 0;
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
  byId<HTMLSelectElement>('captureResolution').value = settings.captureResolution;
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
  byId<HTMLSelectElement>('motionExposure').value = String(settings.motionExposureSeconds);
  byId<HTMLInputElement>('motionSensitivity').value = String(settings.motionSensitivity);
  setText('motionSensitivityValue', String(settings.motionSensitivity));
  byId<HTMLInputElement>('motionKeepFastest').checked = settings.motionKeepFastest;
  byId<HTMLInputElement>('motionFadeTrails').checked = settings.motionFadeTrails;
  byId<HTMLInputElement>('motionEventTrigger').checked = settings.motionEventTrigger;
  byId<HTMLInputElement>('motionFov').value = settings.motionFovDegrees > 0
    ? String(settings.motionFovDegrees)
    : '';
  setText('motionFovValue', settings.motionFovDegrees > 0 ? `${settings.motionFovDegrees}°` : 'not set');
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
  setText('benchIdentity', rates.identitySignal === 'none'
    ? 'Abandoned — frames counted unconditionally'
    : rates.identitySignal);
  setText('benchDelivery', diagnostics.deliveryActive
    ? `Active · ${diagnostics.deliveredUnique} unique / ${diagnostics.deliveredRepeated} repeated`
    : diagnostics.deliverySubscribed
      ? 'Subscribed but not running'
      : 'Not subscribed');
  setText('benchCaptureFailures', diagnostics.captureFailures
    ? `${diagnostics.captureFailures} · ${diagnostics.lastCaptureError}`
    : 'None');
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

let viewerOpen = false;
let viewerContext: CanvasRenderingContext2D | null = null;
let hintTimer = 0;

/**
 * Mirror the analysed frame into the full-screen canvas.
 *
 * The viewer is a second presentation of the SAME pipeline output, not a
 * second pipeline: nothing here captures or analyses anything, so opening it
 * costs one canvas blit per analysed frame and cannot change what the
 * instruments read.
 */
function paintViewer(): void {
  if (!viewerOpen) return;
  const target = byId<HTMLCanvasElement>('viewerCanvas');
  viewerContext ??= target.getContext('2d');
  if (!viewerContext) return;

  const source: CanvasImageSource = visionCanvas.hidden ? video : visionCanvas;
  const width = visionCanvas.hidden ? video.videoWidth : visionCanvas.width;
  const height = visionCanvas.hidden ? video.videoHeight : visionCanvas.height;
  if (!width || !height) return;

  if (target.width !== width || target.height !== height) {
    target.width = width;
    target.height = height;
  }
  viewerContext.drawImage(source, 0, 0, width, height);

  const rates = frameRateMeter.report;
  setText('viewerStats', `${rates.deliveredFps.toFixed(0)} fps in · ${rates.processingFps.toFixed(0)} fps analysed · ${zoomState.value.toFixed(1)}×`);
  setText('viewerMode', MODE_LABELS[visionMode].split(' • ')[0]);
}

function buildViewerControls(): void {
  const modes = byId('viewerModes');
  if (!modes.childElementCount) {
    for (const [mode, label] of Object.entries(MODE_LABELS) as [VisionMode, string][]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.viewerMode = mode;
      button.textContent = label.split(' • ')[0];
      button.addEventListener('click', () => {
        updateVisionMode(mode);
        buildViewerControls();
      });
      modes.appendChild(button);
    }
  }
  for (const button of modes.querySelectorAll<HTMLButtonElement>('[data-viewer-mode]')) {
    button.classList.toggle('active', button.dataset.viewerMode === visionMode);
  }

  const zoom = byId('viewerZoom');
  const stops = zoomState.kind === 'none' ? [] : zoomPresetStops(zoomState.min, zoomState.max);
  const signature = stops.join(',');
  if (zoom.dataset.signature !== signature) {
    zoom.dataset.signature = signature;
    zoom.textContent = '';
    for (const stop of stops) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.zoom = String(stop);
      button.textContent = `${stop % 1 === 0 ? stop.toFixed(0) : stop.toFixed(1)}×`;
      button.addEventListener('click', () => void requestZoom(stop));
      zoom.appendChild(button);
    }
  }
  for (const button of zoom.querySelectorAll<HTMLButtonElement>('[data-zoom]')) {
    button.classList.toggle('active', Math.abs(Number(button.dataset.zoom) - zoomState.value) < 0.05);
  }
}

function setViewerOpen(open: boolean): void {
  if (open && !camera.active) {
    setText('cameraMessage', 'Enable the camera before opening the full screen view.');
    return;
  }

  viewerOpen = open;
  byId('cameraViewer').hidden = !open;
  document.body.style.overflow = open ? 'hidden' : '';

  if (!open) return;
  buildViewerControls();
  syncTorchButtons();

  const hint = byId('viewerHint');
  hint.style.opacity = '1';
  window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => { hint.style.opacity = '0'; }, 2600);
  paintViewer();
}

/**
 * Save a still at the camera's full resolution.
 *
 * Deliberately NOT a copy of the on-screen canvas. That canvas holds the
 * ANALYSIS frame, which is sized to a pixel budget for real-time processing —
 * 144x256 on a portrait phone — so saving it discarded almost everything the
 * sensor captured. The filter is re-run here at the video's native resolution
 * instead, which is a few tens of milliseconds once, for a photo.
 */
let stillCanvas: HTMLCanvasElement | null = null;
let stillContext: CanvasRenderingContext2D | null = null;

/**
 * Ask whether the track's reported resolution is carrying real detail.
 *
 * `width: { ideal: 3840 }` is satisfiable by a scaler, so a track can report
 * 4K truthfully while a smaller sensor mode is being stretched to fill it —
 * "the pixels are high but the resolution is poor". This measures it instead of
 * guessing.
 *
 * The sample is a centre crop taken at 1:1 PIXEL SCALE, never the analysis
 * buffer: that buffer is downsampled to a processing budget, so measuring it
 * would only rediscover our own downsampling. One crop is a few milliseconds,
 * so this runs on request rather than per frame.
 */
const DETAIL_SAMPLE = 256;
let detailCanvas: HTMLCanvasElement | null = null;
let detailContext: CanvasRenderingContext2D | null = null;

function measureEffectiveDetail(): string {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) return 'no video';

  const size = Math.min(DETAIL_SAMPLE, sourceWidth, sourceHeight);
  detailCanvas ??= document.createElement('canvas');
  detailContext ??= detailCanvas.getContext('2d', { willReadFrequently: true });
  if (!detailContext) return 'unavailable';

  detailCanvas.width = size;
  detailCanvas.height = size;
  detailContext.drawImage(
    video,
    Math.floor((sourceWidth - size) / 2),
    Math.floor((sourceHeight - size) / 2),
    size,
    size,
    0,
    0,
    size,
    size
  );

  const sample = detailContext.getImageData(0, 0, size, size);
  const gray = rgbaToGray(sample.data);
  const report = estimateEffectiveResolution(gray, size, size);

  if (report.detailRatio >= 1) return 'too flat to judge — aim at some texture';
  if (!report.likelyUpscaled) {
    return `${sourceWidth}×${sourceHeight} · detail at full pixel scale`;
  }
  const effectiveWidth = Math.round(sourceWidth * report.effectiveScale);
  const effectiveHeight = Math.round(sourceHeight * report.effectiveScale);
  return `${sourceWidth}×${sourceHeight} reported · ≈${effectiveWidth}×${effectiveHeight} real detail (upscaled)`;
}

/** Grab the live video at native resolution, honouring any digital crop. */
function grabFullFrame(): ImageData | null {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) return null;

  // Camera zoom already happened in the sensor; only a digital crop has to be
  // reproduced, exactly as the live capture path does it.
  const crop = zoomState.kind === 'digital' ? Math.max(1, zoomState.value) : 1;
  const cropWidth = sourceWidth / crop;
  const cropHeight = sourceHeight / crop;
  const cropX = (sourceWidth - cropWidth) / 2;
  const cropY = (sourceHeight - cropHeight) / 2;
  const width = Math.round(cropWidth);
  const height = Math.round(cropHeight);

  stillCanvas ??= document.createElement('canvas');
  stillContext ??= stillCanvas.getContext('2d', { willReadFrequently: true });
  if (!stillContext) return null;

  stillCanvas.width = width;
  stillCanvas.height = height;
  stillContext.drawImage(video, cropX, cropY, cropWidth, cropHeight, 0, 0, width, height);
  return stillContext.getImageData(0, 0, width, height);
}

/** Wait for the next presented frame, so a temporal mode has two to compare. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const element = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
    };
    if (typeof element.requestVideoFrameCallback === 'function') {
      element.requestVideoFrameCallback(() => resolve());
      return;
    }
    window.setTimeout(resolve, 40);
  });
}

/** Render one mode at full resolution into an RGBA buffer. */
function renderStill(mode: VisionMode, frame: ImageData, previous: ImageData | null): Uint8ClampedArray {
  const { width, height } = frame;
  const gray = rgbaToGray(frame.data);

  switch (mode) {
    case 'relief':
      return reliefFromGray(gray, width, height);
    case 'edges':
      return grayToRgba(sobelEdges(gray, width, height));
    case 'motion': {
      if (!previous) return frame.data;
      const difference = absoluteDifference(gray, rgbaToGray(previous.data));
      return motionMaskToRgba(gray, difference, width, height, 18);
    }
    case 'difference': {
      if (!previous) return frame.data;
      return differenceToRgba(absoluteDifference(gray, rgbaToGray(previous.data)), 3.2);
    }
    case 'flow': {
      if (!previous) return frame.data;
      // Scale the grid with resolution so a full-size still keeps the same
      // vector density as the preview rather than a far denser one.
      const scale = width / Math.max(1, latestMetrics?.analysisWidth ?? 256);
      const options = flowOptionsForPreset();
      const field = computeBlockFlow(rgbaToGray(previous.data), gray, width, height, {
        cellSize: Math.round(options.cellSize * scale),
        patchRadius: Math.max(2, Math.round(options.patchRadius * scale)),
        maxShift: Math.max(2, Math.round(options.maxShift * scale))
      });
      const rgba = dimGrayToRgba(gray, 0.42);
      return drawFlowIntoRgba(rgba, field, width, height);
    }
    case 'speed': {
      // Deliberately NOT a fresh full-resolution flow. Cell size, patch radius
      // and search range all scale with the image, so matching at this size
      // either paints 125-pixel cells as flat rectangles or costs hundreds of
      // millions of operations. The measurement stays where it was made and
      // only the picture is enlarged, so the saved frame is the one that was on
      // screen — at full size, over a full-resolution scene.
      const analysis = visionBuffers;
      if (!analysis) return frame.data;
      const scaled = upscaleSpeedField(
        speedField.speed,
        speedField.state,
        analysis.width,
        analysis.height,
        width,
        height
      );
      return renderMotionIronbow(gray, scaled.speed, scaled.state, new Uint8ClampedArray(width * height * 4));
    }
    case 'night': {
      const rgba = Uint8ClampedArray.from(frame.data);
      applyLightBoost(rgba, settings.nightGain, settings.nightGamma);
      applyPalette(rgba, settings.nightPalette);
      return rgba;
    }
    default:
      return frame.data;
  }
}

/** Draw flow vectors directly into an RGBA buffer, for the still path. */
function drawFlowIntoRgba(
  rgba: Uint8ClampedArray,
  field: FlowField,
  width: number,
  height: number
): Uint8ClampedArray {
  const gain = 2.2;
  for (const vector of field.vectors) {
    const steps = Math.max(2, Math.round(vector.magnitude * gain));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const x = Math.round(vector.x + vector.dx * gain * t);
      const y = Math.round(vector.y + vector.dy * gain * t);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const p = (y * width + x) * 4;
      rgba[p] = 140;
      rgba[p + 1] = 240;
      rgba[p + 2] = 190;
    }
  }
  return rgba;
}

async function captureStill(): Promise<void> {
  if (!camera.active) {
    setText('cameraMessage', 'Enable the camera before saving a frame.');
    return;
  }

  // Night mode is the one exception: the exposure is accumulated at analysis
  // resolution over many frames, so there is no full-resolution version of it
  // to render. Saving the stack as it exists is honest; re-rendering a single
  // frame at full size would be a different picture.
  const stackedNight = visionMode === 'night' && !integrator.isEmpty;
  // Motion trails are the same case as a night stack: the picture is an
  // accumulation over many frames at analysis resolution, so there is no
  // full-resolution version of it to render. Saving what was built is honest;
  // re-rendering one instant at full size would be a different picture, and an
  // empty one.
  const accumulatedTrail = visionMode === 'motiontrails' && motionTrails.framesAccumulated > 0;
  if (stackedNight || accumulatedTrail) {
    saveCanvas(visionCanvas, `${visionCanvas.width}×${visionCanvas.height} ${
      stackedNight ? 'stacked exposure' : 'motion trail'
    }`);
    return;
  }

  const frame = grabFullFrame();
  if (!frame) {
    setText('cameraMessage', 'No frame is available to save yet.');
    return;
  }

  let previous: ImageData | null = null;
  // Speed is absent on purpose: it reuses the live measurement rather than
  // re-deriving one, so a second frame would be grabbed and thrown away.
  if (visionMode === 'motion' || visionMode === 'difference' || visionMode === 'flow') {
    setText('cameraMessage', 'Capturing two frames for the motion comparison…');
    await nextFrame();
    previous = frame;
    const second = grabFullFrame();
    if (second) return finishStill(second, previous);
  }
  finishStill(frame, previous);
}

function finishStill(frame: ImageData, previous: ImageData | null): void {
  const rgba = renderStill(visionMode, frame, previous);
  const output = document.createElement('canvas');
  output.width = frame.width;
  output.height = frame.height;
  const context = output.getContext('2d');
  if (!context) return;

  const image = new ImageData(frame.width, frame.height);
  image.data.set(rgba);
  context.putImageData(image, 0, 0);
  saveCanvas(output, `${frame.width}×${frame.height}`);
}

function saveCanvas(source: HTMLCanvasElement, description: string): void {
  source.toBlob((blob) => {
    if (!blob) {
      setText('cameraMessage', 'The frame could not be encoded.');
      return;
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `visual-sensor-${visionMode}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setText('cameraMessage', `Saved ${description} · ${visionMode}. It stays on this device.`);
  }, 'image/png');
}

/**
 * Offer each camera the device exposes as its own button.
 *
 * An iPhone lists the ultrawide separately from the virtual "Dual Wide"
 * device. Asking the virtual device for zoom 0.5 does not reliably switch
 * lenses — it can scale the wide sensor instead, which cannot add field of
 * view and looks soft at high resolutions. Picking the dedicated ultrawide
 * gets its real optics at its own native resolution.
 */
async function renderLensPicker(): Promise<void> {
  const row = byId('lensRow');
  const report = await camera.videoInputs();
  const devices = report.devices.filter((device) => device.label);

  // Labels only appear after a permission grant, and with fewer than two
  // cameras there is nothing to choose between.
  if (devices.length < 2) {
    row.hidden = true;
    return;
  }

  const signature = devices.map((device) => device.deviceId).join(',');
  if (row.dataset.signature !== signature) {
    row.dataset.signature = signature;
    row.textContent = '';
    for (const device of devices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'lens-button';
      button.dataset.deviceId = device.deviceId;
      button.textContent = device.label.replace(/\s*Camera$/i, '');
      button.addEventListener('click', () => void selectLens(device.deviceId, device.label));
      row.appendChild(button);
    }
  }

  const selected = camera.selectedDeviceId;
  for (const button of row.querySelectorAll<HTMLButtonElement>('.lens-button')) {
    button.classList.toggle('active', button.dataset.deviceId === selected);
  }
  row.hidden = false;
}

async function selectLens(deviceId: string, label: string): Promise<void> {
  for (const button of byId('lensRow').querySelectorAll<HTMLButtonElement>('.lens-button')) {
    button.disabled = true;
  }
  resetVisionState();

  try {
    await camera.selectDevice(deviceId);
    await applyCaptureResolution();
    await applyCameraFrameRate();
    const diagnostics = camera.diagnostics;
    setText('cameraMessage', `Switched to ${label} · ${diagnostics.videoWidth}×${diagnostics.videoHeight}.`
      + ' A dedicated lens gives its own optics rather than a scaled crop of another one.');
  } catch (error) {
    setText('cameraMessage', describeCameraError(error, isStandalone()));
  } finally {
    void renderLensPicker();
    void refreshSettingsDiagnostics();
  }
}

// --- Manual camera controls ---------------------------------------------

let torchOn = false;

function syncTorchButtons(): void {
  for (const id of ['torchToggle', 'viewerTorchButton']) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button) button.setAttribute('aria-pressed', String(torchOn));
  }
}

async function toggleTorch(): Promise<void> {
  const next = !torchOn;
  const result = await camera.applyCameraSetting('torch', next);
  if (result.applied) {
    torchOn = next;
  } else {
    setText('cameraMessage', `The torch was refused by the camera (${result.reason ?? 'unknown'}).`);
  }
  syncTorchButtons();
}

/**
 * Show only the manual controls the live track actually advertises.
 *
 * A control for a capability WebKit does not expose would be a button that
 * does nothing, so an unsupported control is hidden rather than disabled.
 */
function syncManualControls(): void {
  const report = camera.capabilityReport;
  const fields = report.available ? report.fields : {};

  const torchSupported = fields.torch?.state === 'supported';
  for (const id of ['torchToggle', 'viewerTorchButton']) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button) button.hidden = !torchSupported;
  }
  if (!torchSupported) torchOn = false;

  const wbField = fields.whiteBalanceMode;
  const wbWrap = byId('whiteBalanceWrap');
  const wbSelect = byId<HTMLSelectElement>('whiteBalanceMode');
  const wbOptions = wbField?.state === 'supported' && Array.isArray(wbField.options) ? wbField.options : [];
  wbWrap.hidden = wbOptions.length === 0;
  if (wbOptions.length && wbSelect.dataset.signature !== wbOptions.join(',')) {
    wbSelect.dataset.signature = wbOptions.join(',');
    wbSelect.textContent = '';
    for (const option of wbOptions) {
      const element = document.createElement('option');
      element.value = String(option);
      element.textContent = String(option);
      wbSelect.appendChild(element);
    }
    const current = report.settings.whiteBalanceMode;
    if (typeof current === 'string') wbSelect.value = current;
  }

  const focusField = fields.focusDistance;
  const focusWrap = byId('focusDistanceWrap');
  const focusInput = byId<HTMLInputElement>('focusDistance');
  const hasRange = focusField?.state === 'supported'
    && typeof focusField.min === 'number'
    && typeof focusField.max === 'number';
  focusWrap.hidden = !hasRange;
  if (hasRange) {
    focusInput.min = String(focusField.min);
    focusInput.max = String(focusField.max);
    focusInput.step = String(focusField.step ?? (focusField.max! - focusField.min!) / 100);
  }

  byId('manualRow').hidden = false;
  syncTorchButtons();
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
      line.className = `benchmark-row ${row.verdict.replace(' ', '-')}`;
      const detail = row.verdict === 'unsupported'
        ? row.reason || 'refused'
        : row.verdict === 'not measured'
          ? `track reports ${row.reported || '?'} FPS, but no frames were counted`
          : `reports ${row.reported || '?'} · measured ${row.measuredFps} fps`;
      line.textContent = `${row.requested} FPS · ${row.verdict} · ${detail}`;
      results.appendChild(line);
    }

    const best = report.results
      .filter((row) => row.verdict === 'accepted' || row.verdict === 'negotiated')
      .reduce<number>((max, row) => Math.max(max, row.measuredFps), 0);
    const unmeasured = report.results.every((row) => row.verdict === 'not measured');

    setText('benchmarkStatus', best > 0
      ? `Highest rate this device actually delivered: ${best.toFixed(1)} FPS. Requested rates above that were negotiated down or refused.`
      : unmeasured
        // A total measurement failure is a fault in the measurement, not a
        // verdict on the camera, and must not be reported as one.
        ? 'No frames could be counted, so no rate was measured. This is a measurement failure, not a fault in the camera — the preview above is unaffected. Make sure the camera is live and try again.'
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
    } else if (field.options?.length) {
      value.textContent = `Supported · ${field.options.join(', ')}`;
    } else if (field.value !== undefined) {
      value.textContent = `Supported · ${String(field.value)}`;
    } else {
      // WebKit advertises some capabilities as an empty object: the control
      // exists but no range or value comes with it. Printing String(undefined)
      // rendered that as the literal text "undefined".
      value.textContent = 'Supported · no range reported';
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
    cameraFrameRate: byId<HTMLSelectElement>('cameraFrameRate').value as CameraFrameRatePreference,
    captureResolution: byId<HTMLSelectElement>('captureResolution').value as CaptureResolution
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
on('captureStillButton', 'click', () => void captureStill());
on('expandViewButton', 'click', () => setViewerOpen(true));
on('viewerCloseButton', 'click', () => setViewerOpen(false));
on('viewerFitButton', 'click', () => {
  // Contain shows the whole frame with bars; fill crops to the screen. An
  // instrument defaults to showing everything, but filling reads better on a
  // 9:19.5 screen when nothing at the edges matters.
  const viewer = byId('cameraViewer');
  const filling = viewer.dataset.fit === 'fill';
  viewer.dataset.fit = filling ? 'contain' : 'fill';
  const button = byId<HTMLButtonElement>('viewerFitButton');
  button.textContent = filling ? 'Fill' : 'Fit';
  button.setAttribute('aria-pressed', String(!filling));
});
on('viewerShutterButton', 'click', () => void captureStill());
on('viewerSwitchButton', 'click', () => void switchCamera());
on('torchToggle', 'click', () => void toggleTorch());
on('viewerTorchButton', 'click', () => void toggleTorch());
on('whiteBalanceMode', 'change', (event) => {
  void camera.applyCameraSetting('whiteBalanceMode', (event.target as HTMLSelectElement).value);
});
on('focusDistance', 'input', (event) => {
  void camera.applyCameraSetting('focusDistance', Number((event.target as HTMLInputElement).value));
});
on('runBenchmarkButton', 'click', () => void runBenchmark());
on('measureDetailButton', 'click', () => {
  setText('benchEffective', 'measuring…');
  // A frame later, so the placeholder actually paints before the readback.
  requestAnimationFrame(() => setText('benchEffective', measureEffectiveDetail()));
});
on('resetPeakButton', 'click', () => {
  frameRateMeter.resetPeak();
  void refreshSettingsDiagnostics();
});
on('motionExposure', 'change', (event) => {
  settings.motionExposureSeconds = Number((event.target as HTMLSelectElement).value);
  saveSettings();
});
on('motionSensitivity', 'input', (event) => {
  settings.motionSensitivity = Number((event.target as HTMLInputElement).value);
  setText('motionSensitivityValue', String(settings.motionSensitivity));
  saveSettings();
});
on('motionKeepFastest', 'change', (event) => {
  settings.motionKeepFastest = (event.target as HTMLInputElement).checked;
  saveSettings();
});
on('motionFadeTrails', 'change', (event) => {
  settings.motionFadeTrails = (event.target as HTMLInputElement).checked;
  saveSettings();
});
on('motionClearButton', 'click', () => {
  motionTrails.reset();
  speedField.reset();
  eventDetector.reset();
  activeEvent = null;
  lastCompletedEvent = null;
  eventPhase = 'idle';
  setTrailFrozen(false);
  setText('motionTrailCoverage', 'Cleared');
});
on('motionFreezeButton', 'click', () => setTrailFrozen(!trailFrozen));
on('motionSnapshotButton', 'click', () => saveSnapshot());
on('motionEventTrigger', 'change', (event) => {
  settings.motionEventTrigger = (event.target as HTMLInputElement).checked;
  if (!settings.motionEventTrigger) {
    eventDetector.reset();
    activeEvent = null;
    eventPhase = 'idle';
  }
  saveSettings();
});
on('motionFov', 'change', (event) => {
  const entered = Number((event.target as HTMLInputElement).value);
  settings.motionFovDegrees = Number.isFinite(entered) ? clamp(entered, 0, 180) : 0;
  setText('motionFovValue', settings.motionFovDegrees > 0
    ? `${settings.motionFovDegrees}°`
    : 'not set');
  saveSettings();
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
on('captureResolution', 'change', () => {
  saveSettingFromControls();
  void applyCaptureResolution();
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
installViewerGestures();
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
