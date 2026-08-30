export type CameraFacing = 'environment' | 'user';

export interface CapturedFrame {
  imageData: ImageData;
  width: number;
  height: number;
}

interface CameraEngine {
  start(facing?: CameraFacing): Promise<CameraFacing>;
  switchCamera(): Promise<CameraFacing>;
  stop(): void;
  captureFrame(targetWidth?: number): CapturedFrame;
  loadNativePhoto(file: Blob): Promise<ImageData>;
  describeError(error: unknown, standalone?: boolean): string;
  readonly active: boolean;
  readonly ready: boolean;
  readonly currentFacing: CameraFacing;
  readonly sourceKind: 'none' | 'live' | 'photo';
  readonly diagnostics: {
    stage: string;
    sourceKind: string;
    trackState: string;
    videoWidth: number;
    videoHeight: number;
    readyState: number;
  };
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

export class CameraController {
  constructor(_video: HTMLVideoElement) {
    // The video element is owned by public/camera-bootstrap.js.
    // This TypeScript class is intentionally only a compatibility bridge.
    engine();
  }

  get currentFacing(): CameraFacing {
    return engine().currentFacing;
  }

  get active(): boolean {
    return engine().ready;
  }

  get sourceKind(): CameraEngine['sourceKind'] {
    return engine().sourceKind;
  }

  get diagnostics(): CameraEngine['diagnostics'] {
    return engine().diagnostics;
  }

  async start(facing: CameraFacing = this.currentFacing): Promise<void> {
    await engine().start(facing);
  }

  async switchCamera(): Promise<CameraFacing> {
    return engine().switchCamera();
  }

  stop(): void {
    engine().stop();
  }

  captureFrame(targetWidth = 192): CapturedFrame {
    return engine().captureFrame(targetWidth);
  }

  async loadNativePhoto(file: Blob): Promise<ImageData> {
    return engine().loadNativePhoto(file);
  }
}