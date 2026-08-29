export type CameraFacing = 'environment' | 'user';

export interface CapturedFrame {
  imageData: ImageData;
  width: number;
  height: number;
}

export class CameraController {
  private stream: MediaStream | null = null;
  private facing: CameraFacing = 'environment';
  private readonly captureCanvas = document.createElement('canvas');
  private readonly captureContext = this.captureCanvas.getContext('2d', { willReadFrequently: true });

  constructor(private readonly video: HTMLVideoElement) {
    if (!this.captureContext) throw new Error('Canvas 2D is required for camera processing.');
  }

  get currentFacing(): CameraFacing {
    return this.facing;
  }

  get active(): boolean {
    return Boolean(this.stream);
  }

  async start(facing: CameraFacing = this.facing): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera access is not available in this browser.');
    }

    this.stop();
    this.facing = facing;
    const constraints: MediaStreamConstraints = {
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    };

    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', 'true');
    this.video.muted = true;
    await this.video.play();
  }

  async switchCamera(): Promise<CameraFacing> {
    const next: CameraFacing = this.facing === 'environment' ? 'user' : 'environment';
    await this.start(next);
    return next;
  }

  stop(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
    }
    this.stream = null;
    this.video.srcObject = null;
  }

  captureFrame(targetWidth = 192): CapturedFrame {
    const sourceWidth = this.video.videoWidth;
    const sourceHeight = this.video.videoHeight;
    if (!sourceWidth || !sourceHeight) {
      throw new Error('Camera frame is not ready yet.');
    }

    const safeWidth = Math.max(32, Math.min(640, Math.round(targetWidth)));
    const height = Math.max(24, Math.round((sourceHeight / sourceWidth) * safeWidth));
    this.captureCanvas.width = safeWidth;
    this.captureCanvas.height = height;
    this.captureContext!.drawImage(this.video, 0, 0, safeWidth, height);
    return {
      imageData: this.captureContext!.getImageData(0, 0, safeWidth, height),
      width: safeWidth,
      height
    };
  }
}
