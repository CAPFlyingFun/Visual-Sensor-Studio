import type { LocalPoint, QuaternionLike } from './math.js';

export type VisionMode =
  | 'camera'
  | 'relief'
  | 'edges'
  | 'motion'
  | 'difference'
  | 'flow'
  | 'speed'
  | 'motiontrails'
  | 'amplify'
  | 'background'
  | 'chrono'
  | 'slitscan'
  | 'night';

export interface VisionMetrics {
  /** Mean scene luminance, 0..1. */
  brightness: number;
  /** Normalised luminance spread, 0..1. Not a physical contrast ratio. */
  contrast: number;
  /** Share of the frame carrying strong edge structure, 0..1. */
  detail: number;
  /** Normalised inter-frame change, 0..1. */
  motion: number;
  /** Frames per second actually pushed through the vision pipeline. */
  processingFps: number;
  /** Width in pixels of the downsampled analysis frame. */
  analysisWidth: number;
}

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
  vision: {
    mode: VisionMode;
    metrics: VisionMetrics | null;
    zoom: number;
    zoomKind: 'camera' | 'digital' | 'none';
  };
  /**
   * How far the phone travelled between the two parallax captures.
   *
   * Null when the motion sensors were off, so a reader can tell "not measured"
   * from "measured as zero".
   */
  parallaxBaseline: {
    displacementMetres: number;
    uncertaintyMetres: number;
    rotationDegrees: number;
    durationSeconds: number;
    usable: boolean;
    estimatedDepthMetres: number | null;
    method: string;
  } | null;
}
