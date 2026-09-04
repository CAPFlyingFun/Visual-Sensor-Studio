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
import { ASSUMED_ENVELOPE, type EncoderEnvelope } from './capture/encoder-envelope.js';
import { DEFAULT_STREAM_TIER } from './camera/stream-tiers.js';
import { DEFAULT_FRAME_AVERAGE } from './render/frame-average.js';

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
  /** dataavailable deliveries that built the file — 1 means the timeslice
   * request was not honored and a killed encoder loses the whole clip. */
  chunkCount: number;
  /** Frames the file really holds — null where the container was unreadable. */
  encodedFrames: number | null;
  /** The encoder's kept rate: frames / the file's own (or the clip's) seconds. */
  encodedFps: number | null;
  /** Frames handed to the encoder per second over the clip, measured. */
  fedFps: number;
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
  /**
   * Where CAPABILITY came from: the track advertising it, or V2 measuring it
   * with a scan (ask the live track for max, confirm a decoded frame,
   * restore). Two different kinds of fact, per docs/camera_rule.md, so the
   * row names which one it is.
   */
  capabilitySource: 'advertised' | 'measured' | null;
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
  /** The chosen viewfinder guide id; the guides registry defines it. */
  guide: string;
  /**
   * VIEWING AIDS — the chosen zebra and focus-peaking levels; the overlays
   * registry defines what each means. They change what the PREVIEW shows and
   * nothing else: the photo and recording paths ask the renderer for none.
   */
  zebra: string;
  peaking: string;
  /**
   * Whether the exposure readout is on screen. It gates a census, so it is
   * state rather than a CSS class: an instrument nobody is looking at should
   * not be costing a frame read.
   */
  exposureShown: boolean;
  /**
   * FRAME AVERAGING: the chosen level id; render/frame-average.ts defines what
   * each one means. One owner for every filter, because it changes the PICTURE
   * they all measure — a per-filter copy would let two of them disagree about
   * what this frame even is.
   */
  frameAverage: string;
  /**
   * GYRO ALIGNMENT: whether frame averaging is steadied by the phone's own
   * orientation. Its own switch rather than a level on the averaging ladder,
   * because it needs a motion permission and can therefore be REFUSED — a
   * ladder rung that silently does nothing would be the dishonest version.
   */
  align: boolean;
  /**
   * THE MOTION SENSOR's own state, owned once and read by everything that
   * needs it — gyro alignment and the steady shutter both do. Not derived
   * from either feature's switch: "off" and "the phone refused the sensor"
   * are different facts, and a feature that inferred one from the other would
   * report a refusal as a preference.
   */
  motionStatus: 'off' | 'asking' | 'on' | 'denied' | 'unsupported';
  /**
   * STEADY SHUTTER: armed and waiting for a hold steady enough to photograph.
   * Its own flag rather than a mode, because it is a thing the camera is
   * WAITING to do and the picture has to keep working meanwhile.
   */
  autoShot: boolean;
  /**
   * The colour picker's aiming reticle. Its own switch, not a guide: the
   * picker forces it on while armed, and otherwise it shows only if asked
   * for — nothing sits in the middle of the picture uninvited.
   */
  reticle: boolean;
  /** Non-null while a clip is being recorded. */
  recording: ActiveRecording | null;
  /** ENCODED: what the last clip's file really contained. */
  lastClip: SavedClip | null;
  /**
   * ENCODER CAPABILITY: the largest frame the video encoder can write —
   * assumed at the H.264 Level 5.2 line until the encoder probe measures
   * this device. RECORD IN is held under it, with the reason named.
   */
  encoderEnvelope: EncoderEnvelope;
  /**
   * RECORD AT MAX REGARDLESS OF THE ENVELOPE — Joshua's own call, 2026-09-04:
   * "don't assume my phone can't as I am able to record at MAX at around
   * 30fps." With this set, RECORD IN follows the chosen tier exactly as a
   * photo does and the encoder check is skipped entirely. It is a CHOICE, so
   * it also overrides a measured envelope, not merely the assumed one: the
   * finished file is decoded and reported either way, so a frame the encoder
   * really cannot hold announces itself instead of being predicted away.
   *
   * DEFAULT TRUE. The envelope generalises one codec's frame limit, measured
   * on one device, to every camera this app will ever meet — "what if using a
   * computer with a camera up to 16K, having a recording limit seems like
   * failure for the app". Shrinking every recording everywhere to pre-empt a
   * failure that announces itself anyway is the worse trade.
   */
  forceMaxRecord: boolean;
  /**
   * Measure how far a saved still compresses before it visibly changes, and
   * encode at that quality rather than at a flat 1.00.
   *
   * DEFAULT TRUE. Joshua, 2026-09-04, on a 3.69 MB save: "with a photo
   * compression app, I got that same image and resolution at 288KB... at no
   * visual quality loss." Quality 1.00 spends most of its bits reproducing
   * sensor noise exactly; the resolution is untouched either way, so this
   * costs nothing MAX MEANS MAX is about.
   */
  visuallyLossless: boolean;
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
  capabilitySource: null,
  deliveredFps: 0,
  zoom: null,
  geometry: null,
  activeFilter: 'rgb',
  previewFps: 0,
  viewfinder: null,
  lastPhoto: null,
  captureActive: false,
  // FROM THE REGISTRY, never a second copy of the number. This was the
  // literal '720' while stream-tiers.ts owned DEFAULT_STREAM_TIER, so
  // changing the registry's default changed nothing the app actually booted
  // with — the duplicate silently won. One owner for the default.
  streamTier: DEFAULT_STREAM_TIER,
  guide: 'off',
  zebra: 'off',
  peaking: 'off',
  exposureShown: false,
  frameAverage: DEFAULT_FRAME_AVERAGE,
  align: false,
  motionStatus: 'off',
  autoShot: false,
  reticle: false,
  recording: null,
  lastClip: null,
  encoderEnvelope: ASSUMED_ENVELOPE,
  // ON until the stored preference or an explicit untick says otherwise —
  // see storedForceMaxRecord in app.ts for why the default is this way round.
  forceMaxRecord: true,
  // ON: the alternative is a flat 1.00 that knows nothing about the picture
  // in front of it — see measureQuality in capture/photo.ts.
  visuallyLossless: true
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
