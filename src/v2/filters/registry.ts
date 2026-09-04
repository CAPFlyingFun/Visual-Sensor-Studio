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
  /** Reads the whole frame's colour histogram, so the shell must supply one. */
  needsHistogram?: boolean;
  /**
   * Reads the frame's measured luma range (relief's contrast stretch), so the
   * shell must supply one — the same census that feeds the histogram.
   */
  needsLumaRange?: boolean;
  /**
   * What this filter does, in one sentence, for the strip's note.
   *
   * It lives HERE rather than in the shell because the shell's copy was a
   * lookup table keyed by id, and a table like that goes stale silently: RGB
   * and Edges shipped with no note at all and nothing said so (Joshua,
   * 2026-09-02). A filter now carries its own sentence, so adding a filter
   * without one is visible in the same file that adds it.
   */
  note?: string;
}

export const SHADER_HEADER = `precision mediump float;
varying vec2 vUv;
uniform sampler2D uFrame;
uniform sampler2D uRamp;
uniform sampler2D uPrevious;
uniform sampler2D uState;
uniform vec2 uTexel;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

/*
 * THE SOBEL, ONCE (Rule 4).
 *
 * This had been written out three times — in the Edges filter, in the focus
 * peaking aid below, and again in the compiled lens channel — and three more
 * copies were about to arrive with Cel, Ink and Wash. Six transcriptions of
 * the same eight taps is six chances for one of them to drift, silently, in
 * a way that shows up as two filters disagreeing about where an edge is.
 *
 * The texel is a PARAMETER rather than uTexel, which is what lets the aid
 * share it: peaking measures at the aid's own resolution and everything else
 * at the render size, and that difference is the only thing that ever
 * separated the copies.
 */
float sobelLuma(vec2 uv, vec2 texel) {
  float tl = luma(texture2D(uFrame, uv + texel * vec2(-1.0, -1.0)).rgb);
  float  l = luma(texture2D(uFrame, uv + texel * vec2(-1.0,  0.0)).rgb);
  float bl = luma(texture2D(uFrame, uv + texel * vec2(-1.0,  1.0)).rgb);
  float tr = luma(texture2D(uFrame, uv + texel * vec2( 1.0, -1.0)).rgb);
  float  r = luma(texture2D(uFrame, uv + texel * vec2( 1.0,  0.0)).rgb);
  float br = luma(texture2D(uFrame, uv + texel * vec2( 1.0,  1.0)).rgb);
  float  t = luma(texture2D(uFrame, uv + texel * vec2( 0.0, -1.0)).rgb);
  float  b = luma(texture2D(uFrame, uv + texel * vec2( 0.0,  1.0)).rgb);
  float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  float gy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
  return length(vec2(gx, gy));
}
// The frame's colour histogram (64 texels, red channel = share of the
// commonest hue) and its prevailing colour as HSV. Both are measurements of
// the WHOLE picture; a filter that ignores them costs nothing for them.
uniform sampler2D uHistogram;
uniform vec3 uDominant;

/*
 * VIEWING AIDS — zebra and focus peaking (see render/overlays.ts).
 *
 * They live in the HEADER, and every filter ends by passing its colour
 * through withAids(), because an aid that only some filters honour is worse
 * than none: you would learn to trust stripes that quietly stop appearing.
 *
 * NEVER CAPTURED. Both uniforms are 0 unless the caller asks for them, and
 * only the preview asks — the photo and recording paths pass nothing, so
 * stripes cannot be baked into a file. Structural, not a flag to remember.
 *
 * Off costs one uniform comparison per pixel. Peaking's Sobel is eight taps
 * and is paid for only while it is on.
 */
// The frame's luma range, measured by the shell's census — relief is a
// CONTRAST-STRETCHED shading, so it needs to know where this frame's darkest
// and brightest actually sit rather than assuming 0..1.
uniform vec2 uLumaRange;
uniform float uZebra;
uniform float uPeak;
uniform vec2 uAidTexel;
vec3 withAids(vec3 color, vec2 uv) {
  if (uZebra <= 0.0 && uPeak <= 0.0) return color;
  // Judged on the CAMERA's luminance, not on the filter's output: under a
  // false-colour ramp the pixel on screen is a palette choice, and striping
  // by that would report the ramp rather than the exposure.
  vec3 scene = texture2D(uFrame, uv).rgb;
  if (uZebra > 0.0 && luma(scene) >= uZebra) {
    // Diagonal stripes in SCREEN space, so they read as an overlay rather
    // than as texture belonging to the picture.
    float stripe = fract((gl_FragCoord.x + gl_FragCoord.y) / 12.0);
    if (stripe < 0.5) color = mix(color, vec3(1.0, 0.1, 0.1), 0.65);
  }
  if (uPeak > 0.0) {
    // At the AID's resolution, which is why sobelLuma takes its texel.
    if (sobelLuma(uv, uAidTexel) >= uPeak) color = vec3(0.2, 1.0, 0.3);
  }
  return color;
}
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

/**
 * The FRAME-AVERAGE pass: this camera frame mixed into the running average of
 * the last few, so every filter measures one steadier picture instead of a
 * fresh roll of sensor noise. Renderer machinery rather than a filter — it
 * produces no product of its own — but it lives HERE because every fragment
 * shader in V2 does, and a shader kept somewhere else is the first half of a
 * second filter path (Rule 4).
 *
 * The renderer runs it with the OFFSCREEN vertex shader. Flipping here would
 * average each frame against a mirror of the one before it — the same trap
 * that turned every temporal filter into a kaleidoscope (2026-09-01).
 */
/**
 * NIGHT RECOVERY — the lift a finished stack has EARNED.
 *
 * A mean of N aligned frames is not brighter than one frame; it is the same
 * brightness with about sqrt(N) less noise. That suppressed noise is exactly
 * what makes lifting affordable: raising a single dark frame raises its grain
 * with it, and raising a fifteen-frame mean does not. So the gain belongs
 * here, AFTER the stack, and nowhere else.
 *
 * Three measured uniforms, all resolved from the stacked frame's own
 * exposure reading (vision/exposure.ts) rather than chosen by taste:
 *
 * - uGain  a straight multiply, never below 1.0. Night may brighten and may
 *          not darken; a daylight frame that already sits at a good mean
 *          gets 1.0 and passes through the multiply untouched.
 * - uGain  a straight multiply, never below 1.0. Night may brighten and may
 *          not darken; a daylight frame already at a good mean gets exactly
 *          1.0, and at 1.0 the whole curve below collapses to an identity.
 * - uLift  a shadow gamma driven by how much of the frame measured CRUSHED.
 *          This is the half that answers daylight: it opens the dark end
 *          without touching white, which is the "HDR" of the ask.
 *
 * The tone curve is Reinhard with its WHITE POINT SET TO THE GAIN, which is
 * what makes the gain safe to be large. Written out, out = c(1 + c/w²)/(1 + c)
 * for c = value × gain and w = gain. Three properties earn it its place:
 *
 *   - An input of 1.0 maps to exactly 1.0 at EVERY gain, so white stays white
 *     and no amount of lift can wash the picture out.
 *   - At gain 1.0 the whole expression reduces to c, an exact identity — a
 *     correctly exposed frame is not quietly re-graded for a lift it never
 *     asked for.
 *   - It is monotonic and asymptotically bounded, so it cannot clip: whatever
 *     the stack preserved at the top stays distinguishable instead of
 *     becoming one flat white.
 *
 * A fixed knee was tried first and rejected on its own numbers: at gain 6 it
 * squashed everything above 0.25 into the 0.92-0.98 band, which is brighter
 * and milky rather than brighter and legible. The white point keeps the
 * midtone separation the stacking was spent earning.
 */
export const NIGHT_RECOVERY_FRAGMENT = `precision mediump float;
varying vec2 vUv;
uniform sampler2D uFrame;
uniform float uGain;
uniform float uLift;
// PER-CHANNEL TRIM, measured from the gained result. (1,1,1) is an identity.
uniform vec3 uBalance;
void main() {
  vec3 c = texture2D(uFrame, vUv).rgb * uGain;
  // Reinhard, white point = the gain. At uGain 1.0 this is exactly c.
  float w = max(uGain, 1.0);
  c = c * (1.0 + c / (w * w)) / (1.0 + c);
  // SHADOWS. A gamma of 1.0 is an identity; above it the dark end opens and
  // white stays where it is.
  c = pow(max(c, 0.0), vec3(1.0 / max(uLift, 0.0001)));
  // COLOUR LAST, and measured at this same stage rather than before the
  // curve — a trim computed from the gained picture has to be applied to the
  // gained picture or it is correcting numbers it never saw. Clamped because
  // a channel pulled UP toward the average can pass 1.0.
  c = clamp(c * uBalance, 0.0, 1.0);
  gl_FragColor = vec4(c, 1.0);
}`;

/*
 * THE GPU PRECISION PROBE'S TWO SHADERS (render/gpu-precision.ts).
 *
 * They live here for the reason AVERAGE_FRAGMENT does: every fragment shader
 * in V2 lives in this file, and one kept elsewhere is the first half of a
 * second filter path (Rule 4). Neither draws a product — they write known
 * fractional values into a candidate accumulator format and read them back
 * amplified, to find out whether this device can hold more than 8 bits.
 *
 * highp on purpose. The whole question is whether small fractions survive, so
 * the probe must not be the thing that rounds them away. Where highp is
 * unavailable in a fragment shader the report says so and the result is read
 * as the device's honest answer.
 */
export const PROBE_VERTEX = `attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

/** Writes one known colour into whatever target is bound. */
export const PROBE_CONSTANT_FRAGMENT = `precision highp float;
uniform vec4 uValue;
void main() { gl_FragColor = uValue; }`;

/**
 * Reads the candidate target and multiplies it back into 8-bit range, so the
 * readback can be an ordinary UNSIGNED_BYTE readPixels that every WebGL1
 * implementation supports.
 */
export const PROBE_AMPLIFY_FRAGMENT = `precision highp float;
varying vec2 vUv;
uniform sampler2D uFrame;
uniform float uAmplify;
void main() { gl_FragColor = vec4(texture2D(uFrame, vUv).rgb * uAmplify, 1.0); }`;

export const AVERAGE_FRAGMENT = `precision mediump float;
varying vec2 vUv;
uniform sampler2D uFrame;
uniform sampler2D uAverage;
uniform float uWeight;
// ALIGNMENT, in UV. The accumulation stays in the orientation it began at and
// is never itself warped; each arriving frame is sampled at an offset that
// puts the scene back where the accumulation expects it. Zero is exactly the
// unaligned pass, so averaging with no gyro behaves as it always did.
uniform vec2 uAlign;
void main() {
  vec2 src = vUv + uAlign;
  vec3 now = texture2D(uFrame, src).rgb;
  vec3 before = texture2D(uAverage, vUv).rgb;
  // Past the frame's edge there is nothing photographed. The clamp would
  // repeat the edge row and the average would blend in a smear that was never
  // in front of the lens, so the accumulation simply keeps what it had there.
  float inside = step(0.0, src.x) * step(src.x, 1.0)
    * step(0.0, src.y) * step(src.y, 1.0);
  gl_FragColor = vec4(mix(before, now, uWeight * inside), 1.0);
}`;

/**
 * AGE — seconds since this pixel last moved, held in the state texture as a
 * fraction of the six-second window.
 *
 * A pixel that has not moved SINCE THE STATE WAS CLEARED reads as the full
 * window rather than as "never", because a texture cannot hold "no answer".
 * The state clears to zero on a filter change, so everything begins at "just
 * moved" and ages up truthfully over the following six seconds; the reading
 * is honest from then on. Saying so beats inventing a validity channel that
 * would have to be carried through every pass.
 */
export const AGE_STATE = HEADER + `uniform float uFps;
void main() {
  float now = luma(texture2D(uFrame, vUv).rgb);
  float before = luma(texture2D(uPrevious, vUv).rgb);
  // The same noise floor Speed uses, so "moved" means one thing in this app.
  float moved = step(0.02, abs(now - before));
  float dt = 1.0 / max(uFps, 1.0);
  float previous = texture2D(uState, vUv).r;
  float next = moved > 0.5 ? 0.0 : min(1.0, previous + dt / 6.0);
  gl_FragColor = vec4(next, next, next, 1.0);
}`;

/**
 * NOVELTY — a slowly learned background, so the display pass can ask how far
 * this pixel departs from what is normally here.
 *
 * SELF-PRIMING. The state clears to black, and a black background would make
 * the whole scene read as maximally novel for the second or two it took to
 * learn. So while the stored background is still black the frame is adopted
 * whole, and only then does it start blending slowly. A genuinely black scene
 * re-primes every frame, which costs nothing: it has no novelty to report.
 */
export const NOVELTY_STATE = HEADER + `void main() {
  vec3 now = texture2D(uFrame, vUv).rgb;
  vec3 background = texture2D(uState, vUv).rgb;
  float learned = step(0.004, luma(background));
  vec3 next = mix(now, mix(background, now, 0.02), learned);
  gl_FragColor = vec4(next, 1.0);
}`;

export const FILTERS: readonly FilterDefinition[] = [
  {
    id: 'rgb',
    note: 'The camera\'s own picture, unfiltered — the reference every other filter is a departure from.',
    name: 'RGB',
    family: 'view',
    temporal: false,
    supportsPhoto: true,
    supportsVideo: true,
    fragment: HEADER + `void main() {
  gl_FragColor = vec4(withAids(texture2D(uFrame, vUv).rgb, vUv), 1.0);
}`
  },
  {
    id: 'ironbow',
    note: 'False colour: visible-light brightness through the Ironbow ramp — not thermal.',
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
  gl_FragColor = vec4(withAids(texture2D(uRamp, vec2(y, 0.5)).rgb, vUv), 1.0);
}`
  },
  {
    id: 'difference',
    note: 'Change between frames through the ramp — history held at ANALYSIS resolution. A still is the frame you were shown; the trail behind it lives at ANALYSIS resolution.',
    name: 'Motion',
    family: 'motion',
    temporal: true,
    // A still is saved like every other filter's, at the full sensor. The
    // trail itself lives at ANALYSIS resolution, so a photo of it is that
    // memory enlarged rather than new detail — but refusing the shutter was
    // the worse answer, and it is the same picture you were looking at
    // (Joshua, 2026-09-02).
    supportsPhoto: true,
    supportsVideo: true,
    // Change between THIS frame and the PREVIOUS one, through the ramp.
    // uPrevious is the renderer's history texture — bounded at analysis
    // resolution, stated in the UI. The 4x gain is a display choice
    // (tuning, not measurement): small real motion reads as visible warmth.
    fragment: HEADER + `void main() {
  float now = luma(texture2D(uFrame, vUv).rgb);
  float before = luma(texture2D(uPrevious, vUv).rgb);
  float change = clamp(abs(now - before) * 4.0, 0.0, 1.0);
  gl_FragColor = vec4(withAids(texture2D(uRamp, vec2(change, 0.5)).rgb, vUv), 1.0);
}`
  },
  {
    id: 'speed',
    note: 'Motion along the brightness gradient (normal flow), smoothed over frames — texels per frame at ANALYSIS resolution, not a velocity.',
    name: 'Speed',
    family: 'motion',
    temporal: true,
    supportsPhoto: true,
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
  gl_FragColor = vec4(withAids(texture2D(uRamp, vec2(s, 0.5)).rgb, vUv), 1.0);
}`
  },
  {
    id: 'trails',
    note: 'Motion that fades over about half a second — the trail lives at ANALYSIS resolution, so a still enlarges that memory rather than adding detail.',
    name: 'Trails',
    family: 'motion',
    temporal: true,
    supportsPhoto: true,
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
  gl_FragColor = vec4(withAids(texture2D(uRamp, vec2(t, 0.5)).rgb, vUv), 1.0);
}`
  },
  {
    id: 'edges',
    note: 'Brightness boundaries (Sobel on luma), as grey. It finds a light thing against a dark one; two different colours of the same lightness have no brightness edge and it will not see them — Colour Edges will.',
    name: 'Edges',
    family: 'view',
    temporal: false,
    supportsPhoto: true,
    supportsVideo: true,
    // Sobel on luma. uTexel is one texel at the RENDER size, supplied by the
    // renderer from the target geometry — the shader owns no resolution.
    fragment: HEADER + `void main() {
  float g = clamp(sobelLuma(vUv, uTexel), 0.0, 1.0);
  gl_FragColor = vec4(withAids(vec3(g), vUv), 1.0);
}`
  },
  {
    id: 'grid',
    note: 'A ruled grid draped over the picture as if brightness were height. Bright things push the mesh toward you and the lines bend around them; the colour is the same height through the ramp. It is a SHADING read, not a depth sensor — a white wall reads as near.',
    name: 'Grid',
    family: 'view',
    temporal: false,
    supportsPhoto: true,
    supportsVideo: true,
    // The stretch needs the frame's measured luma range, the same census
    // relief uses — without it a dim room is a flat sheet.
    needsLumaRange: true,
    /*
     * HOW A FLAT GRID COMES TO HAVE A SHAPE.
     *
     * Joshua, 2026-09-04: "a grid style filter that purposefully draws grids,
     * but will warp based on what it sees".
     *
     * The grid itself is nothing — fract() of a scaled coordinate. All of the
     * effect is in WHERE it is sampled, and that offset is PARALLAX MAPPING,
     * the standard bump-map trick: a point standing at height h on a surface
     * viewed from a direction d appears displaced across the surface by h*d.
     * Feed it the picture's brightness as h and the mesh climbs over whatever
     * is lit, both axes moving, because d is a diagonal.
     *
     * It is deliberately the honest version of the metaphor and not a fake
     * three-dimensional one: there is no depth sensor on a web page, and
     * `relief` already says in this codebase why bright standing for near is
     * a shading estimate rather than a measurement. A white wall will read as
     * near. That is a property of the light, and it is stated in the note
     * rather than hidden behind a convincing render.
     *
     * SQUARE CELLS AT ANY SHAPE OF FRAME. uTexel is one texel at the render
     * size, so uTexel.x / uTexel.y is height/width — the factor that turns a
     * count of columns into the matching count of rows. The shader still owns
     * no resolution of its own, and the grid looks the same in the preview
     * and in a twelve-megapixel still.
     *
     * LINE WIDTH IS A FRACTION OF A CELL, NOT A COUNT OF PIXELS. Those are
     * the same thing on the preview and very different things on a
     * twelve-megapixel still, which is viewed scaled to fit: pixel-width
     * lines would come back as a hairline mesh that looked nothing like the
     * frame the shutter was pressed on. A cell-relative width makes the
     * saved picture the one that was shown, at any size. The pixel term
     * survives only as a MINIMUM, so a small preview cannot be given
     * sub-pixel lines that shimmer.
     *
     * No derivatives anywhere: OES_standard_derivatives is an extension this
     * build does not require, so fwidth() is not available to lean on.
     */
    fragment: HEADER + `const float COLUMNS = 34.0;
const float RELIEF = 0.055;
const vec2 VIEW_LEAN = vec2(0.55, 0.835);
const float SCENE_UNDER = 0.40;
const float HEIGHT_GAMMA = 0.5;
const float LINE_HALF_WIDTH = 0.035;
const float INK_FLOOR = 0.18;
const float LINE_LUMA = 0.62;

void main() {
  // Height, stretched into the frame's measured range and then GAMMA'D.
  //
  // The stretch alone is not enough and it is worth saying exactly why,
  // because it looks like it should be. uLumaRange is an absolute min and
  // max (see vision/exposure.ts), so a single bright thing in an otherwise
  // dark room — a television, a lamp — pins the top at 1.0 and the bottom is
  // almost always 0.0. Measured on Joshua's own room: min 0.0000, max
  // 1.0000, which makes the stretch an identity and leaves 29% of the frame
  // in the bottom fifth of the ramp, where the mesh is a deep violet nobody
  // can read. That is the whole of "it did it, but it's dark".
  //
  // The range stays as it is — it is the honest reading, and the exposure
  // instrument and relief both depend on it. The curve belongs here instead:
  // a square root is the ordinary way to spend more of a display's range on
  // the dark end, and it moves that room's median height from 0.30 to 0.58
  // without touching what the census reports.
  float span = max(0.004, uLumaRange.y - uLumaRange.x);
  float stretched = clamp((luma(texture2D(uFrame, vUv).rgb) - uLumaRange.x) / span, 0.0, 1.0);
  float h = pow(stretched, HEIGHT_GAMMA);

  // The parallax offset. Both axes move, so the mesh bends rather than only
  // rippling in rows.
  vec2 p = vUv + h * RELIEF * VIEW_LEAN;

  vec2 cells = vec2(COLUMNS, COLUMNS * (uTexel.x / uTexel.y));
  vec2 g = p * cells;
  // Distance to the nearest line of each family, in cell units.
  vec2 d = abs(fract(g) - 0.5);
  // Half-width of a line in cell units — a fixed share of a cell, with one
  // device pixel as the floor so the preview never draws sub-pixel lines.
  vec2 w = max(vec2(LINE_HALF_WIDTH), uTexel * cells);
  vec2 lit = vec2(1.0) - smoothstep(vec2(0.0), max(w, vec2(1e-5)), d);
  float line = max(lit.x, lit.y);

  // The line's colour is the height it stands at, so the mesh is a contour
  // map as well as a shape — but LIFTED OFF THE BOTTOM OF THE RAMP. Ironbow
  // begins at black by design, and a black line is not a line: colouring
  // strictly by height made the mesh vanish over everything dark, which in a
  // dim room is most of the frame. The lookup stays monotonic in height, so
  // the reading is unchanged; it simply never lands where it cannot be seen.
  vec3 ink = texture2D(uRamp, vec2(INK_FLOOR + (1.0 - INK_FLOOR) * h, 0.5)).rgb;

  // HUE CARRIES THE HEIGHT; BRIGHTNESS CARRIES "THIS IS A LINE". Lifting the
  // lookup off black was not enough on a real dark room (Joshua, 2026-09-04:
  // "It did it, but it's dark") because the ramp's low end is dim by nature —
  // a deep violet line is still a line nobody can read. Every line is now
  // raised to the same luminance, so the mesh is legible from end to end
  // while its colour still says how high it stands.
  //
  // Only ever a LIFT, and never past the point where a channel would clip:
  // scaling a bright line down would flatten the ramp's top, and clipping
  // would bend its hue. Both would make the colour lie about the height.
  float inkLuma = max(luma(ink), 0.001);
  float brightest = max(max(ink.r, ink.g), max(ink.b, 0.001));
  ink *= min(max(LINE_LUMA / inkLuma, 1.0), 1.0 / brightest);

  // The scene underneath gets the SAME curve before it is dimmed. Dividing
  // by the measured maximum was the obvious move and it is worthless for the
  // same reason the stretch was: that maximum is pinned at 1.0 by whatever
  // is brightest, so it lifts nothing. A gamma does not care what else is in
  // the frame.
  vec3 scene = texture2D(uFrame, vUv).rgb;
  vec3 under = pow(scene, vec3(HEIGHT_GAMMA)) * SCENE_UNDER;
  gl_FragColor = vec4(withAids(mix(under, ink, line), vUv), 1.0);
}`
  },
  {
    id: 'poly',
    note: 'The picture rebuilt as flat-filled triangles. Each cell is cut along the edge running through it, so facets line up with real boundaries instead of with the grid, and each triangle takes the average colour inside it. The colours are the camera\'s own — nothing here brightens or invents.',
    name: 'Poly',
    family: 'view',
    temporal: false,
    supportsPhoto: true,
    supportsVideo: true,
    /*
     * LOW-POLY WITHOUT A TRIANGULATION.
     *
     * Joshua, 2026-09-04: "basically it tries to do a lot of polygons and
     * fills."
     *
     * Real low-poly art triangulates: it finds feature points and connects
     * them, which a fragment shader cannot do — it has no memory of other
     * pixels and no way to build a mesh. What it CAN do is decide, for the
     * one pixel it is holding, which triangle that pixel belongs to. So the
     * frame is cut into cells, each cell is split by a diagonal, and every
     * pixel fills with the average colour of its own half.
     *
     * WHICH DIAGONAL IS THE TRICK, AND ITS LIMIT IS WORTH KNOWING. Cutting
     * every cell the same way gives a herringbone that sits on top of the
     * picture and ignores it, so the cut follows the local edge instead: a
     * four-tap gradient at the cell centre gives the edge direction, and the
     * diagonal more nearly parallel to it wins. Facets then meet along real
     * boundaries rather than along the grid.
     *
     * Measured on a real room, it is worth 4% less error against the source
     * in the cells where edges are strong, and nothing at all elsewhere —
     * which is the honest figure and smaller than it sounds like it should
     * be. The reason is structural: for a PURELY VERTICAL OR HORIZONTAL edge
     * the two diagonals score identically, because neither of them aligns
     * with it. A room full of cabinets and doorframes is mostly such edges.
     * The gain is real on diagonal features, which are exactly the ones a
     * fixed cut renders as a zigzag, and it costs four texture reads. It is
     * not a triangulation and does not pretend to be one.
     *
     * THE FILL IS AN AVERAGE, NOT A SAMPLE. One texel deciding a whole facet
     * makes sensor noise into visible flicker, and in a dark room that is
     * most of what would be showing. Four taps inside the triangle cost four
     * reads and settle it.
     *
     * NOTHING IS BRIGHTENED. Grid needed a curve because its subject was a
     * measured height that the ramp rendered invisible; Poly's subject is the
     * camera's own colour, and lifting it would be inventing an exposure the
     * sensor did not report. If a dark room comes out dark, that is the room.
     */
    fragment: HEADER + `const float POLY_COLUMNS = 26.0;
const float FILL_SPREAD = 0.19;

void main() {
  vec2 cells = vec2(POLY_COLUMNS, POLY_COLUMNS * (uTexel.x / uTexel.y));
  vec2 g = vUv * cells;
  vec2 cell = floor(g);
  vec2 f = g - cell;

  // The local edge direction, from four taps half a cell out. Sampling the
  // CELL rather than the pixel is deliberate: every pixel in a cell must
  // reach the same verdict or the diagonal would tear down its own length.
  // (halfCell, not 'half' — that word is RESERVED in GLSL ES 1.00 and the
  // shader would simply have failed to compile on the device.)
  vec2 halfCell = 0.5 / cells;
  vec2 c = (cell + 0.5) / cells;
  float gx = luma(texture2D(uFrame, clamp(c + vec2(halfCell.x, 0.0), 0.0, 1.0)).rgb)
           - luma(texture2D(uFrame, clamp(c - vec2(halfCell.x, 0.0), 0.0, 1.0)).rgb);
  float gy = luma(texture2D(uFrame, clamp(c + vec2(0.0, halfCell.y), 0.0, 1.0)).rgb)
           - luma(texture2D(uFrame, clamp(c - vec2(0.0, halfCell.y), 0.0, 1.0)).rgb);

  // An edge runs perpendicular to its gradient, so the edge direction is
  // (-gy, gx). Score both diagonals against it and cut along the better fit.
  float fitBack = abs(gx - gy);
  float fitFwd = abs(gx + gy);
  float back = step(fitFwd, fitBack);

  // The centroid of whichever half this pixel is in. Back is the '\\'
  // diagonal, split by f.y > f.x; forward is '/', split by f.x + f.y > 1.
  vec2 upperBack = vec2(1.0 / 3.0, 2.0 / 3.0);
  vec2 lowerBack = vec2(2.0 / 3.0, 1.0 / 3.0);
  vec2 upperFwd = vec2(2.0 / 3.0, 2.0 / 3.0);
  vec2 lowerFwd = vec2(1.0 / 3.0, 1.0 / 3.0);
  vec2 centroid = mix(
    mix(lowerFwd, upperFwd, step(1.0, f.x + f.y)),
    mix(lowerBack, upperBack, step(f.x, f.y)),
    back);

  // Four taps inside the triangle, averaged, so one noisy texel cannot
  // decide a facet.
  vec2 at = (cell + centroid) / cells;
  vec2 spread = FILL_SPREAD / cells;
  vec3 facet = texture2D(uFrame, clamp(at + vec2(spread.x, 0.0), 0.0, 1.0)).rgb
             + texture2D(uFrame, clamp(at - vec2(spread.x, 0.0), 0.0, 1.0)).rgb
             + texture2D(uFrame, clamp(at + vec2(0.0, spread.y), 0.0, 1.0)).rgb
             + texture2D(uFrame, clamp(at - vec2(0.0, spread.y), 0.0, 1.0)).rgb;
  gl_FragColor = vec4(withAids(facet * 0.25, vUv), 1.0);
}`
  },
  {
    id: 'cel',
    note: 'Anime cel shading: the picture flattened into a few bands of tone with its colour kept, and dark ink laid along the edges. The banding runs on a curved value so a dim room lands in more than one band — a stylisation, and the only thing here that is not the camera\'s own reading.',
    name: 'Cel',
    family: 'view',
    temporal: false,
    supportsPhoto: true,
    supportsVideo: true,
    /*
     * FLAT TONE PLUS INK, which is what cel animation actually is: paint
     * mixed in a few discrete values, and a line drawn over it.
     *
     * BANDING THE VALUE, NOT THE COLOUR. Quantising r, g and b separately is
     * the obvious way and it wrecks hue — a wall drifts from beige to pink as
     * two channels cross a step at different moments. Banding LUMA and then
     * rescaling the original colour to sit on that band keeps the hue exactly
     * and moves only the brightness, which is what a painter mixing four
     * values does.
     *
     * THE CURVE IS A STYLISATION AND IS SAID TO BE. Poly shows the camera's
     * own colour untouched because its subject is that colour. Cel's subject
     * is a painting, and a dark room quantised on raw luma lands entirely in
     * the bottom band — one flat shape, no picture. The curve spends the
     * bands where the room actually is. It is not a measurement and the note
     * does not present it as one.
     */
    fragment: HEADER + `const float BANDS = 5.0;
const float VALUE_GAMMA = 0.7;
const float SATURATION = 1.25;
const float INK_FULL = 0.30;
const vec3 INK = vec3(0.04, 0.03, 0.05);

void main() {
  vec3 scene = texture2D(uFrame, vUv).rgb;
  float y = luma(scene);
  float curved = pow(clamp(y, 0.0, 1.0), VALUE_GAMMA);
  float band = floor(curved * BANDS + 0.5) / BANDS;

  // Rescale the ORIGINAL colour onto the band: hue and saturation survive,
  // only the value moves. The guard is for near-black, where the ratio has
  // no meaning and would otherwise multiply noise up into the top band.
  vec3 painted = scene * (band / max(y, 0.02));
  painted = clamp(painted, 0.0, 1.0);
  painted = clamp(mix(vec3(luma(painted)), painted, SATURATION), 0.0, 1.0);

  // Ink where the picture has a boundary, softened over the approach so the
  // line has a drawn edge rather than a staircase.
  float ink = smoothstep(INK_FULL * 0.35, INK_FULL, sobelLuma(vUv, uTexel));
  gl_FragColor = vec4(withAids(mix(painted, INK, ink), vUv), 1.0);
}`
  },
  {
    id: 'ink',
    note: 'The room drawn on paper: graphite strokes along every edge, and cross-hatching that thickens as the light falls. Four hatch layers at different angles, each cutting in at its own darkness, the way a pen builds up shade.',
    name: 'Ink',
    family: 'view',
    temporal: false,
    supportsPhoto: true,
    supportsVideo: true,
    /*
     * A PEN HAS ONE COLOUR AND ONLY DENSITY TO SPEND.
     *
     * That is the whole idea, and it is why hatching is the right instrument
     * rather than a grey wash: a drawing gets darker by putting more lines
     * down, so four layers at four angles cut in at four thresholds, and the
     * darker a region is the more of them are drawn over it.
     *
     * THE HATCH IS MEASURED IN THE FRAME, NOT IN PIXELS. Spacing in device
     * pixels would give the preview a coarse weave and a twelve-megapixel
     * still a fine grey mist — the same mistake Grid's line width made — so
     * the pattern is scaled by the frame and the drawing survives being
     * saved. The aspect term keeps the strokes at 45 degrees instead of
     * shearing with the frame's shape.
     *
     * The paper is not flat white: a little grain keeps it from reading as a
     * screen, and it is cheap because it comes from the same hash the strokes
     * already need.
     */
    fragment: HEADER + `const float HATCH_SCALE = 210.0;
const float STROKE = 0.34;
const vec3 PAPER = vec3(0.96, 0.94, 0.88);
const vec3 GRAPHITE = vec3(0.13, 0.12, 0.15);
const float EDGE_FULL = 0.26;

// Hash without sine: sin() at large arguments loses precision at mediump,
// which on a phone is a visible seam rather than a rounding error.
float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// One family of parallel strokes, at an angle, in FRAME coordinates.
float hatch(vec2 p, float c, float sn, float width) {
  float v = p.x * c + p.y * sn;
  return 1.0 - smoothstep(0.0, width, abs(fract(v) - 0.5));
}

void main() {
  vec3 scene = texture2D(uFrame, vUv).rgb;
  float y = pow(clamp(luma(scene), 0.0, 1.0), 0.7);

  // Square the coordinate system before hatching, or the strokes shear.
  vec2 p = vec2(vUv.x, vUv.y * (uTexel.x / uTexel.y)) * HATCH_SCALE;

  // Four layers, each arriving as the light falls further.
  float shade = 0.0;
  shade = max(shade, hatch(p, 0.707, 0.707, STROKE) * step(y, 0.80));
  shade = max(shade, hatch(p, 0.707, -0.707, STROKE) * step(y, 0.55));
  shade = max(shade, hatch(p * 1.7, 1.0, 0.0, STROKE) * step(y, 0.34));
  shade = max(shade, hatch(p * 1.7, 0.0, 1.0, STROKE) * step(y, 0.16));

  // The outline, drawn over everything the hatching has built up.
  float stroke = smoothstep(EDGE_FULL * 0.3, EDGE_FULL, sobelLuma(vUv, uTexel));

  float grain = hash(floor(vUv / max(uTexel, vec2(1e-6)) * 0.5)) * 0.05;
  vec3 paper = PAPER - grain;
  vec3 drawn = mix(paper, GRAPHITE, max(shade * 0.85, stroke));
  gl_FragColor = vec4(withAids(drawn, vUv), 1.0);
}`
  },
  {
    id: 'wash',
    note: 'Watercolour: colour bled sideways into soft pools, pigment gathering darker along every boundary the way a real wash dries, and the grain of the paper showing through. The heaviest filter here — thirteen taps a pixel.',
    name: 'Wash',
    family: 'view',
    temporal: false,
    supportsPhoto: true,
    supportsVideo: true,
    /*
     * WHAT MAKES A WASH LOOK LIKE A WASH, in the order it matters.
     *
     * 1. THE EDGE IS DARKER THAN THE MIDDLE. Pigment migrates to the rim of a
     *    drying pool and settles there. This is the one effect that reads as
     *    watercolour and nothing else, and it is why the boundary is
     *    DARKENED rather than outlined in ink — a line would be a drawing.
     * 2. COLOUR SPREADS PAST ITS SUBJECT. Eight taps around a small disc, so
     *    a red mug bleeds a little into the table beside it.
     * 3. THE SPREAD IS UNEVEN. A perfectly circular blur reads as a lens
     *    defect; wet paper wanders. A hash-driven offset, constant per small
     *    patch, wobbles where each pixel reaches for its colour. The bleed
     *    stops at 6 texels for a reason that was measured rather than
     *    guessed: at 9 the patches stop reading as wet paper and start
     *    reading as rectangles, because the offset is constant across each
     *    one and a wide enough reach makes that constancy visible.
     * 4. THE PAPER SHOWS. Grain multiplies the result, strongest where the
     *    wash is pale, exactly as it does when the pigment is thin.
     *
     * Thirteen taps a pixel makes this the most expensive filter in the
     * registry, which is a fact worth stating rather than discovering: it is
     * a still-and-preview effect, and a twelve-megapixel save will take
     * noticeably longer than RGB's.
     */
    fragment: HEADER + `const float BLEED = 6.0;
const float WOBBLE = 1.6;
const float RIM = 1.2;
const float POOL_BANDS = 8.0;
const float PAPER_GRAIN = 0.13;
const float LIFT = 1.06;

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

void main() {
  // Where this pixel reaches for its colour, nudged by a value that is
  // constant across a small patch — wet paper does not wander per pixel.
  vec2 patch = floor(vUv / max(uTexel, vec2(1e-6)) / 14.0);
  vec2 drift = vec2(hash(patch) - 0.5, hash(patch + 7.31) - 0.5) * WOBBLE;
  vec2 at = vUv + drift * uTexel * BLEED;

  vec2 r = uTexel * BLEED;
  vec3 pool = texture2D(uFrame, at).rgb * 2.0;
  pool += texture2D(uFrame, at + vec2( r.x, 0.0)).rgb;
  pool += texture2D(uFrame, at + vec2(-r.x, 0.0)).rgb;
  pool += texture2D(uFrame, at + vec2(0.0,  r.y)).rgb;
  pool += texture2D(uFrame, at + vec2(0.0, -r.y)).rgb;
  pool += texture2D(uFrame, at + r * 0.7).rgb;
  pool += texture2D(uFrame, at - r * 0.7).rgb;
  pool += texture2D(uFrame, at + vec2(r.x, -r.y) * 0.7).rgb;
  pool += texture2D(uFrame, at + vec2(-r.x, r.y) * 0.7).rgb;
  pool = clamp(pool / 10.0 * LIFT, 0.0, 1.0);

  // A WASH DRIES FLAT. Blur alone gave a slightly soft photograph and not a
  // painting — measured, the rim contrast was +0.068, which is nothing. The
  // pools are banded like Cel's tone, by VALUE so the hue is untouched, and
  // that plus a stronger rim brings it to +0.211: pigment pooling you can
  // actually see. Banding after the blur rather than before is what keeps
  // the steps as soft-edged shapes instead of posterised noise.
  float pooled = max(luma(pool), 0.02);
  float flatten = floor(pow(clamp(pooled, 0.0, 1.0), 0.75) * POOL_BANDS + 0.5) / POOL_BANDS;
  pool = clamp(pool * (flatten / pooled), 0.0, 1.0);

  // Pigment gathering at the rim of the pool.
  float rim = clamp(sobelLuma(vUv, uTexel) * RIM, 0.0, 0.75);
  vec3 washed = pool * (1.0 - rim);

  // Paper, strongest where the wash is thin.
  float grain = hash(floor(vUv / max(uTexel, vec2(1e-6)) * 0.6));
  float thin = 1.0 - clamp(luma(washed), 0.0, 1.0);
  washed *= 1.0 - PAPER_GRAIN * grain * (0.35 + 0.65 * thin);
  gl_FragColor = vec4(withAids(clamp(washed, 0.0, 1.0), vUv), 1.0);
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

/**
 * REVERSED RAMPS — a session-only flip, held here and nowhere else.
 *
 * Joshua's ask, after making an inverted rainbow by hand and finding it read
 * better than the forward one: "have an edit to copy or invert colors as a tap
 * that will reverse for that one time use but won't save it."
 *
 * So it lives in memory. It is NOT written to the lens document, not written
 * to localStorage, and not carried across a reload — a saved lens means what
 * its author saved, and a look you are trying out is not an edit you made.
 * "Save as new" is still how a flip becomes permanent.
 *
 * It lives in the REGISTRY rather than in the shell because the strip, the
 * renderer and the capability checks all read this one list (Rule 5). A flip
 * applied anywhere else would be a second opinion about what a filter is.
 */
let reversedIds: ReadonlySet<string> = new Set();

export function setReversedFilters(ids: Iterable<string>): void {
  reversedIds = new Set(ids);
}

export function isReversed(id: string): boolean {
  return reversedIds.has(id);
}

/**
 * Reversing means reading the RAMP the other way, so it is offered only where
 * a ramp is actually read. RGB and Edges paint no ramp at all, and a lens in
 * mask or swap mode keeps the camera's own colours — flipping their stops
 * would change nothing, and a control that does nothing is worse than none.
 */
export function canReverse(filter: FilterDefinition | null): boolean {
  if (!filter || filter.unavailableReason) return false;
  // THE BODY, not the whole shader. SHADER_HEADER declares uRamp for every
  // filter whether it reads one or not, so testing the full text offered a
  // chip on RGB, Edges and every mask lens — all of which would have flipped
  // a ramp nothing samples.
  const body = filter.fragment.slice(filter.fragment.indexOf('void main'));
  return body.includes('uRamp');
}

/** The same 256 texels read back to front; colours untouched, order mirrored. */
function reverseRamp(ramp: Uint8Array): Uint8Array {
  const out = new Uint8Array(ramp.length);
  const texels = ramp.length / 4;
  for (let i = 0; i < texels; i++) {
    const from = (texels - 1 - i) * 4;
    out[i * 4] = ramp[from];
    out[i * 4 + 1] = ramp[from + 1];
    out[i * 4 + 2] = ramp[from + 2];
    out[i * 4 + 3] = ramp[from + 3];
  }
  return out;
}

/**
 * Reversed copies are MEMOISED, keyed by what they were built from.
 *
 * allFilters() runs on every render — filterById goes through it — so without
 * this a 256-texel ramp would be rebuilt for every reversed filter sixty
 * times a second, and thrown away each time. The cache is invalidated by the
 * source's own rampKey, which already moves whenever the ramp changes.
 */
const reversedCache = new Map<string, { from: string; filter: FilterDefinition }>();

function reversedFilter(filter: FilterDefinition): FilterDefinition {
  const from = `${filter.rampKey ?? 'ironbow'}|${filter.revision ?? ''}`;
  const held = reversedCache.get(filter.id);
  if (held && held.from === from) return held.filter;
  const built = buildReversed(filter);
  reversedCache.set(filter.id, { from, filter: built });
  return built;
}

function buildReversed(filter: FilterDefinition): FilterDefinition {
  // A built-in with no ramp of its own is drawn through the Ironbow LUT, so
  // that is the ramp being reversed for it.
  const ramp = reverseRamp(filter.ramp ?? ironbowLut());
  return {
    ...filter,
    ramp,
    // The rampKey is what makes the renderer re-upload; the SHADER is
    // untouched, so the revision (its program cache key) must not move.
    rampKey: `${filter.rampKey ?? 'ironbow'}::reversed`
  };
}

export function allFilters(): readonly FilterDefinition[] {
  const base = [...FILTERS, ...customFilters];
  if (reversedIds.size === 0) return base;
  return base.map((filter) =>
    reversedIds.has(filter.id) && canReverse(filter) ? reversedFilter(filter) : filter);
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
