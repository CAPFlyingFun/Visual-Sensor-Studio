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
import {
  budgetedShortSide,
  measureDisplay,
  megapixels,
  projectTiers,
  throughputMegapixelsPerSecond
} from './vision/display-metrics.js';
import { aspectRatioFor, cropToAspect, retainedFraction, type SaveAspect } from './vision/aspect.js';
import { createPlane, type Plane } from './vision/super-resolution.js';
import { readCapabilities, capabilityLogLine } from './vision/camera-capabilities.js';
import { fitFocalLength, type FocalSample } from './vision/focal-fit.js';
import {
  mergeAndCompare, comparisonStrip, comparisonLayout, pickBest,
  type MergeReport, type PanelKey
} from './vision/burst-merge.js';
import {
  supportedClipFormats, preferredClipFormat, suggestedBitrate, clipFileName,
  formatFromMime, fitLongSide, candidatesFor, BROWSER_DEFAULT,
  type ClipFormat, type CodecPreference
} from './vision/clip-format.js';
import { RollingRecorder, MAX_CLIP_SECONDS } from './vision/clip-recorder.js';
import {
  budgetFromQuota, planRetention, describeSize, describeClip, budgetSeconds,
  type ClipRecord, type RetentionLimits
} from './vision/clip-library.js';
import {
  putClip, listClips, deleteClip, clearClips, markExported, readQuota,
  type StoredClip
} from './vision/clip-store.js';
import {
  encodeGifAsync, estimateGifBytes, MIN_DELAY_CENTISECONDS, type GifFrame
} from './vision/gif.js';
import {
  CAPTURE_CANDIDATES, KEEP_FRAMES, MIN_CONFIDENCE, SPREAD_FLOOR,
  estimateShift, judgeBurst, rotationToPixels, type ShiftEstimate
} from './vision/burst-capture.js';
import {
  SAVE_FORMATS, clampQuality, describeBytes, fileName, formatInfo,
  resolveFormat, supportedFormats, DEFAULT_QUALITY, type SaveFormat
} from './vision/save-format.js';
import type { GpsSample, MotionSample, SensorSnapshot, VisionMetrics, VisionMode } from './core/types.js';

/**
 * How large the live lens picture is drawn.
 *
 * Every other mode paints the analysis frame, which is a few hundred pixels
 * wide — cheap, and fine for a mask or a vector field. A lens is a PICTURE,
 * and at 256 across it looks like a picture of blocks.
 *
 * Full resolution is not free, and the numbers are not close. Measured over
 * 12 frames per size, per-frame cost for the lens render alone:
 *
 *            luma lens   edge lens   speed lens
 *   256 px      1.4 ms      3.3 ms       2.4 ms
 *   540p       16.5 ms     42.9 ms      27.7 ms
 *   720p       26.8 ms     72.2 ms      45.2 ms
 *   1080p      59.3 ms    161.5 ms     101.7 ms
 *
 * That is before the camera, the difference, the metrics and getting the
 * pixels onto the canvas, so 1080p is a single-figure frame rate for anything but the
 * cheapest lens. It is offered because a still, careful observation may well
 * be worth six frames a second — but it is not the default, and the panel
 * reports the cost measured on THIS device rather than asking anyone to
 * trust the table above.
 */
export type LensDetail = 'auto' | 'analysis' | '540' | '720' | 'full';
import {
  CHANNELS,
  buildRampLut,
  channelInfo,
  describeLens,
  rampToCss,
  renderLens,
  upscaleChannel,
  type ChannelId,
  type ChannelSource,
  type CustomLens
} from './vision/lens.js';
import {
  deleteLens as removeLens,
  encodeLensShare,
  lensFromLocation,
  loadGallery,
  decodeLensShare,
  loadLenses,
  newLensId,
  sanitiseLens,
  saveLens as persistLens,
  shareLink
} from './vision/lens-store.js';
import {
  LensPreview,
  RAMP_PRESETS,
  TEST_BAR_SPEEDS,
  previewStep
} from './vision/lens-preview.js';
import {
  DEFAULT_MAX_PIXELS,
  describeMissing,
  fitWithin,
  looksBlank,
  renderPhotoLens,
  type DecodedPhoto
} from './vision/photo-lens.js';
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
  reliefField,
  reliefFromGray,
  rgbaToGray,
  sobelEdges
} from './vision/frame-processing.js';
import { computeBlockFlow, flowVectorColor, type FlowField } from './vision/optical-flow.js';
import { estimateEffectiveResolution } from './vision/sharpness.js';
import {
  BackgroundModel,
  Chronochrome,
  MotionAmplifier,
  SlitScan,
  type BackgroundReport
} from './vision/layers.js';
import {
  decideAutoStart,
  describeAutoStart,
  onFirstGesture,
  readPermission,
  type AutoStartDecision
} from './sensors/autostart.js';
import {
  StabilityCalibrator,
  excursion,
  isSteady,
  type StabilityCalibration
} from './sensors/stability.js';
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
  UNRESOLVED,
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
  lightBoostTable,
  applyPalette,
  applyZebra,
  type NightPalette
} from './vision/overlays.js';
import { StabilityMonitor } from './sensors/stability.js';
import { computeBlockDisparity } from './vision/parallax.js';
import {
  metresPerPixel as terrainMetresPerPixel,
  projectToField,
  sampleHeight,
  slopeAt,
  tilesForRadius,
  type Heightfield
} from './terrain/tiles.js';
import { loadHeightfield } from './terrain/loader.js';
import { contourInterval, estimateRoughness, renderTerrain, terrainStats } from './terrain/render.js';
import { buildTerrainMesh, type TerrainMesh } from './terrain/mesh.js';
import { QuaternionSmoother } from './rig/one-euro.js';
import { RigRecorder, tripodGait, waveGait, type GaitLeg } from './rig/recorder.js';
import {
  BaselineTracker,
  MAX_BASELINE_ROTATION_DEGREES,
  depthUncertaintyMetres,
  estimateDepthMetres,
  focalLengthPixels,
  type BaselineEstimate
} from './vision/baseline.js';

type RecordDetail = 'preview' | 'higher' | 'full' | 'sensor';

const APP_VERSION = '0.53.0';
const SETTINGS_KEY = 'visual-sensor-settings-v1';
const CACHE_PREFIX = 'visual-sensor-studio-';

type CameraPreference = 'auto' | CameraFacing;
type QualityPreference = 'low' | 'normal' | 'high';
type VisionRatePreference = 'battery' | 'balanced' | 'fast' | 'adaptive';
type CameraFrameRatePreference = 'auto' | '30' | '60' | '120' | '240';
type TrailPreference = 'off' | 'short' | 'medium' | 'long';
/**
 * Capture tier, naming the SHORT side in pixels.
 *
 * '10000' is not a size: it asks the camera for its largest mode, which the
 * engine expresses as a very large ideal on both axes so the fitness distance
 * lands on whatever that device actually has.
 */
type CaptureResolution = '720' | '1080' | '1440' | '2160' | '10000';
type GpsAccuracyPreference = 'balanced' | 'high';

interface AppSettings {
  cameraPreference: CameraPreference;
  qualityPreference: QualityPreference;
  visionRatePreference: VisionRatePreference;
  lensDetail: LensDetail;
  /**
   * How much detail a FILTER renders while recording.
   *
   * The preview's budget is the screen's logical pixel count, which caps a
   * filtered recording at about 0.4 megapixels on a phone. That cap is right
   * for a preview — rendering more than the screen can show is what made the
   * preview lag — and wrong for a file, which will be watched full screen
   * later. This raises it while recording only, and it costs frame rate.
   */
  recordDetail: RecordDetail;
  /** Which codec candidates to offer the recorder — a diagnostic switch. */
  recordCodec: CodecPreference;
  saveAspect: SaveAspect;
  saveFormat: SaveFormat;
  saveQuality: number;
  /**
   * Whether the live detail was actually PICKED, rather than left at whatever
   * the app defaulted to.
   *
   * Without this a default can never be corrected: the first version of this
   * setting shipped capped at 540p — a guess made from a benchmark run in a
   * slow container rather than measured on a phone — and every install that
   * never touched the control had that guess frozen into its stored settings.
   * Tracking the difference lets a default improve for everyone who never
   * expressed a preference, while a deliberate choice is never overridden.
   */
  lensDetailChosen: boolean;
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
  autoStartCamera: boolean;
  autoStartGps: boolean;
  autoStartMotion: boolean;
  /** Suppress motion work while the phone itself is moving. */
  steadyGate: boolean;
  /** Horizontal field of view in degrees, entered by hand. 0 means unknown. */
  motionFovDegrees: number;
  /** Post-capture gain. Not exposure — it cannot un-clip a highlight. */
  exposureGain: number;
  exposureGamma: number;
  amplifyGain: number;
  chronoSpacing: number;
  slitColumn: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  cameraPreference: 'auto',
  qualityPreference: 'normal',
  // Adaptive is the default: it idles lower than Balanced on a still scene and
  // climbs far above it when something actually moves, which is the whole point.
  visionRatePreference: 'adaptive',
  lensDetail: 'auto',
  // The preview's own size by default: a setting that costs frame rate should
  // be chosen, not inherited.
  recordDetail: 'preview',
  // The shipped order, unchanged, so an A/B against it means something.
  recordCodec: 'auto',
  saveAspect: 'sensor',
  // JPEG by default: the first full-resolution saves were 22-23MB of
  // lossless PNG, which is a share sheet nobody wants to wait for.
  saveFormat: 'jpeg',
  saveQuality: DEFAULT_QUALITY,
  lensDetailChosen: false,
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
  autoStartCamera: false,
  autoStartGps: false,
  autoStartMotion: false,
  steadyGate: false,
  motionFovDegrees: 0,
  exposureGain: 1,
  exposureGamma: 1,
  amplifyGain: 12,
  chronoSpacing: 4,
  slitColumn: 0.5
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
      // A stored value only wins if it was chosen; otherwise it tracks the
      // current default, so a default corrected later actually reaches the
      // installs that never had an opinion.
      lensDetail: parsed.lensDetailChosen === true
        && ['auto', 'analysis', '540', '720', 'full'].includes(String(parsed.lensDetail))
        ? parsed.lensDetail as LensDetail
        : DEFAULT_SETTINGS.lensDetail,
      lensDetailChosen: parsed.lensDetailChosen === true,
      recordDetail: ['preview', 'higher', 'full', 'sensor'].includes(String(parsed.recordDetail))
        ? parsed.recordDetail as RecordDetail
        : DEFAULT_SETTINGS.recordDetail,
      recordCodec: ['auto', 'no-level', 'default'].includes(String(parsed.recordCodec))
        ? parsed.recordCodec as CodecPreference
        : DEFAULT_SETTINGS.recordCodec,
      saveAspect: ['sensor', 'wide'].includes(String(parsed.saveAspect))
        ? parsed.saveAspect as SaveAspect
        : DEFAULT_SETTINGS.saveAspect,
      saveFormat: SAVE_FORMATS.some((f) => f.id === parsed.saveFormat)
        ? parsed.saveFormat as SaveFormat
        : DEFAULT_SETTINGS.saveFormat,
      saveQuality: clampQuality(Number(parsed.saveQuality)),
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
      captureResolution: ['720', '1080', '1440', '2160', '10000'].includes(String(parsed.captureResolution))
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
      autoStartCamera: typeof parsed.autoStartCamera === 'boolean'
        ? parsed.autoStartCamera
        : DEFAULT_SETTINGS.autoStartCamera,
      autoStartGps: typeof parsed.autoStartGps === 'boolean'
        ? parsed.autoStartGps
        : DEFAULT_SETTINGS.autoStartGps,
      autoStartMotion: typeof parsed.autoStartMotion === 'boolean'
        ? parsed.autoStartMotion
        : DEFAULT_SETTINGS.autoStartMotion,
      steadyGate: typeof parsed.steadyGate === 'boolean'
        ? parsed.steadyGate
        : DEFAULT_SETTINGS.steadyGate,
      motionFovDegrees: Number.isFinite(parsed.motionFovDegrees)
        ? clamp(Number(parsed.motionFovDegrees), 0, 180)
        : DEFAULT_SETTINGS.motionFovDegrees,
      exposureGain: Number.isFinite(parsed.exposureGain)
        ? clamp(Number(parsed.exposureGain), 0.25, 4)
        : DEFAULT_SETTINGS.exposureGain,
      exposureGamma: Number.isFinite(parsed.exposureGamma)
        ? clamp(Number(parsed.exposureGamma), 0.4, 2.2)
        : DEFAULT_SETTINGS.exposureGamma,
      amplifyGain: Number.isFinite(parsed.amplifyGain)
        ? clamp(Number(parsed.amplifyGain), 1, 40)
        : DEFAULT_SETTINGS.amplifyGain,
      chronoSpacing: Number.isFinite(parsed.chronoSpacing)
        ? clamp(Number(parsed.chronoSpacing), 1, 12)
        : DEFAULT_SETTINGS.chronoSpacing,
      slitColumn: Number.isFinite(parsed.slitColumn)
        ? clamp(Number(parsed.slitColumn), 0, 1)
        : DEFAULT_SETTINGS.slitColumn
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
  setTerrain(mesh: TerrainMesh | null): void;
  clearTerrain(): void;
  setRig(root: unknown, radius: number): void;
  clearRig(): void;
  setVisible(visible: boolean): void;
  resetView(): void;
  /**
   * False when the 3D module could not load — a blocked CDN, an old WebGL
   * stack. Callers have to check it rather than assume, or the app reports a
   * surface it never drew.
   */
  readonly available: boolean;
}

const fallbackFusion: FusionBridge = {
  setOrientation: (_value) => undefined,
  setAcceleration: (_value) => undefined,
  setGpsTrack: (_track) => undefined,
  setQuality: (_value) => undefined,
  setTerrain: (_mesh) => undefined,
  clearTerrain: () => undefined,
  setRig: (_root, _radius) => undefined,
  clearRig: () => undefined,
  setVisible: (_visible) => undefined,
  resetView: () => undefined,
  available: false
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
const baseline = new BaselineTracker();
let lastBaseline: BaselineEstimate | null = null;
let lastMotionAt = 0;
let parallaxDepthMetres: number | null = null;

const rigRecorder = new RigRecorder();
const rigSmoother = new QuaternionSmoother();
let rigPuppet: import('./rig/puppet.js').RigPuppet | null = null;
let rigArmedBone: string | null = null;
let rigRecordingFrom = 0;
let rigPlaying = false;
let rigLoopStart = 0;
let rigFrame = 0;
let terrainField: Heightfield | null = null;
let terrainOrigin: { lat: number; lon: number } | null = null;
/** Elevation data is ~30 m, so a higher zoom would upsample rather than reveal. */
const TERRAIN_ZOOM = 12;
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
const amplifier = new MotionAmplifier();
const backgroundModel = new BackgroundModel();
const chronochrome = new Chronochrome();
const slitScan = new SlitScan();
let latestBackground: BackgroundReport | null = null;
const motionTrails = new MotionTrailBuffer();
const eventDetector = new EventDetector();
const histogram = createHistogram();
const stability = new StabilityMonitor();
const calibrator = new StabilityCalibrator();
/** Measured from this device in this grip, or null until it has been. */
let stabilityCalibration: StabilityCalibration | null = null;
let deviceSteady = true;
let steadyExcursion = 0;
let cancelArmedStart: (() => void) | null = null;

/* ------------------------------------------------------------------ *
 * Custom lenses
 * ------------------------------------------------------------------ */

/** Saved on this device. */
let savedLenses: CustomLens[] = [];
/** Shipped with the site, plus anything imported this session. */
let galleryLenses: { lens: CustomLens; author?: string }[] = [];
/** The lens the camera is currently painting through. */
let activeLens: CustomLens | null = null;
/** The lens open in the editor, which may be an unsaved edit of the active one. */
let editingLens: CustomLens | null = null;
/** Rebuilt only when the stops change, since it costs 256 interpolations. */
let activeLensLut: Uint8ClampedArray | null = null;
let activeLensStopsKey = '';
/** Scratch for the relief channel, allocated once per geometry. */
let reliefScratch: Uint8ClampedArray | null = null;
/** Validity masks, allocated once per geometry rather than per frame. */
let lensValidScratch: Uint8Array | null = null;
let latestLensCoverage = 0;

/** The channels a lens actually reads, so nothing else has to be computed. */
function lensChannels(lens: CustomLens | null): Set<ChannelId> {
  const needed = new Set<ChannelId>();
  if (!lens) return needed;
  needed.add(lens.color.channel);
  if (lens.brightness) needed.add(lens.brightness.channel);
  return needed;
}

function lensNeeds(channel: ChannelId): boolean {
  return visionMode === 'lens' && lensChannels(activeLens).has(channel);
}

function lensLut(lens: CustomLens): Uint8ClampedArray {
  const key = lens.stops.map((stop) => `${stop.at}:${stop.color}`).join('|');
  if (key !== activeLensStopsKey || !activeLensLut) {
    activeLensStopsKey = key;
    activeLensLut = buildRampLut(lens.stops);
  }
  return activeLensLut;
}

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
    // The resolution has to be asked for BEFORE getUserMedia. Setting it
    // afterwards goes through applyConstraints, which WebKit will negotiate a
    // live track down with but routinely ignores when asked to raise — so a
    // stream opened at the 720 default stayed there for the whole session
    // however high the setting was, and every saved frame was a 720p frame.
    //
    // Synchronous, and deliberately not awaited: nothing may be awaited before
    // camera.start() or the tap's transient activation is gone when WebKit
    // decides whether to show the permission prompt.
    camera.setPreferredCaptureHeight(Number(settings.captureResolution));
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
/**
 * Apply the chosen frame rate, and say plainly if it cost resolution.
 *
 * A camera has a set of modes, and frame rate and resolution are not
 * independent within them: asking a twelve-megapixel track for 60 fps makes
 * WebKit re-select a mode that can sustain 60, which at that size it cannot.
 * The stream then collapses to something much smaller half a second after it
 * opened, with nothing said about why.
 *
 * `auto` no longer re-constrains a live track at all, so this only bites when
 * a rate was explicitly chosen — and then the cost is reported rather than
 * absorbed, because it is a real trade and the user is the one who should be
 * deciding it.
 */
async function applyCameraFrameRate(): Promise<void> {
  const requested = settings.cameraFrameRate === 'auto' ? 'auto' : Number(settings.cameraFrameRate);
  const before = camera.diagnostics;
  const wasShort = Math.min(before.videoWidth, before.videoHeight);
  try {
    await camera.setFrameRate(requested);
  } catch {
    // A refused rate leaves the previous one in force; the camera keeps running.
    return;
  }
  if (requested === 'auto' || !wasShort) return;

  // The track needs a moment to re-select before the new size is readable.
  window.setTimeout(() => {
    const after = camera.diagnostics;
    const nowShort = Math.min(after.videoWidth, after.videoHeight);
    if (!nowShort || nowShort >= wasShort * 0.95) return;
    setText('cameraMessage', `Asking for ${requested} FPS moved the camera to a mode it can sustain:`
      + ` ${before.videoWidth}×${before.videoHeight} became ${after.videoWidth}×${after.videoHeight}.`
      + ' Frame rate and resolution share the same set of sensor modes — set the frame rate back to'
      + ' Auto Max to keep the larger picture.');
  }, 600);
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
    const rawAsked = Number(settings.captureResolution);
    // The tier names the short side; "maximum" asks for whatever is largest,
    // so there is no target to fall short of.
    const asked = rawAsked >= 10000 ? 0 : rawAsked;
    const short = Math.min(diagnostics.videoWidth, diagnostics.videoHeight);
    // What was asked for, beside what arrived, beside what the camera says it
    // could do. The difference between "this camera cannot" and "we did not
    // ask" is invisible without all three — and the second was a real bug.
    const ceiling = diagnostics.capabilityWidth && diagnostics.capabilityHeight
      ? ` This camera advertises up to ${diagnostics.capabilityWidth}×${diagnostics.capabilityHeight} as a video stream.`
      : ' This browser does not expose the camera\'s maximum stream size.';
    const shortfall = asked && short < asked * 0.95
      ? ` It would not give ${asked}p here; restart the camera to renegotiate.`
      : '';
    setText('cameraMessage', `Camera negotiated ${diagnostics.videoWidth}×${diagnostics.videoHeight}`
      + `${info.reported ? ` at ${info.reported} FPS` : ''}. Higher resolutions usually cost frame rate —`
      + ` the Camera Performance panel shows what is actually delivered.${ceiling}${shortfall}`);
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

/**
 * How much of the frame the lens actually had a reading for.
 *
 * Deliberately NOT part of `renderMotionReadouts`, which returns early while
 * the motion panel is hidden — and in lens mode it always is, so a coverage
 * figure put in there never updates. A lens over a still scene bound to a
 * motion channel really is near zero, and saying so is the difference between
 * "nothing is moving" and "this is broken".
 */
function renderLensReadouts(): void {
  if (!byId('displayDetailRow').hidden) {
    const canvas = visionCanvas;
    const size = canvas.width && !canvas.hidden ? `${canvas.width}×${canvas.height}` : '—';
      // Auto that says nothing looks like auto that is not working, so the
    // rung it has settled on is part of the readout.
    const settled = settings.lensDetail === 'auto' ? ' · auto' : '';
    // A picture smaller than the setting asked for must say why, or it reads
    // as the setting being ignored.
    const sourceShort = Math.min(
      camera.diagnostics.videoWidth,
      camera.diagnostics.videoHeight || camera.diagnostics.videoWidth
    );
    const capped = measuredDetailScale !== null
      && sourceShort > 0
      && detailCappedShortSide(sourceShort) < sourceShort;
    // The screen bound is stated first because it applies always and is
    // arithmetic rather than inference — and because it is usually the
    // tighter of the two by a wide margin.
    const screenBound = displayedShort > 0 && sourceShort > displayedShort
      ? `This window shows ${displayedShort}px on its short side, so a larger render`
        + ' is invisible here. Saving is unaffected — a file is rendered from the full capture.'
      : '';
    // A PEGGED reading is a bound, not a measurement: the search ran out of
    // levels without finding where detail stops. Quoting a pixel figure from
    // it states a precision that was never established.
    const real = Math.round(sourceShort * (measuredDetailScale ?? 1));
    const detailNote = capped && settings.lensDetail === 'auto'
      ? `This stream is ${sourceShort}px on its short side but carries`
        + `${measuredDetailPegged ? ' at most about' : ' about'} ${real}px of real detail,`
        + ' so rendering larger costs frame rate for pixels that are interpolation.'
      : '';
    setText('lensDetailCap', [screenBound, detailNote].filter(Boolean).join(' '));
    setText('lensCostValue', lensRenderMs > 0
      ? `${size} · ${lensRenderMs.toFixed(0)} ms/frame${settled}`
      : `${size}${settled}`);
  }
  if (byId('lensPanel').hidden) return;
  setText('lensCoverage', activeLens
    ? `${(latestLensCoverage * 100).toFixed(0)}% measured`
    : 'no lens');

}

function renderMotionReadouts(): void {
  if (byId('motionPanel').hidden) return;

  if (!latestSpeed) {
    setText('motionPeakSpeed', '—');
    setText('motionFullScale', '—');
    setText('motionMovingFraction', '—');
    setText('motionUnresolved', '—');
    setText('motionSaturated', '—');
  } else {
    // Both units, because neither is enough on its own: widths/sec is what the
    // colour actually maps and stays comparable as the pipeline retunes, while
    // px/sec is what the object tracker reports beside it.
    setText('motionPeakSpeed', latestSpeed.peakWidthsPerSecond > 0
      ? `${latestSpeed.peakWidthsPerSecond.toFixed(2)} w/s · ${Math.round(latestSpeed.peakPixelsPerSecond)} px/s`
      : 'still');
    setText('motionFullScale', `${latestSpeed.fullScale.toFixed(2)} w/s = white`);
    // A reading that is a floor rather than a measurement has to say so, or a
    // clipped speed reads as a confident slow one.
    setText('motionSaturated', latestSpeed.saturatedFraction > 0.001
      ? `${(latestSpeed.saturatedFraction * 100).toFixed(0)}% clipped — faster than this method resolves`
      : 'none');
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

  renderSteadyState();
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

const LAYER_MODES: ReadonlySet<VisionMode> = new Set(['amplify', 'background', 'chrono', 'slitscan']);

/**
 * Show only the control that belongs to the layer on screen.
 *
 * A gain slider while Slit Scan is running is a control that does nothing, and
 * an inert control is worse than an absent one.
 */
function setLayerPanel(mode: VisionMode): void {
  const active = LAYER_MODES.has(mode);
  byId('layerPanel').hidden = !active;
  if (!active) return;

  setText('layerPanelTitle', MODE_LABELS[mode].split(' • ')[0]);
  setText('layerHelp', MODE_LABELS[mode].split(' • ')[1] ?? '');
  const showing: Record<string, VisionMode> = {
    amplifyGain: 'amplify',
    chronoSpacing: 'chrono',
    slitColumn: 'slitscan'
  };
  let visible = 0;
  for (const label of byId('layerControls').querySelectorAll<HTMLElement>('label')) {
    const input = label.querySelector('input');
    label.hidden = !input || showing[input.id] !== mode;
    if (!label.hidden) visible++;
  }
  // Background has nothing to tune, so its grid would otherwise be an empty
  // box sitting where a control should be.
  byId('layerControls').hidden = visible === 0;
  renderLayerState();
}

function renderLayerState(): void {
  if (byId('layerPanel').hidden) return;
  switch (visionMode) {
    case 'amplify':
      setText('layerState', `Band ${amplifier.bandStrength.toFixed(2)} levels`
        + ` · amplified ${settings.amplifyGain}× · noise is amplified too`);
      break;
    case 'background':
      setText('layerState', latestBackground
        ? latestBackground.ready
          ? `${(latestBackground.foregroundFraction * 100).toFixed(1)}% does not belong`
            + ` · ${latestBackground.frames} frames learned`
          : `Learning the scene… ${latestBackground.frames} frames`
        : '—');
      break;
    case 'chrono':
      setText('layerState', `${settings.chronoSpacing} frames between channels`
        + ' · grey means still, colour means it moved');
      break;
    case 'slitscan':
      setText('layerState', `${slitScan.columnsCollected} columns of history`);
      break;
    default:
      setText('layerState', '—');
  }
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

const CALIBRATION_MS = 10_000;
const CALIBRATION_KEY = 'visual-sensor-stability-calibration-v1';

function loadCalibration(): StabilityCalibration | null {
  try {
    const raw = localStorage.getItem(CALIBRATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StabilityCalibration;
    // A stored deadzone that is not a real number would silently disable every
    // gate built on it, so it is checked rather than trusted.
    return Number.isFinite(parsed?.rotationDeadzone) && Number.isFinite(parsed?.accelerationDeadzone)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function renderCalibration(): void {
  const stored = stabilityCalibration;
  if (calibrator.running) {
    const progress = calibrator.progress(performance.now(), CALIBRATION_MS);
    const measuring = `Measuring… ${Math.round(progress * 100)}% · ${calibrator.samples} samples`;
    setText('calibrationState', measuring);
    setText('motionCalibrationHint', `${measuring} — hold the phone as you mean to use it.`);
    return;
  }
  const hint = 'Calibration measures how still this phone is in your hand, so tremor stops'
    + ' counting as motion. It is a gate, not stabilisation.';
  if (!stored) {
    setText('calibrationState', 'Not calibrated — using a generic floor');
    setText('calibrationDeadzone', '—');
    setText('calibrationSpread', '—');
    setText('motionCalibrationHint', `Not calibrated — using a generic floor. ${hint}`);
    return;
  }
  setText('motionCalibrationHint',
    `Deadzone ${stored.rotationDeadzone.toFixed(2)} °/s, measured over ${(stored.durationMs / 1000).toFixed(0)}s. ${hint}`);
  setText('calibrationState', `${stored.samples} samples over ${(stored.durationMs / 1000).toFixed(1)}s`
    + ` · ${new Date(stored.capturedAt).toLocaleDateString()}`);
  setText('calibrationDeadzone', `${stored.rotationDeadzone.toFixed(2)} °/s · ${stored.accelerationDeadzone.toFixed(2)} m/s²`);
  setText('calibrationSpread', `min ${stored.rotation.min.toFixed(2)} · mean ${stored.rotation.mean.toFixed(2)}`
    + ` · max ${stored.rotation.max.toFixed(2)} °/s`);
}

function renderSteadyState(): void {
  if (!settings.steadyGate) {
    setText('steadyState', 'Gate off');
    return;
  }
  if (!latestMotion) {
    setText('steadyState', 'Needs motion sensors');
    return;
  }
  setText('steadyState', deviceSteady
    ? `Steady${stabilityCalibration ? '' : ' (generic floor)'}`
    : `Moving · ${(steadyExcursion * 100).toFixed(0)}% past the deadzone`);
}

/**
 * Take a fresh noise floor from however the phone is being held right now.
 *
 * Ten seconds is a deliberate act rather than a background adaptation, and that
 * is the point: a filter that kept adapting would eventually absorb the very
 * movement it exists to reject.
 */
function startCalibration(): void {
  if (!latestMotion) {
    setText('calibrationState', 'Enable motion sensors first — there is nothing to measure without them.');
    return;
  }
  calibrator.start(performance.now());
  setCalibrateLabel('Cancel');
  renderCalibration();

  window.setTimeout(() => {
    if (!calibrator.running) return;
    const result = calibrator.finish(performance.now());
    setCalibrateLabel('Hold Still & Calibrate');
    if (!result) {
      setText('calibrationState', 'Too few samples to trust — the motion sensor stopped reporting. Try again.');
      return;
    }
    stabilityCalibration = result;
    try {
      localStorage.setItem(CALIBRATION_KEY, JSON.stringify(result));
    } catch {
      // Private browsing: the calibration still applies for this session.
    }
    renderCalibration();
  }, CALIBRATION_MS);
}

function cancelCalibration(): void {
  calibrator.cancel();
  setCalibrateLabel('Hold Still & Calibrate');
  renderCalibration();
}

/** The same control exists on the main screen and in Settings; both track it. */
function setCalibrateLabel(label: string): void {
  byId<HTMLButtonElement>('calibrateButton').textContent = label;
  byId<HTMLButtonElement>('motionCalibrateButton').textContent = label;
}

function syncSteadyToggle(): void {
  const button = byId<HTMLButtonElement>('motionSteadyToggle');
  button.textContent = `Steady Gate: ${settings.steadyGate ? 'On' : 'Off'}`;
  button.setAttribute('aria-pressed', String(settings.steadyGate));
  button.classList.toggle('active', settings.steadyGate);
}

/**
 * Start what the user asked to have running, where the browser already agrees.
 *
 * Nothing here holds or renews a permission — a page cannot. It remembers the
 * intent and acts on it only when the grant is already in place, and otherwise
 * says which of the four situations each sensor is in.
 */
async function applyAutoStart(): Promise<void> {
  const [cameraPermission, gpsPermission] = await Promise.all([
    readPermission('camera'),
    readPermission('geolocation')
  ]);

  const decisions: Array<[string, AutoStartDecision, () => void]> = [
    ['Camera', decideAutoStart({ enabled: settings.autoStartCamera, permission: cameraPermission }),
      () => void startCamera()],
    ['GPS', decideAutoStart({ enabled: settings.autoStartGps, permission: gpsPermission }),
      () => { if (!gps.active) startGps(); }],
    // iOS requires a gesture for DeviceMotion no matter what was granted
    // before, so this one can never be in the 'start' branch on that platform.
    ['Motion', decideAutoStart({
      enabled: settings.autoStartMotion,
      permission: 'unknown',
      requiresGesture: typeof (DeviceMotionEvent as unknown as { requestPermission?: unknown })
        ?.requestPermission === 'function'
    }), () => void enableMotion()]
  ];

  const armed: Array<() => void> = [];
  const notes: string[] = [];
  const started: string[] = [];

  for (const [sensor, decision, run] of decisions) {
    if (decision === 'off') continue;
    if (decision === 'start') {
      started.push(sensor);
      run();
      continue;
    }
    if (decision === 'needs-gesture') armed.push(run);
    notes.push(describeAutoStart(decision, sensor));
  }

  if (armed.length) {
    cancelArmedStart?.();
    cancelArmedStart = onFirstGesture(() => {
      cancelArmedStart = null;
      for (const run of armed) run();
    }, document);
  }

  // Always rewritten, never left holding an older run's answer. A status line
  // that still reads "off" while the camera is live is worse than none.
  if (started.length) notes.unshift(`${started.join(' and ')} started automatically.`);
  setText('autoStartStatus', notes.length
    ? notes.join(' ')
    : 'Auto-start is off for every sensor.');
}

/**
 * Release the sensors the camera engine does not already release.
 *
 * The camera suspends itself on the way out. The GPS watch and the motion
 * listeners did not, so a backgrounded app kept the location subsystem awake —
 * exactly the drain that makes auto-start on open a bad trade otherwise.
 */
/** What was running when we suspended, so exactly that much comes back. */
const suspended = { gps: false, motion: false };

function suspendSensors(): void {
  suspended.gps = gps.active;
  suspended.motion = motion.active;

  if (gps.active) {
    gps.stop();
    setChip('gpsChip', 'idle', 'GPS paused (backgrounded)');
    byId<HTMLButtonElement>('gpsButton').textContent = 'Start GPS Track';
  }
  if (motion.active) {
    motion.stop();
    setChip('motionChip', 'idle', 'Motion paused (backgrounded)');
  }
  // A calibration cannot survive the gap: the samples either side of it come
  // from different moments and different grips, and averaging across that would
  // produce a floor describing neither.
  cancelCalibration();
}

function resumeSensors(): void {
  // Restore what WE turned off. The pause was the app's decision, not the
  // user's, so leaving a sensor they had running switched off would be the app
  // silently disabling it.
  if (suspended.gps && !gps.active) startGps();
  if (suspended.motion && !motion.active) {
    // start() only re-attaches listeners. Deliberately NOT requestPermission()
    // again: on iOS that throws outside a user gesture, and the grant this page
    // already holds has not gone anywhere.
    motion.start(onMotionSample);
    setChip('motionChip', 'good', 'Motion live');
  }
  suspended.gps = false;
  suspended.motion = false;

  // And start anything auto-start was asked for that is still not running.
  if (settings.autoStartGps && !gps.active) startGps();
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

/**
 * Rotation integrated CONTINUOUSLY, at the sensor's own rate.
 *
 * The burst probe first integrated this itself, reading `latestMotion` once
 * per captured frame — about ten times a second. Hand tremor is 8 to 12 Hz, so
 * that samples a signal at roughly its own frequency and aliases nearly all of
 * it away: the accumulated rotation came out about a third of the truth, the
 * lens fit reported 126 degrees for a 70 degree camera, and most bursts could
 * not be fitted at all.
 *
 * Integrating here instead, on every sample the IMU delivers, is the only
 * place the full signal exists. The burst then reads the running total rather
 * than re-deriving it from snapshots.
 */
const rotationTotal = { x: 0, y: 0 };
let lastRotationAt = 0;

function onMotionSample(sample: MotionSample): void {
  latestMotion = sample;

  const now = sample.timestamp;
  if (lastRotationAt > 0) {
    // Clamped: a gap means the app was backgrounded or the sensor stalled, and
    // multiplying a stale rate across it invents a rotation that never happened.
    const dt = Math.min(0.1, Math.max(0, (now - lastRotationAt) / 1000));
    rotationTotal.x += (sample.rotationRate.gamma * Math.PI / 180) * dt;
    rotationTotal.y += (sample.rotationRate.beta * Math.PI / 180) * dt;
  }
  lastRotationAt = now;
  // The IMU is already running, so stacking stability is measured rather than
  // assumed. A multi-second exposure is only meaningful if the camera held still.
  const report = stability.update({
    rotationRate: sample.rotationRate,
    acceleration: sample.acceleration
  });
  calibrator.add({ rotationRate: sample.rotationRate, acceleration: sample.acceleration }, performance.now());

  // The baseline tracker integrates between the two parallax captures, so it
  // needs the interval between samples rather than a timestamp.
  const nowMs = performance.now();
  if (baseline.running && lastMotionAt) {
    baseline.add(
      { acceleration: sample.acceleration, rotationRate: sample.rotationRate },
      (nowMs - lastMotionAt) / 1000
    );
  }
  lastMotionAt = nowMs;
  deviceSteady = isSteady(report, stabilityCalibration);
  steadyExcursion = excursion(report, stabilityCalibration);
  if (calibrator.running) renderCalibration();
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
  amplify: 'Motion amplifier • small movement magnified, noise with it',
  background: 'Background subtraction • what is not normally here',
  chrono: 'Chronochrome • red oldest, blue newest, grey means still',
  slitscan: 'Slit scan • one column per frame, left to right is time',
  night: 'Night • computational low-light, not infrared',
  lens: 'Custom lens • your own mapping'
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
  // Each of these accumulates over time, and an accumulation gathered while
  // pointing somewhere else is not this mode's picture.
  amplifier.reset();
  backgroundModel.reset();
  chronochrome.reset();
  slitScan.reset();
  latestBackground = null;
  eventDetector.reset();
  latestSpeed = null;
  latestTrail = null;
  activeEvent = null;
  eventPhase = 'idle';
  setTrailFrozen(false);
  lastAnalysisAt = 0;
  setNightMode(mode === 'night');
  setMotionPanel(mode === 'speed' || mode === 'motiontrails', mode);
  setLayerPanel(mode);
  byId('lensPanel').hidden = mode !== 'lens';
  // RGB shows the video element itself and is always full resolution; the
  // control only means anything for a mode that draws a processed picture.
  byId('displayDetailRow').hidden = mode === 'camera';
  setText('lensDetailNote', DISPLAY_SCALABLE_MODES.has(mode)
    ? 'This mode reads the current frame, so a larger picture is genuinely more detail —'
      + ' up to the point where the screen runs out of pixels to show it with.'
    : 'This mode builds up over frames on the analysis picture, so it stays that size —'
      + ' drawing it larger would enlarge a small measurement, not improve it.');
  if (mode === 'lens') renderLensChips();
  else stopLensPreview();
  setText('visionModeLabel', `${MODE_LABELS[mode]} • ${settings.visionRatePreference}`);
  // Whether a full-resolution recording is even possible depends on the mode.
  syncRecordDetailNote();
}

/* ------------------------------------------------------------------ *
 * Custom lens editor
 * ------------------------------------------------------------------ */

const LENS_SELECTION_KEY = 'vss.lens.active';
const LENS_INTRO_KEY = 'vss.lens.intro';

/**
 * Range controls work in the channel's own units, so the slider bounds have to
 * follow the channel rather than being fixed. A speed slider running 0..255
 * would spend its whole travel far above anything a hand-held camera produces.
 */
function channelSliderMax(id: ChannelId): number {
  const info = channelInfo(id);
  return Math.max(info.high, info.low) * 2;
}

function channelStep(id: ChannelId): number {
  return channelSliderMax(id) > 20 ? 1 : 0.001;
}

function formatChannelValue(id: ChannelId, value: number): string {
  const info = channelInfo(id);
  const digits = channelSliderMax(id) > 20 ? 0 : 3;
  return `${value.toFixed(digits)} ${info.unit === '0–255' ? '' : info.unit}`.trim();
}

function defaultLens(): CustomLens {
  return sanitiseLens({
    id: newLensId(),
    name: 'My lens',
    color: { channel: 'speed', low: 0.01, high: 0.35, gamma: 0.8 },
    stops: [
      { at: 0, color: '#001028' },
      { at: 0.5, color: '#00b7ff' },
      { at: 1, color: '#ffffff' }
    ],
    base: 'black',
    sceneBlend: 0.1
  });
}

/** Saved first, then the shipped gallery, skipping gallery copies already saved. */
function allLenses(): { lens: CustomLens; origin: 'saved' | 'gallery'; author?: string }[] {
  const savedNames = new Set(savedLenses.map((lens) => lens.name.toLowerCase()));
  return [
    ...savedLenses.map((lens) => ({ lens, origin: 'saved' as const })),
    ...galleryLenses
      .filter((entry) => !savedNames.has(entry.lens.name.toLowerCase()))
      .map((entry) => ({ lens: entry.lens, origin: 'gallery' as const, author: entry.author }))
  ];
}

function renderLensChips(): void {
  const container = byId('lensChips');
  container.textContent = '';
  const entries = allLenses();
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'helper';
    empty.textContent = 'No lenses yet. Start a new one.';
    container.append(empty);
    return;
  }
  for (const entry of entries) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'lens-chip';
    chip.classList.toggle('active', activeLens?.id === entry.lens.id);
    const ramp = document.createElement('span');
    ramp.className = 'ramp';
    ramp.style.background = rampToCss(entry.lens.stops);
    const name = document.createElement('span');
    name.textContent = entry.lens.name;
    chip.append(ramp, name);
    if (entry.origin === 'gallery') {
      const origin = document.createElement('span');
      origin.className = 'origin';
      origin.textContent = entry.author ?? 'shipped';
      chip.append(origin);
    }
    chip.addEventListener('click', () => {
      useLens(entry.lens);
      renderLensChips();
    });
    container.append(chip);
  }
}

function useLens(lens: CustomLens): void {
  activeLens = lens;
  activeLensStopsKey = '';
  editingLens = { ...lens, stops: lens.stops.map((stop) => ({ ...stop })) };
  try {
    localStorage.setItem(LENS_SELECTION_KEY, lens.id);
  } catch {
    // A lens that cannot be remembered still works for this session.
  }
  if (byId('lensEditor').hidden === false) fillLensEditor();
}

function populateChannelSelect(select: HTMLSelectElement, includeNone: boolean): void {
  select.textContent = '';
  if (includeNone) {
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'Nothing (flat)';
    select.append(none);
  }
  // The lens FORMAT is shared with V2, but this engine measures only the
  // greyscale fields; a colour field would render blank here, so it is not
  // offered here. (V2's GPU pipeline measures them and offers them.)
  for (const channel of CHANNELS.filter((c) => !c.gpuOnly)) {
    const option = document.createElement('option');
    option.value = channel.id;
    option.textContent = channel.label;
    select.append(option);
  }
}

/**
 * The colour channel is a row of buttons rather than a dropdown.
 *
 * It is the one choice that decides what the lens is about, and a dropdown
 * hides every option but the chosen one — so the list of things this app can
 * actually measure, which is the interesting part, was invisible until you
 * opened it.
 */
function renderChannelButtons(): void {
  const container = byId('lensColorChannels');
  container.textContent = '';
  for (const channel of CHANNELS.filter((c) => !c.gpuOnly)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lens-channel';
    button.dataset.channel = channel.id;
    button.setAttribute('role', 'radio');
    const selected = editingLens?.color.channel === channel.id;
    button.setAttribute('aria-checked', selected ? 'true' : 'false');
    button.classList.toggle('active', selected);
    const name = document.createElement('strong');
    name.textContent = channel.label;
    const unit = document.createElement('span');
    unit.textContent = channel.unit;
    button.append(name, unit);
    button.addEventListener('click', () => {
      if (!editingLens) return;
      const info = channelInfo(channel.id);
      // The old range was in the old channel's units and would mean nothing
      // here, so switching resets to this channel's own sensible span.
      editingLens.color = {
        channel: channel.id,
        low: info.low,
        high: info.high,
        gamma: editingLens.color.gamma
      };
      fillLensEditor();
    });
    container.append(button);
  }
}

/** One-tap starting ramps, each of which stays fully editable afterwards. */
function renderRampPresets(): void {
  const container = byId('lensPresets');
  container.textContent = '';
  for (const preset of RAMP_PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lens-preset';
    button.title = preset.name;
    const ramp = document.createElement('span');
    ramp.className = 'ramp';
    ramp.style.background = rampToCss(preset.stops);
    const label = document.createElement('span');
    label.textContent = preset.name;
    button.append(ramp, label);
    button.addEventListener('click', () => {
      if (!editingLens) return;
      editingLens.stops = preset.stops.map((stop) => ({ ...stop }));
      applyEditedLens();
      renderLensStops();
    });
    container.append(button);
  }
}

function renderLensStops(): void {
  const container = byId('lensStops');
  container.textContent = '';
  if (!editingLens) return;
  const stopCount = editingLens.stops.length;
  editingLens.stops.forEach((stop, index) => {
    const row = document.createElement('div');
    row.className = 'lens-stop';

    const color = document.createElement('input');
    color.type = 'color';
    color.value = stop.color;
    color.addEventListener('input', () => {
      if (!editingLens) return;
      editingLens.stops[index].color = color.value;
      applyEditedLens();
    });

    const position = document.createElement('input');
    position.type = 'range';
    position.min = '0';
    position.max = '1';
    position.step = '0.01';
    position.value = String(stop.at);
    position.addEventListener('input', () => {
      if (!editingLens) return;
      editingLens.stops[index].at = Number(position.value);
      applyEditedLens();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove colour stop ${index + 1}`);
    // Two stops is the minimum that still describes a ramp.
    remove.disabled = stopCount <= 2;
    remove.addEventListener('click', () => {
      if (!editingLens || editingLens.stops.length <= 2) return;
      editingLens.stops.splice(index, 1);
      applyEditedLens();
      renderLensStops();
    });

    row.append(color, position, remove);
    container.append(row);
  });
}

/* --- The live preview tile ---------------------------------------- */

const PREVIEW_WIDTH = 240;
const PREVIEW_HEIGHT = 135;
const PREVIEW_FPS = 20;

let lensPreview: LensPreview | null = null;
let lensPreviewContext: CanvasRenderingContext2D | null = null;
let lensPreviewScratch: HTMLCanvasElement | null = null;
let lensPreviewScratchContext: CanvasRenderingContext2D | null = null;
let lensPreviewImage: ImageData | null = null;
let lensPreviewFrame = 0;
let lensPreviewLast = 0;

/**
 * Run the test scene while the editor is open, and only then.
 *
 * A preview that kept ticking behind a closed panel would burn a phone's
 * battery running a full vision pipeline nobody is looking at, so the loop
 * stops the moment the editor is hidden and restarts when it opens.
 */
function startLensPreview(): void {
  if (lensPreviewFrame) return;
  const canvas = document.getElementById('lensPreviewCanvas') as HTMLCanvasElement | null;
  if (!canvas) {
    bootProblems.push('#lensPreviewCanvas is missing, so the lens preview does nothing');
    return;
  }
  lensPreviewContext = canvas.getContext('2d');
  if (!lensPreviewContext) return;
  // The scene is computed small and drawn large: the channels it feeds are
  // per-pixel estimates, and computing them at display size would cost more
  // than the camera pipeline itself for a thumbnail nobody measures from.
  //
  // The enlargement goes through a SEPARATE scratch canvas rather than
  // scaling the visible one from itself — a canvas used as its own drawImage
  // source while being written is a read of a surface mid-write, and the
  // artefacts it produces look exactly like a lens bug.
  lensPreviewContext.imageSmoothingEnabled = false;
  lensPreviewScratch ??= document.createElement('canvas');
  lensPreviewScratch.width = PREVIEW_WIDTH;
  lensPreviewScratch.height = PREVIEW_HEIGHT;
  lensPreviewScratchContext = lensPreviewScratch.getContext('2d');
  if (!lensPreviewScratchContext) return;
  lensPreview ??= new LensPreview(PREVIEW_WIDTH, PREVIEW_HEIGHT);
  lensPreview.reset();
  lensPreviewImage = lensPreviewScratchContext.createImageData(PREVIEW_WIDTH, PREVIEW_HEIGHT);
  lensPreviewLast = 0;

  const tick = (now: number) => {
    lensPreviewFrame = requestAnimationFrame(tick);
    if (!lensPreview || !lensPreviewContext || !lensPreviewScratchContext) return;
    if (!lensPreviewImage || !activeLens) return;
    // A hidden panel or a backgrounded tab is work with no viewer.
    if (byId('lensPanel').hidden || byId('lensEditor').hidden || document.hidden) return;
    if (lensPreviewLast && now - lensPreviewLast < 1000 / PREVIEW_FPS) return;
    const dt = lensPreviewLast ? (now - lensPreviewLast) / 1000 : 1 / PREVIEW_FPS;
    lensPreviewLast = now;
    const rgba = lensPreview.step(activeLens, previewStep(dt));
    lensPreviewImage.data.set(rgba);
    lensPreviewScratchContext.putImageData(lensPreviewImage, 0, 0);
    lensPreviewContext.drawImage(
      lensPreviewScratch as HTMLCanvasElement,
      0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT,
      0, 0, lensPreviewContext.canvas.width, lensPreviewContext.canvas.height
    );
  };
  lensPreviewFrame = requestAnimationFrame(tick);
}

function stopLensPreview(): void {
  if (!lensPreviewFrame) return;
  cancelAnimationFrame(lensPreviewFrame);
  lensPreviewFrame = 0;
}

/** Push the edited document into the live renderer, without saving it. */
function applyEditedLens(): void {
  if (!editingLens) return;
  activeLens = sanitiseLens(editingLens);
  activeLensStopsKey = '';
  byId('lensSwatch').style.background = rampToCss(editingLens.stops);
  updateLensRangeLabels();
}

function updateLensRangeLabels(): void {
  if (!editingLens) return;
  const channel = editingLens.color.channel;
  setText('lensLowValue', formatChannelValue(channel, editingLens.color.low));
  setText('lensHighValue', formatChannelValue(channel, editingLens.color.high));
  setText('lensGammaValue', editingLens.color.gamma.toFixed(2));
  setText('lensBlendValue', `${Math.round(editingLens.sceneBlend * 100)}%`);
  const brightness = editingLens.brightness;
  if (brightness) {
    setText('lensBrightHighValue', formatChannelValue(brightness.channel, brightness.high));
    setText('lensBrightLowValue', formatChannelValue(brightness.channel, brightness.low));
  }
}

function fillLensEditor(): void {
  if (!editingLens) return;
  const lens = editingLens;
  byId<HTMLInputElement>('lensName').value = lens.name;

  renderChannelButtons();
  setText('lensChannelMeaning', channelInfo(lens.color.channel).meaning);

  const low = byId<HTMLInputElement>('lensLow');
  const high = byId<HTMLInputElement>('lensHigh');
  const max = channelSliderMax(lens.color.channel);
  const step = channelStep(lens.color.channel);
  for (const slider of [low, high]) {
    slider.min = '0';
    slider.max = String(max);
    slider.step = String(step);
  }
  low.value = String(lens.color.low);
  high.value = String(lens.color.high);
  byId<HTMLInputElement>('lensGamma').value = String(lens.color.gamma);
  byId<HTMLSelectElement>('lensBase').value = lens.base;
  byId<HTMLInputElement>('lensBlend').value = String(lens.sceneBlend);

  const brightnessSelect = byId<HTMLSelectElement>('lensBrightnessChannel');
  brightnessSelect.value = lens.brightness?.channel ?? '';
  byId('lensBrightnessRange').hidden = !lens.brightness;
  if (lens.brightness) {
    const bMax = channelSliderMax(lens.brightness.channel);
    const bStep = channelStep(lens.brightness.channel);
    const bLow = byId<HTMLInputElement>('lensBrightLow');
    const bHigh = byId<HTMLInputElement>('lensBrightHigh');
    for (const slider of [bLow, bHigh]) {
      slider.min = '0';
      slider.max = String(bMax);
      slider.step = String(bStep);
    }
    bLow.value = String(lens.brightness.low);
    bHigh.value = String(lens.brightness.high);
  }

  // A shipped lens is a starting point, not a file to overwrite: deleting one
  // from the gallery would only remove it until the next reload.
  const isSaved = savedLenses.some((item) => item.id === lens.id);
  byId<HTMLButtonElement>('lensDeleteButton').disabled = !isSaved;
  byId<HTMLButtonElement>('lensSaveButton').textContent = isSaved ? 'Save' : 'Save to this device';

  renderLensStops();
  applyEditedLens();
}

function setLensStatus(message: string): void {
  setText('lensStatus', message);
}

function openLensEditor(lens: CustomLens): void {
  editingLens = { ...lens, stops: lens.stops.map((stop) => ({ ...stop })) };
  byId('lensEditor').hidden = false;
  byId('lensImport').hidden = true;
  setLensStatus('');
  fillLensEditor();
  startLensPreview();
}

function closeLensEditor(): void {
  byId('lensEditor').hidden = true;
  stopLensPreview();
}

function addLens(lens: CustomLens, message: string): void {
  const result = persistLens(localStorage, savedLenses, lens);
  savedLenses = result.lenses;
  useLens(lens);
  renderLensChips();
  setLensStatus(result.saved ? message : (result.error ?? 'Could not save.'));
}

/**
 * Decode a photograph as large as this device will actually manage.
 *
 * Starts at the file's own size and steps down. The step-down is not a guess
 * at a limit: iOS Safari refuses to back a canvas beyond a device-dependent
 * area and returns a BLANK one rather than throwing, so the only reliable
 * test is to draw it and look. A blank result at 36 megapixels is a browser
 * limit; the same code at 9 megapixels usually is not.
 */
async function decodePhoto(file: File): Promise<DecodedPhoto | null> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return null;
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    bitmap.close?.();
    return null;
  }

  let budget = Math.min(sourceWidth * sourceHeight, DEFAULT_MAX_PIXELS);
  for (let attempt = 0; attempt < 5; attempt++) {
    const fit = fitWithin(sourceWidth, sourceHeight, budget);
    try {
      canvas.width = fit.width;
      canvas.height = fit.height;
      context.clearRect(0, 0, fit.width, fit.height);
      context.drawImage(bitmap, 0, 0, fit.width, fit.height);
      const data = context.getImageData(0, 0, fit.width, fit.height);
      if (!looksBlank(data.data, fit.width * fit.height)) {
        bitmap.close?.();
        return {
          data,
          sourceWidth,
          sourceHeight,
          reduced: fit.width !== sourceWidth || fit.height !== sourceHeight
        };
      }
    } catch {
      // Out of memory or an over-large canvas. Both mean: try smaller.
    }
    budget = Math.floor(budget / 2);
    if (budget < 250_000) break;
  }

  bitmap.close?.();
  return null;
}

async function applyLensToPhoto(file: File): Promise<void> {
  const lens = activeLens;
  if (!lens) {
    setText('lensPhotoStatus', 'Choose a lens first.');
    return;
  }
  setText('lensPhotoStatus', 'Reading the photo…');
  const photo = await decodePhoto(file);
  if (!photo) {
    setText('lensPhotoStatus', 'This device could not decode that image, even reduced.');
    return;
  }

  const { rgba, report } = renderPhotoLens(lens, photo);
  const output = document.createElement('canvas');
  output.width = report.width;
  output.height = report.height;
  const context = output.getContext('2d');
  if (!context) return;
  const image = new ImageData(report.width, report.height);
  image.data.set(rgba);
  context.putImageData(image, 0, 0);
  saveCanvas(output, `${report.width}×${report.height}`);

  const megapixels = (report.width * report.height) / 1e6;
  const shrunk = report.reduced
    ? ` Reduced from ${report.sourceWidth}×${report.sourceHeight} — this browser would not hold a canvas that large.`
    : '';
  setText('lensPhotoStatus',
    `Rendered ${report.width}×${report.height} (${megapixels.toFixed(1)} MP).${shrunk} ${describeMissing(report.missing)}`.trim());
}

/**
 * Show a lens as a link, a code, and a sentence.
 *
 * Sharing used to live only inside the editor, which meant sharing a lens
 * required first pressing Edit on it — a step with no obvious connection to
 * the thing being asked for.
 *
 * The code is put on screen as SELECTABLE TEXT and only then offered to the
 * clipboard. On iOS a clipboard write from anything but a direct user gesture
 * is refused often enough that treating it as the primary path loses the
 * thing being shared; the visible box always works.
 *
 * The description matters as much as the code. A share code is opaque by
 * design, so a lens arriving as a wall of base64 tells the person receiving it
 * nothing about what it does — the sentence is what makes it discussable
 * rather than merely installable.
 */
function showLensShare(lens: CustomLens): void {
  const link = shareLink(sanitiseLens(lens), location.href);
  byId('lensShareBox').hidden = false;
  byId<HTMLTextAreaElement>('lensShareText').value = link;
  setText('lensShareSummary', `${lens.name} — ${describeLens(lens)}`);
  setText('lensShareStatus', '');
  byId('lensShareBox').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function wireLensEditor(): void {
  populateChannelSelect(byId<HTMLSelectElement>('lensBrightnessChannel'), true);
  renderRampPresets();
  const detail = document.getElementById('lensDetail') as HTMLSelectElement | null;
  if (detail) detail.value = settings.lensDetail;
  else bootProblems.push('#lensDetail is missing, so the live detail cannot be chosen');

  // Open the first time, closed once it has been read. A permanent
  // explanation becomes furniture; one that never appears leaves the first
  // lens as guesswork.
  const intro = byId<HTMLDetailsElement>('lensIntro');
  try {
    intro.open = localStorage.getItem(LENS_INTRO_KEY) !== 'read';
  } catch {
    intro.open = true;
  }
  on('lensIntro', 'toggle', () => {
    if (intro.open) return;
    try {
      localStorage.setItem(LENS_INTRO_KEY, 'read');
    } catch {
      // Not remembering it is a small cost; failing to open is not.
    }
  });
  // A statement about the SCENE, which is exactly true and tested. It does
  // not promise the estimator will read those numbers back: a per-pixel
  // normal-flow estimate is biased high inside a textured block, and it is the
  // ORDER that survives, which is what designing a range needs.
  setText('lensPreviewCaption',
    `Test pattern. The three bars travel at ${TEST_BAR_SPEEDS.join(', ')} frame widths per`
    + ' second, slowest at the top. The checkerboard is sharp but still, and the block at the'
    + ' bottom comes and goes so the background model has something to notice.');

  on('lensNewButton', 'click', () => {
    const lens = defaultLens();
    openLensEditor(lens);
    activeLens = lens;
    activeLensStopsKey = '';
    setLensStatus('Unsaved. Adjust it, then save.');
  });

  on('lensEditButton', 'click', () => {
    if (!activeLens) {
      const first = allLenses()[0];
      if (!first) return;
      useLens(first.lens);
    }
    if (activeLens) openLensEditor(activeLens);
  });

  on('lensName', 'input', (event) => {
    if (!editingLens) return;
    editingLens.name = (event.target as HTMLInputElement).value;
  });

  const bindRange = (id: string, apply: (value: number) => void) => {
    on(id, 'input', (event) => {
      if (!editingLens) return;
      apply(Number((event.target as HTMLInputElement).value));
      applyEditedLens();
    });
  };
  bindRange('lensLow', (value) => void (editingLens && (editingLens.color.low = value)));
  bindRange('lensHigh', (value) => void (editingLens && (editingLens.color.high = value)));
  bindRange('lensGamma', (value) => void (editingLens && (editingLens.color.gamma = value)));
  bindRange('lensBlend', (value) => void (editingLens && (editingLens.sceneBlend = value)));
  bindRange('lensBrightLow', (value) => {
    if (editingLens?.brightness) editingLens.brightness.low = value;
  });
  bindRange('lensBrightHigh', (value) => {
    if (editingLens?.brightness) editingLens.brightness.high = value;
  });

  on('lensBase', 'change', (event) => {
    if (!editingLens) return;
    editingLens.base = (event.target as HTMLSelectElement).value as CustomLens['base'];
    applyEditedLens();
  });

  on('lensBrightnessChannel', 'change', (event) => {
    if (!editingLens) return;
    const value = (event.target as HTMLSelectElement).value;
    if (!value) {
      editingLens.brightness = undefined;
    } else {
      const info = channelInfo(value as ChannelId);
      editingLens.brightness = { channel: info.id, low: info.low, high: info.high, gamma: 1 };
    }
    fillLensEditor();
  });

  on('lensAddStop', 'click', () => {
    if (!editingLens || editingLens.stops.length >= 8) return;
    const last = editingLens.stops[editingLens.stops.length - 1];
    editingLens.stops.push({ at: Math.min(1, last.at + 0.1), color: last.color });
    applyEditedLens();
    renderLensStops();
  });

  on('lensSaveButton', 'click', () => {
    if (!editingLens) return;
    addLens(sanitiseLens(editingLens), 'Saved to this device.');
  });

  on('lensDeleteButton', 'click', () => {
    if (!editingLens) return;
    savedLenses = removeLens(localStorage, savedLenses, editingLens.id);
    closeLensEditor();
    const next = allLenses()[0];
    if (next) useLens(next.lens);
    else activeLens = null;
    renderLensChips();
  });

  on('lensShareButton', 'click', () => {
    if (!editingLens) return;
    // One share path, so the editor and the panel cannot drift apart.
    showLensShare(editingLens);
    setLensStatus('');
  });

  on('lensExportButton', 'click', () => {
    if (!editingLens) return;
    const lens = sanitiseLens(editingLens);
    const blob = new Blob([JSON.stringify({ lenses: [lens] }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${lens.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'lens'}.lens.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setLensStatus('Exported.');
  });

  on('lensShareNowButton', 'click', () => {
    const lens = editingLens ?? activeLens;
    if (!lens) {
      setText('lensShareStatus', 'Choose a lens first.');
      return;
    }
    showLensShare(lens);
  });

  on('lensShareCopyButton', 'click', async () => {
    const text = byId<HTMLTextAreaElement>('lensShareText').value;
    try {
      await navigator.clipboard.writeText(text);
      setText('lensShareStatus', 'Copied.');
    } catch {
      // Expected often enough that it is not an error worth alarming about:
      // the text is already on screen and selectable.
      setText('lensShareStatus', 'This browser refused the clipboard — select the text above and copy it.');
    }
  });

  on('lensShareCloseButton', 'click', () => {
    byId('lensShareBox').hidden = true;
  });

  on('lensPhotoButton', 'click', () => {
    setText('lensPhotoStatus', '');
    byId<HTMLInputElement>('lensPhotoFile').click();
  });

  on('lensPhotoFile', 'change', (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void applyLensToPhoto(file);
    input.value = '';
  });

  on('lensImportButton', 'click', () => {
    byId('lensImport').hidden = false;
    closeLensEditor();
    setText('lensImportStatus', '');
  });

  on('lensImportCancel', 'click', () => {
    byId('lensImport').hidden = true;
  });

  on('lensImportConfirm', 'click', () => {
    const text = byId<HTMLTextAreaElement>('lensImportText').value;
    const lens = decodeLensShare(text);
    if (!lens) {
      setText('lensImportStatus', 'That does not look like a lens link or code.');
      return;
    }
    addLens(lens, '');
    byId('lensImport').hidden = true;
    openLensEditor(lens);
    setLensStatus(`Added “${lens.name}”.`);
  });

  on('lensImportFileButton', 'click', () => {
    byId<HTMLInputElement>('lensImportFile').click();
  });

  on('lensImportFile', 'change', async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const list = Array.isArray(parsed)
        ? parsed
        : (parsed as { lenses?: unknown })?.lenses ?? [parsed];
      const lenses = (Array.isArray(list) ? list : [])
        .map((item) => sanitiseLens({ ...(item as object), id: newLensId() }));
      if (!lenses.length) {
        setText('lensImportStatus', 'No lenses in that file.');
        return;
      }
      for (const lens of lenses) {
        const result = persistLens(localStorage, savedLenses, lens);
        savedLenses = result.lenses;
      }
      useLens(lenses[0]);
      renderLensChips();
      byId('lensImport').hidden = true;
      openLensEditor(lenses[0]);
      setLensStatus(`Added ${lenses.length} lens${lenses.length === 1 ? '' : 'es'}.`);
    } catch {
      setText('lensImportStatus', 'That file could not be read as a lens.');
    }
    (event.target as HTMLInputElement).value = '';
  });
}

async function initialiseLenses(): Promise<void> {
  savedLenses = loadLenses(localStorage);
  wireLensEditor();

  // A lens in the address bar is someone handing you one. It is added but not
  // silently activated over whatever is already selected without saying so.
  const shared = lensFromLocation(location.hash, location.search);
  if (shared) {
    const result = persistLens(localStorage, savedLenses, shared);
    savedLenses = result.lenses;
    useLens(shared);
    updateVisionMode('lens');
    openLensEditor(shared);
    setLensStatus(`Added “${shared.name}” from a shared link.`);
    // Clear it so a reload does not add the same lens again.
    history.replaceState(null, '', location.pathname + location.search);
  }

  galleryLenses = await loadGallery((url) => fetch(url));

  if (!activeLens) {
    let remembered: string | null = null;
    try {
      remembered = localStorage.getItem(LENS_SELECTION_KEY);
    } catch {
      remembered = null;
    }
    const entries = allLenses();
    const match = entries.find((entry) => entry.lens.id === remembered) ?? entries[0];
    if (match) useLens(match.lens);
  }
  renderLensChips();
}

function resizeVisionCanvas(width: number, height: number): void {
  if (visionCanvas.width !== width) visionCanvas.width = width;
  if (visionCanvas.height !== height) visionCanvas.height = height;
}

/**
 * The one place the overlay canvas is drawn and revealed.
 *
 * It is opaque and sits on top of the video, so showing it before anything is
 * drawn covers a working preview with a black rectangle. Every painter goes
 * through here so there is exactly one line that can reveal it.
 */
function paintVisionCanvas(
  width: number,
  height: number,
  imageData: ImageData,
  rgba: Uint8ClampedArray
): void {
  resizeVisionCanvas(width, height);
  imageData.data.set(rgba);
  visionContext.putImageData(imageData, 0, 0);
  // Only now is it safe to show: the canvas holds a real frame.
  overlayPainted = true;
  if (visionCanvas.hidden) visionCanvas.hidden = false;
}

function putBuffer(buffers: VisionBuffers, rgba: Uint8ClampedArray): void {
  paintVisionCanvas(buffers.width, buffers.height, buffers.imageData, rgba);
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
/**
 * Gather the per-pixel fields a lens is bound to.
 *
 * Only the bound channels are assembled. A channel that is bound but not
 * currently measurable is left OUT rather than supplied as zeroes — the
 * renderer paints a missing channel as empty, and an empty picture is the
 * truthful rendering of "this is not being measured right now". Handing it a
 * zero-filled buffer would instead paint a confident floor colour across the
 * whole frame.
 */
function buildLensSources(buffers: VisionBuffers, lens: CustomLens): ChannelSource {
  const needed = lensChannels(lens);
  const sources: ChannelSource = {};
  const pixels = buffers.width * buffers.height;

  if (needed.has('luma')) sources.luma = { values: buffers.gray };
  if (needed.has('edges')) sources.edges = { values: buffers.edges };
  if (needed.has('change') && buffers.hasPrevious) {
    sources.change = { values: buffers.difference };
  }

  if (needed.has('relief')) {
    if (!reliefScratch || reliefScratch.length !== pixels) {
      reliefScratch = new Uint8ClampedArray(pixels);
    }
    sources.relief = {
      values: reliefField(buffers.gray, buffers.width, buffers.height, reliefScratch, buffers.edges)
    };
  }

  if (needed.has('speed') && speedField.rawSpeed.length === pixels) {
    if (!lensValidScratch || lensValidScratch.length !== pixels) {
      lensValidScratch = new Uint8Array(pixels);
    }
    const state = speedField.state;
    // STILL is a real measurement of zero; UNRESOLVED is the aperture problem
    // and must not be painted.
    for (let i = 0; i < pixels; i++) lensValidScratch[i] = state[i] === UNRESOLVED ? 0 : 1;
    // Widths per second, not the auto-scaled 0..1 the Ironbow rendering
    // uses: a saved lens has to mean the same thing in the next session.
    sources.speed = { values: speedField.rawSpeed, valid: lensValidScratch };
  }

  if (needed.has('age')) {
    const age = motionTrails.ageField;
    const trailSpeed = motionTrails.speedFieldValues;
    if (age.length === pixels) {
      // Age only means anything where the trail has actually recorded a pass.
      const valid = new Uint8Array(pixels);
      for (let i = 0; i < pixels; i++) valid[i] = trailSpeed[i] > 0 ? 1 : 0;
      sources.age = { values: age, valid };
    }
  }

  if (needed.has('novelty')) {
    latestBackground = backgroundModel.update(buffers.gray, buffers.width, buffers.height);
    // Before the model has warmed up there is no "normally" to depart from.
    if (backgroundModel.warmedUp && backgroundModel.deviation.length === pixels) {
      sources.novelty = { values: backgroundModel.deviation };
    }
  }

  return sources;
}

/**
 * Auto detail: find the largest picture this device sustains, by measuring.
 *
 * A fixed cap is a guess about a phone made somewhere else, and both guesses
 * tried here were wrong in opposite directions — 540p threw away detail the
 * device had, and full resolution on a twelve-megapixel stream produced one to
 * two frames a second and took the camera down with it.
 *
 * So the ladder is CLIMBED, never fallen down. Starting high and backing off
 * sounds equivalent and is not: the first measurement at a level too expensive
 * for the device is taken while the device is already failing, and on a phone
 * that can mean the tab is reclaimed before any adjustment happens. Starting
 * one rung above the analysis frame and stepping up only from a position of
 * measured headroom means every level the app occupies is one it has already
 * seen work.
 *
 * The settled rung is remembered, so a device only learns this once.
 */
/** Ladder rungs as SHORT SIDES, so a rung means the same in either orientation. */
const AUTO_LADDER = [0, 540, 720, 1080, Number.POSITIVE_INFINITY] as const;
/**
 * The band the ladder holds inside, from measurements on a real device.
 *
 * Reported from an iPhone: full resolution on a twelve-megapixel stream gave
 * one to two frames a second and crashed the camera; around 1080 across gave
 * about eighteen, described as good. So below twelve is failing and needs a
 * step down, above twenty is comfortable enough to try one more, and the
 * range between is a settled place to stay rather than something to keep
 * adjusting around.
 *
 * A gap between the two thresholds is what stops oscillation: a single
 * boundary would make every rung both too slow and fast enough.
 */
const AUTO_TARGET_FPS = 10;
const AUTO_HEADROOM_FPS = 20;
/**
 * Headroom needed to climb OFF the bottom rungs.
 *
 * A flat threshold trapped the ladder at the very bottom: once it had stepped
 * down to the analysis frame, any rate inside the dead band held it there
 * forever, so a phone that could manage 540 across at fifteen frames a second
 * sat at 166 instead. The gain from the analysis frame to a real picture is
 * enormous and worth a few frames; the gain from 720 to 1080 is marginal and
 * is not. So the low rungs climb on less evidence than the high ones.
 */
const AUTO_LOW_RUNG_HEADROOM_FPS = 14;
// Bumped: rungs stored by earlier versions were widths, and one release could
// persist a 0 that then survived every launch.
const AUTO_SETTLE_KEY = 'vss.detail.auto.v2';
/** Consecutive verdicts needed before moving — one slow frame is not a trend. */
const AUTO_VOTES = 4;

let autoRung = 1;
let autoVotes = 0;
let autoLastCheck = 0;

function loadAutoRung(): void {
  try {
    const stored = Number(localStorage.getItem(AUTO_SETTLE_KEY));
    // Never START at the bottom, whatever was remembered. The bottom rung is
    // the analysis frame — a fallback, not a settled answer — and a session
    // that begins there has to earn its way out through the dead band before
    // showing a real picture at all. A remembered 0 is the record of one bad
    // session, and restoring it makes that session permanent.
    if (Number.isFinite(stored) && stored >= 0 && stored < AUTO_LADDER.length) {
      autoRung = Math.max(1, stored);
    }
  } catch {
    // The default rung is a safe place to start learning again.
  }
}

function saveAutoRung(): void {
  try {
    localStorage.setItem(AUTO_SETTLE_KEY, String(autoRung));
  } catch {
    // Re-learning next launch costs a few seconds, not correctness.
  }
}

/**
 * Move the auto rung at most one step, on a run of agreeing measurements.
 *
 * Called once per processed frame; it does its own rate limiting so the
 * caller cannot make it thrash by calling more often.
 */
function updateAutoDetail(processingFps: number, now: number): void {
  if (settings.lensDetail !== 'auto') return;
  if (now - autoLastCheck < 1000) return;
  autoLastCheck = now;

  const tooSlow = processingFps > 0 && processingFps < AUTO_TARGET_FPS;
  const needed = autoRung <= 1 ? AUTO_LOW_RUNG_HEADROOM_FPS : AUTO_HEADROOM_FPS;
  const hasHeadroom = processingFps >= needed && autoRung < AUTO_LADDER.length - 1;

  if (tooSlow && autoRung > 0) {
    autoVotes = autoVotes < 0 ? autoVotes - 1 : -1;
    if (autoVotes <= -AUTO_VOTES) {
      autoRung--;
      autoVotes = 0;
      lensDisplay = null;
      saveAutoRung();
    }
    return;
  }
  if (hasHeadroom) {
    autoVotes = autoVotes > 0 ? autoVotes + 1 : 1;
    // Climbing needs more agreement than backing off: a step up that does not
    // hold costs a visible stutter, a step down that was not needed costs
    // only detail nobody had yet.
    if (autoVotes >= AUTO_VOTES * 2) {
      autoRung++;
      autoVotes = 0;
      lensDisplay = null;
      saveAutoRung();
    }
    return;
  }
  autoVotes = 0;
}

/** Target width for the live processed picture, never above what the camera gives. */
function lensDisplayWidth(): number {
  const source = camera.diagnostics.videoWidth;
  const analysis = visionBuffers?.width ?? analysisWidth();
  if (!source) return analysis;
  const sourceShort = Math.min(source, camera.diagnostics.videoHeight || source);

  // Every tier names a SHORT SIDE. Naming a width would make one setting mean
  // two different pictures depending on which way the phone is held.
  const auto = settings.lensDetail === 'auto';
  const wantedShort = auto ? (AUTO_LADDER[autoRung] || 0)
    : settings.lensDetail === 'full' ? sourceShort
    : settings.lensDetail === '720' ? 720
    : settings.lensDetail === '540' ? 540
    : 0;
  if (wantedShort <= 0) return analysis;

  // THE DETAIL CAP APPLIES TO AUTO ONLY.
  //
  // Choosing "Full — sensor resolution" is an instruction, and an instruction
  // is not a starting point for a heuristic to argue with. Capping it produced
  // 756x1008 from a 3024 stream and reported it under a label promising the
  // sensor's own size, which is the control lying about what it did.
  //
  // The evidence behind the cap is also weaker than it looked: the readings
  // driving it were pegged at the estimator's floor, so "about 189px of real
  // detail" was only ever "no more than roughly that". Good enough to inform a
  // ladder that is explicitly asking to be told what to do; nowhere near good
  // enough to overrule someone who has said what they want.
  const ceiling = auto ? detailCappedShortSide(sourceShort) : sourceShort;
  // A RECORDING OVERRULES THE LADDER.
  //
  // Two caps were in play and raising one left the other binding: on Auto the
  // rung is chosen from the frame rate the device is managing, so exactly the
  // phone that needs a bigger recording has settled on a small rung, and the
  // recording budget below was silently overruled by it. While recording at a
  // raised detail the request IS the instruction, the same way "Full" is.
  const recording = (rolling.recording || armingDetail) && settings.recordDetail !== 'preview';
  // The screen bound applies at every setting. Pixels the display cannot
  // resolve are not wasteful, they are invisible, and no setting should be
  // read as a request for invisible ones.
  const aspect = Math.max(source, camera.diagnostics.videoHeight || source)
    / Math.max(1, sourceShort);
  const onScreen = displayedShortSide(aspect, performance.now());
  const budget = onScreen > 0 ? onScreen : sourceShort;
  const short = recording
    ? Math.min(sourceShort, budget)
    : Math.min(sourceShort, ceiling, wantedShort, budget);
  return Math.max(analysis, widthForShortSide(short));
}

/** Buffers for the enlarged picture, kept across frames and shared by modes. */
let lensDisplay: {
  width: number;
  height: number;
  gray: Uint8ClampedArray;
  previousGray: Uint8ClampedArray;
  difference: Uint8ClampedArray;
  hasPrevious: boolean;
  rgba: Uint8ClampedArray;
  imageData: ImageData;
} | null = null;

/**
 * Modes whose picture can honestly be drawn larger than the analysis frame.
 *
 * The division is not about effort, it is about what the mode MEASURES. These
 * read only the current frame — shading, edges, tone, and the difference
 * against the previous frame — so recomputing them at the display size
 * produces genuinely more detail.
 *
 * Everything else accumulates over time on the analysis frame: speed, trails,
 * amplification, the learned background, chronochrome, slit scan. There is no
 * full-resolution history to re-derive those from, so drawing them larger
 * would enlarge a small measurement and call it a big one. They stay at the
 * analysis size and the browser scales the canvas, which is honest about being
 * a scaled small picture rather than pretending to be a large one.
 */
const DISPLAY_SCALABLE_MODES: ReadonlySet<VisionMode> = new Set<VisionMode>([
  'relief', 'edges', 'motion', 'difference', 'night', 'lens'
]);

/** Rolling cost of the lens render, so the panel can report what it costs HERE. */
let lensRenderMs = 0;

/* --- Not rendering pixels that carry no information ------------------ *
 *
 * Measured on one phone, same build, same "Full" setting, two containers:
 *
 *   installed app   3024x4032   289 ms/frame
 *   a browser       1080x1440    35 ms/frame
 *
 * and the two pictures looked the same. They looked the same because they
 * ARE the same: the larger stream carries about as much real detail as the
 * smaller one, so eight times the pixels bought eight times the cost and
 * nothing else. A stream can report a size its sensor mode never resolved.
 *
 * So the display size is capped by what the frame is MEASURED to contain,
 * not by what it claims. The margin is deliberately generous — the estimator
 * is a coarse halving search, and the cost of rendering somewhat more than
 * necessary is a little speed, while the cost of rendering less than the
 * frame holds is detail that cannot be got back.
 */
const DETAIL_CAP_MARGIN = 4;
/**
 * Floor for the cap, as a SHORT SIDE.
 *
 * Everything about the picture's size is expressed as a short side, because
 * width is orientation-dependent and a setting must not mean two different
 * things depending on how the phone is held. Capping width at 1280 gave a
 * landscape frame 1280x960 and a portrait one 1280x1707 — the same setting
 * rendering 1.78x more pixels upright, which is exactly why one read 63
 * ms/frame and the other 92.
 */
const DETAIL_CAP_FLOOR = 720;
const DETAIL_SAMPLE_INTERVAL_MS = 5000;
/** Real detail as a fraction of the reported size, or null when unmeasured. */
let measuredDetailScale: number | null = null;
/**
 * Whether that scale is a MEASUREMENT or only a bound.
 *
 * A pegged search ran out of levels without finding where detail stops, so
 * its scale is the smallest number it can express rather than what it found.
 * Both of Joshua's readings were exactly 1/16 — the floor of a four-level
 * search — and stating "measures about 252px of real detail" from that is the
 * same false precision already fixed once in the readout and reintroduced
 * here the moment the number was reused for something.
 */
let measuredDetailPegged = false;
let lastDetailSample = 0;

/**
 * Re-measure occasionally while a processed mode runs.
 *
 * Only a confident, textured reading counts. A flat scene has nothing to
 * measure and the estimator says so; treating that as "upscaled" would cap
 * the display because someone pointed the camera at a wall.
 */
function sampleDetailForCap(now: number): void {
  if (now - lastDetailSample < DETAIL_SAMPLE_INTERVAL_MS) return;
  lastDetailSample = now;
  const reading = readEffectiveDetail();
  if (!reading || reading.flat || reading.scale === null) return;
  measuredDetailScale = reading.scale;
  measuredDetailPegged = reading.pegged;
}

/** The largest SHORT SIDE worth rendering, given what the frame holds. */
function detailCappedShortSide(sourceShort: number): number {
  if (measuredDetailScale === null || measuredDetailScale >= 1) return sourceShort;
  const real = sourceShort * measuredDetailScale;
  return Math.max(DETAIL_CAP_FLOOR, Math.round(real * DETAIL_CAP_MARGIN));
}

/* --- The screen is a hard bound, not an inference ---------------------- *
 *
 * Joshua: the small panel preview looked sharp while the same mode full
 * screen was at maximum and lagging. Both are true at once, and the reason is
 * that neither picture was ever fully shown.
 *
 * An iPhone 15 Plus is 2796x1290 physical pixels — 932x430 points at a device
 * pixel ratio of 3. A 4:3 frame letterboxed into that full-screen box occupies
 * about 1720x1290 device pixels, and inside the panel about 1020x765. So a
 * 3024x4032 render was putting twelve megapixels through a window that can
 * display two, and the small window looked better because it was closer to
 * showing what it was given.
 *
 * This is not the detail estimator making an inference about upscaling. It is
 * arithmetic about a screen: pixels beyond what the display can resolve are
 * not merely wasteful, they are invisible. So this bound applies at every
 * setting, including the explicit ones, and unlike the detail cap it never
 * has to guess.
 *
 * SAVING IS NOT AFFECTED. A saved frame is rendered from the full sensor
 * capture, because a file is zoomed into and cropped long after the screen it
 * was framed on stopped mattering.
 */
let displayedShort = 0;
let lastDisplayMeasure = 0;

/**
 * Device pixels across the short side of the canvas AS DISPLAYED.
 *
 * Measured from layout rather than assumed, because the canvas is fitted into
 * its box with `contain` or `cover` and the content box is not the element
 * box. Re-read a few times a second: a layout read every frame would force a
 * reflow in the middle of the render loop for a number that changes only when
 * something is resized.
 */
/**
 * The screen's size in CSS pixels — what the OS calls the resolution.
 *
 * `screen` rather than the viewport because browser chrome comes and goes and
 * a render budget should not resize with it.
 */
function logicalScreenPixels(): number {
  const w = window.screen?.width ?? window.innerWidth ?? 0;
  const h = window.screen?.height ?? window.innerHeight ?? 0;
  return w > 0 && h > 0 ? w * h : 0;
}

function displayedShortSide(sourceAspect: number, now: number): number {
  if (now - lastDisplayMeasure < 400 && displayedShort > 0) return displayedShort;
  lastDisplayMeasure = now;
  const rect = presentingElement().getBoundingClientRect();
  if (!rect.width || !rect.height || !(sourceAspect > 0)) return displayedShort;
  const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 4);
  const boxAspect = rect.width / rect.height;
  const fill = byId('cameraViewer').dataset.fit === 'fill';
  // contain fits inside the box, cover fills it: the limiting axis swaps.
  const heightLimited = fill ? boxAspect < sourceAspect : boxAspect > sourceAspect;
  const contentHeight = heightLimited ? rect.height : rect.width / sourceAspect;
  const contentWidth = heightLimited ? rect.height * sourceAspect : rect.width;
  const devicePixels = Math.round(Math.min(contentWidth, contentHeight) * dpr);
  // Joshua measured the screen: 430x932 CSS pixels shown on 1290x2796 physical
  // ones. Multiplying the box by a ratio of 3 is what made full screen ask for
  // 1290 on the short side and 2.2 megapixels a frame. The budget caps the
  // extravagant case without touching the panel, which a flat ratio could not
  // do — see budgetedShortSide.
  displayedShort = budgetedShortSide(devicePixels, sourceAspect, renderPixelBudget());
  return displayedShort;
}

/**
 * The pixel budget a rendered frame is allowed, which is not the same question
 * while recording.
 *
 * The screen's logical pixel count is the right budget for a PREVIEW: drawing
 * more than the screen can show costs frame rate and shows nothing, which is
 * the measurement that fixed the lag. It is the wrong budget for a FILE, which
 * will be watched full screen, zoomed and shared long after the preview is
 * gone — and it is why a filtered clip tops out near 0.4 megapixels on a phone
 * however it is saved.
 *
 * So while recording, and only while recording, the budget can be raised. The
 * cost is frame rate and it is stated plainly: at `full` the render is bounded
 * by the screen's REAL pixels rather than its logical ones, which on a 3x
 * display is nine times the work per frame.
 */
function renderPixelBudget(): number {
  const base = logicalScreenPixels();
  // `arming` as well as recording: the pipeline has to be drawing at the larger
  // size BEFORE the recorder captures the canvas, or the first clip is sized
  // from the preview and every later one from the recording.
  if ((!rolling.recording && !armingDetail) || settings.recordDetail === 'preview') return base;
  // 'higher' doubles the budget, which is 1.41x on each side — enough to be
  // visible in a file without the frame rate falling through the floor.
  if (settings.recordDetail === 'higher') return base * 2;
  // 'full' removes the cap. What remains is the display box measured in real
  // device pixels, which is the most the app ever had reason to draw.
  return Number.POSITIVE_INFINITY;
}

/** The width that produces this short side, in the source's own orientation. */
function widthForShortSide(shortSide: number): number {
  const w = camera.diagnostics.videoWidth;
  const h = camera.diagnostics.videoHeight;
  const sourceShort = Math.min(w, h);
  if (!w || !h || sourceShort <= 0) return shortSide;
  return Math.round(shortSide * (w / sourceShort));
}

function ensureLensDisplay(width: number, height: number) {
  if (lensDisplay && lensDisplay.width === width && lensDisplay.height === height) return lensDisplay;
  const count = width * height;
  lensDisplay = {
    width,
    height,
    gray: new Uint8ClampedArray(count),
    previousGray: new Uint8ClampedArray(count),
    difference: new Uint8ClampedArray(count),
    hasPrevious: false,
    rgba: new Uint8ClampedArray(count * 4),
    imageData: new ImageData(width, height)
  };
  return lensDisplay;
}

/**
 * Paint the live lens, at the analysis size or larger.
 *
 * Above the analysis size this is the same code the saved still uses: the
 * spatial channels are recomputed at the display size from a second, larger
 * capture, and only the accumulated temporal fields are enlarged. The
 * MEASUREMENT is unchanged either way — it is still made on the analysis
 * frame — so raising the detail buys a sharper picture and not a better
 * reading, and the panel says so.
 */
/**
 * Draw a processed mode at the display size rather than the analysis size.
 *
 * Returns false when it could not — no larger frame available, or the mode is
 * one whose measurement only exists at the analysis size — and the caller then
 * takes the ordinary path. Silently drawing a small picture large is the one
 * outcome this must not produce.
 */
function renderDisplayMode(mode: VisionMode, buffers: VisionBuffers): boolean {
  if (!DISPLAY_SCALABLE_MODES.has(mode)) return false;
  const target = lensDisplayWidth();
  if (target <= buffers.width) return false;

  const frame = grabFullFrame(target);
  if (!frame) return false;
  const display = ensureLensDisplay(frame.width, frame.height);
  const { width, height } = display;

  // The previous frame has to be kept at the DISPLAY size too. Differencing a
  // display-size frame against an analysis-size one compares two different
  // pictures, and the result is not a frame difference at all.
  display.previousGray.set(display.gray);
  const hadPrevious = display.hasPrevious;
  rgbaToGray(frame.data, display.gray);
  display.hasPrevious = true;

  switch (mode) {
    case 'relief':
      display.rgba.set(reliefFromGray(display.gray, width, height));
      break;
    case 'edges':
      display.rgba.set(grayToRgba(sobelEdges(display.gray, width, height)));
      break;
    case 'difference':
      if (!hadPrevious) return false;
      absoluteDifference(display.gray, display.previousGray, display.difference);
      display.rgba.set(differenceToRgba(display.difference, 3.2));
      break;
    case 'motion':
      if (!hadPrevious) return false;
      absoluteDifference(display.gray, display.previousGray, display.difference);
      motionMaskToRgba(display.gray, display.difference, width, height, 18, display.rgba);
      break;
    case 'night': {
      display.rgba.set(frame.data);
      applyLightBoost(display.rgba, settings.nightGain, settings.nightGamma);
      applyPalette(display.rgba, settings.nightPalette);
      break;
    }
    case 'lens': {
      if (!activeLens) return false;
      const report = renderLens(
        activeLens,
        buildStillLensSources(activeLens, display.gray, width, height, null),
        display.gray, width, height, display.rgba, lensLut(activeLens)
      );
      latestLensCoverage = report.coverage;
      break;
    }
    default:
      return false;
  }

  paintVisionCanvas(width, height, display.imageData, display.rgba);
  return true;
}

function renderLensFrame(buffers: VisionBuffers, lens: CustomLens, alreadyTried = false): void {
  const started = performance.now();
  const target = lensDisplayWidth();

  if (alreadyTried || target <= buffers.width) {
    const report = renderLens(
      lens,
      buildLensSources(buffers, lens),
      buffers.gray,
      buffers.width,
      buffers.height,
      buffers.rgba,
      lensLut(lens)
    );
    latestLensCoverage = report.coverage;
    putBuffer(buffers, buffers.rgba);
    lensRenderMs += (performance.now() - started - lensRenderMs) * 0.2;
    return;
  }

  if (!renderDisplayMode('lens', buffers)) {
    // No larger frame this time; the analysis-size picture is still a picture.
    const report = renderLens(
      lens, buildLensSources(buffers, lens), buffers.gray,
      buffers.width, buffers.height, buffers.rgba, lensLut(lens)
    );
    latestLensCoverage = report.coverage;
    putBuffer(buffers, buffers.rgba);
  }

  // Exponentially smoothed, so the readout is the steady cost rather than
  // whichever frame happened to be sampled.
  lensRenderMs += (performance.now() - started - lensRenderMs) * 0.2;
}

function processVisionFrame(timestamp: number): boolean {
  const frame = cameraSource.captureFrame(analysisWidth());
  if (!frame) return false;

  // BEFORE the grayscale conversion, so every stage downstream — edges,
  // difference, speed, night, the histogram, the saved still — sees the same
  // pixels the preview shows. Applied after it, half the pipeline would work
  // from the unadjusted frame and the metrics would disagree with the picture.
  //
  // Moving the slider does momentarily read as whole-frame motion, because it
  // genuinely changes every pixel between one frame and the next. That settles
  // as soon as the value stops changing.
  if (exposureActive()) applyLightBoost(frame.data, settings.exposureGain, settings.exposureGamma);

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

  // Only Flow mode needs the block-matched field now. Speed and Trails derive
  // their own per-pixel estimate from the difference and the frame gradient,
  // which is both finer and far cheaper than a block search.
  const wantsFlow = visionMode === 'flow';
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

  // A lens binding either speed or age needs the same per-pixel estimate, so
  // the field runs for it too — and only for it, so a lens reading edges costs
  // nothing extra.
  const wantsSpeedField = visionMode === 'speed'
    || visionMode === 'motiontrails'
    || lensNeeds('speed')
    || lensNeeds('age');
  if (wantsSpeedField) {
    latestSpeed = speedField.update(
      buffers.difference,
      buffers.gray,
      buffers.width,
      buffers.height,
      usableDt,
      { motionThreshold: settings.motionSensitivity }
    );
    // The detector runs in BOTH motion modes, so Speed can arm a tripod watch
    // without the trail buffer being the thing that notices.
    // The steady gate. This does NOT stabilise the image and cannot: once the
    // phone has turned, the pixels have already moved and knowing about it does
    // not put them back. What it does is stop the app calling ego-motion an
    // event — a hand drifting lights up the whole frame, which is exactly the
    // signal the detector is watching for.
    const gated = settings.steadyGate && !!latestMotion && !deviceSteady;
    if (gated && eventDetector.currentPhase !== 'idle') {
      eventDetector.reset();
      activeEvent = null;
      eventPhase = 'idle';
    }

    if (settings.motionEventTrigger && !gated) {
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

    // Trails are held rather than reset while the phone moves: a pass already
    // painted is still a real observation, and throwing it away because the
    // phone was picked up afterwards would lose the thing that was watched for.
    if ((visionMode === 'motiontrails' || lensNeeds('age')) && !trailFrozen && !gated) {
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

  // Modes whose measurement is made on THIS frame can be redrawn at the
  // display size; the ones that accumulate over time cannot, and fall through
  // to the analysis-size path below rather than being enlarged and passed off
  // as something larger.
  const displayStarted = performance.now();
  // Sampled here because this runs only while a view is actually on screen.
  sampleStageBox(displayStarted);
  const drewLarge = renderDisplayMode(visionMode, buffers);
  if (drewLarge) lensRenderMs += (performance.now() - displayStarted - lensRenderMs) * 0.2;
  // Measured on the mode actually running, so the ladder settles differently
  // for a cheap lens than for relief — which is the point of measuring.
  updateAutoDetail(frameRateMeter.report.processingFps, displayStarted);
  sampleDetailForCap(displayStarted);

  switch (drewLarge ? 'camera' : visionMode) {
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
    case 'amplify':
      putBuffer(buffers, amplifier.render(buffers.gray, buffers.width, buffers.height, buffers.rgba, {
        gain: settings.amplifyGain
      }));
      break;
    case 'background':
      latestBackground = backgroundModel.update(buffers.gray, buffers.width, buffers.height);
      putBuffer(buffers, backgroundModel.render(buffers.gray, buffers.rgba));
      break;
    case 'chrono':
      putBuffer(buffers, chronochrome.render(
        buffers.gray, buffers.width, buffers.height, buffers.rgba, settings.chronoSpacing));
      break;
    case 'slitscan':
      putBuffer(buffers, slitScan.render(
        buffers.gray, buffers.width, buffers.height, buffers.rgba, settings.slitColumn));
      break;
    case 'night':
      renderNightFrame(buffers, frame.data);
      break;
    case 'lens':
      if (activeLens) renderLensFrame(buffers, activeLens, true);
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
  renderLensReadouts();
  renderLayerState();
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
  // Analysis is the most expensive thing here, and running it while the camera
  // panel is parked off-screen burns battery computing pixels nobody can see.
  // The STREAM stays live so returning to the tab is instant.
  if (!cameraTabVisible()) return;
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
  // Recording is driven from here rather than from a timer, so a clip cannot
  // run long while the phone is in a pocket — see RollingRecorder.tick.
  tickRecording(timestamp);

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

/**
 * Rotating the phone invalidates every cached frame size.
 *
 * The camera keeps running — the track is fine and iOS does not drop it — but
 * the frames come back transposed, and everything sized from the old geometry
 * is now wrong: the analysis buffers, the enlarged lens buffers, and the
 * overlay canvas itself. The canvas is opaque and sits on top of the video, so
 * a stale one does not look stale. It looks BLACK, and the camera looks dead
 * when it is actually still delivering.
 *
 * Nothing here restarts the camera. It drops the cached geometry and hides the
 * overlay, which uncovers the live video immediately and lets the next frame
 * rebuild everything at the new size.
 */
function handleViewportRotation(): void {
  lensDisplay = null;
  reliefScratch = null;
  lensValidScratch = null;
  lensRenderMs = 0;
  resetVisionState();
}

let rotationSettle = 0;

/**
 * Check for a new build every time the app comes back to the front.
 *
 * An installed app is resumed far more often than it is launched, and iOS can
 * keep one suspended for days. The service worker already claims clients the
 * moment it activates — but only once it has been FETCHED, and nothing was
 * asking for it after the first load. The visible symptom is the installed app
 * quietly running an older build than the same URL opened in the browser,
 * which looks like the two containers having different camera capabilities
 * rather than different code.
 *
 * `update()` is a conditional request; when nothing has changed it costs a 304.
 */
function watchForUpdatesOnResume(): void {
  if (!('serviceWorker' in navigator)) return;
  let lastCheck = 0;
  const check = () => {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    // Resuming repeatedly in a minute is one return, not several.
    if (now - lastCheck < 60_000) return;
    lastCheck = now;
    void navigator.serviceWorker.getRegistration()
      .then((registration) => registration?.update())
      .catch(() => {
        // Offline, or the registration is gone. Neither is worth reporting:
        // the app keeps working from cache either way.
      });
  };
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
}

function watchForRotation(): void {
  const onChange = () => {
    // iOS reports the change before the video track has transposed, so a
    // rebuild on the event itself measures the OLD geometry and has to be
    // thrown away again. A short settle costs one frame of live video and
    // saves rebuilding twice.
    window.clearTimeout(rotationSettle);
    rotationSettle = window.setTimeout(handleViewportRotation, 250);
  };
  window.addEventListener('orientationchange', onChange);
  // Not every device fires orientationchange, and a resize that swaps the
  // long axis is the same event by another name.
  let wasPortrait = window.innerHeight >= window.innerWidth;
  window.addEventListener('resize', () => {
    const portrait = window.innerHeight >= window.innerWidth;
    if (portrait === wasPortrait) return;
    wasPortrait = portrait;
    onChange();
  });
  screen.orientation?.addEventListener?.('change', onChange);
}

function captureParallaxReference(): void {
  try {
    const frame = camera.captureFrame(160);
    referenceGray = rgbaToGray(frame.imageData.data);
    referenceWidth = frame.width;
    referenceHeight = frame.height;
    parallaxAnalyzed = false;
    medianDisparityPx = null;
    parallaxDepthMetres = null;
    lastBaseline = null;
    // From here until Analyze B, the IMU is measuring how far the phone
    // actually travelled — which is what turns "nearer" into "roughly this
    // far", and what catches a twist masquerading as a slide.
    baseline.start();
    frameToThumbnail(byId<HTMLCanvasElement>('referenceCanvas'), frame.imageData);
    setText('parallaxMessage', motion.active
      ? 'Reference captured. Slide the phone sideways about 5–10 cm without rotating, then tap Analyze B. The baseline is being measured.'
      : 'Reference captured. Move the phone sideways about 5–10 cm without rotating much, then tap Analyze B.'
        + ' Enable motion sensors first if you want a distance rather than relative depth.');
    byId<HTMLButtonElement>('analyzeParallaxButton').disabled = false;
  } catch (error) {
    setText('parallaxMessage', error instanceof Error ? error.message : 'Unable to capture a reference frame.');
  }
}

/**
 * Say what the baseline lets us claim, and no more than that.
 *
 * Three genuinely different outcomes, and collapsing them would be the whole
 * problem: no IMU means relative depth only; a twist means the disparity is an
 * artefact and reporting a distance from it would be worse than reporting
 * nothing; and a good slide plus an entered field of view gives a real
 * triangulation, which still has to arrive with its uncertainty attached.
 */
function describeBaseline(disparityPx: number): string {
  const estimate = lastBaseline;
  if (!estimate) {
    return 'This is not calibrated distance — enable motion sensors to measure the baseline.';
  }

  if (estimate.rotationDegrees > MAX_BASELINE_ROTATION_DEGREES) {
    // Rotation shifts every pixel regardless of how far away it is, so a
    // rotated pair reads as "everything is close". That is not depth.
    return `The phone rotated ${estimate.rotationDegrees.toFixed(0)}° during the move, so this`
      + ' disparity is mostly rotation rather than parallax. Slide it sideways without turning'
      + ' and try again.';
  }

  if (!estimate.usable) {
    return `Baseline not measurable (${(estimate.displacementMetres * 100).toFixed(1)} cm`
      + ` ±${(estimate.uncertaintyMetres * 100).toFixed(1)} cm over`
      + ` ${estimate.durationSeconds.toFixed(1)}s), so this stays relative depth.`
      + ' A quicker, more definite sideways slide measures better.';
  }

  const baselineText = `Baseline ${(estimate.displacementMetres * 100).toFixed(1)} cm`
    + ` ±${(estimate.uncertaintyMetres * 100).toFixed(1)} cm.`;

  const focal = focalLengthPixels(referenceWidth, settings.motionFovDegrees);
  if (focal === null) {
    return `${baselineText} Enter a horizontal field of view in the motion panel to turn this`
      + ' into a distance.';
  }

  const depth = estimateDepthMetres(disparityPx, estimate.displacementMetres, focal);
  if (depth === null) return `${baselineText} No usable disparity to triangulate from.`;

  parallaxDepthMetres = depth;
  const error = depthUncertaintyMetres(depth, estimate);
  return `${baselineText} Median structure ≈ ${depth.toFixed(2)} m ±${error.toFixed(2)} m,`
    + ` assuming ${settings.motionFovDegrees}° horizontal field of view.`
    + ' Handheld frames are not rectified, so treat this as an estimate rather than a measurement.';
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

      baseline.stop();
      lastBaseline = motion.active ? baseline.estimate : null;
      parallaxDepthMetres = null;

      if (medianDisparityPx === null) {
        setText('parallaxMessage',
          'Not enough textured matches. Try a scene with more detail and a steadier sideways move.');
        return;
      }

      const relative = `Relative disparity median: ${medianDisparityPx.toFixed(1)} px.`
        + ' Larger disparity generally means nearer structure.';
      setText('parallaxMessage', `${relative} ${describeBaseline(medianDisparityPx)}`);
    } catch (error) {
      setText('parallaxMessage', error instanceof Error ? error.message : 'Parallax analysis failed.');
    } finally {
      button.disabled = false;
    }
  }, 20);
}

/**
 * Fetch elevation around a point and draw it.
 *
 * The only network request the app makes. Everything about it is deliberate:
 * the URL carries a zoom and two tile indices, the fetch omits credentials and
 * the referrer, and the position is never sent in any form.
 */
async function loadTerrain(lat: number, lon: number, source: string): Promise<void> {
  // Both entry points into terrain loading, disabled together: a second load
  // started while the first is fetching would interleave two sets of tiles into
  // one field.
  const buttons = ['locateAndLoadButton', 'loadTerrainManualButton']
    .map((id) => byId<HTMLButtonElement>(id));
  for (const button of buttons) button.disabled = true;

  const radius = Number(byId<HTMLSelectElement>('terrainRadius').value) || 3218;
  const window_ = tilesForRadius(lon, lat, radius, TERRAIN_ZOOM);
  setText('terrainMessage', `Requesting ${window_.tiles.length} elevation tile`
    + `${window_.tiles.length === 1 ? '' : 's'} · z${window_.zoom} ${window_.minX}–${window_.maxX},`
    + ` ${window_.minY}–${window_.maxY}. No coordinate is sent.`);

  try {
    const { field, progress } = await loadHeightfield(window_, (p) => {
      setText('terrainTiles', `${p.loaded} of ${p.total}${p.failed ? ` · ${p.failed} missing` : ''}`);
    });

    if (progress.loaded === 0) {
      setText('terrainMessage', 'No elevation tiles could be fetched. This needs a network connection,'
        + ' and open ocean genuinely has no tiles in this dataset.');
      return;
    }

    terrainField = field;
    terrainOrigin = { lat, lon };
    // A fresh area starts framed, not at whatever zoom the last one was left at.
    terrainView.scale = 1;
    terrainView.centreX = 0.5;
    terrainView.centreY = 0.5;
    drawTerrain();
    pushTerrainToScene();
    // The tiles cover at LEAST the radius asked for, and usually rather more,
    // because a tile window is quantised to tile boundaries. Reporting the
    // request rather than the result would disagree with the 3D readout.
    const coveredMiles = ((field.east - field.west) * 111320
      * Math.cos((lat * Math.PI) / 180)) / 1609.34;
    setText('terrainMessage', `Loaded from ${source}. ${progress.loaded} tile`
      + `${progress.loaded === 1 ? '' : 's'} covering ${coveredMiles.toFixed(1)} miles across`
      + ` — at least the ${(radius / 1609).toFixed(0)} mile`
      + `${radius > 1700 ? 's' : ''} requested, rounded out to whole tiles.`
      + ' Elevation data is roughly 30 m resolution — good for a hillside, not for a kerb.');
  } catch (error) {
    setText('terrainMessage', error instanceof Error ? error.message : 'Terrain could not be loaded.');
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

/**
 * The full map, rendered once at field resolution.
 *
 * Pan and zoom then blit a sub-rectangle of this to the visible canvas, so
 * dragging costs a drawImage rather than a full hillshade — which at 512x512
 * would be far too slow to follow a finger.
 */
let terrainSurface: HTMLCanvasElement | null = null;
const terrainView = { scale: 1, centreX: 0.5, centreY: 0.5 };

function drawTerrain(): void {
  const field = terrainField;
  if (!field) return;

  terrainSurface ??= document.createElement('canvas');
  const canvas = terrainSurface;
  canvas.width = field.width;
  canvas.height = field.height;
  const context = canvas.getContext('2d');
  if (!context) return;

  const stats = terrainStats(field);
  const roughness = estimateRoughness(field);
  const rgba = new Uint8ClampedArray(field.width * field.height * 4);
  renderTerrain(field, stats, rgba, {
    azimuth: Number(byId<HTMLInputElement>('terrainAzimuth').value),
    exaggeration: Number(byId<HTMLInputElement>('terrainExaggeration').value),
    contours: byId<HTMLInputElement>('terrainContours').checked,
    // Both scaled by the noise actually measured, and contours far harder,
    // because a threshold breaks into blobs where shading only gets textured.
    smoothing: clamp(Math.round(1 + roughness.mean * 2), 1, 4),
    contourSmoothing: clamp(Math.round(2 + roughness.mean * 5), 2, 9),
    noiseFloor: roughness.mean
  });
  const image = new ImageData(field.width, field.height);
  image.data.set(rgba);
  context.putImageData(image, 0, 0);

  const interval = contourInterval(Math.max(1, stats.max - stats.min), roughness.mean);
  setText('terrainRange', `${stats.min.toFixed(0)}–${stats.max.toFixed(0)} m`
    + (stats.missingFraction > 0.01 ? ` · ${(stats.missingFraction * 100).toFixed(0)}% no data` : ''));
  setText('terrainContour', `${interval} m`);
  setText('terrainResolution', `${field.metresPerPixel.toFixed(1)} m per pixel`);

  // A visible seam along a tile edge is the dataset, not the renderer: it
  // mosaics national and satellite surveys, and they carry different amounts of
  // noise. Saying so is better than leaving it looking like a bug.
  setText('terrainSourceMix', roughness.variation > 1.8
    ? `Uneven — one part of this area is ${roughness.variation.toFixed(1)}× rougher than another.`
      + ' The tile set mosaics different surveys, so a seam along a tile edge is the data.'
    : `Consistent · noise about ${roughness.mean.toFixed(2)} m`);

  if (!terrainOrigin) {
    paintTerrainView();
    return;
  }
  const point = projectToField(field, terrainOrigin.lon, terrainOrigin.lat);
  const elevation = sampleHeight(field, point.x, point.y);
  const slope = slopeAt(field, point.x, point.y);

  setText('terrainElevation', elevation === null
    ? 'no data at this point'
    : `${elevation.toFixed(1)} m · ${(elevation * 3.28084).toFixed(0)} ft`);
  setText('terrainSlope', slope === null
    ? '—'
    : `${slope.degrees.toFixed(1)}° facing ${compassPoint(slope.aspectDegrees)}`);

  paintTerrainView();
}

/**
 * Blit the visible part of the rendered map, then draw the marker on top.
 *
 * The marker is drawn HERE rather than into the surface so it keeps a constant
 * screen size as the map is zoomed — a crosshair that grows with the image
 * becomes a stripe across the whole view at 8x.
 */
function paintTerrainView(): void {
  const field = terrainField;
  const surface = terrainSurface;
  if (!field || !surface) return;

  const canvas = byId<HTMLCanvasElement>('terrainCanvas');
  const box = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round((box.width || 320) * ratio));
  const height = Math.max(1, Math.round((box.height || 320) * ratio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) return;

  clampTerrainView();
  const sourceWidth = field.width / terrainView.scale;
  const sourceHeight = field.height / terrainView.scale;
  const sourceX = terrainView.centreX * field.width - sourceWidth / 2;
  const sourceY = terrainView.centreY * field.height - sourceHeight / 2;

  context.imageSmoothingEnabled = terrainView.scale < 3;
  context.clearRect(0, 0, width, height);
  context.drawImage(surface, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);

  if (!terrainOrigin) return;
  const point = projectToField(field, terrainOrigin.lon, terrainOrigin.lat);
  const x = ((point.x - sourceX) / sourceWidth) * width;
  const y = ((point.y - sourceY) / sourceHeight) * height;
  if (x < -40 || y < -40 || x > width + 40 || y > height + 40) return;

  const reach = 11 * ratio;
  context.strokeStyle = '#ff3b6b';
  context.lineWidth = 2 * ratio;
  context.beginPath();
  context.moveTo(x - reach, y);
  context.lineTo(x + reach, y);
  context.moveTo(x, y - reach);
  context.lineTo(x, y + reach);
  context.stroke();
  context.beginPath();
  context.arc(x, y, reach * 0.55, 0, Math.PI * 2);
  context.stroke();
}

/** Keep the view inside the map, so panning cannot run off into blank space. */
function clampTerrainView(): void {
  terrainView.scale = clamp(terrainView.scale, 1, 12);
  const half = 0.5 / terrainView.scale;
  terrainView.centreX = clamp(terrainView.centreX, half, 1 - half);
  terrainView.centreY = clamp(terrainView.centreY, half, 1 - half);
}

function resetTerrainView(): void {
  terrainView.scale = 1;
  terrainView.centreX = 0.5;
  terrainView.centreY = 0.5;
  paintTerrainView();
}

/**
 * Drag to pan, pinch to zoom, double-tap to reset.
 *
 * Pointer events rather than touch events so a mouse works too, and the canvas
 * takes `touch-action: none` so the browser does not steal the gesture to
 * scroll the page — which on a card this tall is exactly what it would do.
 */
function installTerrainGestures(): void {
  const canvas = byId<HTMLCanvasElement>('terrainCanvas');
  const active = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;
  let lastTap = 0;

  const centreOf = (): { x: number; y: number } => {
    let x = 0;
    let y = 0;
    for (const point of active.values()) {
      x += point.x;
      y += point.y;
    }
    return { x: x / active.size, y: y / active.size };
  };
  const spread = (): number => {
    const points = [...active.values()];
    return points.length < 2 ? 0 : Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  };

  canvas.addEventListener('pointerdown', (event) => {
    if (!terrainField) return;
    canvas.setPointerCapture(event.pointerId);
    active.set(event.pointerId, { x: event.clientX, y: event.clientY });
    pinchDistance = spread();

    const now = performance.now();
    if (active.size === 1 && now - lastTap < 320) resetTerrainView();
    lastTap = now;
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!active.has(event.pointerId) || !terrainField) return;
    const previousCentre = centreOf();
    const previousSpread = spread();
    active.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const centre = centreOf();

    const box = canvas.getBoundingClientRect();
    // Drag distance is converted through the CURRENT zoom, so the ground moves
    // with the finger at every scale rather than sliding faster when zoomed in.
    terrainView.centreX -= (centre.x - previousCentre.x) / Math.max(1, box.width) / terrainView.scale;
    terrainView.centreY -= (centre.y - previousCentre.y) / Math.max(1, box.height) / terrainView.scale;

    if (active.size >= 2 && previousSpread > 0 && pinchDistance > 0) {
      terrainView.scale *= spread() / previousSpread;
    }
    pinchDistance = spread();
    paintTerrainView();
  });

  const release = (event: PointerEvent): void => {
    active.delete(event.pointerId);
    pinchDistance = spread();
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  canvas.addEventListener('wheel', (event) => {
    if (!terrainField) return;
    event.preventDefault();
    terrainView.scale *= event.deltaY < 0 ? 1.12 : 1 / 1.12;
    paintTerrainView();
  }, { passive: false });

  window.addEventListener('resize', () => paintTerrainView());
}

/**
 * Put the loaded terrain into the fusion scene.
 *
 * The mesh is built around the GPS TRACK's origin rather than the terrain's
 * centre, because the track is already positioned relative to that origin and
 * the two have to share it. Loading terrain by hand with no GPS running uses
 * the entered point instead, which is the only sensible origin available.
 */
function pushTerrainToScene(): void {
  const field = terrainField;
  if (!field || !terrainOrigin) return;

  const trackOrigin = gps.track[0];
  const lat = trackOrigin ? trackOrigin.latitude : terrainOrigin.lat;
  const lon = trackOrigin ? trackOrigin.longitude : terrainOrigin.lon;

  // Fewer vertices on the low quality setting: this is a phone, and a 512x512
  // field is a quarter of a million of them.
  const resolution = settings.qualityPreference === 'low' ? 96
    : settings.qualityPreference === 'high' ? 256
      : 160;

  const mesh = buildTerrainMesh(field, lat, lon, {
    resolution,
    exaggeration: Number(byId<HTMLInputElement>('terrainExaggeration').value)
  });
  fusion.setTerrain(mesh);

  if (!mesh) {
    setText('terrainSceneState', 'No elevation to build a surface from.');
    return;
  }
  if (!fusion.available) {
    // The map above is still real; only the 3D view is missing. Saying a
    // surface was built when nothing was drawn would be the worse failure.
    setText('terrainSceneState', 'The 3D view could not load, so there is nowhere to put the'
      + ' surface. The map above is unaffected.');
    return;
  }

  setText('terrainSceneState', `${mesh.columns}×${mesh.rows} surface`
    + ` · ${(mesh.spanMetres / 1609).toFixed(1)} miles across`
    + ` · datum ${mesh.datumMetres.toFixed(0)} m`
    + (mesh.missingVertices ? ` · ${mesh.missingVertices} vertices without data` : ''));

  // GPS altitude and terrain elevation disagree for real reasons — GPS height
  // is against an ellipsoid, terrain is against a geoid, and GPS vertical error
  // is several times its horizontal error. Showing the gap is more useful than
  // quietly picking one.
  if (latestGps && latestGps.altitude !== null) {
    const gap = latestGps.altitude - mesh.datumMetres;
    setText('terrainDatumGap', `${gap >= 0 ? '+' : ''}${gap.toFixed(0)} m`
      + ' (GPS altitude vs terrain; they use different vertical references)');
  } else {
    setText('terrainDatumGap', 'GPS altitude unavailable');
  }
}

/**
 * Start GPS if needed, wait for a fix, then load the terrain around it.
 *
 * One tap for what used to be three, spread across two cards and a scroll. The
 * wait is the part that needs care: a first fix can take many seconds outdoors
 * and never arrive indoors, so it is bounded and the button says which stage it
 * is in rather than sitting silent.
 */
async function locateAndLoadTerrain(): Promise<void> {
  const button = byId<HTMLButtonElement>('locateAndLoadButton');

  if (latestGps) {
    await loadTerrain(latestGps.latitude, latestGps.longitude, 'your GPS position');
    return;
  }

  if (!gps.active) {
    startGps();
    setText('terrainMessage', 'Started GPS. Waiting for a first fix…');
  } else {
    setText('terrainMessage', 'GPS is running but has no fix yet. Waiting…');
  }

  button.disabled = true;
  button.textContent = 'Waiting for GPS…';
  try {
    const fix = await waitForGpsFix(GPS_FIX_TIMEOUT_MS);
    if (!fix) {
      setText('terrainMessage', 'No GPS fix within 30 seconds. Indoors this often will not arrive'
        + ' at all — open "Pick a location by hand" and type coordinates instead.');
      return;
    }
    await loadTerrain(fix.latitude, fix.longitude, 'your GPS position');
  } finally {
    button.disabled = false;
    button.textContent = 'Use My Location';
  }
}

const GPS_FIX_TIMEOUT_MS = 30_000;

/** Resolve on the first fix, or null once the deadline passes. */
function waitForGpsFix(timeoutMs: number): Promise<GpsSample | null> {
  return new Promise((resolve) => {
    const deadline = performance.now() + timeoutMs;
    const poll = (): void => {
      if (latestGps) {
        resolve(latestGps);
        return;
      }
      if (performance.now() >= deadline) {
        resolve(null);
        return;
      }
      window.setTimeout(poll, 250);
    };
    poll();
  });
}

function compassPoint(degrees: number): string {
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return points[Math.round(degrees / 45) % 8];
}

/**
 * The rig puppet loop.
 *
 * Runs only while a model is loaded. Every frame it drives the armed bone from
 * the live IMU, plays every committed channel back, and — when a gait is set —
 * fills the remaining legs from one recorded cycle at their phase offsets.
 */
function rigTick(now: number): void {
  rigFrame = requestAnimationFrame(rigTick);
  const puppet = rigPuppet;
  if (!puppet?.rig) return;

  const loop = rigRecorder.loopSeconds;
  const position = rigPlaying || rigRecorder.isRecording
    ? (((now - rigLoopStart) / 1000) % loop + loop) % loop
    : 0;

  // Playback first, so the armed bone's live motion is not overwritten by its
  // own previous take a frame later.
  const gait = rigGaitLegs();
  const source = byId<HTMLSelectElement>('rigGaitSource').value || undefined;
  for (const [bone, rotation] of rigRecorder.pose(position, gait, source)) {
    if (bone === rigArmedBone && rigRecorder.isRecording) continue;
    puppet.setBoneRotation(bone, rotation);
  }

  if (rigArmedBone && latestMotion) {
    // Relative to the device's own resting orientation is deliberately NOT
    // done here: the rig composes onto the bone's rest pose instead, so the
    // phone's absolute orientation maps directly and predictably.
    const smoothed = rigSmoother.filter(latestMotion.quaternion, now / 1000);
    puppet.setBoneRotation(rigArmedBone, smoothed);
    if (rigRecorder.isRecording) rigRecorder.record(position, smoothed);
  }

  setText('rigClock', `${position.toFixed(2)} s`);
}

function rigGaitLegs(): GaitLeg[] {
  const pattern = byId<HTMLSelectElement>('rigGait').value;
  if (pattern === 'none') return [];
  const legs = byId<HTMLInputElement>('rigLegs').value
    .split(',').map((name) => name.trim()).filter(Boolean);
  if (legs.length < 6) return [];
  return pattern === 'wave' ? waveGait(legs) : tripodGait(legs);
}

function renderRigBones(): void {
  const list = byId('rigBoneList');
  const rig = rigPuppet?.rig;
  if (!rig) {
    list.textContent = 'Load a model to list its bones.';
    return;
  }
  list.textContent = '';
  for (const bone of rig.bones) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'bone-button';
    button.classList.toggle('active', bone.name === rigArmedBone);
    const recorded = rigRecorder.channel(bone.name);
    // Indented by depth, so a skeleton reads as a tree rather than a word list.
    button.innerHTML = `${'&nbsp;'.repeat(bone.depth * 2)}`
      + `<span class="${recorded ? 'has-take' : bone.isTip ? 'tip' : ''}">`
      + `${bone.isTip ? '•' : '▸'} ${bone.name}</span>`
      + (recorded ? ` <span class="has-take">(${recorded.keys.length} keys)</span>` : '');
    button.addEventListener('click', () => armRigBone(bone.name));
    list.appendChild(button);
  }
  setText('rigChannelCount', String(rigRecorder.boneNames.length));

  const source = byId<HTMLSelectElement>('rigGaitSource');
  const chosen = source.value;
  source.textContent = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '—';
  source.appendChild(none);
  for (const name of rigRecorder.boneNames) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    source.appendChild(option);
  }
  source.value = chosen;
}

function armRigBone(name: string | null): void {
  rigArmedBone = name;
  rigSmoother.reset();
  setText('rigArmedBone', name ?? 'none');
  byId<HTMLButtonElement>('rigRecordButton').disabled = !name;
  byId<HTMLButtonElement>('rigResetPoseButton').disabled = !rigPuppet?.rig;
  renderRigBones();
  setText('rigMessage', name
    ? `${name} armed. Move the phone to pose it${latestMotion ? '' : ' — enable motion sensors first'}.`
    : 'No bone armed.');
}

async function loadRigModel(file: File): Promise<void> {
  setText('rigMessage', `Loading ${file.name}…`);
  try {
    if (!rigPuppet) {
      const { RigPuppet } = await import('./rig/puppet.js');
      rigPuppet = new RigPuppet();
    }
    const rig = await rigPuppet.load(file);
    fusion.setRig(rig.root, rig.radius);
    rigRecorder.clear();
    armRigBone(null);
    renderRigBones();
    byId<HTMLButtonElement>('rigPlayButton').disabled = false;
    byId<HTMLButtonElement>('rigExportButton').disabled = false;
    byId<HTMLButtonElement>('rigResetPoseButton').disabled = false;

    cancelAnimationFrame(rigFrame);
    rigFrame = requestAnimationFrame(rigTick);

    setText('rigMessage', `${file.name} · ${rig.bones.length} nodes`
      + (rig.clips.length ? ` · ${rig.clips.length} existing clip${rig.clips.length === 1 ? '' : 's'}` : '')
      + (fusion.available ? '. Tap a bone below.' : '. The 3D view could not load, so nothing will be shown.'));
  } catch (error) {
    // A glTF that will not parse is the common case here — a .gltf whose
    // textures and buffers sit in sibling files a file picker never handed us.
    setText('rigMessage', `Could not load that model: ${
      error instanceof Error ? error.message : 'unknown error'
    }. A single self-contained .glb is the safest format.`);
  }
}

function exportRigAnimation(): void {
  const gait = rigGaitLegs();
  const source = byId<HTMLSelectElement>('rigGaitSource').value;
  const document_ = {
    format: 'visual-sensor-studio/rig-take',
    version: 1,
    exportedAt: new Date().toISOString(),
    loopSeconds: rigRecorder.loopSeconds,
    // The gait is exported as the RULE rather than baked into six copies of
    // the same curve, so it can be retimed or swapped in the engine.
    gait: gait.length ? { pattern: byId<HTMLSelectElement>('rigGait').value, source, legs: gait } : null,
    channels: rigRecorder.boneNames.map((bone) => {
      const channel = rigRecorder.channel(bone)!;
      return {
        bone,
        phase: channel.phase,
        muted: channel.muted,
        keys: channel.keys.map((key) => ({
          t: Number(key.time.toFixed(4)),
          q: [key.rotation.x, key.rotation.y, key.rotation.z, key.rotation.w]
            .map((v) => Number(v.toFixed(5)))
        }))
      };
    }),
    note: 'Rotations are quaternions to be composed ONTO each bone\'s rest pose, not to replace it.'
  };

  const blob = new Blob([JSON.stringify(document_, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `rig-take-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  setText('rigMessage', `Exported ${document_.channels.length} channel`
    + `${document_.channels.length === 1 ? '' : 's'}. It stays on this device.`);
}

function downloadSnapshot(): void {
  const snapshot: SensorSnapshot = {
    capturedAt: new Date().toISOString(),
    cameraFacing: camera.currentFacing,
    motion: latestMotion,
    gps: latestGps,
    gpsTrackPoints: gps.track.length,
    parallaxBaseline: lastBaseline ? {
      displacementMetres: Number(lastBaseline.displacementMetres.toFixed(4)),
      uncertaintyMetres: Number(lastBaseline.uncertaintyMetres.toFixed(4)),
      rotationDegrees: Number(lastBaseline.rotationDegrees.toFixed(2)),
      durationSeconds: Number(lastBaseline.durationSeconds.toFixed(2)),
      usable: lastBaseline.usable,
      estimatedDepthMetres: parallaxDepthMetres === null ? null : Number(parallaxDepthMetres.toFixed(3)),
      method: 'IMU dead reckoning between the two captures; error grows with the square of elapsed time'
    } : null,
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
  // Built rather than declared in the markup, because which entries exist
  // depends on what this browser can encode.
  buildSaveFormatOptions();
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
  byId<HTMLInputElement>('exposureGain').value = String(settings.exposureGain);
  byId<HTMLInputElement>('exposureGamma').value = String(settings.exposureGamma);
  applyExposureToPreview();
  byId<HTMLInputElement>('amplifyGain').value = String(settings.amplifyGain);
  setText('amplifyGainValue', `${settings.amplifyGain}×`);
  byId<HTMLInputElement>('chronoSpacing').value = String(settings.chronoSpacing);
  setText('chronoSpacingValue', `${settings.chronoSpacing} frames`);
  byId<HTMLInputElement>('slitColumn').value = String(settings.slitColumn);
  setText('slitColumnValue', settings.slitColumn < 0.34 ? 'left'
    : settings.slitColumn > 0.66 ? 'right' : 'centre');
  byId<HTMLSelectElement>('motionExposure').value = String(settings.motionExposureSeconds);
  byId<HTMLInputElement>('motionSensitivity').value = String(settings.motionSensitivity);
  setText('motionSensitivityValue', String(settings.motionSensitivity));
  byId<HTMLInputElement>('motionKeepFastest').checked = settings.motionKeepFastest;
  byId<HTMLInputElement>('motionFadeTrails').checked = settings.motionFadeTrails;
  byId<HTMLInputElement>('motionEventTrigger').checked = settings.motionEventTrigger;
  byId<HTMLInputElement>('autoStartCamera').checked = settings.autoStartCamera;
  byId<HTMLInputElement>('autoStartGps').checked = settings.autoStartGps;
  byId<HTMLInputElement>('autoStartMotion').checked = settings.autoStartMotion;
  byId<HTMLInputElement>('steadyGate').checked = settings.steadyGate;
  syncSteadyToggle();
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
/**
 * Show the camera itself full screen in RGB, exactly as the panel does.
 *
 * Joshua: "RGB small size has no lag, full screen yes." The panel hides the
 * vision canvas in RGB and lets the <video> element show through, so the
 * BROWSER composites it at the camera's own rate and none of our code runs per
 * frame. Full screen had no video element, so the same mode was blitted here
 * instead and inherited our loop's rate — about eight frames a second on his
 * device. The mode did not get slower full screen; it stopped being free.
 *
 * A filter has no equivalent: its picture only exists because we computed it,
 * so it must go through the canvas. This is why no filter can ever feel like
 * RGB in the panel, and why RGB in the panel is the one unfair baseline.
 *
 * Returns true when the video is carrying the picture and the canvas can stay
 * idle. Falls back to painting if the element is not delivering frames, so a
 * browser that dislikes two elements on one MediaStream degrades to the old
 * behaviour rather than to a black screen.
 */
function presentViewerVideo(): boolean {
  const viewerVideo = byId<HTMLVideoElement>('viewerVideo');
  const canvas = byId<HTMLCanvasElement>('viewerCanvas');
  const wanted = viewerOpen && visionCanvas.hidden;

  if (!wanted) {
    if (!viewerVideo.hidden) {
      viewerVideo.hidden = true;
      viewerVideo.srcObject = null;
    }
    canvas.hidden = false;
    return false;
  }

  if (viewerVideo.srcObject !== video.srcObject) {
    viewerVideo.srcObject = video.srcObject;
    // Autoplay is declared, but a stream attached after the element existed
    // needs the nudge, and a rejected promise here is not an error worth
    // surfacing — the fallback below covers it.
    void viewerVideo.play().catch(() => {});
  }
  // Only hand the stage over once frames are actually arriving.
  const live = viewerVideo.videoWidth > 0 && viewerVideo.readyState >= 2;
  viewerVideo.hidden = !live;
  canvas.hidden = live;
  return live;
}

function paintViewer(): void {
  if (!viewerOpen) return;
  // The video is carrying it; painting would be the same picture, computed.
  if (presentViewerVideo()) {
    renderViewerBadges();
    return;
  }
  const target = byId<HTMLCanvasElement>('viewerCanvas');
  viewerContext ??= target.getContext('2d');
  if (!viewerContext) return;

  const source: CanvasImageSource = visionCanvas.hidden ? video : visionCanvas;
  const sourceWidth = visionCanvas.hidden ? video.videoWidth : visionCanvas.width;
  const sourceHeight = visionCanvas.hidden ? video.videoHeight : visionCanvas.height;
  if (!sourceWidth || !sourceHeight) return;

  // THE SAME SCREEN BOUND THE PANEL OBEYS.
  //
  // Joshua: "RGB small size has no lag, full screen yes." In the panel RGB
  // does no per-frame pixel work at all — the video element goes straight to
  // the compositor. Full screen went through here instead and sized this
  // canvas to the SOURCE, so a 3024x4032 capture meant a 48MB backing store
  // and a twelve-megapixel copy every frame to fill a 430x932pt window.
  //
  // A filter arrives here already bounded, so its size passes through and only
  // the untouched RGB path changes.
  const sourceShort = Math.min(sourceWidth, sourceHeight);
  const capped = budgetedShortSide(
    sourceShort,
    Math.max(sourceWidth, sourceHeight) / sourceShort,
    logicalScreenPixels()
  );
  const scale = sourceShort > 0 ? capped / sourceShort : 1;
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  if (target.width !== width) target.width = width;
  if (target.height !== height) target.height = height;
  viewerContext.drawImage(source, 0, 0, width, height);
  renderViewerBadges();
}

/** The chip above the picture, drawn whichever element is carrying it. */
function renderViewerBadges(): void {
  const rates = frameRateMeter.report;
  // The negotiated stream size and the build both belong here, not buried in
  // Settings. The same app in an installed PWA and in Safari can negotiate
  // DIFFERENT camera modes and can be running DIFFERENT builds, and comparing
  // the two took digging through two menus on two containers to find out.
  // One glance should answer it.
  const diagnostics = camera.diagnostics;
  // Two sizes, both labelled. This chip previously showed the camera SOURCE
  // with no label, and it was read as the render size — so a screen bound
  // doing its job looked like one that had stopped working.
  const stream = diagnostics.videoWidth
    ? ` · cam ${diagnostics.videoWidth}×${diagnostics.videoHeight}`
    : '';
  const drawn = !visionCanvas.hidden && visionCanvas.width
    ? ` · draw ${visionCanvas.width}×${visionCanvas.height}`
    : '';
  setText('viewerStats', `${rates.deliveredFps.toFixed(0)} fps in · ${rates.processingFps.toFixed(0)} fps analysed`
    + ` · ${zoomState.value.toFixed(1)}×${stream}${drawn} · v${APP_VERSION}${isStandalone() ? ' PWA' : ''}`);
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

  // Release the stream from the viewer's video on the way out. paintViewer
  // returns early once the viewer is closed, so its own cleanup never runs,
  // and a second element left holding the MediaStream is a decoder still
  // being fed for a picture nobody can see.
  if (!open) presentViewerVideo();

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
/**
 * Side of the native-pixel crop the detail estimate is measured on.
 *
 * Bigger is not about accuracy at one level, it is about RANGE: each halving
 * costs a factor of two, and a 256-pixel sample runs out after three of them.
 * A 12-megapixel frame that is upscaled by more than eight then pegs the
 * search at its floor, which used to be reported as though it were a
 * measurement.
 */
const DETAIL_SAMPLE = 512;
let detailCanvas: HTMLCanvasElement | null = null;
let detailContext: CanvasRenderingContext2D | null = null;

interface DetailReading {
  sourceWidth: number;
  sourceHeight: number;
  /** Energy surviving one halve-and-restore, 0..1. Lower means real detail. */
  ratio: number;
  /** Real detail as a fraction of the reported size, or null when unjudgeable. */
  scale: number | null;
  pegged: boolean;
  flat: boolean;
}

function readEffectiveDetail(): DetailReading | null {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) return null;
  const size = Math.min(DETAIL_SAMPLE, sourceWidth, sourceHeight);
  detailCanvas ??= document.createElement('canvas');
  detailContext ??= detailCanvas.getContext('2d', { willReadFrequently: true });
  if (!detailContext) return null;
  detailCanvas.width = size;
  detailCanvas.height = size;
  detailContext.drawImage(
    video,
    Math.floor((sourceWidth - size) / 2),
    Math.floor((sourceHeight - size) / 2),
    size, size, 0, 0, size, size
  );
  const gray = rgbaToGray(detailContext.getImageData(0, 0, size, size).data);
  const report = estimateEffectiveResolution(gray, size, size);
  return {
    sourceWidth,
    sourceHeight,
    ratio: report.detailRatio,
    scale: report.detailRatio >= 1 ? null : report.effectiveScale,
    pegged: report.pegged,
    flat: report.detailRatio >= 1
  };
}

/**
 * Which capture tier actually delivers the most REAL detail.
 *
 * Asking a camera for more pixels does not always get more information. A
 * phone's video pipeline has a set of sensor readout modes, and a size that is
 * not one of them can be synthesised by scaling a smaller one up — which
 * reports a bigger number and carries no more detail, while costing more of
 * every frame to move around. Whether that is happening is not a thing to
 * reason about; it is a thing to measure on the device in hand.
 *
 * The ladder only steps DOWN. `applyConstraints` will narrow a live track
 * reliably and routinely refuses to widen one, so starting high and descending
 * is the only order that produces trustworthy readings without restarting the
 * camera between every rung.
 */
async function compareCaptureResolutions(): Promise<void> {
  const tiers = [10000, 2160, 1440, 1080, 720];
  const original = Number(settings.captureResolution);
  const rows: string[] = [];
  const started = tiers.filter((tier) => tier <= original || tier === 10000);

  setText('benchEffective', 'comparing…');
  for (const tier of started) {
    setText('benchmarkStatus', `Trying ${tier === 10000 ? 'maximum' : `${tier}p`}…`);
    await camera.setCaptureHeight(tier);
    // The track needs a moment to renegotiate and the element to catch up.
    await new Promise((resolve) => window.setTimeout(resolve, 1100));
    const reading = readEffectiveDetail();
    if (!reading) continue;
    const label = tier === 10000 ? 'max' : `${tier}p`;
    const size = `${reading.sourceWidth}×${reading.sourceHeight}`;
    if (reading.flat) {
      rows.push(`${label}: ${size} · too flat to judge`);
      continue;
    }
    const factor = reading.scale ? Math.round(1 / reading.scale) : 1;
    const real = reading.scale
      ? Math.round(Math.min(reading.sourceWidth, reading.sourceHeight) * reading.scale)
      : Math.min(reading.sourceWidth, reading.sourceHeight);
    // The comparable number across tiers is REAL detail on the short side, not
    // the reported size — that is the whole point of the exercise.
    rows.push(`${label}: ${size} · ${reading.pegged ? '≤' : '≈'}${real}px real`
      + ` (${factor}× ${factor > 1 ? 'coarser' : 'sharp'}, ratio ${reading.ratio.toFixed(2)})`);
  }

  await camera.setCaptureHeight(original);
  setText('benchEffective', rows.length ? rows.join('  |  ') : 'no readings');
  setText('benchmarkStatus', 'Real detail on the short side is the comparable number, not the reported size.'
    + ' If a bigger tier does not give more real pixels, the extra ones are interpolation:'
    + ' pick the smallest tier that reaches the maximum, since it costs less of every frame.'
    + ' Restored your original setting. Point at something textured — a blank wall has nothing to measure.');
}

/**
 * The last geometry seen while a camera view was actually on screen.
 *
 * Measuring on demand does not work here, and the first reading proved it:
 * the button lives in Settings, opening Settings covers the camera stage, and
 * the tool dutifully reported a 0x0 box and "no picture on screen". The one
 * moment a person can ask the question is the one moment the answer is not
 * visible.
 *
 * So the geometry is sampled while the view IS up, and the readout reports
 * the last good sample along with where it was taken.
 */
let lastStageBox: { width: number; height: number; where: string; at: number } | null = null;

/**
 * Which element is actually presenting the picture right now.
 *
 * Three cases, and getting this wrong silently sizes the render to something
 * nobody is looking at:
 *
 *  - Full screen draws to its OWN canvas, a blit of the pipeline's output.
 *    The panel canvas stays laid out underneath at its small size, so
 *    measuring it while the viewer is open sizes the whole render to the
 *    panel and then stretches that across the screen.
 *  - In RGB there is no canvas at all: the video element is the picture.
 *  - Otherwise it is the panel canvas.
 */
function presentingElement(): HTMLElement {
  if (viewerOpen) {
    const viewerCanvas = document.getElementById('viewerCanvas');
    if (viewerCanvas) return viewerCanvas;
  }
  return visionCanvas.hidden ? video : visionCanvas;
}

function sampleStageBox(now: number): void {
  if (lastStageBox && now - lastStageBox.at < 400) return;
  const rect = presentingElement().getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  const viewerOpen = !byId('cameraViewer').hidden;
  lastStageBox = {
    width: rect.width,
    height: rect.height,
    where: viewerOpen ? 'full screen' : 'panel',
    at: now
  };
}

/**
 * Report the three sizes that all get called "resolution".
 *
 * Built because guessing which one was which cost several rounds of changes:
 * the viewer chip showed the camera SOURCE while being read as the render
 * size, so a working screen bound looked like a broken one.
 */
function reportDisplayMetrics(): void {
  // Prefer a live box; fall back to the last one seen while the view was up.
  sampleStageBox(performance.now());
  const live = presentingElement().getBoundingClientRect();
  const usable = live.width >= 1 && live.height >= 1;
  const rect = usable
    ? { width: live.width, height: live.height }
    : { width: lastStageBox?.width ?? 0, height: lastStageBox?.height ?? 0 };
  const taken = usable ? 'now' : (lastStageBox ? `last seen in the ${lastStageBox.where}` : 'never seen');
  const diagnostics = camera.diagnostics;
  const report = measureDisplay({
    screenWidth: window.screen?.width ?? window.innerWidth,
    screenHeight: window.screen?.height ?? window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    boxWidth: rect.width,
    boxHeight: rect.height,
    sourceWidth: diagnostics.videoWidth,
    sourceHeight: diagnostics.videoHeight,
    renderWidth: visionCanvas.hidden ? diagnostics.videoWidth : visionCanvas.width,
    renderHeight: visionCanvas.hidden ? diagnostics.videoHeight : visionCanvas.height,
    fill: document.getElementById('cameraViewer')?.dataset.fit === 'fill'
  });

  setText('dispScreen', `${report.screenDevice.width}×${report.screenDevice.height} px`);
  setText('dispRatio', `${(window.devicePixelRatio || 1).toFixed(2)}× · `
    + `${Math.round(rect.width)}×${Math.round(rect.height)} pt box`);
  setText('dispBox', `${report.boxDevice.width}×${report.boxDevice.height} px`);
  setText('dispContent', report.contentPixels
    ? `${report.contentDevice.width}×${report.contentDevice.height} · ${megapixels(report.contentPixels)}`
    : 'no picture on screen');
  setText('dispSource', diagnostics.videoWidth
    ? `${diagnostics.videoWidth}×${diagnostics.videoHeight} · ${megapixels(report.sourcePixels)}`
    : 'no camera');
  setText('dispRender', visionCanvas.hidden
    ? `RGB — the video element itself, ${diagnostics.videoWidth}×${diagnostics.videoHeight}`
    : `${visionCanvas.width}×${visionCanvas.height} · ${megapixels(report.renderPixels)}`);
  setText('dispWhen', taken);

  // What this device actually manages, and therefore what each tier would
  // cost on it. The work is per-pixel, so one measured rate predicts them all
  // — which is the difference between "try it and see" and knowing first.
  const throughput = throughputMegapixelsPerSecond(report.renderPixels, lensRenderMs);
  setText('dispThroughput', throughput > 0
    ? `${throughput.toFixed(1)} MP/s in this mode`
    : 'run a filter mode to measure');

  const sourceAspect = diagnostics.videoHeight > 0
    ? diagnostics.videoWidth / diagnostics.videoHeight
    : 0;
  const ceiling = Math.min(report.contentDevice.width, report.contentDevice.height) || 0;
  const rows = throughput > 0 && sourceAspect > 0 && ceiling > 0
    ? projectTiers(
        [
          { shortSide: 540, label: '540' },
          { shortSide: 720, label: '720' },
          { shortSide: 1080, label: '1080' },
          { shortSide: ceiling, label: 'Full' }
        ],
        sourceAspect,
        throughput,
        ceiling
      )
    : [];
  setText('dispProjection', rows.length
    ? `At this rate, here: ${rows
        .map((row) => `${row.label} ≈ ${row.fps.toFixed(0)} fps`)
        .join(' · ')}. Pick the largest that still moves.`
    : '');
  // Overdraw costs very different things depending on who does the scaling.
  // In RGB the browser hands the video straight to the compositor and the GPU
  // scales it for nothing, so a large number there is not a problem. A canvas
  // render is CPU work per pixel, and the same number is the frame rate.
  const free = visionCanvas.hidden;
  setText('dispOverdraw', report.overdraw
    ? `${report.overdraw.toFixed(2)}× ${report.overdraw > 1.2
        ? (free ? 'more than shown — but scaled by the GPU, so free' : 'more than can be seen — CPU work per pixel')
        : 'of what is shown'}`
    : '—');
  setText('dispSourceOver', report.sourceOverdraw
    ? `${report.sourceOverdraw.toFixed(1)}× the displayable pixels`
    : '—');
}

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
  const ratio = report.detailRatio.toFixed(2);
  if (!report.likelyUpscaled) {
    return `${sourceWidth}×${sourceHeight} · detail at full pixel scale (ratio ${ratio})`;
  }

  const factor = Math.round(1 / report.effectiveScale);
  if (report.pegged) {
    // The search ran out of levels without ever finding real detail, so the
    // scale it stopped at is the floor of what it can express rather than an
    // estimate. Quoting a pixel size here would state a precision the method
    // does not have — the honest reading is a bound.
    return `${sourceWidth}×${sourceHeight} reported · at least ${factor}× coarser than that`
      + ` — beyond what a ${size}px sample can resolve (ratio ${ratio})`;
  }
  const effectiveWidth = Math.round(sourceWidth * report.effectiveScale);
  const effectiveHeight = Math.round(sourceHeight * report.effectiveScale);
  return `${sourceWidth}×${sourceHeight} reported · ≈${effectiveWidth}×${effectiveHeight} real detail`
    + ` (about ${factor}× upscaled, ratio ${ratio})`;
}

/** Grab the live video at native resolution, honouring any digital crop. */
/**
 * Draw the video into an ImageData at a chosen width, or at its own.
 *
 * Deliberately NOT `cameraSource.captureFrame`, which clamps to 960 px. That
 * clamp is right for the analysis pipeline it was written for — a per-frame
 * budget, not a picture — but it is the reason a live lens asked to render at
 * 720p or full resolution came back at 960 either way.
 */
function grabFullFrame(targetWidth?: number): ImageData | null {
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
  const wanted = targetWidth && targetWidth > 0
    ? Math.min(Math.round(cropWidth), Math.round(targetWidth))
    : Math.round(cropWidth);
  const width = Math.max(32, wanted);
  const height = Math.max(24, Math.round((cropHeight / cropWidth) * width));

  stillCanvas ??= document.createElement('canvas');
  stillContext ??= stillCanvas.getContext('2d', { willReadFrequently: true });
  if (!stillContext) return null;

  // ONLY WHEN IT CHANGES. Assigning to canvas.width or canvas.height resets
  // the backing store and clears the bitmap even when the value is unchanged —
  // that is what the spec says the setter does, not an optimisation browsers
  // are free to skip. This ran unguarded on every frame, so every filter frame
  // reallocated and cleared its capture canvas before drawing into it, in the
  // small panel exactly as much as in full screen. paintVisionCanvas has
  // always guarded the same assignment; this path did not.
  if (stillCanvas.width !== width) stillCanvas.width = width;
  if (stillCanvas.height !== height) stillCanvas.height = height;
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
/**
 * Channel data for a full-resolution still.
 *
 * Four of the seven channels are recomputed here at the frame's real size, so
 * a saved lens picture carries the detail the sensor actually delivered. The
 * three that cannot are accumulated across time on the analysis frame — there
 * is no full-resolution history to re-derive them from — so they are enlarged
 * from the live measurement instead, smoothly and with a conservative valid
 * mask.
 */
function buildStillLensSources(
  lens: CustomLens,
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  previous: ImageData | null
): ChannelSource {
  const needed = lensChannels(lens);
  const sources: ChannelSource = {};
  const analysis = visionBuffers;

  if (needed.has('luma')) sources.luma = { values: gray };

  let edges: Uint8ClampedArray | null = null;
  if (needed.has('edges') || needed.has('relief')) {
    edges = sobelEdges(gray, width, height);
    if (needed.has('edges')) sources.edges = { values: edges };
    if (needed.has('relief')) {
      sources.relief = { values: reliefField(gray, width, height, undefined, edges) };
    }
  }

  if (needed.has('change') && previous) {
    // A genuine full-resolution difference, from the second captured frame.
    sources.change = { values: absoluteDifference(gray, rgbaToGray(previous.data)) };
  }

  if (analysis) {
    const live = buildLensSources(analysis, lens);
    // Change is enlarged only when there was no second full frame to difference
    // — that is the live path, where grabbing two full frames per displayed
    // frame would cost more than the whole lens render.
    const enlarge = needed.has('change') && !previous
      ? (['change', 'speed', 'age', 'novelty'] as const)
      : (['speed', 'age', 'novelty'] as const);
    for (const id of enlarge) {
      const channel = live[id];
      if (needed.has(id) && channel) {
        sources[id] = upscaleChannel(channel, analysis.width, analysis.height, width, height);
      }
    }
  }

  return sources;
}

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
      // Deliberately NOT re-derived at full resolution. The measurement is a
      // per-pixel estimate made on the analysis frame; enlarging the picture
      // keeps the saved frame the one that was on screen, at full size, over a
      // full-resolution scene.
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
    case 'lens': {
      if (!activeLens) return frame.data;
      // Rendered at FULL resolution. Most of what a lens reads can be
      // recomputed from this frame at its real size — luma, edges, relief,
      // and a frame difference when a second full frame was captured — so
      // there is no reason for a saved still to carry analysis-resolution
      // detail. Only the accumulated temporal estimates have to be enlarged,
      // and those are enlarged smoothly rather than as blocks.
      const out = new Uint8ClampedArray(width * height * 4);
      renderLens(
        activeLens,
        buildStillLensSources(activeLens, gray, width, height, previous),
        gray,
        width,
        height,
        out,
        lensLut(activeLens)
      );
      return out;
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
  const lensWantsChange = visionMode === 'lens'
    && !!activeLens
    && lensChannels(activeLens).has('change');
  if (visionMode === 'motion' || visionMode === 'difference' || visionMode === 'flow'
    || lensWantsChange) {
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
  // The mode renders at the FULL frame first and the crop is taken from the
  // result, not before it. Cropping first would change what the edge and
  // relief filters see at the new border, so the same scene would render
  // differently depending on a setting about the file's shape.
  const source = document.createElement('canvas');
  source.width = frame.width;
  source.height = frame.height;
  const sourceContext = source.getContext('2d');
  if (!sourceContext) return;
  const image = new ImageData(frame.width, frame.height);
  image.data.set(rgba);
  sourceContext.putImageData(image, 0, 0);

  const ratio = aspectRatioFor(settings.saveAspect);
  const crop = ratio
    ? cropToAspect(frame.width, frame.height, ratio)
    : { x: 0, y: 0, width: frame.width, height: frame.height };

  if (crop.width === frame.width && crop.height === frame.height) {
    saveCanvas(source, `${frame.width}×${frame.height}`);
    return;
  }

  const output = document.createElement('canvas');
  output.width = crop.width;
  output.height = crop.height;
  const context = output.getContext('2d');
  if (!context) return;
  context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  const kept = Math.round(retainedFraction(frame.width, frame.height, crop) * 100);
  saveCanvas(output, `${crop.width}×${crop.height} · ${kept}% of the ${frame.width}×${frame.height} frame`);
}

function saveCanvas(source: HTMLCanvasElement, description: string): void {
  // Resolved rather than trusted: a browser asked for a type it cannot encode
  // does not throw, it quietly returns a PNG. Writing 22MB of PNG under a
  // .webp name would be the file lying about what it is.
  const format = resolveFormat(settings.saveFormat, encodableFormats());
  const info = formatInfo(format);
  const quality = clampQuality(settings.saveQuality);
  source.toBlob((blob) => {
    if (!blob) {
      setText('cameraMessage', 'The frame could not be encoded.');
      return;
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName(visionMode, format, new Date());
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    // Fill is a DISPLAY crop, and the save is always the whole frame. Saying
    // so matters: a shot framed in Fill contains more than was on screen, and
    // finding that out later — after the moment has gone — is worse than
    // reading one clause now. Extra frame can be cropped afterwards; a frame
    // cropped at capture cannot be got back.
    const cropped = byId('cameraViewer').dataset.fit === 'fill'
      ? ' Fill crops the screen, not the file — this is the whole frame.'
      : '';
    // The size is stated because it is the thing that surprised him: the same
    // frame is 22MB as PNG and about a tenth of that as JPEG, and no part of
    // the UI said so until after the file existed.
    const size = describeBytes(blob.size);
    setText('cameraMessage',
      `Saved ${description} · ${visionMode} · ${size} ${info.extension.toUpperCase()}.`
      + ` It stays on this device.${cropped}`);
  }, info.mime, info.lossy ? quality : undefined);
}

/**
 * Offer only what this browser can encode, and say which one is in force.
 *
 * An unavailable option must never look functional: a WebP entry on a browser
 * that silently returns PNG would be a control that appears to work and
 * quietly does something else.
 */
function buildSaveFormatOptions(): void {
  const select = document.getElementById('saveFormat') as HTMLSelectElement | null;
  if (!select) return;
  const available = encodableFormats();
  select.innerHTML = '';
  for (const format of SAVE_FORMATS) {
    if (!available.includes(format.id)) continue;
    const option = document.createElement('option');
    option.value = format.id;
    option.textContent = format.label;
    select.appendChild(option);
  }
  select.value = resolveFormat(settings.saveFormat, available);
  syncSaveFormatControls();
}

function syncSaveFormatControls(): void {
  const active = formatInfo(resolveFormat(settings.saveFormat, encodableFormats()));
  const quality = clampQuality(settings.saveQuality);
  const slider = document.getElementById('saveQuality') as HTMLInputElement | null;
  if (slider) {
    slider.value = String(Math.round(quality * 100));
    // Disabled rather than hidden: the control keeps its place, and the note
    // below says why it is inert, so PNG does not look like a broken slider.
    slider.disabled = !active.lossy;
  }
  setText('saveQualityValue', active.lossy ? `${Math.round(quality * 100)}%` : 'n/a');
  setText('saveQualityNote', active.lossy
    ? 'Only applies to JPEG and WebP. Lossless PNG ignores it.'
    : 'PNG is lossless, so there is no quality to trade. Choose JPEG or WebP to use this.');
}

/**
 * The image types this browser can actually encode, measured once.
 *
 * A version table would be one more thing claiming a capability the device may
 * not have. Asking the canvas is cheap and cannot be wrong.
 */
let encodable: SaveFormat[] | null = null;
function encodableFormats(): SaveFormat[] {
  encodable ??= supportedFormats((mime) => {
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    return probe.toDataURL(mime);
  });
  return encodable;
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

  // Exposure, where the hardware offers it. On iOS these are usually "not
  // exposed" — WebKit implements almost none of the photo capabilities — so
  // these rows simply will not appear, and the digital pair below still works.
  const exposureField = fields.exposureMode;
  const exposureWrap = byId('exposureModeWrap');
  const exposureSelect = byId<HTMLSelectElement>('exposureMode');
  const exposureModes = exposureField?.state === 'supported' && Array.isArray(exposureField.options)
    ? exposureField.options
    : [];
  exposureWrap.hidden = exposureModes.length === 0;
  if (exposureModes.length && exposureSelect.dataset.signature !== exposureModes.join(',')) {
    exposureSelect.dataset.signature = exposureModes.join(',');
    exposureSelect.textContent = '';
    for (const option of exposureModes) {
      const element = document.createElement('option');
      element.value = String(option);
      element.textContent = String(option);
      exposureSelect.appendChild(element);
    }
    const current = report.settings.exposureMode;
    if (typeof current === 'string') exposureSelect.value = current;
  }

  // Shutter and ISO are only meaningful once exposure is off automatic, so
  // they follow the mode rather than standing alone.
  const manualExposure = exposureModes.includes('manual')
    && exposureSelect.value === 'manual';
  for (const [id, wrapId, needsManual] of [
    ['exposureCompensation', 'exposureCompWrap', false],
    ['exposureTime', 'exposureTimeWrap', true],
    ['isoValue', 'isoWrap', true]
  ] as Array<[string, string, boolean]>) {
    const key = id === 'isoValue' ? 'iso' : id;
    const field = fields[key];
    const usable = field?.state === 'supported'
      && typeof field.min === 'number' && typeof field.max === 'number'
      && (!needsManual || manualExposure);
    byId(wrapId).hidden = !usable;
    if (!usable) continue;
    const input = byId<HTMLInputElement>(id);
    input.min = String(field.min);
    input.max = String(field.max);
    input.step = String(field.step ?? (field.max! - field.min!) / 100);
    const current = report.settings[key];
    if (typeof current === 'number') input.value = String(current);
  }

  byId('manualRow').hidden = false;
  syncTorchButtons();
}

/**
 * Post-capture brightness, which always works and is never exposure.
 *
 * Real exposure decides how much light the sensor collects. This multiplies
 * what it already collected, so it lifts a dark frame at the cost of lifting
 * its noise too, and a highlight that clipped to 255 stays clipped — there is
 * nothing above white to recover. Worth having because WebKit exposes almost no
 * real photo controls, and worth labelling because the two are not the same
 * thing and a slider called Brightness invites believing they are.
 */
function exposureActive(): boolean {
  return Math.abs(settings.exposureGain - 1) > 0.01 || Math.abs(settings.exposureGamma - 1) > 0.01;
}

function applyExposureToPreview(): void {
  // The live RGB preview shows the video element directly, so there is no
  // buffer to adjust — the filter does it in the compositor instead.
  //
  // A sampled table, not CSS brightness/contrast and not feComponentTransfer's
  // own `gamma` type: neither can express the soft shoulder, so the preview
  // would diverge from the pipeline exactly where the shoulder does its work.
  const table = lightBoostTable(settings.exposureGain, settings.exposureGamma).join(' ');
  for (const id of ['R', 'G', 'B']) {
    document.getElementById('exposureFilter')
      ?.querySelector(`feFunc${id}`)
      ?.setAttribute('tableValues', table);
  }
  video.style.filter = exposureActive() ? 'url(#exposureFilter)' : '';
  setText('exposureGainValue', `${settings.exposureGain.toFixed(2)}×`);
  setText('exposureGammaValue', settings.exposureGamma.toFixed(2));
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

/* --- Recording ----------------------------------------------------------
 *
 * Joshua: "Is it possible to make GIF and videos? Maybe have it record
 * continuously but in 30s max clips for size, and temporary hold on the user's
 * phone until you save it."
 *
 * WHAT IS RECORDED is what is on screen, filter included — a recording of the
 * raw camera would be a worse copy of what the phone's own camera app already
 * does, and the reason to record here is the processing. When no filter is
 * painting, the camera's own track is recorded directly instead, because
 * re-encoding a canvas copy of an untouched frame only loses quality.
 */

let clipFormat: ClipFormat | null = null;
let clipBitrate = 0;
let mediaRecorder: MediaRecorder | null = null;
let segmentChunks: Blob[] = [];
let segmentStartedAt = 0;
let segmentLabel = 'camera';
let recordStream: MediaStream | null = null;
/** True when recordStream is ours to stop — never the camera's own tracks. */
let recordStreamIsOurs = false;
/** Frames actually written into the recording canvas this clip. */
let segmentFrames = 0;
/** The last clip's measured rate, or 0 before one exists. */
let recordedFps = 0;
/** True between pressing Record and the pipeline drawing at the record size. */
let armingDetail = false;
let clipLimits: RetentionLimits = { maxClips: 0, maxBytes: 0 };
let lastElapsedPaint = 0;

const rolling = new RollingRecorder({
  beginSegment: () => beginSegment(),
  endSegment: () => endSegment()
});

function recordingSupported(): boolean {
  return typeof MediaRecorder !== 'undefined' && clipFormat !== null;
}


function detectClipFormat(): void {
  if (typeof MediaRecorder === 'undefined') {
    clipFormat = null;
    setText('recordFormat', 'not available in this browser');
    return;
  }
  const named = typeof MediaRecorder.isTypeSupported === 'function'
    ? preferredClipFormat(supportedClipFormats(
      (mime) => MediaRecorder.isTypeSupported(mime),
      candidatesFor(settings.recordCodec)
    ))
    : null;
  // ASKING IS NOT THE ONLY WAY TO FIND OUT. On Joshua's iPhone isTypeSupported
  // matched nothing, and the app told a phone that records video perfectly well
  // that it could not record video. A MediaRecorder built with no mimeType uses
  // the browser's own default and reports it back — so a browser that names
  // nothing still records, and the format is read off the recorder afterwards.
  clipFormat = named ?? BROWSER_DEFAULT;
  setText('recordFormat', clipFormat.label);
}

let recordCanvas: HTMLCanvasElement | null = null;
let recordContext: CanvasRenderingContext2D | null = null;
/** Manual-frame track while recording full-resolution stills. */
let stillsTrack: (MediaStreamTrack & { requestFrame?: () => void }) | null = null;
let stillsPrevious: ImageData | null = null;

/**
 * Modes a full-resolution still can actually reproduce.
 *
 * renderStill re-derives these from the frame in hand at whatever size it is
 * given. The rest — trails, amplify, the learned background, chronochrome,
 * slit scan — are accumulated over time ON THE ANALYSIS FRAME, so there is no
 * full-resolution history to redraw them from and a "still" of one is just the
 * camera frame with the filter missing. Offering sensor-resolution recording
 * for those would produce a large file of the wrong picture.
 */
const STILL_RENDERABLE_MODES: ReadonlySet<VisionMode> = new Set<VisionMode>([
  'camera', 'relief', 'edges', 'motion', 'difference', 'flow', 'speed', 'lens', 'night'
]);

/**
 * The largest frame the H.264 encoder will take, as a short side.
 *
 * Not an arbitrary limit: H.264 levels are specified in macroblocks, and the
 * highest level phones implement tops out around 36,864 of them — about 8.3
 * megapixels. This phone's sensor is 3024x4032, which is 12.2 MP and 47,628
 * macroblocks, so asking the encoder for the true sensor size would be asking
 * for something no level allows. 2160 on the short side is 4K-class and inside
 * every level that matters.
 */
const STILLS_MAX_SHORT_SIDE = 2160;

function stillsRecordingWanted(): boolean {
  return settings.recordDetail === 'sensor' && STILL_RENDERABLE_MODES.has(visionMode);
}

function stillsTargetWidth(): number {
  const w = camera.diagnostics.videoWidth || 0;
  const h = camera.diagnostics.videoHeight || 0;
  if (!w || !h) return 0;
  const shortSide = Math.min(w, h);
  const scale = Math.min(1, STILLS_MAX_SHORT_SIDE / shortSide);
  return Math.max(32, Math.round(w * scale));
}

/**
 * Record by taking stills, which is Joshua's own proposal: "why can't the
 * recording basically keep taking stills of the video feed?"
 *
 * It can, and this is it. The still path already renders every mode it can
 * re-derive at the camera's own resolution — that is how Save Frame works — so
 * the only new thing is doing it repeatedly and handing each result to the
 * encoder as one frame.
 *
 * WHAT IT COSTS, measured on one sobel pass over random data, single-threaded:
 *
 *   0.40 MP (the preview's size)   29 ms   35 frames/s
 *   1.67 MP                       123 ms    8 frames/s
 *   2.07 MP (1080p)               143 ms    7 frames/s
 *   8.29 MP (4K)                  515 ms    1.9 frames/s
 *  12.19 MP (this sensor)         784 ms    1.3 frames/s
 *
 * and a whole mode is several times one sobel pass. So this produces about one
 * frame a second at 4K: a full-resolution TIMELAPSE, not a video, and the
 * control says so. That is not a limitation of the recorder — it is what
 * filtering twelve megapixels in a browser costs, and it is the same arithmetic
 * that made the preview budget exist in the first place.
 *
 * captureStream(0) rather than a frame rate: in manual mode the canvas emits a
 * frame only when asked, so every frame in the file is one that was actually
 * rendered and none is a duplicate of a slow one.
 */
async function stillsRecordingLoop(): Promise<void> {
  const width = stillsTargetWidth();
  while (rolling.recording && stillsTrack && recordContext && recordCanvas) {
    const frame = grabFullFrame(width);
    if (!frame) break;
    const rgba = renderStill(visionMode, frame, stillsPrevious);
    const image = new ImageData(frame.width, frame.height);
    image.data.set(rgba);
    if (recordCanvas.width !== frame.width) recordCanvas.width = frame.width;
    if (recordCanvas.height !== frame.height) recordCanvas.height = frame.height;
    recordContext.putImageData(image, 0, 0);
    stillsTrack.requestFrame?.();
    segmentFrames += 1;
    stillsPrevious = frame;
    // Yield, or the interface is frozen for the whole recording. A full-size
    // render already blocks for most of a second; this at least lets the timer
    // that cuts a clip, and the button that stops one, run between frames.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * The size to record a FILTER at.
 *
 * Joshua: "was wondering why so small — was doing the original issue of
 * 166x221 and not max resolution it can do." A ten-second clip came out
 * 382kB because the overlay canvas IS 166x221: several modes compute at the
 * analysis size for speed, and recording that canvas directly recorded the
 * analysis frame rather than the picture on screen.
 *
 * So a filter is recorded at the size it is DISPLAYED, through the same budget
 * the viewer uses — capped against the screen so a recording cannot ask for the
 * twelve-megapixel frames that made the preview lag.
 *
 * BE CLEAR ABOUT WHAT THIS IS. Upscaling adds no detail. The picture in the
 * file is the same picture that was on screen, at the size it was on screen,
 * and the fine structure still comes from whatever the filter actually
 * computed. Making the FILTER render larger is what the Live detail control
 * does, and it costs frame rate — which is the trade Joshua already made once
 * deliberately. This only stops the file being smaller than the preview.
 */
function recordTargetSize(): { width: number; height: number } {
  const sourceWidth = visionCanvas.width || 4;
  const sourceHeight = visionCanvas.height || 3;
  const long = Math.max(sourceWidth, sourceHeight);
  const short = Math.min(sourceWidth, sourceHeight);
  const elongation = short > 0 ? long / short : 1;

  const cameraShort = Math.min(
    camera.diagnostics.videoWidth || 0,
    camera.diagnostics.videoHeight || 0
  );
  const wanted = cameraShort > 0 ? cameraShort : short;
  // Never smaller than what the filter produced — an upscale is a presentation
  // choice, a downscale would throw away something that was actually computed.
  // renderPixelBudget, not logicalScreenPixels: the two have to agree or a mode
  // that cannot render larger is still pinned to the preview's size while one
  // that can is not.
  const target = Math.max(short, budgetedShortSide(wanted, elongation, renderPixelBudget()));
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  const scale = target / short;
  return sourceWidth >= sourceHeight
    ? { width: even(sourceWidth * scale), height: even(target) }
    : { width: even(target), height: even(sourceHeight * scale) };
}

/**
 * Copy the overlay into the recording canvas, and COUNT IT.
 *
 * The count is the honest frame rate of the recording, and it is worth
 * measuring rather than assuming, because Joshua's 7-second lens clip came out
 * at 7.52 fps and the obvious explanation was wrong.
 *
 * Measured in Chromium, four ways:
 *
 *   redraw at 60Hz, changing content   -> 29.6 fps recorded
 *   redraw at 60Hz, identical content  -> 29.6 fps recorded (tiny file)
 *   redraw at 8Hz                      ->  8.3 fps recorded
 *   never redrawn after the first draw ->  no frames at all
 *
 * So the recorded rate is exactly the rate this function runs at, and a canvas
 * that is not redrawn produces nothing — not even duplicates. Then the case
 * that matters: with 120ms of blocking work per frame, the way a
 * display-resolution lens render behaves, the recording came out at 4.4 fps —
 * and poking the track with requestFrame() 30 times a second changed it to 4.3,
 * because that timer is queued behind the same blocked thread.
 *
 * THERE IS NO MAIN-THREAD TRICK. A steady 30 fps output while the pipeline
 * makes 7 pictures a second is not something the recorder can arrange; the
 * frames do not exist. What the app can do is say so, which is what
 * recordedFps is for.
 */
function blitRecordFrame(): void {
  if (!recordCanvas || !recordContext) return;
  if (visionCanvas.hidden || !overlayPainted || !visionCanvas.width) return;
  recordContext.drawImage(
    visionCanvas, 0, 0, visionCanvas.width, visionCanvas.height,
    0, 0, recordCanvas.width, recordCanvas.height
  );
  segmentFrames += 1;
}

/**
 * The surface to record, and what to call it.
 *
 * The overlay canvas is only the source while it is actually painting: a
 * hidden or stale canvas would record a black rectangle, which is the failure
 * this returns the camera track to avoid.
 */
function recordSource(): { stream: MediaStream; ours: boolean; label: string } | null {
  if (stillsRecordingWanted()) {
    const width = stillsTargetWidth();
    if (width > 0) {
      recordCanvas ??= document.createElement('canvas');
      recordContext = recordCanvas.getContext('2d');
      if (recordContext && typeof recordCanvas.captureStream === 'function') {
        // Manual frames: every frame in the file is one that was rendered.
        const stream = recordCanvas.captureStream(0);
        stillsTrack = stream.getVideoTracks()[0] as typeof stillsTrack;
        stillsPrevious = null;
        return { stream, ours: true, label: `${visionMode} stills` };
      }
    }
  }
  const painting = !visionCanvas.hidden && overlayPainted && visionCanvas.width > 0;
  if (painting) {
    const { width, height } = recordTargetSize();
    recordCanvas ??= document.createElement('canvas');
    if (recordCanvas.width !== width) recordCanvas.width = width;
    if (recordCanvas.height !== height) recordCanvas.height = height;
    recordContext = recordCanvas.getContext('2d');
    if (recordContext && typeof recordCanvas.captureStream === 'function') {
      recordContext.imageSmoothingEnabled = true;
      recordContext.imageSmoothingQuality = 'high';
      blitRecordFrame();
      return {
        stream: recordCanvas.captureStream(30),
        ours: true,
        label: `${visionMode} ${width}×${height}`
      };
    }
  }
  const live = video.srcObject as MediaStream | null;
  if (live && live.getVideoTracks().length > 0) {
    const w = camera.diagnostics.videoWidth;
    const h = camera.diagnostics.videoHeight;
    return { stream: live, ours: false, label: w && h ? `camera ${w}×${h}` : 'camera' };
  }
  return null;
}

function beginSegment(): void {
  if (!recordStream || !clipFormat) return;
  segmentChunks = [];
  segmentStartedAt = performance.now();
  segmentFrames = 0;
  try {
    mediaRecorder = clipFormat.mime
      ? new MediaRecorder(recordStream, {
        mimeType: clipFormat.mime,
        videoBitsPerSecond: clipBitrate
      })
      : new MediaRecorder(recordStream, { videoBitsPerSecond: clipBitrate });
  } catch {
    setText('recordMessage', 'This browser refused to start a recorder for that format.');
    stopRecording();
    return;
  }
  // What it actually chose, which is the only reliable answer. The file is
  // named from this rather than from what was asked for — a .mp4 holding WebM
  // would be the file lying about what it is.
  if (mediaRecorder.mimeType && mediaRecorder.mimeType !== clipFormat.mime) {
    clipFormat = formatFromMime(mediaRecorder.mimeType);
    setText('recordFormat', clipFormat.label);
  }
  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) segmentChunks.push(event.data);
  };
  mediaRecorder.onstop = () => { void finishSegment(); };
  mediaRecorder.start();
}

function endSegment(): void {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
}

/**
 * Read back what the encoder ACTUALLY produced, by decoding the file.
 *
 * This is the measurement the whole codec question turns on. Everything else
 * in the app knows the size it ASKED for; only the file knows the size it got,
 * and an encoder that downscales to fit the level it was handed would be
 * invisible to every other readout here.
 */
function measureEncodedSize(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const probe = document.createElement('video');
    const done = (width: number, height: number) => {
      URL.revokeObjectURL(url);
      resolve({ width, height });
    };
    probe.preload = 'metadata';
    probe.muted = true;
    probe.onloadedmetadata = () => done(probe.videoWidth, probe.videoHeight);
    probe.onerror = () => done(0, 0);
    // A file that never reports metadata must not hold up the recording.
    window.setTimeout(() => done(probe.videoWidth, probe.videoHeight), 3000);
    probe.src = url;
  });
}

async function finishSegment(): Promise<void> {
  const chunks = segmentChunks;
  segmentChunks = [];
  const format = clipFormat;
  if (!format || chunks.length === 0) return;
  const seconds = Math.max(0, (performance.now() - segmentStartedAt) / 1000);
  const frames = segmentFrames;
  recordedFps = seconds > 0 ? frames / seconds : 0;
  const blob = new Blob(chunks, { type: format.mime });
  const encoded = await measureEncodedSize(blob);
  const clip: StoredClip = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: Date.now() - Math.round(seconds * 1000),
    seconds,
    bytes: blob.size,
    label: segmentLabel,
    savedAt: null,
    fps: recordedFps,
    encodedWidth: encoded.width || undefined,
    encodedHeight: encoded.height || undefined,
    recorderMime: mediaRecorder?.mimeType || format.mime || undefined,
    blob,
    mime: format.mime,
    extension: format.extension
  };
  appendRecordLog(recordDiagnosticLine(clip, encoded));
  try {
    await putClip(clip);
  } catch {
    setText('recordMessage',
      'The clip could not be held on this device — storage refused it. Recording stopped.');
    stopRecording();
    return;
  }
  await pruneClips();
  await renderClips();
}

/**
 * Everything that decides how big a recording came out, on one line.
 *
 * Five separate ceilings are in play and each is invisible from the others:
 * the camera stream's own size (Capture resolution in Settings, which defaults
 * to 1080 on the short side), the render budget, the recording canvas, the bit
 * rate, and whatever the encoder decided to do with the frames it was handed.
 * "It is still 548x732" cannot be diagnosed without all five, so here they are
 * in one copyable line.
 */
function recordDiagnosticLine(
  clip: StoredClip,
  encoded: { width: number; height: number }
): string {
  const stamp = new Date(clip.startedAt).toLocaleTimeString();
  const stream = `${camera.diagnostics.videoWidth || 0}x${camera.diagnostics.videoHeight || 0}`;
  const render = `${visionCanvas.width}x${visionCanvas.height}`;
  const canvas = recordCanvas ? `${recordCanvas.width}x${recordCanvas.height}` : 'camera track';
  const got = encoded.width ? `${encoded.width}x${encoded.height}` : 'unreadable';
  const shrank = encoded.width && recordCanvas && encoded.width !== recordCanvas.width
    ? ' <-- ENCODER RESIZED'
    : '';
  return [
    stamp,
    `stream ${stream}`,
    `render ${render}`,
    `canvas ${canvas}`,
    `encoded ${got}${shrank}`,
    `${clip.seconds.toFixed(1)}s`,
    `${(clip.fps ?? 0).toFixed(1)}fps`,
    `asked ${(clipBitrate / 1e6).toFixed(1)}Mb/s`,
    describeSize(clip.bytes),
    `detail ${settings.recordDetail}`,
    `codec ${settings.recordCodec}`,
    clip.recorderMime || 'no mime',
    `v${APP_VERSION}`
  ].join(' · ');
}

function appendRecordLog(line: string): void {
  const log = document.getElementById('recordLog') as HTMLTextAreaElement | null;
  if (!log) return;
  log.value = log.value ? `${log.value}\n${line}` : line;
  log.scrollTop = log.scrollHeight;
}

/**
 * Drop what will not fit, and say which — never silently.
 *
 * A recorder that quietly deletes yesterday's clip to make room for this one
 * is indistinguishable from a bug, so the count and the reason are always on
 * screen after a prune.
 */
async function pruneClips(): Promise<void> {
  const quota = await readQuota();
  clipLimits = quota
    ? budgetFromQuota(quota.quota, quota.usage)
    // No estimate means no budget can be justified, so hold a conservative
    // handful rather than inventing a quota the phone never reported.
    : { maxClips: 6, maxBytes: 150 * 1024 * 1024 };
  const held = await listClips();
  const plan = planRetention(held, clipLimits);
  for (const clip of plan.evict) await deleteClip(clip.id);
  // The browser's allowance for this ONE website, not the phone's free space.
  // Joshua had 193GB free while this read 41GB, because they are different
  // numbers and only one of them is any of the app's business.
  const allowance = quota
    ? `${describeSize(Math.max(0, quota.quota - quota.usage))} this browser allows this site`
    : 'the browser does not say how much it allows this site';
  const minutes = clipBitrate > 0
    ? Math.floor(budgetSeconds(clipLimits, clipBitrate) / 60)
    : 0;
  setText('clipStorage',
    `${plan.reason} · budget ${describeSize(clipLimits.maxBytes)}`
    + (minutes > 0 ? ` (about ${minutes} min)` : '')
    + ` · ${allowance}`);
}

async function renderClips(): Promise<void> {
  const list = byId('clipList');
  const held = await listClips();
  list.replaceChildren();
  byId('clipClearButton').hidden = held.length === 0;

  for (const clip of held) {
    const row = document.createElement('div');
    row.className = 'clip-row';
    row.dataset.saved = clip.savedAt === null ? 'no' : 'yes';

    const name = document.createElement('span');
    name.className = 'clip-name';
    const encoded = clip.encodedWidth
      ? ` · ${clip.encodedWidth}×${clip.encodedHeight} encoded`
      : '';
    name.textContent = describeClip(clip) + encoded;
    row.appendChild(name);

    const save = document.createElement('button');
    save.className = 'secondary-button';
    save.type = 'button';
    save.textContent = 'Save';
    save.addEventListener('click', () => void exportClip(clip, 'save'));
    row.appendChild(save);

    if (canShareFile(clip.mime)) {
      const share = document.createElement('button');
      share.className = 'secondary-button';
      share.type = 'button';
      share.textContent = 'Share';
      share.addEventListener('click', () => void exportClip(clip, 'share'));
      row.appendChild(share);
    }

    const remove = document.createElement('button');
    remove.className = 'secondary-button';
    remove.type = 'button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => void removeClip(clip.id));
    row.appendChild(remove);

    list.appendChild(row);
  }
}

async function removeClip(id: string): Promise<void> {
  await deleteClip(id);
  await renderClips();
  await pruneClips();
}

async function exportClip(clip: StoredClip, how: 'save' | 'share'): Promise<void> {
  const name = clipFileName(clip.label, new Date(clip.startedAt), clip.extension);
  if (how === 'share') {
    const file = new File([clip.blob], name, { type: clip.mime });
    try {
      await navigator.share({ files: [file] });
    } catch (error) {
      const kind = error instanceof Error ? error.name : '';
      if (kind !== 'AbortError') setText('recordMessage', 'The share sheet could not open.');
      return;
    }
  } else {
    const url = URL.createObjectURL(clip.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  // Exported clips are the first to be dropped when room is needed, so this is
  // not bookkeeping — it decides what survives.
  await markExported(clip.id, Date.now());
  setText('recordMessage', `${name} · ${describeSize(clip.bytes)}`);
  await renderClips();
}

/**
 * Wait for the pipeline to actually redraw at the recording size.
 *
 * Raising the budget only changes what the NEXT analysed frame renders at, and
 * a heavy filter analyses a few times a second. Capturing the canvas before
 * that lands would record the preview's size and quietly ignore the setting.
 */
async function awaitRecordDetail(): Promise<void> {
  if (settings.recordDetail === 'preview') return;
  const was = visionCanvas.width;
  const until = performance.now() + 1500;
  while (performance.now() < until) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (visionCanvas.width !== was && visionCanvas.width > 0) return;
  }
  // Timed out: record anyway, at whatever size the pipeline is drawing. A
  // recording that does not start is worse than one at the preview's size.
}

async function startRecording(): Promise<void> {
  if (!recordingSupported() || rolling.recording || armingDetail) return;
  if (settings.recordDetail !== 'preview' && !stillsRecordingWanted()) {
    armingDetail = true;
    lastDisplayMeasure = 0;
    setText('recordMessage', 'Raising the render size for recording…');
    try {
      await awaitRecordDetail();
    } finally {
      armingDetail = false;
    }
    if (!camera.active) { setText('recordMessage', 'The camera stopped.'); return; }
  }
  const source = recordSource();
  if (!source) {
    setText('recordMessage', 'There is nothing to record until the camera is live.');
    return;
  }
  recordStream = source.stream;
  recordStreamIsOurs = source.ours;
  segmentLabel = source.label;
  const track = source.stream.getVideoTracks()[0];
  // Named apart from the app's own `settings`: this function reads both, and a
  // shadowing `const settings` here put the module-level one in its temporal
  // dead zone for the whole function.
  const trackSettings = track?.getSettings?.() ?? {};
  // The RECORDING canvas, not the overlay: falling back to the overlay's size
  // would aim the bit rate at the 166x221 analysis frame while encoding a
  // frame several times that, and starve it.
  const fallbackWidth = recordStreamIsOurs && recordCanvas ? recordCanvas.width : 1280;
  const fallbackHeight = recordStreamIsOurs && recordCanvas ? recordCanvas.height : 720;
  clipBitrate = suggestedBitrate(
    trackSettings.width ?? fallbackWidth,
    trackSettings.height ?? fallbackHeight,
    trackSettings.frameRate ?? 30
  );
  rolling.start(performance.now());
  // The display size is memoised for 400ms; recording changes the budget it was
  // measured under, so the old answer is stale the instant recording starts.
  lastDisplayMeasure = 0;
  syncRecordButton();
  if (stillsTrack) void stillsRecordingLoop();
  // SAY WHAT WAS ACTUALLY DONE, because three different things decide the size
  // and "it is still 548x732" is otherwise impossible to diagnose from outside.
  let how: string;
  if (stillsTrack) {
    how = ` · full-resolution stills at ${recordCanvas?.width}×${recordCanvas?.height},`
      + ' about a frame a second — a timelapse, not a video';
  } else if (settings.recordDetail === 'sensor') {
    how = ` · ${visionMode} accumulates over frames on the analysis picture, so there is no`
      + ' full-resolution version of it to save; recorded at the preview size instead';
  } else if (recordCanvas && recordCanvas.width > visionCanvas.width) {
    how = ` · ${visionMode} renders at ${visionCanvas.width}×${visionCanvas.height} and is`
      + ` scaled up to ${recordCanvas.width}×${recordCanvas.height} — the picture on screen,`
      + ' not more detail';
  } else {
    how = ` · ${visionMode} at ${recordCanvas?.width ?? 0}×${recordCanvas?.height ?? 0}`;
  }
  setText('recordMessage',
    `Recording${how} · a new clip every ${MAX_CLIP_SECONDS}s.`);
}

function stopRecording(): void {
  if (!rolling.recording) return;
  rolling.stop(performance.now());
  lastDisplayMeasure = 0;
  // Only tracks this code created. Stopping the camera's own tracks here would
  // switch the camera off as a side effect of stopping a recording.
  if (recordStreamIsOurs) recordStream?.getTracks().forEach((t) => t.stop());
  recordStream = null;
  recordStreamIsOurs = false;
  recordContext = null;
  stillsTrack = null;
  // The largest thing this app holds, and it is a full-resolution frame.
  stillsPrevious = null;
  syncRecordButton();
  setText('recordElapsed', '');
  setText('recordMessage', 'Stopped. Clips are held below until you export them.');
}

/**
 * Say what the choice costs in this device's numbers, not in adjectives.
 *
 * "Higher" and "full" both mean more pixels per frame, and pixels per frame is
 * exactly what the frame rate is spent on. A person can only weigh that if the
 * app shows the arithmetic.
 */
function syncRecordDetailNote(): void {
  // The control follows the stored choice as well as describing it, so a
  // reload does not show "match the preview" while recording at full detail.
  const control = document.getElementById('recordDetail') as HTMLSelectElement | null;
  if (control && control.value !== settings.recordDetail) control.value = settings.recordDetail;
  const codec = document.getElementById('recordCodec') as HTMLSelectElement | null;
  if (codec && codec.value !== settings.recordCodec) codec.value = settings.recordCodec;
  const screen = logicalScreenPixels();
  if (!(screen > 0)) return;
  if (settings.recordDetail === 'sensor') {
    const width = stillsTargetWidth();
    const height = width > 0
      ? Math.round(width * (camera.diagnostics.videoHeight || 3) / (camera.diagnostics.videoWidth || 4))
      : 0;
    const size = width > 0 ? `${width}×${height}` : 'the camera\u2019s own size';
    setText('recordDetailNote', STILL_RENDERABLE_MODES.has(visionMode)
      ? `Takes full-resolution stills (${size}) and encodes them as frames — about one a `
        + 'second, so the result is a timelapse rather than a video. This is the only '
        + 'setting that produces detail the preview never had.'
      : `${MODE_LABELS[visionMode]} builds up over frames on the small analysis picture, so `
        + 'there is no full-resolution version of it to save. This setting will record at '
        + 'the preview size for this mode.');
    return;
  }
  const factor = settings.recordDetail === 'preview' ? 1
    : settings.recordDetail === 'higher' ? 2
      : Math.max(1, (window.devicePixelRatio || 1) ** 2);
  setText('recordDetailNote', settings.recordDetail === 'preview'
    ? 'Records the picture at the size the preview draws it.'
    : `About ${factor.toFixed(factor < 10 ? 1 : 0)}× the pixels per frame while recording, `
      + 'so expect the frame rate to fall by roughly the same factor. It stops '
      + 'when the recording stops.');
}

function syncRecordButton(): void {
  const button = byId<HTMLButtonElement>('recordButton');
  const live = Boolean(video.srcObject) && camera.active;
  button.disabled = !recordingSupported() || (!live && !rolling.recording);
  button.textContent = rolling.recording ? 'Stop' : 'Record';
  button.dataset.recording = rolling.recording ? 'yes' : 'no';
  if (!recordingSupported()) {
    setText('recordMessage', 'This browser cannot record video from a web page.');
  } else if (!live && !rolling.recording) {
    setText('recordMessage', 'Enable the camera to record.');
  }
}

let lastCameraLive = false;

/** Driven from the animation loop, so a backgrounded tab cannot run a clip long. */
function tickRecording(now: number): void {
  // The Record button follows the camera without a listener on it, because the
  // camera can also stop on its own — a permission revoked, a track ended by
  // the system — and a button that only tracked the deliberate paths would
  // stay enabled through exactly those cases.
  const live = camera.active && Boolean(video.srcObject);
  if (live !== lastCameraLive) {
    lastCameraLive = live;
    if (!live) stopRecording();
    syncRecordButton();
    syncGifEstimate();
  }
  if (!rolling.recording) return;
  // One blit per frame, and only while recording. The canvas is capped at the
  // screen's budget, so this is nothing like the twelve-megapixel per-frame
  // copy that made the preview lag. Skipped while recording stills, which draw
  // their own frames and would otherwise be overwritten by the preview.
  if (!stillsTrack) blitRecordFrame();
  rolling.tick(now);
  if (now - lastElapsedPaint < 250) return;
  lastElapsedPaint = now;
  const total = rolling.totalElapsedMs(now) / 1000;
  const segment = rolling.segmentElapsedMs(now) / 1000;
  // THREE RATES, because they are three different things and only the last one
  // is what the file will contain. The camera delivers at one rate, the vision
  // pipeline analyses at another, and the recording gets a frame every time a
  // picture is actually redrawn — which on a saturated thread is the slowest of
  // the three. Showing only "Processing" invited the reasonable guess that the
  // counter was wrong rather than that the pictures were genuinely that rare.
  const rates = frameRateMeter.report;
  const writtenFps = segment > 0.5 ? segmentFrames / segment : 0;
  setText('recordElapsed',
    `${total.toFixed(0)}s · clip ${rolling.segmentIndex + 1} at ${segment.toFixed(0)}/${MAX_CLIP_SECONDS}s`
    + ` · in ${rates.deliveredFps.toFixed(0)} · analysed ${rates.processingFps.toFixed(0)}`
    + ` · recording ${writtenFps.toFixed(1)} fps`);
}

function canShareFile(type: string): boolean {
  if (typeof navigator.canShare !== 'function' || typeof navigator.share !== 'function') {
    return false;
  }
  try {
    return navigator.canShare({ files: [new File([new Uint8Array(1)], 'probe', { type })] });
  } catch {
    return false;
  }
}


/* --- GIF ----------------------------------------------------------------
 *
 * Frames are grabbed live rather than decoded back out of a recorded clip.
 * Decoding would mean playing the video through and reading it frame by frame,
 * which depends on seek accuracy and autoplay rules that differ between
 * browsers — a lot of machinery to arrive at pictures the camera can simply be
 * asked for directly.
 *
 * MEMORY IS THE LIMIT, and it is why the controls are three fixed lists rather
 * than free numbers. Frames are held as raw RGBA while capturing: 320x240 is
 * 300kB each, so six seconds at twelve and a half a second is 23MB. The
 * combinations offered stay inside a budget; one that would not is refused with
 * the reason rather than quietly shortened.
 */

/*
 * Frames are held as raw RGBA while capturing, so this is the real ceiling on
 * what can be offered. Sized so that every combination in the three lists fits
 * once the long side rather than the width is what is chosen: the largest is
 * six seconds at twelve and a half a second at a 480 long side, which is 75
 * frames of 480x360 — about 52MB. The check stays as a guard rather than as a
 * routine refusal.
 */
const GIF_MEMORY_BUDGET = 72 * 1024 * 1024;

let gifFrames: GifFrame[] = [];
let gifBlob: Blob | null = null;
let gifCapturing = false;
let gifCanvas: HTMLCanvasElement | null = null;

function gifChoice(): { seconds: number; fps: number; width: number } {
  const read = (id: string, fallback: number) => {
    const el = document.getElementById(id) as HTMLSelectElement | null;
    const value = Number(el?.value);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return { seconds: read('gifSeconds', 4), fps: read('gifFps', 10), width: read('gifWidth', 320) };
}

function gifSize(longSide: number): { width: number; height: number } {
  const source = !visionCanvas.hidden && visionCanvas.width > 0
    ? { w: visionCanvas.width, h: visionCanvas.height }
    : { w: video.videoWidth || 4, h: video.videoHeight || 3 };
  return fitLongSide(source.w, source.h, longSide);
}

function syncGifEstimate(): void {
  const choice = gifChoice();
  const { width, height } = gifSize(choice.width);
  const frames = Math.max(1, Math.round(choice.seconds * choice.fps));
  const held = width * height * 4 * frames;
  const bytes = estimateGifBytes(width, height, frames);
  const overBudget = held > GIF_MEMORY_BUDGET;
  setText('gifEstimate',
    `${frames} frames at ${width}×${height} · roughly ${describeSize(bytes)} `
    + `· ${describeSize(held)} of memory while capturing`
    + (overBudget ? ' — too much to hold, choose fewer or smaller frames.' : ''));
  const button = document.getElementById('gifButton') as HTMLButtonElement | null;
  if (button && !gifCapturing) {
    button.disabled = overBudget || !(camera.active && Boolean(video.srcObject));
  }
}

/** One frame, drawn from whatever is on screen, at the GIF's own size. */
function grabGifFrame(width: number, height: number, delay: number): GifFrame | null {
  gifCanvas ??= document.createElement('canvas');
  if (gifCanvas.width !== width) gifCanvas.width = width;
  if (gifCanvas.height !== height) gifCanvas.height = height;
  const context = gifCanvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;

  const painting = !visionCanvas.hidden && overlayPainted && visionCanvas.width > 0;
  const source: CanvasImageSource = painting ? visionCanvas : video;
  const sw = painting ? visionCanvas.width : video.videoWidth;
  const sh = painting ? visionCanvas.height : video.videoHeight;
  if (!sw || !sh) return null;

  context.drawImage(source, 0, 0, sw, sh, 0, 0, width, height);
  const image = context.getImageData(0, 0, width, height);
  return { data: image.data, width, height, delayCentiseconds: delay };
}

async function captureGif(): Promise<void> {
  if (gifCapturing) return;
  if (!camera.active || !video.srcObject) {
    setText('gifMessage', 'Enable the camera first.');
    return;
  }
  const choice = gifChoice();
  const { width, height } = gifSize(choice.width);
  const wanted = Math.max(1, Math.round(choice.seconds * choice.fps));
  if (width * height * 4 * wanted > GIF_MEMORY_BUDGET) {
    setText('gifMessage', 'That combination needs more memory than is safe to hold. '
      + 'Choose a shorter length or a smaller width.');
    return;
  }

  gifCapturing = true;
  gifFrames = [];
  gifBlob = null;
  byId('gifPreviewFigure').hidden = true;
  byId('gifSaveButton').hidden = true;
  byId('gifShareButton').hidden = true;
  const button = byId<HTMLButtonElement>('gifButton');
  button.disabled = true;

  // Delays are hundredths of a second, so 12.5 a second is 8 exactly while 30
  // would be 3.33 and cannot be written. The delay is what is REAL — the frame
  // rate asked for is only how often frames are grabbed — so the interval is
  // taken from the delay and the two cannot drift apart.
  const delay = Math.max(MIN_DELAY_CENTISECONDS, Math.round(100 / choice.fps));
  const intervalMs = delay * 10;

  try {
    let next = performance.now();
    while (gifFrames.length < wanted) {
      const frame = grabGifFrame(width, height, delay);
      if (frame) gifFrames.push(frame);
      setText('gifMessage', `Capturing ${gifFrames.length} of ${wanted}…`);
      next += intervalMs;
      const wait = Math.max(0, next - performance.now());
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (!camera.active) break;
    }

    if (gifFrames.length < 2) {
      setText('gifMessage', 'The camera stopped before there was anything to make a GIF from.');
      return;
    }

    setText('gifMessage', `Encoding ${gifFrames.length} frames…`);
    const bytes = await encodeGifAsync(gifFrames, { dither: true }, async (done, total) => {
      setText('gifMessage', `Encoding ${done} of ${total} frames…`);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    gifBlob = new Blob([bytes as unknown as BlobPart], { type: 'image/gif' });

    const preview = byId<HTMLImageElement>('gifPreview');
    if (preview.src.startsWith('blob:')) URL.revokeObjectURL(preview.src);
    preview.src = URL.createObjectURL(gifBlob);
    byId('gifPreviewFigure').hidden = false;
    setText('gifCaption',
      `${width}×${height} · ${gifFrames.length} frames at ${(100 / delay).toFixed(1)} a second `
      + `· ${describeSize(gifBlob.size)}`);
    setText('gifMessage', '');
    byId('gifSaveButton').hidden = false;
    byId('gifShareButton').hidden = !canShareFile('image/gif');
  } finally {
    // The frames are the largest thing this app ever holds. Dropping them the
    // moment the file exists matters more than keeping them for a re-encode.
    gifFrames = [];
    gifCapturing = false;
    syncGifEstimate();
  }
}

async function exportGif(how: 'save' | 'share'): Promise<void> {
  if (!gifBlob) return;
  const name = clipFileName('gif', new Date(), 'gif');
  if (how === 'share') {
    try {
      await navigator.share({ files: [new File([gifBlob], name, { type: 'image/gif' })] });
    } catch (error) {
      const kind = error instanceof Error ? error.name : '';
      if (kind !== 'AbortError') setText('gifMessage', 'The share sheet could not open.');
    }
    return;
  }
  const url = URL.createObjectURL(gifBlob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  setText('gifMessage', `${name} · ${describeSize(gifBlob.size)}`);
}

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
on('recordButton', 'click', () => {
  if (rolling.recording) stopRecording();
  else void startRecording();
});
on('recordCodec', 'change', (event) => {
  const value = (event.target as HTMLSelectElement).value;
  settings.recordCodec = ['auto', 'no-level', 'default'].includes(value)
    ? value as CodecPreference
    : 'auto';
  saveSettings();
  // Re-ask: the answer depends on which candidates are offered.
  detectClipFormat();
});
on('recordCopyLog', 'click', () => {
  const log = document.getElementById('recordLog') as HTMLTextAreaElement | null;
  if (!log) return;
  void navigator.clipboard?.writeText(log.value).then(
    () => setText('recordMessage', 'Diagnostics copied.'),
    () => { log.select(); }
  );
});
on('recordDetail', 'change', (event) => {
  const value = (event.target as HTMLSelectElement).value;
  settings.recordDetail = ['preview', 'higher', 'full', 'sensor'].includes(value)
    ? value as RecordDetail
    : 'preview';
  saveSettings();
  syncRecordDetailNote();
});
on('clipClearButton', 'click', () => {
  void clearClips().then(() => renderClips()).then(() => pruneClips());
});
on('gifButton', 'click', () => void captureGif());
on('gifSaveButton', 'click', () => void exportGif('save'));
on('gifShareButton', 'click', () => void exportGif('share'));
for (const id of ['gifSeconds', 'gifFps', 'gifWidth']) {
  on(id, 'change', () => syncGifEstimate());
}
on('cameraOverlayButton', 'click', () => void startCamera());
on('cameraBrowserFallback', 'click', openCameraInBrowser);
on('switchCameraButton', 'click', () => void switchCamera());
on('motionButton', 'click', () => void enableMotion());
on('gpsButton', 'click', toggleGps);
on('resetGpsButton', 'click', resetGps);
on('exposureGain', 'input', (event) => {
  settings.exposureGain = Number((event.target as HTMLInputElement).value);
  applyExposureToPreview();
  saveSettings();
});
on('exposureGamma', 'input', (event) => {
  settings.exposureGamma = Number((event.target as HTMLInputElement).value);
  applyExposureToPreview();
  saveSettings();
});
on('exposureResetButton', 'click', () => {
  settings.exposureGain = 1;
  settings.exposureGamma = 1;
  byId<HTMLInputElement>('exposureGain').value = '1';
  byId<HTMLInputElement>('exposureGamma').value = '1';
  applyExposureToPreview();
  saveSettings();
});
on('exposureMode', 'change', (event) => {
  const mode = (event.target as HTMLSelectElement).value;
  void camera.applyCameraSetting('exposureMode', mode).then((result) => {
    setText('cameraMessage', result.applied
      ? `Exposure set to ${mode}.`
      : `This camera refused exposureMode (${result.reason}).`);
    // Shutter and ISO only appear once exposure is off automatic.
    syncManualControls();
  });
});
on('exposureCompensation', 'input', (event) => {
  const value = Number((event.target as HTMLInputElement).value);
  void camera.applyCameraSetting('exposureCompensation', value);
});
on('exposureTime', 'input', (event) => {
  const value = Number((event.target as HTMLInputElement).value);
  void camera.applyCameraSetting('exposureTime', value);
});
on('isoValue', 'input', (event) => {
  const value = Number((event.target as HTMLInputElement).value);
  void camera.applyCameraSetting('iso', value);
});
on('rigFile', 'change', (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) void loadRigModel(file);
});
on('rigClearButton', 'click', () => {
  rigPuppet?.dispose();
  fusion.clearRig();
  rigRecorder.clear();
  armRigBone(null);
  cancelAnimationFrame(rigFrame);
  byId<HTMLButtonElement>('rigPlayButton').disabled = true;
  byId<HTMLButtonElement>('rigExportButton').disabled = true;
  byId<HTMLButtonElement>('rigResetPoseButton').disabled = true;
  renderRigBones();
  setText('rigMessage', 'Model removed.');
});
on('rigRecordButton', 'click', () => {
  const button = byId<HTMLButtonElement>('rigRecordButton');
  if (rigRecorder.isRecording) {
    const channel = rigRecorder.stopRecording();
    button.textContent = 'Record Bone';
    setText('rigState', 'Idle');
    setText('rigMessage', channel
      ? `${channel.bone}: ${channel.keys.length} keys committed. Arm the next bone — this one keeps playing.`
      : 'That take was too short to keep. Hold the record for at least a moment of the loop.');
    renderRigBones();
    return;
  }
  if (!rigArmedBone) return;
  rigRecorder.startRecording(rigArmedBone);
  rigLoopStart = performance.now();
  rigPlaying = true;
  button.textContent = 'Stop Recording';
  setText('rigState', `Recording ${rigArmedBone}`);
  setText('rigMessage', 'Everything already recorded is playing back. Move the phone.');
});
on('rigPlayButton', 'click', () => {
  rigPlaying = !rigPlaying;
  if (rigPlaying) rigLoopStart = performance.now();
  byId<HTMLButtonElement>('rigPlayButton').textContent = rigPlaying ? 'Stop Loop' : 'Play Loop';
  setText('rigState', rigPlaying ? 'Playing' : 'Idle');
});
on('rigResetPoseButton', 'click', () => {
  rigPuppet?.resetBone();
  setText('rigMessage', 'Every bone back to the pose the file authored.');
});
on('rigClearTakesButton', 'click', () => {
  rigRecorder.clear();
  rigPuppet?.resetBone();
  renderRigBones();
  setText('rigMessage', 'All takes cleared. The model is untouched.');
});
on('rigExportButton', 'click', exportRigAnimation);
on('rigLoop', 'change', (event) => {
  rigRecorder.loopSeconds = Number((event.target as HTMLSelectElement).value) || 2;
});
on('rigMinCutoff', 'input', (event) => {
  const value = Number((event.target as HTMLInputElement).value);
  setText('rigMinCutoffValue', `${value.toFixed(1)} Hz`);
  rigSmoother.configure({ minCutoff: value });
});
on('rigBeta', 'input', (event) => {
  const value = Number((event.target as HTMLInputElement).value);
  setText('rigBetaValue', value.toFixed(2));
  rigSmoother.configure({ beta: value });
});
on('rigGuessLegsButton', 'click', () => {
  void (async () => {
    const rig = rigPuppet?.rig;
    if (!rig) return;
    const { guessLegOrder } = await import('./rig/puppet.js');
    const guess = guessLegOrder(rig.bones);
    if (guess.length < 6) {
      setText('rigMessage', 'Could not find six leg bones by name. Type them in order instead —'
        + ' the guess only reads common naming conventions and rigs do not agree on one.');
      return;
    }
    byId<HTMLInputElement>('rigLegs').value = guess.join(', ');
    setText('rigMessage', `Guessed: ${guess.join(', ')}. Check the order before relying on it.`);
  })();
});
on('captureParallaxButton', 'click', captureParallaxReference);
on('locateAndLoadButton', 'click', () => void locateAndLoadTerrain());
on('loadTerrainManualButton', 'click', () => {
  const lat = Number(byId<HTMLInputElement>('terrainLat').value);
  const lon = Number(byId<HTMLInputElement>('terrainLon').value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) {
    setText('terrainMessage', 'Enter a latitude between -85 and 85 and a longitude between -180 and 180.');
    return;
  }
  void loadTerrain(lat, lon, 'the location you entered');
});
on('terrainExaggeration', 'input', (event) => {
  setText('terrainExaggerationValue', `${Number((event.target as HTMLInputElement).value).toFixed(1)}×`);
  drawTerrain();
});
on('terrainExaggeration', 'change', () => pushTerrainToScene());
on('terrain3dButton', 'click', () => {
  pushTerrainToScene();
  // The viewport is already in this tab, so this only needs to bring it into
  // view rather than move anywhere.
  byId('fusionScene').scrollIntoView({ behavior: 'smooth', block: 'center' });
});
on('terrainClear3dButton', 'click', () => {
  fusion.clearTerrain();
  setText('terrainSceneState', 'Cleared from the 3D view.');
});
on('terrainAzimuth', 'input', (event) => {
  setText('terrainAzimuthValue', `${(event.target as HTMLInputElement).value}°`);
  drawTerrain();
});
on('terrainContours', 'change', () => drawTerrain());
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
on('burstCaptureButton', 'click', () => void runBurstProbe());
// The row must follow the sensors rather than only the buttons: camera and
// motion can also be started from their own tabs, or dropped when the app is
// backgrounded, and a stale "Enable Camera" on a running camera reads as broken.
window.setInterval(syncBurstReadiness, 1000);
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
  // Neither setting changes what is captured, and the label should not have to
  // be discovered by saving one and comparing.
  button.title = filling
    ? 'Showing the whole frame. Saving always writes the whole frame.'
    : 'Cropping the view to the screen. Saving still writes the whole frame.';
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
on('compareResolutionsButton', 'click', () => {
  void compareCaptureResolutions();
});
on('measureDisplayButton', 'click', reportDisplayMetrics);
on('measureDetailButton', 'click', () => {
  setText('benchEffective', 'measuring…');
  // A frame later, so the placeholder actually paints before the readback.
  requestAnimationFrame(() => setText('benchEffective', measureEffectiveDetail()));
});
on('resetPeakButton', 'click', () => {
  frameRateMeter.resetPeak();
  void refreshSettingsDiagnostics();
});
on('autoStartCamera', 'change', (event) => {
  settings.autoStartCamera = (event.target as HTMLInputElement).checked;
  saveSettings();
  void applyAutoStart();
});
on('autoStartGps', 'change', (event) => {
  settings.autoStartGps = (event.target as HTMLInputElement).checked;
  saveSettings();
  void applyAutoStart();
});
on('autoStartMotion', 'change', (event) => {
  settings.autoStartMotion = (event.target as HTMLInputElement).checked;
  saveSettings();
  void applyAutoStart();
});
on('steadyGate', 'change', (event) => {
  settings.steadyGate = (event.target as HTMLInputElement).checked;
  saveSettings();
  syncSteadyToggle();
  renderSteadyState();
});
on('motionCalibrateButton', 'click', () => {
  if (calibrator.running) cancelCalibration();
  else startCalibration();
});
on('motionSteadyToggle', 'click', () => {
  settings.steadyGate = !settings.steadyGate;
  saveSettings();
  byId<HTMLInputElement>('steadyGate').checked = settings.steadyGate;
  syncSteadyToggle();
  syncSteadyToggle();
  renderSteadyState();
});
on('calibrateButton', 'click', () => {
  if (calibrator.running) cancelCalibration();
  else startCalibration();
});
on('clearCalibrationButton', 'click', () => {
  stabilityCalibration = null;
  try {
    localStorage.removeItem(CALIBRATION_KEY);
  } catch {
    // Nothing to clear if storage was never available.
  }
  renderCalibration();
});
on('amplifyGain', 'input', (event) => {
  settings.amplifyGain = Number((event.target as HTMLInputElement).value);
  setText('amplifyGainValue', `${settings.amplifyGain}×`);
  saveSettings();
});
on('chronoSpacing', 'input', (event) => {
  settings.chronoSpacing = Number((event.target as HTMLInputElement).value);
  setText('chronoSpacingValue', `${settings.chronoSpacing} frames`);
  chronochrome.reset();
  saveSettings();
});
on('slitColumn', 'input', (event) => {
  settings.slitColumn = Number((event.target as HTMLInputElement).value);
  setText('slitColumnValue', settings.slitColumn < 0.34 ? 'left'
    : settings.slitColumn > 0.66 ? 'right' : 'centre');
  slitScan.reset();
  saveSettings();
});
on('layerResetButton', 'click', () => {
  amplifier.reset();
  backgroundModel.reset();
  chronochrome.reset();
  slitScan.reset();
  latestBackground = null;
  setText('layerState', 'Restarted');
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
  // Each of these accumulates over time, and an accumulation gathered while
  // pointing somewhere else is not this mode's picture.
  amplifier.reset();
  backgroundModel.reset();
  chronochrome.reset();
  slitScan.reset();
  latestBackground = null;
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
  // Raising it needs a fresh getUserMedia, so record the wish first: if the
  // live track refuses, the next camera start will honour it.
  camera.setPreferredCaptureHeight(Number(settings.captureResolution));
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
on('saveAspect', 'change', () => {
  saveSettingFromControls();
});
on('saveFormat', 'change', (event) => {
  settings.saveFormat = (event.target as HTMLSelectElement).value as SaveFormat;
  saveSettings();
  syncSaveFormatControls();
});
on('saveQuality', 'input', (event) => {
  settings.saveQuality = clampQuality(Number((event.target as HTMLInputElement).value) / 100);
  saveSettings();
  syncSaveFormatControls();
});
on('lensDetail', 'change', (event) => {
  settings.lensDetail = (event.target as HTMLSelectElement).value as LensDetail;
  // From here on this install has an opinion, and no future default overrides it.
  settings.lensDetailChosen = true;
  saveSettings();
  // The canvas geometry changes with the setting, so whatever is on it now is
  // the wrong size until the next frame paints.
  lensDisplay = null;
  lensRenderMs = 0;
  overlayPainted = false;
  visionCanvas.hidden = true;
});
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

/**
 * Tabs.
 *
 * Everything shared one long scroll, so reaching the terrain map meant passing
 * the entire camera lab on the way. Each section is a tab now.
 *
 * Two things this has to get right. The 3D viewport is ONE canvas and two tabs
 * want it, so it is moved into whichever is active rather than duplicated — a
 * second WebGL context for the same scene would be a waste and would not share
 * its state anyway. And the camera panel is never given display:none: that can
 * stop WebKit decoding frames, and the camera then never recovers, which is the
 * exact failure this app already spent a long time fixing in the overlay.
 */
const TAB_KEY = 'visual-sensor-active-tab-v1';
const TABS = ['camera', 'motion', 'world', 'rig', 'data', 'burst'] as const;
type TabKey = (typeof TABS)[number];
let activeTab: TabKey = 'camera';

function isTabKey(value: string | null): value is TabKey {
  return !!value && (TABS as readonly string[]).includes(value);
}

function setActiveTab(key: TabKey, remember = true): void {
  activeTab = key;
  // Attach or release the burst preview as the tab comes and goes. The timer
  // would get there within a second, but a second of black where the camera
  // should be reads as the feature being broken.
  syncBurstPreview();
  for (const tab of TABS) {
    const panel = document.getElementById(`tab-${tab}`);
    const button = document.getElementById(`tabbtn-${tab}`);
    if (panel) panel.hidden = tab !== key;
    if (button) {
      button.setAttribute('aria-selected', String(tab === key));
      button.tabIndex = tab === key ? 0 : -1;
    }
  }

  // Move the 3D viewport to the active tab, or park it where it cannot be seen
  // but keeps its context alive.
  const host = byId('sceneHost');
  const slot = document.querySelector<HTMLElement>(`#tab-${key} [data-scene-slot]`);
  if (slot && host.parentElement !== slot) slot.appendChild(host);
  host.hidden = !slot;
  fusion.setVisible(!!slot);

  if (remember) {
    try {
      localStorage.setItem(TAB_KEY, key);
    } catch {
      // Private browsing: the tab simply does not persist.
    }
  }
  // The viewport's size changes when it moves between tabs of different widths.
  window.dispatchEvent(new Event('resize'));
}

/**
 * Is the camera's own tab on screen?
 *
 * Vision analysis is the most expensive thing the app does, and running it
 * against a panel parked off-screen burns battery to compute pixels nobody can
 * see. The stream stays live so returning is instant; only the analysis pauses.
 */
function cameraTabVisible(): boolean {
  return activeTab === 'camera' || viewerOpen;
}

function installTabs(): void {
  const bar = document.querySelector('.tabbar');
  if (!bar) return;
  for (const button of bar.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    button.addEventListener('click', () => {
      const key = button.dataset.tab;
      if (isTabKey(key ?? null)) setActiveTab(key as TabKey);
    });
  }
  bar.addEventListener('keydown', (event) => {
    const key = (event as KeyboardEvent).key;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;
    event.preventDefault();
    const index = TABS.indexOf(activeTab);
    const next = TABS[(index + (key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    setActiveTab(next);
    document.getElementById(`tabbtn-${next}`)?.focus();
  });

  let stored: string | null = null;
  try {
    stored = localStorage.getItem(TAB_KEY);
  } catch {
    stored = null;
  }
  setActiveTab(isTabKey(stored) ? stored : 'camera', false);
}

setText('secureContextValue', window.isSecureContext ? 'Secure ✓' : 'Needs HTTPS');
setChip('pwaChip', 'good', isStandalone() ? 'PWA installed' : browserCameraMode ? 'Browser camera mode' : 'PWA ready');
syncSettingsControls();
updateVisionMode('camera');
// Lenses load after the mode is set, so a shared link can switch the mode to
// its own lens without that being overwritten a line later.
void initialiseLenses();
watchForRotation();
watchForUpdatesOnResume();
installPinchZoom();
installTerrainGestures();
installTabs();
installViewerGestures();
camera.subscribe(applyCameraStatus);
renderMetrics();
requestAnimationFrame(fallbackVisionLoop);
void initializeFusion();
void refreshSettingsDiagnostics();

stabilityCalibration = loadCalibration();
loadAutoRung();
renderCalibration();
renderSteadyState();
void applyAutoStart();

// The camera engine already releases itself on the way out. The GPS watch and
// the motion listeners did not, so a backgrounded app kept the location
// subsystem awake — which is what makes starting sensors automatically a fair
// trade rather than a battery leak.
// stopRecording() first: the camera suspends on the way out, so a recorder
// left running would write a clip of nothing. Stopping here also FINISHES the
// clip in hand rather than losing it — the whole reason recording is segmented.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { stopRecording(); suspendSensors(); }
  else resumeSensors();
});
window.addEventListener('pagehide', suspendSensors);
document.addEventListener('freeze', suspendSensors);
document.addEventListener('resume', resumeSensors);

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

/* --- Burst detail probe -------------------------------------------------
 *
 * Joshua: "Before assuming hand movements won't work on devices... test out
 * the theory... could add a new tab in our app so you don't have to make a
 * new file with motion and camera being prompted first."
 *
 * Phase 0 established on synthetic data that merging recovers real resolution
 * only when the frames' sub-pixel offsets are spread across the grid, and that
 * random offsets underperform a plain upscale. What it could NOT establish is
 * whether a particular hand holding a particular phone produces usable spread.
 * That is an empirical question, and this is the instrument for it.
 *
 * It merges nothing and produces no picture. It reports whether producing one
 * would be worth the work — including when the answer is no.
 */

/**
 * Offsets must be measured in the pixels we would MERGE in.
 *
 * A shift of 0.3 preview pixels is 3.8 pixels at full resolution, and its
 * fractional part — the only part that carries new information — is unrelated.
 * So the probe samples a small window at 1:1 from the centre of the full
 * frame rather than a scaled-down whole frame: true full-resolution units, at
 * the cost of reading a few hundred pixels a side.
 */
const BURST_WINDOW = 256;
let burstCanvas: HTMLCanvasElement | null = null;
let burstContext: CanvasRenderingContext2D | null = null;

function sampleBurstWindow(): Plane | null {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return null;
  const size = Math.min(BURST_WINDOW, width, height);

  burstCanvas ??= document.createElement('canvas');
  burstContext ??= burstCanvas.getContext('2d', { willReadFrequently: true });
  if (!burstContext) return null;
  if (burstCanvas.width !== size) burstCanvas.width = size;
  if (burstCanvas.height !== size) burstCanvas.height = size;

  // 1:1 from the centre. No scaling, so a pixel here is a sensor pixel there.
  burstContext.drawImage(
    video,
    Math.round((width - size) / 2), Math.round((height - size) / 2), size, size,
    0, 0, size, size
  );
  const image = burstContext.getImageData(0, 0, size, size);
  const plane = createPlane(size, size);
  for (let i = 0, p = 0; i < image.data.length; i += 4, p++) {
    plane.data[p] = 0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2];
  }
  return plane;
}

let burstRunning = false;

async function runBurstProbe(): Promise<void> {
  if (burstRunning) return;
  if (!camera.active) {
    setText('burstReason', 'Start the camera first — the button is just above.');
    syncBurstReadiness();
    return;
  }
  burstRunning = true;
  const button = byId<HTMLButtonElement>('burstCaptureButton');
  button.disabled = true;

  try {
    const planes: Plane[] = [];
    // Gyro rotation accumulated between frames, in radians, so the sensor
    // prediction can be checked against what the image actually did.
    // Snapshots of the CONTINUOUS accumulator, taken as each frame is grabbed.
    // Integrating here instead would sample tremor at the capture rate and
    // alias away most of it — see rotationTotal.
    const gyro: Array<{ x: number; y: number }> = [];
    const rotationAtStart = { x: rotationTotal.x, y: rotationTotal.y };

    for (let i = 0; i < CAPTURE_CANDIDATES; i++) {
      const plane = sampleBurstWindow();
      if (!plane) break;
      planes.push(plane);
      gyro.push({
        x: rotationTotal.x - rotationAtStart.x,
        y: rotationTotal.y - rotationAtStart.y
      });
      setText('burstProgress', `Capturing ${i + 1} of ${CAPTURE_CANDIDATES}…`);

      // WAIT FOR A GENUINELY NEW FRAME, via requestVideoFrameCallback.
      //
      // The first version polled on requestAnimationFrame plus 40ms, which on
      // a twelve-megapixel capture delivering 8-12 frames a second is FASTER
      // THAN FRAMES ARRIVE — so a good share of the burst was the same image
      // recorded twice. A repeated frame measures a shift of exactly zero, so
      // it piles candidates onto one offset and drags the coverage figure
      // down: the probe would have reported a steady hand when the truth was
      // a fast loop. Joshua's 39-48% readings were taken with that bug in
      // place and cannot be trusted.
      await nextFrame();
    }
    setText('burstProgress', '');

    if (planes.length < 2) {
      setText('burstVerdict', 'Could not capture.');
      setText('burstReason', 'No frames arrived from the camera.');
      return;
    }

    const reference = planes[0];
    const shifts: ShiftEstimate[] = planes.map((plane, index) =>
      index === 0
        ? { shiftX: 0, shiftY: 0, confidence: 1 }
        : estimateShift(reference, plane, 8)
    );

    // Reported, not assumed. A burst of thirty-two samples of eight distinct
    // frames looks exactly like a very steady hand from the offsets alone, and
    // the two need completely different fixes.
    const distinct = countDistinctFrames(planes);
    setText('burstDistinct', `${distinct}/${planes.length}`);

    const verdict = judgeBurst(shifts, KEEP_FRAMES);
    renderBurstVerdict(verdict, shifts);
    // Measure the lens before comparing against it. The browser has no field
    // of view to report — Joshua's capability readout returned seven controls
    // and none of them was one — but the burst already contains both halves of
    // the relation that defines it, so it can be solved for rather than typed.
    // Kept so Merge runs on the frames that were just measured, rather than
    // capturing a second burst that the verdict on screen would not describe.
    lastBurst = { planes, shifts };
    byId<HTMLButtonElement>('burstMergeButton').disabled = verdict.confident < 2;

    const calibration = calibrateFromBurst(shifts, gyro);
    appendBurstLog(burstLogLine(verdict, distinct, renderBurstAgreement(shifts, gyro), calibration));
  } finally {
    burstRunning = false;
    byId<HTMLButtonElement>('burstCaptureButton').disabled = false;
  }
}

/**
 * How many frames in the burst are actually different images.
 *
 * Compares each frame against the previous one over a sparse grid. Two
 * captures of the SAME delivered frame are bit-identical, so any difference at
 * all — even camera noise — means the sensor read again.
 */
function countDistinctFrames(planes: Plane[]): number {
  if (planes.length === 0) return 0;
  let distinct = 1;
  for (let i = 1; i < planes.length; i++) {
    const previous = planes[i - 1].data;
    const current = planes[i].data;
    let changed = false;
    for (let p = 0; p < current.length; p += 37) {
      if (current[p] !== previous[p]) { changed = true; break; }
    }
    if (changed) distinct++;
  }
  return distinct;
}

function renderBurstVerdict(
  verdict: ReturnType<typeof judgeBurst>,
  shifts: ShiftEstimate[]
): void {
  setText('burstFrames', String(verdict.frames));
  setText('burstConfident', `${verdict.confident}/${verdict.frames}`);
  setText('burstTravel', `${verdict.travelPixels.toFixed(1)} px`);
  setText('burstSpread', `${(verdict.selectedSpread * 100).toFixed(0)}%`);
  setText('burstVerdict', verdict.worthMerging
    ? 'This burst would carry more detail.'
    : 'This burst would not help.');
  // The threshold is stated alongside the reading, so a refusal is a number
  // the reader can act on rather than a verdict they have to trust.
  setText('burstReason', `${verdict.reason} `
    + `(Selecting the best ${KEEP_FRAMES} of ${verdict.frames} reached `
    + `${(verdict.selectedSpread * 100).toFixed(0)}% against `
    + `${(verdict.rawSpread * 100).toFixed(0)}% for the raw burst; `
    + `${(SPREAD_FLOOR * 100).toFixed(0)}% is where merging starts to pay.)`);
  drawBurstScatter(shifts, verdict.selected);
}

/** Plot where each frame landed inside one pixel. */
function drawBurstScatter(shifts: ShiftEstimate[], selected: number[]): void {
  const canvas = document.getElementById('burstScatter') as HTMLCanvasElement | null;
  const context = canvas?.getContext('2d');
  if (!canvas || !context) return;
  const size = canvas.width;
  const keep = new Set(selected);
  context.clearRect(0, 0, size, size);

  context.strokeStyle = 'rgba(120, 190, 255, 0.18)';
  context.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const at = (size * i) / 4;
    context.beginPath();
    context.moveTo(at, 0); context.lineTo(at, size);
    context.moveTo(0, at); context.lineTo(size, at);
    context.stroke();
  }

  shifts.forEach((shift, index) => {
    if (index !== 0 && shift.confidence < MIN_CONFIDENCE) return;
    const fx = shift.shiftX - Math.floor(shift.shiftX);
    const fy = shift.shiftY - Math.floor(shift.shiftY);
    const x = fx * size;
    const y = fy * size;
    const kept = keep.has(index);
    context.beginPath();
    context.arc(x, y, kept ? 7 : 4, 0, Math.PI * 2);
    if (kept) {
      context.fillStyle = 'rgba(255, 196, 84, 0.9)';
      context.fill();
    } else {
      context.strokeStyle = 'rgba(150, 200, 245, 0.55)';
      context.lineWidth = 1.5;
      context.stroke();
    }
  });
}

/**
 * Does the gyroscope agree with what the picture actually did?
 *
 * This is the question behind driving capture from the motion sensors at all.
 * Where the two agree the sensors could time the shutter; where they disagree
 * they would be steering by a number that does not describe the image — and
 * on a tripod both should read zero, which is its own useful answer.
 */
function renderBurstAgreement(
  shifts: ShiftEstimate[],
  gyro: Array<{ x: number; y: number }>
): { travel: number | null; reason: string } {
  const focal = focalLengthPixels(video.videoWidth, settings.motionFovDegrees);
  const imageTravel = shifts.reduce(
    (worst, s) => Math.max(worst, Math.hypot(s.shiftX, s.shiftY)), 0);
  setText('burstImageMove', `${imageTravel.toFixed(1)} px`);

  if (!focal || gyro.length === 0) {
    setText('burstGyroMove', '—');
    // Two different causes with two different fixes, and "needs a field of
    // view" was wrong whenever the cause was the other one. Joshua's log read
    // a gyro figure on two runs and n/a on every run after, with no obvious
    // change in between — which is unanswerable while the message is the same
    // either way.
    const reason = !(settings.motionFovDegrees > 0)
      ? 'no-fov'
      : !motion.active
        ? 'motion-off'
        : 'no-cam-size';
    setText('burstAgreement', reason === 'no-fov'
      ? 'needs a field of view'
      : reason === 'motion-off'
        ? 'motion sensors stopped'
        : 'camera size unknown');
    return { travel: null, reason };
  }
  const gyroTravel = gyro.reduce((worst, g) => Math.max(worst,
    Math.hypot(rotationToPixels(g.x, focal), rotationToPixels(g.y, focal))), 0);
  setText('burstGyroMove', `${gyroTravel.toFixed(1)} px`);

  if (imageTravel < 0.05 && gyroTravel < 0.05) {
    setText('burstAgreement', 'both still');
    return { travel: gyroTravel, reason: 'still' };
  }
  const ratio = gyroTravel > 0 ? imageTravel / gyroTravel : 0;
  setText('burstAgreement', ratio > 0 ? `${ratio.toFixed(2)}× image/gyro` : '—');
  return { travel: gyroTravel, reason: 'ok' };
}

/* --- Burst tab: self-contained setup and a shareable log -----------------
 *
 * Joshua: "the prompt to allow camera and phone motion should be in that tab
 * as well so I don't have to open up each tab and except before opening up
 * that one" — and a log he can copy and send back, since he is the probe now
 * and a screenshot of six numbers is a poor way to report a measurement.
 */

/**
 * Show the camera in the Burst tab.
 *
 * Joshua: "I didn't see the camera on the screen unless I wasn't supposed to,
 * and had to guess what I was looking at." He was aiming a measurement
 * instrument blind, and the instrument only reads the CENTRE of the sensor at
 * 1:1 — so "point at texture" meant something far more specific than the tab
 * gave him any way to know.
 *
 * A second video element sharing the same MediaStream, the pattern already
 * proven by the full-screen viewer. Attached only while the tab is showing:
 * a hidden element still decoding frames is a decoder running for a picture
 * nobody can see.
 */
function syncBurstPreview(): void {
  const preview = document.getElementById('burstVideo') as HTMLVideoElement | null;
  if (!preview) return;
  const wanted = activeTab === 'burst' && camera.active && !!video.srcObject;

  if (!wanted) {
    if (preview.srcObject) preview.srcObject = null;
    return;
  }
  if (preview.srcObject !== video.srcObject) {
    preview.srcObject = video.srcObject;
    void preview.play().catch(() => {});
  }
}

/** Reuse the real enable paths rather than duplicating the permission dance. */
function syncBurstReadiness(): void {
  syncBurstPreview();
  const cameraButton = document.getElementById('burstEnableCamera') as HTMLButtonElement | null;
  const motionButton = document.getElementById('burstEnableMotion') as HTMLButtonElement | null;
  if (!cameraButton || !motionButton) return;

  cameraButton.disabled = camera.active;
  cameraButton.textContent = camera.active ? 'Camera on' : 'Enable Camera';
  motionButton.disabled = motion.active;
  motionButton.textContent = motion.active ? 'Motion on' : 'Enable Motion';

  const fov = document.getElementById('burstFov') as HTMLInputElement | null;
  if (fov && document.activeElement !== fov) {
    fov.value = settings.motionFovDegrees > 0 ? String(settings.motionFovDegrees) : '';
  }

  const missing: string[] = [];
  if (!camera.active) missing.push('the camera');
  if (!motion.active) missing.push('motion');
  if (!(settings.motionFovDegrees > 0)) missing.push('a lens field of view');

  setText('burstReadiness', missing.length === 0
    ? 'Ready. Capture measures the image and the gyroscope together.'
    : `Still needed: ${missing.join(', ')}. `
      + 'Without motion or a field of view the burst is still measured from the '
      + 'image alone — only the gyroscope comparison is skipped.');
}

/**
 * One line per capture, in a form that survives being pasted into a message.
 *
 * Fixed-width columns and a leading timestamp, because these are meant to be
 * compared across runs — a screenshot of the panel shows one result and loses
 * the run before it, which is the comparison that actually says anything.
 */
function appendBurstLog(line: string): void {
  const log = document.getElementById('burstLog') as HTMLTextAreaElement | null;
  if (!log) return;
  const stamp = new Date().toLocaleTimeString();
  log.value += `${log.value ? '\n' : ''}${stamp}  ${line}`;
  log.scrollTop = log.scrollHeight;
}

/**
 * Solve for the focal length from this burst, and adopt it if nothing was set.
 *
 * Adopted only when the box is empty: a typed value is a deliberate choice and
 * a measurement should not overwrite one. Same rule the live-detail setting
 * follows.
 */
function calibrateFromBurst(
  shifts: ShiftEstimate[],
  gyro: Array<{ x: number; y: number }>
): string {
  const samples: FocalSample[] = [];
  for (let i = 0; i < shifts.length && i < gyro.length; i++) {
    if (shifts[i].confidence < MIN_CONFIDENCE) continue;
    samples.push({
      imagePixels: Math.hypot(shifts[i].shiftX, shifts[i].shiftY),
      rotationRadians: Math.hypot(gyro[i].x, gyro[i].y)
    });
  }
  const fit = fitFocalLength(samples, video.videoWidth);
  setText('burstFovMeasured', fit.reason);

  if (fit.fovDegrees === null) return 'unfit';
  if (!(settings.motionFovDegrees > 0)) {
    // ROUNDED BEFORE IT IS STORED, not just before it is displayed.
    //
    // Storing the raw fit and rounding only in the box put 126.641734 in a
    // field with step="1" — a value the browser flags as invalid and no one
    // would type. The precision was false anyway: the fit's own quality figure
    // is a percentage, so a sixth decimal place of a degree is noise dressed as
    // a measurement.
    settings.motionFovDegrees = Math.round(fit.fovDegrees * 10) / 10;
    saveSettings();
    const shown = settings.motionFovDegrees.toFixed(1);
    const box = document.getElementById('burstFov') as HTMLInputElement | null;
    if (box && document.activeElement !== box) box.value = shown;
    const twin = document.getElementById('motionFov') as HTMLInputElement | null;
    if (twin) twin.value = shown;
    syncBurstReadiness();
  }
  return `${fit.fovDegrees.toFixed(1)}deg@${(fit.quality * 100).toFixed(0)}%`;
}

function burstLogLine(
  verdict: ReturnType<typeof judgeBurst>,
  distinct: number,
  gyro: { travel: number | null; reason: string },
  calibration: string
): string {
  const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
  // THE REASON, NOT JUST "n/a". Thirty rows of Joshua's log read n/a and none
  // of them said why, so the log — which is the thing he actually sends —
  // could not answer whether the sensors had been used at all. The panel knew;
  // the record did not.
  return [
    `frames ${String(verdict.frames).padStart(2)}`,
    `distinct ${String(distinct).padStart(2)}`,
    `measurable ${String(verdict.confident).padStart(2)}`,
    `travel ${verdict.travelPixels.toFixed(1).padStart(5)}px`,
    `raw ${pct(verdict.rawSpread).padStart(4)}`,
    `selected ${pct(verdict.selectedSpread).padStart(4)}`,
    `gyro ${(gyro.travel === null ? gyro.reason : `${gyro.travel.toFixed(1)}px`).padStart(12)}`,
    `lens ${calibration.padStart(14)}`,
    verdict.worthMerging ? 'WORTH' : 'no',
    `v${APP_VERSION}`
  ].join(' · ');
}

async function copyBurstLog(): Promise<void> {
  const log = document.getElementById('burstLog') as HTMLTextAreaElement | null;
  if (!log || !log.value) {
    setText('burstCopyStatus', 'Nothing captured yet.');
    return;
  }
  try {
    await navigator.clipboard.writeText(log.value);
    setText('burstCopyStatus', 'Copied.');
  } catch {
    // Clipboard access can be refused outright, and on iOS it is refused
    // whenever the write is not tied closely enough to the tap. Selecting the
    // text leaves the reader one long-press from copying it by hand rather
    // than at a dead end.
    log.focus();
    log.select();
    setText('burstCopyStatus', 'Copy blocked — the log is selected, copy it by hand.');
  }
}

on('burstEnableCamera', 'click', () => void startCamera().then(syncBurstReadiness));
on('burstEnableMotion', 'click', () => void enableMotion().then(syncBurstReadiness));
on('burstFov', 'change', (event) => {
  const degrees = Number((event.target as HTMLInputElement).value);
  settings.motionFovDegrees = Number.isFinite(degrees) && degrees > 0 && degrees < 180
    ? degrees
    : 0;
  saveSettings();
  // The Motion tab shows the same setting, so it has to follow.
  const twin = document.getElementById('motionFov') as HTMLInputElement | null;
  if (twin) twin.value = settings.motionFovDegrees > 0 ? String(settings.motionFovDegrees) : '';
  syncBurstReadiness();
});
/**
 * Ask the live track what it will let us set, and show the answer verbatim.
 *
 * The track comes straight off the stream rather than through the camera
 * engine, because the engine's job is to negotiate a working stream and this
 * is a question about the one it already negotiated.
 */
function readCameraCapabilities(): void {
  const stream = video.srcObject as MediaStream | null;
  const track = stream?.getVideoTracks?.()[0] ?? null;
  if (!track) {
    setText('burstCapsSummary', 'Start the camera first — there is no track to ask.');
    return;
  }

  // Both calls are optional in the standard and absent in some WebKit builds.
  // An absent method is a real answer, not an error to swallow silently.
  const caps = typeof track.getCapabilities === 'function'
    ? track.getCapabilities() as Record<string, unknown>
    : null;
  const live = typeof track.getSettings === 'function'
    ? track.getSettings() as Record<string, unknown>
    : null;

  const report = readCapabilities(caps, live);
  setText('burstCapsSummary', report.summary);

  const list = byId('burstCapsList');
  list.innerHTML = '';
  for (const control of report.controls) {
    const row = document.createElement('div');
    if (!control.supported) row.className = 'cap-no';
    const name = document.createElement('span');
    name.className = 'cap-name';
    name.textContent = control.name;
    const range = document.createElement('span');
    range.className = 'cap-range';
    // Left empty when unsupported: the stylesheet writes "not supported" there,
    // so an absent control cannot be mistaken for one with an empty range.
    range.textContent = control.supported
      ? [control.range, control.current && `now ${control.current}`].filter(Boolean).join('  ')
      : '';
    row.append(name, range);
    list.appendChild(row);
  }

  appendBurstLog(capabilityLogLine(report));
}

/* --- Phase 2: merge the frames that were just measured ------------------ */

let lastBurst: { planes: Plane[]; shifts: ShiftEstimate[] } | null = null;
let lastMerge: MergeReport | null = null;
let merging = false;

/** Paint a single-channel plane into a canvas, scaled to fit its box. */
function paintPlane(canvas: HTMLCanvasElement, plane: Plane): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  if (canvas.width !== plane.width) canvas.width = plane.width;
  if (canvas.height !== plane.height) canvas.height = plane.height;
  const image = context.createImageData(plane.width, plane.height);
  for (let i = 0, p = 0; p < plane.data.length; p++, i += 4) {
    const value = Math.max(0, Math.min(255, plane.data[p]));
    image.data[i] = value;
    image.data[i + 1] = value;
    image.data[i + 2] = value;
    image.data[i + 3] = 255;
  }
  context.putImageData(image, 0, 0);
}

async function runBurstMerge(): Promise<void> {
  if (merging || !lastBurst) return;
  merging = true;
  const button = byId<HTMLButtonElement>('burstMergeButton');
  button.disabled = true;
  setText('burstProgress', 'Merging…');
  // Yield once so the label paints before the arithmetic blocks the thread.
  // This runs for seconds and a frozen button with no explanation reads as a
  // crash rather than as work.
  await new Promise((resolve) => setTimeout(resolve, 30));

  try {
    const candidates = lastBurst.planes.map((plane, index) => ({
      plane, shift: lastBurst!.shifts[index]
    }));
    const report = await mergeAndCompare(candidates, KEEP_FRAMES, async (label) => {
      setText('burstProgress', label);
      // Two frames of breathing room: one to paint the label, one to let the
      // browser decide the page is alive before the next block of arithmetic.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (!report) {
      setText('burstMergeVerdict', 'No usable frames in that burst.');
      return;
    }
    renderMergeReport(report);
  } finally {
    merging = false;
    setText('burstProgress', '');
    button.disabled = false;
  }
}

function renderMergeReport(report: MergeReport): void {
  lastMerge = report;
  byId('burstCompareFigure').hidden = false;
  byId('burstSaveRow').hidden = false;
  // Sharing a FILE is a narrower capability than sharing a link, and Safari is
  // the only mobile browser that has it — so the button appears when the
  // browser says it can take this file, not when a version table says it
  // should. A share sheet is what puts the result in Photos; a download puts it
  // in Files, which is not where a picture is looked for.
  byId('burstShareMerged').hidden = !canShareImages();
  setText('burstSaveStatus', '');
  const canvas = byId<HTMLCanvasElement>('burstCompare');
  paintPlane(canvas, comparisonStrip(report));
  labelPanels(canvas, report);
  fitToScreen(canvas);

  const mtf = (value: number | null) => value === null ? '—' : value.toFixed(3);
  // Named in the order they appear, so the caption is a legend rather than a
  // summary — the panels are unlabelled pixels otherwise.
  setText('burstCompareCaption',
    `Top row: upscaled (${mtf(report.controlMtf.mtf50)}) and `
    + `sharpened one frame (${mtf(report.deconvolvedMtf.mtf50)}). `
    + `Bottom row: merged (${mtf(report.splatMtf.mtf50)}) and `
    + `merged and back-projected (${mtf(report.refinedMtf.mtf50)}) — each merge sits under `
    + `the control it has to beat. MTF50 in cycles/px, higher is sharper, Nyquist is 0.500.`);

  setText('burstMergeVerdict', report.verdict);
  appendBurstLog(mergeLogLine(report));
}

/**
 * Show the figure at ONE OUTPUT PIXEL PER DEVICE PIXEL, and never wider.
 *
 * A canvas with no CSS width is laid out at one backing-store pixel per CSS
 * pixel, which on a three-times display magnifies it threefold — that is what
 * "zoomed way in" was. Dividing by the pixel ratio undoes exactly that
 * magnification and nothing else: no browser resampling, no detail lost, the
 * merge shown as the sensor's pixels.
 *
 * The stylesheet's `max-width: 100%` is the clamp underneath it, so a narrower
 * screen or a bigger window scales the figure down to fit instead of widening
 * the document. Both together are the rule: as large as it honestly is, and
 * never larger than the screen.
 */
function fitToScreen(canvas: HTMLCanvasElement): void {
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.style.width = `${Math.round(canvas.width / ratio)}px`;
}

/**
 * Name each panel on the picture itself.
 *
 * A caption listing four names in reading order is one mis-read away from
 * crediting the merge with the control's result, and the panels are
 * indistinguishable grey squares without it. A label drawn into the picture
 * cannot come apart from the panel it names.
 */
function labelPanels(canvas: HTMLCanvasElement, report: MergeReport): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  const named: Record<PanelKey, [string, number | null]> = {
    control: ['upscaled', report.controlMtf.mtf50],
    deconvolved: ['sharpened 1 frame', report.deconvolvedMtf.mtf50],
    splat: ['merged', report.splatMtf.mtf50],
    refined: ['merged + back-projected', report.refinedMtf.mtf50]
  };

  context.font = '600 15px ui-monospace, Menlo, monospace';
  context.textBaseline = 'top';
  for (const panel of comparisonLayout(report).panels) {
    const [name, mtf50] = named[panel.key];
    const text = mtf50 === null ? name : `${name}  ${mtf50.toFixed(3)}`;
    const metrics = context.measureText(text);
    const x = panel.x + 8;
    const y = panel.y + 7;
    // A plate behind it, because the label sits over whatever the camera saw
    // and white on white is not a label.
    context.fillStyle = 'rgba(2, 8, 14, 0.72)';
    context.fillRect(x - 4, y - 3, metrics.width + 10, 22);
    context.fillStyle = panel.key === 'control'
      ? 'rgba(220, 235, 255, 0.95)'
      : 'rgba(255, 196, 84, 0.95)';
    context.fillText(text, x, y);
  }
}

/* --- Saving and sharing the merged result -------------------------------- */

/**
 * PNG, always, and not the save format chosen for camera frames.
 *
 * This picture exists to be compared against another picture at the pixel
 * level. A lossy codec adds its own ringing to exactly the edges the merge is
 * being judged on, and someone looking at a saved JPEG later would be reading
 * the encoder as much as the merge. The file is a few hundred kilobytes at this
 * size, so there is nothing to trade away.
 */
function planeToCanvas(plane: Plane): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  paintPlane(canvas, plane);
  return canvas;
}

function canShareImages(): boolean {
  const probe = new File([new Uint8Array(1)], 'probe.png', { type: 'image/png' });
  return typeof navigator.canShare === 'function'
    && typeof navigator.share === 'function'
    && navigator.canShare({ files: [probe] });
}

function mergeStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function encodePng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/**
 * What the saved file IS, written into its name.
 *
 * Four of these end up in a camera roll together and none of them is
 * self-describing — the merged output and the plain upscale are the same size,
 * the same scene and the same grey. `merged-x1.34` and `comparison` are the
 * difference between a file that can be checked later and one that can only be
 * guessed at.
 */
function mergedFileName(report: MergeReport): string {
  const gain = report.gain === null ? 'unmeasured' : `x${report.gain.toFixed(2)}`;
  return `visual-sensor-${report.best}-${gain}-${mergeStamp()}.png`;
}

async function saveMergedImage(which: 'result' | 'comparison'): Promise<void> {
  if (!lastMerge) return;
  const canvas = planeToCanvas(
    which === 'result' ? pickBest(lastMerge) : comparisonStrip(lastMerge)
  );
  if (which === 'comparison') labelPanels(canvas, lastMerge);
  const blob = await encodePng(canvas);
  if (!blob) {
    setText('burstSaveStatus', 'The image could not be encoded.');
    return;
  }
  const name = which === 'result'
    ? mergedFileName(lastMerge)
    : `visual-sensor-comparison-${mergeStamp()}.png`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  setText('burstSaveStatus',
    `Saved ${canvas.width}\u00d7${canvas.height} PNG \u00b7 ${describeBytes(blob.size)} \u00b7 ${name}`);
}

async function shareMergedImage(): Promise<void> {
  if (!lastMerge) return;
  const blob = await encodePng(planeToCanvas(pickBest(lastMerge)));
  if (!blob) {
    setText('burstSaveStatus', 'The image could not be encoded.');
    return;
  }
  const file = new File([blob], mergedFileName(lastMerge), { type: 'image/png' });
  try {
    await navigator.share({
      files: [file],
      // The verdict travels with the picture. A merged frame on its own says
      // nothing about whether merging helped, and that is the whole claim.
      text: lastMerge.verdict
    });
    setText('burstSaveStatus', 'Shared.');
  } catch (error) {
    // Dismissing the share sheet rejects, and a cancelled share is not a
    // failure to report as one.
    const name = error instanceof Error ? error.name : '';
    setText('burstSaveStatus', name === 'AbortError' ? '' : 'The share sheet could not open.');
  }
}

function mergeLogLine(report: MergeReport): string {
  const mtf = (value: number | null) => value === null ? '  n/a' : value.toFixed(3);
  return [
    `MERGE frames ${String(report.framesUsed).padStart(2)}`,
    `ctrl ${mtf(report.controlMtf.mtf50)}`,
    `sharp1 ${mtf(report.deconvolvedMtf.mtf50)}`,
    `splat ${mtf(report.splatMtf.mtf50)}`,
    `bp ${mtf(report.refinedMtf.mtf50)}`,
    `psf ${report.psfSigma.toFixed(2)}`,
    `best ${report.best}`,
    // Both ratios, because one of them is the whole question: how much of the
    // gain over an upscale actually needed more than a single frame.
    `x${report.gain === null ? 'n/a' : report.gain.toFixed(2)}`,
    `multi x${report.multiFrameGain === null ? 'n/a' : report.multiFrameGain.toFixed(2)}`,
    report.beyondSingleFrame ? 'BEYOND-1F' : 'within-1f',
    `v${APP_VERSION}`
  ].join(' · ');
}

on('burstMergeButton', 'click', () => void runBurstMerge());

on('burstReadCaps', 'click', readCameraCapabilities);
on('burstSaveMerged', 'click', () => void saveMergedImage('result'));
on('burstSaveFigure', 'click', () => void saveMergedImage('comparison'));
on('burstShareMerged', 'click', () => void shareMergedImage());
on('burstCopyLog', 'click', () => void copyBurstLog());
on('burstClearLog', 'click', () => {
  const log = document.getElementById('burstLog') as HTMLTextAreaElement | null;
  if (log) log.value = '';
  setText('burstCopyStatus', '');
});

/*
 * RECORDING STARTS UP LAST, at the end of the file, on purpose.
 *
 * The first version of these four lines was inserted after `void
 * applyAutoStart()` — and there are four of those, three of them inside change
 * handlers in the settings panel. It landed in the FIRST one, so the whole
 * recording subsystem only initialised if you happened to toggle "start the
 * camera automatically". The format was never detected, and the app told a
 * phone that records video perfectly well that it could not record video.
 *
 * At the end of the file it cannot be nested inside anything, and a test holds
 * it there: main.ts must END with this block.
 */
detectClipFormat();
syncRecordButton();
syncRecordDetailNote();
syncGifEstimate();
void renderClips().then(() => pruneClips()).catch(() => {
  setText('clipStorage', 'Held clips could not be read from this device.');
});
