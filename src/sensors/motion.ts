import { deviceOrientationToQuaternion } from '../core/math.js';
import type { MotionSample } from '../core/types.js';

type PermissionResult = 'granted' | 'denied';
type PermissionCapableConstructor = typeof DeviceMotionEvent & {
  requestPermission?: () => Promise<PermissionResult>;
};
type OrientationPermissionCapableConstructor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<PermissionResult>;
};

function screenAngle(): number {
  const modern = window.screen.orientation?.angle;
  if (typeof modern === 'number') return modern;
  const legacy = (window as Window & { orientation?: number }).orientation;
  return typeof legacy === 'number' ? legacy : 0;
}

export class MotionController {
  private orientation = { alpha: null as number | null, beta: null as number | null, gamma: null as number | null };
  private acceleration = { x: 0, y: 0, z: 0 };
  private rotationRate = { alpha: 0, beta: 0, gamma: 0 };
  private callback: ((sample: MotionSample) => void) | null = null;
  private listening = false;

  async requestPermission(): Promise<boolean> {
    const motionCtor = DeviceMotionEvent as PermissionCapableConstructor;
    const orientationCtor = DeviceOrientationEvent as OrientationPermissionCapableConstructor;

    const results: PermissionResult[] = [];
    if (typeof motionCtor.requestPermission === 'function') {
      results.push(await motionCtor.requestPermission());
    }
    if (typeof orientationCtor.requestPermission === 'function') {
      results.push(await orientationCtor.requestPermission());
    }
    return results.every((result) => result === 'granted');
  }

  start(callback: (sample: MotionSample) => void): void {
    this.callback = callback;
    if (this.listening) return;
    window.addEventListener('deviceorientation', this.handleOrientation, true);
    window.addEventListener('devicemotion', this.handleMotion, true);
    this.listening = true;
    this.emit();
  }

  stop(): void {
    if (!this.listening) return;
    window.removeEventListener('deviceorientation', this.handleOrientation, true);
    window.removeEventListener('devicemotion', this.handleMotion, true);
    this.listening = false;
  }

  private readonly handleOrientation = (event: DeviceOrientationEvent): void => {
    this.orientation = { alpha: event.alpha, beta: event.beta, gamma: event.gamma };
    this.emit();
  };

  private readonly handleMotion = (event: DeviceMotionEvent): void => {
    const accel = event.accelerationIncludingGravity ?? event.acceleration;
    this.acceleration = {
      x: accel?.x ?? 0,
      y: accel?.y ?? 0,
      z: accel?.z ?? 0
    };
    const rate = event.rotationRate;
    this.rotationRate = {
      alpha: rate?.alpha ?? 0,
      beta: rate?.beta ?? 0,
      gamma: rate?.gamma ?? 0
    };
    this.emit();
  };

  private emit(): void {
    if (!this.callback) return;
    const angle = screenAngle();
    this.callback({
      ...this.orientation,
      screenAngle: angle,
      quaternion: deviceOrientationToQuaternion(
        this.orientation.alpha,
        this.orientation.beta,
        this.orientation.gamma,
        angle
      ),
      acceleration: { ...this.acceleration },
      rotationRate: { ...this.rotationRate },
      timestamp: performance.now()
    });
  }
}
