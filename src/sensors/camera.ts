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
