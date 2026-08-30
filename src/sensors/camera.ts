import type { AnalysisFrame, FrameSource, FrameSourceZoom } from '../vision/frame-source.js';

export type CameraFacing = 'environment' | 'user';

/**
 * `live` is the only state in which frames are trustworthy.
 * `suspended` means the engine deliberately released the camera (backgrounding,
 * a muted track, a system takeover) and is waiting for a user gesture.
 */
export type CameraState = 'idle' | 'requesting' | 'live' | 'suspended' | 'error';

export interface CapturedFrame {
  imageData: ImageData;
  width: number;
  height: number;
}

export interface CameraZoomState {
  value: number;
  min: number;
  max: number;
  step: number;
  kind: 'camera' | 'digital' | 'none';
}

export interface CameraStatus {
  state: CameraState;
  stage: string;
  reason: string;
  facing: CameraFacing;
  zoom: CameraZoomState;
}

export interface CameraAttempt {
  id: string;
  at: string;
  standalone: boolean;
  profile: number;
  facing: CameraFacing;
  /**
   * `pending` is the diagnostically important outcome: it means getUserMedia
   * was called and never settled — it neither resolved nor rejected — which
   * no live state can distinguish from "never called" after a reload.
   */
  outcome: 'pending' | 'live' | 'failed' | 'superseded' | 'unsupported';
  stage: string;
  elapsedMs: number | null;
  errorName: string;
  errorMessage: string;
  firstFrameMs: number | null;
  firstFrameVia: string;
  trackState: string;
  trackMuted: boolean;
  videoWidth: number;
  videoHeight: number;
}

export interface FrameRateInfo {
  requested: 'auto' | number;
  /** What the track claims. An intention, not a measurement. */
  reported: number;
  /** Range the active configuration advertises, where WebKit exposes it. */
  capability: { min: number; max: number } | null;
}

export interface BenchmarkResult {
  requested: number;
  reported: number;
  /** Frames per second actually counted. This is the number that matters. */
  measuredFps: number;
  uniqueFrames: number;
  repeatedFrames: number;
  verdict: 'accepted' | 'negotiated' | 'unsupported' | 'unstable' | 'not measured';
  reason: string;
}

export interface BenchmarkReport {
  supported: boolean;
  reason?: string;
  results: BenchmarkResult[];
}

export interface CapabilityField {
  /**
   * `supported` — advertised and usable.
   * `unsupported` — capabilities are reported but this one is not offered.
   * `not exposed` — no capability reporting at all. Not the same as unsupported.
   */
  state: 'supported' | 'unsupported' | 'not exposed';
  min?: number;
  max?: number;
  step?: number;
  value?: unknown;
  options?: unknown[];
}

export interface VideoInput {
  deviceId: string;
  /** Empty until camera permission is granted — WebKit withholds labels. */
  label: string;
  groupId: string;
}

export interface CapabilityReport {
  available: boolean;
  fields: Record<string, CapabilityField>;
  settings: Record<string, unknown>;
}

export interface CameraDiagnostics {
  state: CameraState;
  stage: string;
  reason: string;
  sourceKind: string;
  facing: CameraFacing;
  trackState: string;
  trackMuted: boolean;
  trackEnabled: boolean;
  trackLabel: string;
  settingsWidth: number;
  settingsHeight: number;
  settingsFrameRate: number;
  videoWidth: number;
  videoHeight: number;
  readyState: number;
  paused: boolean;
  currentTime: number;
  frameEvidence: boolean;
  firstFrameMs: number | null;
  firstFrameVia: string;
  startedAt: number;
  lastErrorName: string;
  lastErrorMessage: string;
  standalone: boolean;
  deliveryActive: boolean;
  deliverySubscribed: boolean;
  deliveredUnique: number;
  deliveredRepeated: number;
  captureFailures: number;
  lastCaptureError: string;
  zoomKind: string;
  zoomValue: number;
  zoomMin: number;
  zoomMax: number;
}

interface CameraEngine {
  start(facing?: CameraFacing): Promise<CameraFacing>;
  switchCamera(): Promise<CameraFacing>;
  stop(): void;
  suspend(reason: string): void;
  hardReset(): void;
  captureFrame(targetWidth?: number): CapturedFrame;
  setZoom(value: number): Promise<CameraZoomState>;
  describeError(error: unknown, standalone?: boolean): string;
  subscribe(listener: (status: CameraStatus) => void): () => void;
  clearAttempts(): void;
  permissionState(): Promise<string>;
  setCaptureHeight(height: number): Promise<{ applied: boolean; reason?: string }>;
  selectDevice(deviceId: string | null): Promise<CameraFacing>;
  readonly selectedDeviceId: string | null;
  setFrameRate(requested: 'auto' | number): Promise<{ applied: boolean; reason?: string; reported: number }>;
  benchmarkFrameRates(
    rates: number[],
    sampleMs: number,
    onProgress?: (progress: { rate: number; phase: string }) => void
  ): Promise<BenchmarkReport>;
  startFrameDelivery(listener: (frame: { now: number; mediaTime: number; presentedFrames?: number }) => void): boolean;
  stopFrameDelivery(): void;
  videoInputs(): Promise<{ available: boolean; devices: VideoInput[] }>;
  applyCameraSetting(name: string, value: unknown): Promise<{ applied: boolean; reason?: string }>;
  readonly frameRateInfo: FrameRateInfo;
  readonly capabilityReport: CapabilityReport;
  readonly attempts: CameraAttempt[];
  readonly state: CameraState;
  readonly active: boolean;
  readonly ready: boolean;
  readonly currentFacing: CameraFacing;
  readonly sourceKind: 'none' | 'live';
  readonly zoom: CameraZoomState;
  readonly diagnostics: CameraDiagnostics;
}

type WindowWithCamera = Window & typeof globalThis & { VisualCamera?: CameraEngine };

function engine(): CameraEngine {
  const camera = (window as WindowWithCamera).VisualCamera;
  if (!camera) throw new Error('The persistent HTML camera engine did not load. Reload the app and try again.');
  return camera;
}

export function describeCameraError(error: unknown, standalone = false): string {
  try {
    return engine().describeError(error, standalone);
  } catch {
    return error instanceof Error ? error.message : 'Unable to start the camera.';
  }
}

/**
 * Compatibility bridge to public/camera-bootstrap.js.
 *
 * The <video> element, every getUserMedia call and the whole camera lifecycle
 * live in that plain-JavaScript file so a TypeScript or Three.js load failure
 * can never take the camera down with it. Nothing here calls getUserMedia.
 */
export class CameraController {
  constructor(_video: HTMLVideoElement) {
    engine();
  }

  get currentFacing(): CameraFacing {
    return engine().currentFacing;
  }

  get state(): CameraState {
    return engine().state;
  }

  get active(): boolean {
    return engine().ready;
  }

  get sourceKind(): CameraEngine['sourceKind'] {
    return engine().sourceKind;
  }

  get zoom(): CameraZoomState {
    return engine().zoom;
  }

  get diagnostics(): CameraDiagnostics {
    return engine().diagnostics;
  }

  /** Camera attempts recorded across reloads, newest first. */
  get attempts(): CameraAttempt[] {
    try {
      return engine().attempts;
    } catch {
      return [];
    }
  }

  clearAttempts(): void {
    engine().clearAttempts();
  }

  get frameRateInfo(): FrameRateInfo {
    return engine().frameRateInfo;
  }

  /** Apply a manual control the track advertised. Reports refusal rather than hiding it. */
  async applyCameraSetting(name: string, value: unknown): Promise<{ applied: boolean; reason?: string }> {
    try {
      return await engine().applyCameraSetting(name, value);
    } catch {
      return { applied: false, reason: 'unavailable' };
    }
  }

  /** Video inputs WebKit reports. Labels appear only after a permission grant. */
  async videoInputs(): Promise<{ available: boolean; devices: VideoInput[] }> {
    try {
      return await engine().videoInputs();
    } catch {
      return { available: false, devices: [] };
    }
  }

  get capabilityReport(): CapabilityReport {
    return engine().capabilityReport;
  }

  async setFrameRate(requested: 'auto' | number): Promise<{ applied: boolean; reason?: string; reported: number }> {
    return engine().setFrameRate(requested);
  }

  get selectedDeviceId(): string | null {
    return engine().selectedDeviceId;
  }

  /** Switch to a specific camera. Restarts the stream; does not re-prompt. */
  async selectDevice(deviceId: string | null): Promise<CameraFacing> {
    return engine().selectDevice(deviceId);
  }

  /** Request a capture resolution by target height. The result must be read back. */
  async setCaptureHeight(height: number): Promise<{ applied: boolean; reason?: string }> {
    return engine().setCaptureHeight(height);
  }

  async benchmarkFrameRates(
    rates: number[],
    sampleMs = 1200,
    onProgress?: (progress: { rate: number; phase: string }) => void
  ): Promise<BenchmarkReport> {
    return engine().benchmarkFrameRates(rates, sampleMs, onProgress);
  }

  /**
   * Drive a callback from presented video frames. Returns false where
   * requestVideoFrameCallback is unavailable, so the caller can fall back
   * rather than silently measuring the display instead of the camera.
   */
  startFrameDelivery(listener: (frame: { now: number; mediaTime: number; presentedFrames?: number }) => void): boolean {
    return engine().startFrameDelivery(listener);
  }

  stopFrameDelivery(): void {
    engine().stopFrameDelivery();
  }

  /** 'granted' | 'denied' | 'prompt', where WebKit exposes the Permissions API. */
  async permissionState(): Promise<string> {
    try {
      return await engine().permissionState();
    } catch {
      return 'unavailable';
    }
  }

  subscribe(listener: (status: CameraStatus) => void): () => void {
    return engine().subscribe(listener);
  }

  async start(facing: CameraFacing = this.currentFacing): Promise<void> {
    await engine().start(facing);
  }

  async switchCamera(): Promise<CameraFacing> {
    return engine().switchCamera();
  }

  async setZoom(value: number): Promise<CameraZoomState> {
    return engine().setZoom(value);
  }

  stop(): void {
    engine().stop();
  }

  /** Full media-element teardown, used by the Hard Reset Camera recovery path. */
  hardReset(): void {
    engine().hardReset();
  }

  captureFrame(targetWidth = 192): CapturedFrame {
    return engine().captureFrame(targetWidth);
  }
}

/**
 * The browser camera presented as a generic `FrameSource`.
 *
 * Vision processing consumes this interface rather than the camera engine, so
 * a future native multi-lens provider only has to implement `FrameSource`.
 */
export class BrowserCameraSource implements FrameSource {
  constructor(private readonly camera: CameraController) {}

  get id(): string {
    return `browser:${this.camera.currentFacing}`;
  }

  get label(): string {
    return this.camera.currentFacing === 'environment' ? 'Rear camera' : 'Front camera';
  }

  get active(): boolean {
    return this.camera.active;
  }

  get zoom(): FrameSourceZoom {
    return this.camera.zoom;
  }

  captureFrame(targetWidth: number): AnalysisFrame | null {
    if (!this.camera.active) return null;
    try {
      const frame = this.camera.captureFrame(targetWidth);
      return {
        data: frame.imageData.data,
        width: frame.width,
        height: frame.height,
        timestamp: performance.now(),
        sourceId: this.id
      };
    } catch {
      // A camera can briefly report no frame while switching or refocusing.
      return null;
    }
  }
}
