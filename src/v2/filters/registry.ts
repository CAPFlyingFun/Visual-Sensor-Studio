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

export type FilterFamily = 'view' | 'motion' | 'time' | 'night' | 'custom';

export interface FilterDefinition {
  id: string;
  name: string;
  family: FilterFamily;
  /** Needs frame history — none of Milestone B's filters do. */
  temporal: boolean;
  supportsPhoto: boolean;
  supportsVideo: boolean;
  /** Fragment shader; samples uFrame, may read uTexel and uRamp. */
  fragment: string;
}

const HEADER = `precision mediump float;
varying vec2 vUv;
uniform sampler2D uFrame;
uniform sampler2D uRamp;
uniform sampler2D uPrevious;
uniform vec2 uTexel;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

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

export function filterById(id: string): FilterDefinition | null {
  return FILTERS.find((filter) => filter.id === id) ?? null;
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
