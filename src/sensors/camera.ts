export type CameraFacing = 'environment' | 'user';

export interface CapturedFrame {
  imageData: ImageData;
  width: number;
  height: number;
}

function errorName(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error) return String((error as { name?: unknown }).name ?? '');
  return '';
}

export function describeCameraError(error: unknown, standalone = false): string {
  const name = errorName(error);
  const standaloneHint = standalone
    ? ' If it works in Edge but not the installed app, close the installed app completely and retry. iOS/WebKit can handle standalone camera permission separately.'
    : '';

  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return `Camera permission was blocked. Tap Retry Camera and choose Allow when iOS asks. If no prompt appears, check camera access for Edge/the installed web app in iPhone Settings.${standaloneHint}`;
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return `No usable camera was reported by the browser.${standaloneHint}`;
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return `The camera exists but iOS could not start it. Close other camera/video apps, then tap Retry Camera.${standaloneHint}`;
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return `The requested camera mode was not available. Retry Camera will use a simpler camera request.${standaloneHint}`;
  }
  if (name === 'AbortError') {
    return `Camera startup was interrupted. Tap Retry Camera.${standaloneHint}`;
  }

  const message = error instanceof Error ? error.message : 'Unable to start the camera.';
  return `${message}${standaloneHint}`;
}

function waitForMetadata(video: HTMLVideoElement, timeoutMs = 1800): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA || video.videoWidth > 0) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener('loadedmetadata', finish);
      video.removeEventListener('loadeddata', finish);
      resolve();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    video.addEventListener('loadedmetadata', finish, { once: true });
    video.addEventListener('loadeddata', finish, { once: true });
  });
}

export class CameraController {
  private stream: MediaStream | null = null;
  private facing: CameraFacing = 'environment';
  private readonly captureCanvas = document.createElement('canvas');
  private readonly captureContext = this.captureCanvas.getContext('2d', { willReadFrequently: true });

  constructor(private readonly video: HTMLVideoElement) {
    if (!this.captureContext) throw new Error('Canvas 2D is required for camera processing.');
    this.prepareVideoElement();
  }

  get currentFacing(): CameraFacing {
    return this.facing;
  }

  get active(): boolean {
    return Boolean(this.stream?.getVideoTracks().some((track) => track.readyState === 'live'));
  }

  private prepareVideoElement(): void {
    this.video.setAttribute('playsinline', 'true');
    this.video.setAttribute('webkit-playsinline', 'true');
    this.video.setAttribute('autoplay', 'true');
    this.video.autoplay = true;
    this.video.muted = true;
  }

  async start(facing: CameraFacing = this.facing): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera access is not available in this browser context.');
    }

    this.stop();
    this.facing = facing;
    this.prepareVideoElement();

    const constraints: MediaStreamConstraints = {
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    };

    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (error) {
        const name = errorName(error);
        if (name !== 'OverconstrainedError' && name !== 'ConstraintNotSatisfiedError') throw error;
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: facing } });
      }

      this.stream = stream;
      this.video.srcObject = stream;
      await waitForMetadata(this.video);

      try {
        await this.video.play();
      } catch (playError) {
        const liveTrack = stream.getVideoTracks().some((track) => track.readyState === 'live');
        const videoHasFrames = this.video.videoWidth > 0 || this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
        if (!liveTrack || !videoHasFrames) throw playError;
      }

      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState !== 'live') throw new Error('Camera stream did not become live.');
    } catch (error) {
      this.stop();
      throw error;
    }
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
    try {
      this.video.pause();
    } catch {
      // Some WebKit states can throw while a media element is being torn down.
    }
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
