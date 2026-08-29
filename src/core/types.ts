import type { LocalPoint, QuaternionLike } from './math.js';

export type VisionMode = 'camera' | 'relief' | 'edges';

export interface MotionSample {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  screenAngle: number;
  quaternion: QuaternionLike;
  acceleration: { x: number; y: number; z: number };
  rotationRate: { alpha: number; beta: number; gamma: number };
  timestamp: number;
}

export interface GpsSample {
  latitude: number;
  longitude: number;
  altitude: number | null;
  accuracy: number;
  altitudeAccuracy: number | null;
  heading: number | null;
  speed: number | null;
  timestamp: number;
  local: LocalPoint;
}

export interface SensorSnapshot {
  capturedAt: string;
  cameraFacing: 'environment' | 'user';
  motion: MotionSample | null;
  gps: GpsSample | null;
  gpsTrackPoints: number;
  parallax: {
    capturedReference: boolean;
    analyzed: boolean;
    medianDisparityPx: number | null;
  };
}
