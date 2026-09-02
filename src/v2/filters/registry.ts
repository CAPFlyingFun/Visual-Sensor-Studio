/**
 * FILTERS — the one registry (Rule 5) and the one filter definition (Rule 4).
 *
 * A filter is a GLSL fragment shader plus metadata. The strip, the capability
 * checks and every render target read THIS list; there is no second list in
 * HTML, no switch statement naming the same filters again, and no separate
 * preview/photo implementations — preview and photo are the same shader at
 * different sizes, which makes Rule 4 structural rather than a convention.
 *
 * GPU-first is an adopted V2 decision (see the design spec's addendum): the
 * CPU path on main produced 0.40 MP filtered frames at 6 fps while the camera
 * delivered 12.2 MP. Point-wise work belongs in a fragment shader. There is
 * deliberately NO CPU fallback — that would be exactly the second
 * implementation Rule 4 forbids; where WebGL is missing the page says so.
 */

import { ironbowColor } from '../../vision/motion-ironbow.js';
import type { CustomLens } from '../../vision/lens.js';

export type FilterFamily = 'view' | 'motion' | 'time' | 'night' | 'custom';

export interface FilterDefinition {
  id: string;
  name: string;
  family: FilterFamily;
  /** Needs frame history (uPrevious) — in the display pass or the state pass. */
  temporal: boolean;
  supportsPhoto: boolean;
  supportsVideo: boolean;
  /** Fragment shader; samples uFrame, may read uTexel, uRamp, uPrevious, uState. */
  fragment: string;
  /**
   * Milestone D's history machinery, second stage. An optional STATE pass:
   * a fragment shader run at ANALYSIS resolution before the display pass,
   * reading uFrame, uPrevious and its own previous output (uState), writing
   * the new state. The display `fragment` then samples uState. Motion
   * needs none (it compares two frames); Speed smooths over frames and
   * Trails accumulates, and both keep that memory here — bounded at the
   * analysis size, never at the stream's — so the memory envelope that
   * killed a GPU context on device is never approached.
   */
  state?: string;
  /** A per-filter ramp (256 RGBA texels); absent = the Ironbow ramp. */
  ramp?: Uint8Array;
  /** Changes whenever `ramp` changes, so the renderer re-uploads exactly then. */
  rampKey?: string;
  /** Changes whenever the shader text changes (custom lenses are edited live). */
  revision?: string;
  /** Set when the filter cannot run here — shown, never made to look functional. */
  unavailableReason?: string;
  /** The lens document a custom filter was compiled from. */
  lens?: CustomLens;
}

export const SHADER_HEADER = `precision mediump float;
varying vec2 vUv;
uniform sampler2D uFrame;
uniform sampler2D uRamp;
uniform sampler2D uPrevious;
uniform sampler2D uState;
uniform vec2 uTexel;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;
const HEADER = SHADER_HEADER;

/**
 * The Speed state pass, exported so a custom lens bound to the speed channel
 * runs the SAME estimator (Rule 4) rather than a second one.
 */
export const SPEED_STATE = HEADER + `void main() {
  float now = luma(texture2D(uFrame, vUv).rgb);
  float before = luma(texture2D(uPrevious, vUv).rgb);
  float dx = luma(texture2D(uFrame, vUv + uTexel * vec2(1.0, 0.0)).rgb)
           - luma(texture2D(uFrame, vUv - uTexel * vec2(1.0, 0.0)).rgb);
  float dy = luma(texture2D(uFrame, vUv + uTexel * vec2(0.0, 1.0)).rgb)
           - luma(texture2D(uFrame, vUv - uTexel * vec2(0.0, 1.0)).rgb);
  float grad = length(vec2(dx, dy)) * 0.5;
  float dt = abs(now - before);
  float flow = dt * smoothstep(0.01, 0.05, dt) / (grad + 0.02);
  float target = clamp(flow / 8.0, 0.0, 1.0);
  float s = mix(texture2D(uState, vUv).r, target, 0.35);
  gl_FragColor = vec4(s, s, s, 1.0);
}`;

export const FILTERS: readonly FilterDefinition[] = [
  {
    id: 'rgb',
    name: 'RGB',
    family: 'view',
    temporal: false,
    supportsPhoto: true,
    supportsVideo: true,
    fragment: HEADER + `void main() {
  gl_FragColor = vec4(texture2D(uFrame, vUv).rgb, 1.0);
}`
  },
  {
    id: 'ironbow',
    name: 'Ironbow',
    family: 'view',
    temporal: false,
    supportsPhoto: true,
    supportsVideo: true,
    // Brightness through the ramp LUT. FALSE colour: this maps visible-light
    // luminance, not temperature — the honesty rule from the legacy app rides
    // along with the ramp itself.
    fragment: HEADER + `void main() {
  float y = luma(texture2D(uFrame, vUv).rgb);
  gl_FragColor = vec4(texture2D(uRamp, vec2(y, 0.5)).rgb, 1.0);
}`
  },
  {
    id: 'difference',
    name: 'Motion',
    family: 'motion',
    temporal: true,
    // A still of frame-to-frame change would render from history that lives
    // at ANALYSIS resolution — upscaling it to photo size and calling it
    // detail is exactly what the camera rule forbids. Video is the honest
    // product of this filter.
    supportsPhoto: false,
    supportsVideo: true,
    // Change between THIS frame and the PREVIOUS one, through the ramp.
    // uPrevious is the renderer's history texture — bounded at analysis
    // resolution, stated in the UI. The 4x gain is a display choice
    // (tuning, not measurement): small real motion reads as visible warmth.
    fragment: HEADER + `void main() {
  float now = luma(texture2D(uFrame, vUv).rgb);
  float before = luma(texture2D(uPrevious, vUv).rgb);
  float change = clamp(abs(now - before) * 4.0, 0.0, 1.0);
  gl_FragColor = vec4(texture2D(uRamp, vec2(change, 0.5)).rgb, 1.0);
}`
  },
  {
    id: 'speed',
    name: 'Speed',
    family: 'motion',
    temporal: true,
    supportsPhoto: false,
    supportsVideo: true,
    // NORMAL FLOW: motion along the brightness gradient, from the optical
    // flow constraint |dI/dt| / |∇I| — texels per frame at ANALYSIS
    // resolution. That is the component of motion a single pixel can see;
    // it is not full optical flow and not a velocity in metres. A noise
    // floor on the temporal difference keeps flat, static regions dark, and
    // an exponential average over frames (0.35 per frame) steadies it.
    // Full scale = 8 texels/frame — display tuning, not a measurement.
    state: SPEED_STATE,
    fragment: HEADER + `void main() {
  float s = texture2D(uState, vUv).r;
  gl_FragColor = vec4(texture2D(uRamp, vec2(s, 0.5)).rgb, 1.0);
}`
  },
  {
    id: 'trails',
    name: 'Trails',
    family: 'motion',
    temporal: true,
    supportsPhoto: false,
    supportsVideo: true,
    // Motion that FADES: each frame's change (the same measure Motion shows)
    // is kept as the maximum of "now" and the previous trail decayed by
    // 0.94 — about half a second to half brightness at 30 fps. The trail
    // itself lives in the state texture at ANALYSIS resolution; the
    // legacy app's constant-memory trail buffer, made a shader.
    state: HEADER + `void main() {
  float now = luma(texture2D(uFrame, vUv).rgb);
  float before = luma(texture2D(uPrevious, vUv).rgb);
  float change = clamp(abs(now - before) * 4.0, 0.0, 1.0);
  float t = max(change, texture2D(uState, vUv).r * 0.94);
  gl_FragColor = vec4(t, t, t, 1.0);
}`,
    fragment: HEADER + `void main() {
  float t = texture2D(uState, vUv).r;
  gl_FragColor = vec4(texture2D(uRamp, vec2(t, 0.5)).rgb, 1.0);
}`
  },
  {
    id: 'edges',
    name: 'Edges',
    family: 'view',
    temporal: false,
    supportsPhoto: true,
    supportsVideo: true,
    // Sobel on luma. uTexel is one texel at the RENDER size, supplied by the
    // renderer from the target geometry — the shader owns no resolution.
    fragment: HEADER + `void main() {
  float tl = luma(texture2D(uFrame, vUv + uTexel * vec2(-1.0, -1.0)).rgb);
  float  l = luma(texture2D(uFrame, vUv + uTexel * vec2(-1.0,  0.0)).rgb);
  float bl = luma(texture2D(uFrame, vUv + uTexel * vec2(-1.0,  1.0)).rgb);
  float tr = luma(texture2D(uFrame, vUv + uTexel * vec2( 1.0, -1.0)).rgb);
  float  r = luma(texture2D(uFrame, vUv + uTexel * vec2( 1.0,  0.0)).rgb);
  float br = luma(texture2D(uFrame, vUv + uTexel * vec2( 1.0,  1.0)).rgb);
  float  t = luma(texture2D(uFrame, vUv + uTexel * vec2( 0.0, -1.0)).rgb);
  float  b = luma(texture2D(uFrame, vUv + uTexel * vec2( 0.0,  1.0)).rgb);
  float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  float gy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
  float g = clamp(length(vec2(gx, gy)), 0.0, 1.0);
  gl_FragColor = vec4(vec3(g), 1.0);
}`
  }
];

/**
 * Custom lenses join the SAME registry as data-driven entries (Rule 5): the
 * strip, the capability checks and the renderer read one list. The shell
 * replaces this set whenever the saved lenses or the lens being edited change.
 */
let customFilters: readonly FilterDefinition[] = [];

export function setCustomFilters(filters: readonly FilterDefinition[]): void {
  customFilters = filters;
}

export function allFilters(): readonly FilterDefinition[] {
  return [...FILTERS, ...customFilters];
}

export function filterById(id: string): FilterDefinition | null {
  return allFilters().find((filter) => filter.id === id) ?? null;
}

/**
 * The Ironbow ramp as LUT pixels — built FROM the legacy ramp function, not
 * re-derived (Rule 6). One row of 256 RGBA texels; the shader samples it by
 * luminance.
 */
export function ironbowLut(): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = ironbowColor(i / 255);
    lut[i * 4] = r;
    lut[i * 4 + 1] = g;
    lut[i * 4 + 2] = b;
    lut[i * 4 + 3] = 255;
  }
  return lut;
}
