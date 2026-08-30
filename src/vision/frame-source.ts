/**
 * The boundary between camera acquisition and vision processing.
 *
 * Everything downstream of this file works on generic `AnalysisFrame`s and
 * never touches `getUserMedia`, a `<video>` element or a `MediaStreamTrack`.
 * That is what lets a future native provider (a Capacitor/AVFoundation bridge
 * offering separate ultrawide and wide streams, for example) be dropped in as
 * another `FrameSource` without the processing modes changing at all.
 *
 * Acquisition -> FrameSource -> vision processing -> sensor state -> optional 3D.
 * Never the other way round.
 */

export interface AnalysisFrame {
  /** Tightly packed RGBA, `width * height * 4` bytes. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** `performance.now()` at capture. */
  timestamp: number;
  /** Which physical source produced this frame. */
  sourceId: string;
}

export interface FrameSourceZoom {
  /** Zoom actually in effect. */
  value: number;
  min: number;
  max: number;
  step: number;
  /**
   * `camera` means the sensor/lens is zoomed through MediaTrack constraints.
   * `digital` means the frame is centre-cropped and scaled by this app.
   * `none` means zoom is not offered by this source at all.
   */
  kind: 'camera' | 'digital' | 'none';
}

export interface FrameSource {
  /** Stable identifier, e.g. `browser:environment`. */
  readonly id: string;
  /** Human-readable label for diagnostics. */
  readonly label: string;
  /** True only when the source is delivering real frames right now. */
  readonly active: boolean;
  readonly zoom: FrameSourceZoom;
  /**
   * Capture the current frame downsampled to roughly `targetWidth` pixels wide,
   * preserving aspect ratio. Returns null when no usable frame is available.
   */
  captureFrame(targetWidth: number): AnalysisFrame | null;
}

/**
 * Future dual-camera shape, declared now so the processing side is already
 * written against a set of sources rather than against one. Not implemented
 * by the browser provider: WebKit does not expose simultaneous lens streams,
 * and this app does not pretend otherwise.
 */
export interface FrameSourceSet {
  readonly primary: FrameSource;
  readonly sources: readonly FrameSource[];
  select(id: string): Promise<void>;
}
