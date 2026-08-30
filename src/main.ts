import { CameraController } from './sensors/camera.js';
import { MotionController } from './sensors/motion.js';
import { GpsController } from './sensors/gps.js';
import { clamp, median } from './core/math.js';
import type { GpsSample, MotionSample, SensorSnapshot, VisionMode } from './core/types.js';
import { disparityToRgba, grayToRgba, reliefFromGray, rgbaToGray, sobelEdges } from './vision/frame-processing.js';
import { computeBlockDisparity } from './vision/parallax.js';
import { FusionScene } from './visualization/scene.js';

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

const video = byId<HTMLVideoElement>('cameraVideo');
const visionCanvas = byId<HTMLCanvasElement>('visionCanvas');
const visionContext = visionCanvas.getContext('2d');
if (!visionContext) throw new Error('Canvas 2D is required.');

const camera = new CameraController(video);
const motion = new MotionController();
const gps = new GpsController();
const fusion = new FusionScene(byId('fusionScene'));

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

async function startCamera(): Promise<void> {
  const button = byId<HTMLButtonElement>('cameraButton');
  button.disabled = true;
  setChip('cameraChip', 'warn', 'Camera requesting…');
  try {
    await camera.start();
    setChip('cameraChip', 'good', `Camera ${camera.currentFacing === 'environment' ? 'rear' : 'front'}`);
    button.textContent = 'Restart Camera';
    byId<HTMLButtonElement>('switchCameraButton').disabled = false;
  } catch (error) {
    setChip('cameraChip', 'warn', 'Camera unavailable');
    setText('cameraMessage', error instanceof Error ? error.message : 'Unable to start camera.');
  } finally {
    button.disabled = false;
  }
}

async function switchCamera(): Promise<void> {
  const button = byId<HTMLButtonElement>('switchCameraButton');
  button.disabled = true;
  try {
    const facing = await camera.switchCamera();
    setChip('cameraChip', 'good', `Camera ${facing === 'environment' ? 'rear' : 'front'}`);
  } catch (error) {
    setText('cameraMessage', error instanceof Error ? error.message : 'Unable to switch camera.');
  } finally {
    button.disabled = false;
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

function toggleGps(): void {
  const button = byId<HTMLButtonElement>('gpsButton');
  if (gps.active) {
    gps.stop();
    setChip('gpsChip', 'idle', 'GPS paused');
    button.textContent = 'Start GPS Track';
    return;
  }

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
    }
  );
  button.textContent = 'Pause GPS Track';
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
  setText('visionModeLabel', mode === 'camera' ? 'RGB camera' : mode === 'relief' ? 'Image relief • not physical depth' : 'Edge map');
}

async function visionLoop(timestamp: number): Promise<void> {
  requestAnimationFrame((time) => void visionLoop(time));
  if (!camera.active || visionMode === 'camera' || processingVision || timestamp - lastVisionFrameAt < 95) return;
  lastVisionFrameAt = timestamp;
  processingVision = true;
  try {
    const frame = camera.captureFrame(256);
    const gray = rgbaToGray(frame.imageData.data);
    const output = visionMode === 'relief'
      ? reliefFromGray(gray, frame.width, frame.height)
      : grayToRgba(sobelEdges(gray, frame.width, frame.height));
    drawImageData(visionCanvas, new ImageData(output, frame.width, frame.height));
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
      const valid = [...result.disparity].filter((value, index) => Number.isFinite(value) && value > 0.25 && result.confidence[index] > 0.015);
      medianDisparityPx = valid.length ? median(valid) : null;
      const rgba = disparityToRgba(result.disparity, result.confidence, maxDisparity);
      drawImageData(byId<HTMLCanvasElement>('parallaxCanvas'), new ImageData(rgba, result.width, result.height));
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

byId<HTMLButtonElement>('cameraButton').addEventListener('click', () => void startCamera());
byId<HTMLButtonElement>('switchCameraButton').addEventListener('click', () => void switchCamera());
byId<HTMLButtonElement>('motionButton').addEventListener('click', () => void enableMotion());
byId<HTMLButtonElement>('gpsButton').addEventListener('click', toggleGps);
byId<HTMLButtonElement>('resetGpsButton').addEventListener('click', resetGps);
byId<HTMLButtonElement>('captureParallaxButton').addEventListener('click', captureParallaxReference);
byId<HTMLButtonElement>('analyzeParallaxButton').addEventListener('click', analyzeParallax);
byId<HTMLButtonElement>('resetViewButton').addEventListener('click', () => fusion.resetView());
byId<HTMLButtonElement>('downloadButton').addEventListener('click', downloadSnapshot);

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-vision-mode]')) {
  button.addEventListener('click', () => updateVisionMode(button.dataset.visionMode as VisionMode));
}

setText('secureContextValue', window.isSecureContext ? 'Secure ✓' : 'Needs HTTPS');
setChip('pwaChip', 'good', window.matchMedia('(display-mode: standalone)').matches ? 'PWA installed' : 'PWA ready');
updateVisionMode('camera');
requestAnimationFrame((time) => void visionLoop(time));

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => {
      setChip('pwaChip', 'warn', 'PWA cache unavailable');
    });
  });
}
