/**
 * V2 shared state — the one owner.
 *
 * Rule 1 of docs/V2-DATA-DRIVEN-RULES.md: if two parts of V2 mean the same
 * quantity, they read the same value from the same owner. This module is that
 * owner for Milestone A's quantities: camera status, the negotiated source
 * size, the measured delivered rate, and zoom. Milestone B's frame geometry
 * authority extends from here rather than starting a second store.
 *
 * Flow is one-directional (Rule 7): camera/capability events are written in by
 * the app shell, and renderers, readouts and controls subscribe. Nothing in
 * the UI writes camera facts back.
 */

import type { CameraStatus, CameraZoomState } from '../sensors/camera.js';
import type { FrameGeometryState } from './camera/geometry.js';

export interface FrameSize {
  width: number;
  height: number;
  /** width / height — below 1 in portrait. */
  aspect: number;
}

/** The VIEWFINDER's rectangle in device pixels — display geometry, not camera. */
export interface DevicePixelBox {
  width: number;
  height: number;
}

/** What the last shutter press actually saved — measured, never assumed. */
export interface SavedPhoto {
  width: number;
  height: number;
  bytes: number;
}

/**
 * A recording in flight: which path, and the RECORD IN size FROZEN at start —
 * the encoder was promised these dimensions, so nothing may resize the render
 * target underneath it until stop.
 */
export interface ActiveRecording {
  path: 'native' | 'filtered';
  input: FrameSize;
}

/** What the last recording really produced — measured from the file. */
export interface SavedClip {
  seconds: number;
  width: number;
  height: number;
  bytes: number;
  measuredMbps: number;
  mimeType: string;
  /** The encoder wrote different dimensions than it was handed — flagged. */
  resizedFromInput: boolean;
}

export interface V2State {
  camera: CameraStatus | null;
  /**
   * SOURCE: what the camera actually negotiated. Read from the stream, never
   * from CSS, and never a stand-in for analysis/preview/photo/record sizes —
   * those are different facts and arrive with the geometry authority.
   */
  source: FrameSize | null;
  /**
   * CAPABILITY: the largest stream the track ADVERTISES, orientation as
   * reported. Null where WebKit does not expose it — which is "unknown", not
   * "equal to source". A different fact from SOURCE on purpose: the gap
   * between them is the difference between "cannot do more" and "did not ask".
   */
  capability: FrameSize | null;
  /** Measured from presented frames. 0 until enough frames have arrived. */
  deliveredFps: number;
  zoom: CameraZoomState | null;
  /**
   * Resolved by the FrameGeometryAuthority whenever source or viewport
   * change. Null until the first source exists — consumers must not invent a
   * stand-in.
   */
  geometry: FrameGeometryState | null;
  /** The one active filter id; the registry defines what it means. */
  activeFilter: string;
  /** Preview renders per second, measured — the GPU's own delivery rate. */
  previewFps: number;
  /**
   * VIEWFINDER: the on-screen rectangle in device pixels. Measured by the one
   * sanctioned layout read; PREVIEW derives from it and nothing else does.
   */
  viewfinder: DevicePixelBox | null;
  /** LAST PHOTO: what the most recent shutter press really saved. */
  lastPhoto: SavedPhoto | null;
  /** True only inside the shutter's temporary maximum-stream window. */
  captureActive: boolean;
  /** The chosen CAMERA STREAM tier id; the registry defines what it means. */
  streamTier: string;
  /** Non-null while a clip is being recorded. */
  recording: ActiveRecording | null;
  /** ENCODED: what the last clip's file really contained. */
  lastClip: SavedClip | null;
}

export function frameSize(width: number, height: number): FrameSize | null {
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height, aspect: width / height };
}

type Listener = (state: Readonly<V2State>) => void;

const state: V2State = {
  camera: null,
  source: null,
  capability: null,
  deliveredFps: 0,
  zoom: null,
  geometry: null,
  activeFilter: 'rgb',
  previewFps: 0,
  viewfinder: null,
  lastPhoto: null,
  captureActive: false,
  streamTier: 'speed',
  recording: null,
  lastClip: null
};

const listeners = new Set<Listener>();

export function readState(): Readonly<V2State> {
  return state;
}

export function updateState(patch: Partial<V2State>): void {
  Object.assign(state, patch);
  for (const listener of listeners) listener(state);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}
