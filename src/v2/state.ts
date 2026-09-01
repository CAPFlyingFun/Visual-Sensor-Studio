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

export interface V2State {
  camera: CameraStatus | null;
  /**
   * SOURCE: what the camera actually negotiated. Read from the stream, never
   * from CSS, and never a stand-in for analysis/preview/photo/record sizes —
   * those are different facts and arrive with the geometry authority.
   */
  source: FrameSize | null;
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
}

export function frameSize(width: number, height: number): FrameSize | null {
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height, aspect: width / height };
}

type Listener = (state: Readonly<V2State>) => void;

const state: V2State = {
  camera: null,
  source: null,
  deliveredFps: 0,
  zoom: null,
  geometry: null,
  activeFilter: 'rgb',
  previewFps: 0
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
