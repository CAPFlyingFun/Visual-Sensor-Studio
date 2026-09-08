/**
 * Custom lenses on the GPU — Milestone E.
 *
 * A lens is the legacy DATA document (src/vision/lens.ts): one measured
 * channel through a colour ramp, optionally a second channel driving
 * brightness, a base and a scene blend. Nothing in it executes. Here it is
 * COMPILED into a V2 filter — one fragment shader that serves preview,
 * photo and record alike (Rule 4) — so a lens is a first-class filter, not
 * a second rendering path. The ramp becomes a per-lens LUT texture built by
 * the very same buildRampLut the legacy editor swatch uses (Rule 6).
 *
 * Units are the legacy channel units, so a .lens.json authored in the old
 * app means the same thing here: luma/edges/change in 0–255, speed in frame
 * widths per second. Channels V2 does not compute yet (relief, age,
 * novelty) compile to an UNAVAILABLE filter that says so — never a silent
 * stand-in.
 */

import {
  buildRampLut, channelInfo, parseHex,
  type ChannelId, type CustomLens, type LensBinding, type LensStop
} from '../../vision/lens.js';
import { COLOUR_GAP_GLSL, rgbToHsvValues } from '../vision/colour-gap.js';
import {
  AGE_STATE, NOVELTY_STATE, SHADER_HEADER, SPEED_STATE, type FilterDefinition
} from './registry.js';

/** Channels V2 computes on the GPU, in legacy units. */
export const V2_CHANNELS: readonly ChannelId[] = [
  'luma', 'edges', 'change', 'speed',
  // The colour fields — one pass over the frame, no state, no history.
  'hue', 'saturation', 'red', 'green', 'blue', 'colourDistance',
  // Fed by the frame histogram the shell measures each few frames.
  'rarity', 'backgroundDistance', 'chromaEdge',
  // Fed by a STATE pass, or by the frame's measured luma range.
  'relief', 'age', 'novelty'
];

/**
 * The channels that need the renderer's one state texture. A lens can bind
 * only ONE of them, because there is only one state pass — asking for two
 * would silently give the second the first one's memory.
 */
export const STATEFUL_CHANNELS: readonly ChannelId[] = ['speed', 'age', 'novelty'];

/** A hex colour as HSV, each 0..1 — the shader's own convention. */
export function rgbToHsv(hex: string): [number, number, number] {
  const [r, g, b] = parseHex(hex);
  return rgbToHsvValues(r, g, b);
}

export function channelAvailability(id: ChannelId): { available: boolean; reason: string } {
  if (V2_CHANNELS.includes(id)) return { available: true, reason: '' };
  return {
    available: false,
    reason: `"${channelInfo(id).label}" is not built in V2 yet — it needs an estimator V2 does not run.`
  };
}

/**
 * The same ramp, read the other way: a stop at 0 lands at 1 and back again.
 * Colours are untouched — only their positions mirror — so black→white
 * becomes white→black and reversing twice is exactly where it started.
 */
export function reverseStops(stops: readonly LensStop[]): LensStop[] {
  return stops
    .map((stop) => ({ at: 1 - stop.at, color: stop.color }))
    .sort((a, b) => a.at - b.at);
}

export function lensFilterId(lens: CustomLens): string {
  return `lens:${lens.id}`;
}

/** A short fingerprint of everything that changes the shader or the ramp. */
export function lensRevision(lens: CustomLens): string {
  const text = JSON.stringify([
    lens.color, lens.brightness ?? null, lens.stops, lens.base, lens.sceneBlend,
    lens.output ?? 'paint', lens.reference ?? '', lens.target ?? '',
    lens.brightnessFloor ?? 0, lens.fill ?? null
  ]);
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return hash.toString(16);
}

const glslFloat = (value: number): string => {
  const safe = Number.isFinite(value) ? value : 0;
  const text = safe.toFixed(4);
  return text.includes('.') ? text : `${text}.0`;
};

/** GLSL for one channel in LEGACY units, sampled at `uv`. */
function channelGlsl(id: ChannelId): string {
  switch (id) {
    case 'luma':
      return `float ch_luma(vec2 uv) { return luma(texture2D(uFrame, uv).rgb) * 255.0; }`;
    case 'edges':
      // The legacy field is hypot(gx, gy) of a Sobel on 0–255 gray, clamped
      // to 255; on 0–1 luma that is the same number × 255.
      // The SAME eight taps every other edge reader uses — sobelLuma lives in
      // SHADER_HEADER (Rule 4). A lens and the Edges filter disagreeing about
      // where an edge is would be a bug nobody could see until they were
      // compared side by side.
      return `float ch_edges(vec2 uv) {
  return clamp(sobelLuma(uv, uTexel) * 255.0, 0.0, 255.0);
}`;
    case 'change':
      return `float ch_change(vec2 uv) {
  return abs(luma(texture2D(uFrame, uv).rgb) - luma(texture2D(uPrevious, uv).rgb)) * 255.0;
}`;
    case 'red':
      return `float ch_red(vec2 uv) { return texture2D(uFrame, uv).r * 255.0; }`;
    case 'green':
      return `float ch_green(vec2 uv) { return texture2D(uFrame, uv).g * 255.0; }`;
    case 'blue':
      return `float ch_blue(vec2 uv) { return texture2D(uFrame, uv).b * 255.0; }`;
    case 'hue':
      // Degrees around the wheel. Grey pixels have no hue; the field says so
      // by sitting at 0, and a hue lens is meant to be paired with strength.
      return `float ch_hue(vec2 uv) { return rgb2hsv(texture2D(uFrame, uv).rgb).x * 360.0; }`;
    case 'saturation':
      return `float ch_saturation(vec2 uv) { return rgb2hsv(texture2D(uFrame, uv).rgb).y * 255.0; }`;
    case 'chromaEdge':
      // Sobel is a subtraction, and hue is a circle, so the differences are
      // taken the short way round. A grey pixel has no hue, so a "hue edge"
      // across grey is not an edge at all — the strength gates it.
      return `float hueGap(float a, float b) {
  float d = abs(a - b);
  return min(d, 1.0 - d) * 2.0;
}
float ch_chromaEdge(vec2 uv) {
  vec3 here = rgb2hsv(texture2D(uFrame, uv).rgb);
  float acc = hueGap(here.x, rgb2hsv(texture2D(uFrame, uv + uTexel * vec2(1.0, 0.0)).rgb).x)
    + hueGap(here.x, rgb2hsv(texture2D(uFrame, uv - uTexel * vec2(1.0, 0.0)).rgb).x)
    + hueGap(here.x, rgb2hsv(texture2D(uFrame, uv + uTexel * vec2(0.0, 1.0)).rgb).x)
    + hueGap(here.x, rgb2hsv(texture2D(uFrame, uv - uTexel * vec2(0.0, 1.0)).rgb).x);
  float colourful = smoothstep(0.10, 0.25, here.y);
  return clamp(acc * 0.5 * colourful, 0.0, 1.0) * 255.0;
}`;
    case 'rarity':
      // One minus the share of the frame that carries this hue. A grey pixel
      // has no hue to be rare in, so it is reported as ordinary rather than
      // as the rarest thing in the picture.
      return `float ch_rarity(vec2 uv) {
  vec3 hsv = rgb2hsv(texture2D(uFrame, uv).rgb);
  float share = texture2D(uHistogram, vec2(hsv.x, 0.5)).r;
  float colourful = smoothstep(0.10, 0.25, hsv.y);
  return (1.0 - share) * colourful * 255.0;
}`;
    case 'backgroundDistance':
      return `float ch_backgroundDistance(vec2 uv) {
  return colourGap(rgb2hsv(texture2D(uFrame, uv).rgb), uDominant) * 255.0;
}`;
    case 'colourDistance':
      // Distance from the reference in hue, strength and brightness together.
      // The hue term is weighted by how colourful BOTH colours are, because
      // the hue of a grey pixel is arithmetic, not a measurement. The weights
      // are display tuning, stated as such.
      return `float ch_colourDistance(vec2 uv) {
  return colourGap(rgb2hsv(texture2D(uFrame, uv).rgb), REF_HSV) * 255.0;
}`;
    case 'relief':
      // Contrast-stretched shading with an edge term, matching the legacy
      // reliefField exactly (215 of stretch + 40 of edge) so a lens written
      // in V1 paints the same field here. Bright reads as near because that
      // is how a lit surface usually behaves — it is NOT a distance, and no
      // depth sensor is available to a web page.
      return `float ch_relief(vec2 uv) {
  float y = luma(texture2D(uFrame, uv).rgb);
  float span = max(0.004, uLumaRange.y - uLumaRange.x);
  float stretched = clamp((y - uLumaRange.x) / span, 0.0, 1.0);
  return clamp(stretched * 215.0 + (ch_edges(uv) / 255.0) * 40.0, 0.0, 255.0);
}`;
    case 'age':
      // Seconds since this pixel last moved; the state holds it as a fraction
      // of the six-second window (see AGE_STATE).
      return `float ch_age(vec2 uv) { return texture2D(uState, uv).r * 6.0; }`;
    case 'novelty':
      // How far this pixel departs from the background the state pass has
      // learned. A thing that has just arrived reads high; the wall it is
      // standing against reads nothing, however bright the wall is.
      return `float ch_novelty(vec2 uv) {
  float now = luma(texture2D(uFrame, uv).rgb);
  float background = luma(texture2D(uState, uv).rgb);
  return abs(now - background) * 255.0;
}`;
    case 'speed':
      // The Speed state holds normal flow / 8 (texels per frame at analysis
      // size); widths per second = texels/frame × fps / analysis width.
      return `float ch_speed(vec2 uv) {
  return texture2D(uState, uv).r * 8.0 * uFps / max(uAnalysisWidth, 1.0);
}`;
    default:
      return `float ch_${id}(vec2 uv) { return 0.0; }`;
  }
}

/**
 * How far apart two colours are, 0..1, in hue, strength and brightness
 * together. The hue term is weighted by how colourful BOTH colours are,
 * because the hue of a grey pixel is arithmetic rather than a measurement.
 * The weights are display tuning and are stated as such.
 */
const COLOUR_GAP = COLOUR_GAP_GLSL;

/**
 * REGION FILL — the body of a shape, in seventeen taps.
 *
 * Joshua, 2026-09-08, against Smalland's antenna mode: "EDGE THICKENING =
 * bright border becomes fat. OBJECT FILL = the entire visible object body
 * gains a luminous value. I want the second."
 *
 * The method is two rings of eight samples. Sampling a ring gives the mean
 * for free and the VARIANCE for free with it — the same eight taps — which is
 * why this costs about what Wash costs rather than what a blur pyramid would.
 *
 *   body      how far the patch's own level stands from the ROOM's level
 *   texture   the fine ring's variance: grain, and grain is not a shape
 *
 * IT IS NOT A DILATED EDGE. A dilation spreads the edge MAP, so a thin line
 * becomes a thick line and the middle of a shape stays as empty as it was.
 * Nothing here ever looks at the edge map: each pixel is asked about the
 * picture, so the middle of a slab answers on its own account.
 *
 * WHY THIS PASS AND NOT THE STATE PASS. The state pass runs at analysis
 * resolution and would be about nine times cheaper. It is also SKIPPED for
 * stills — capture/photo.ts renders with no stateSize — so a fill computed
 * there would be missing from every photograph while showing in the
 * viewfinder that framed it. One shader for preview, photo and clip (Rule 4)
 * is worth the taps.
 *
 * The radii are FRAME-RELATIVE for the same reason Ink's hatch and Cel's ink
 * threshold are: the same shader draws a 1170-wide preview and a 3024-wide
 * still, and a radius in texels would gather a quarter as much of the picture
 * in the photograph. A shape must not stop being a shape because it was drawn
 * bigger.
 */
const FILL_REFERENCE = 900;

/**
 * MEASURED, NOT CHOSEN. Fine-scale standard deviation over the ring, read off
 * a built room scene (tests/lens-fill.test.mjs renders the same one):
 *
 *   flat painted slab   0.000       lamp shade   0.012
 *   popcorn ceiling     0.068
 *
 * The rejection band spans that gap, with its low end lifted clear of the
 * sensor noise a dim room actually carries rather than sitting at the
 * synthetic zero.
 */
const ROUGH_LO = 0.022;
const ROUGH_HI = 0.070;

function fillGlsl(fill: NonNullable<CustomLens['fill']>): string {
  // Fine ←→ Broad: how much detail is smoothed away before a patch is asked
  // what level it sits at. Small shapes survive a fine setting; a broad one
  // reads the picture in slabs.
  const broad = 3 + 15 * Math.min(1, Math.max(0, fill.scale));
  // The texture ring stays SMALL whatever the detail setting. It has one job
  // — is this grain? — and grain is only grain at the scale of grain; asked
  // at a broad radius it reports every object boundary as texture and cuts a
  // dark halo just inside every outline.
  const fine = 4.3;
  // Eager ← sensitivity → strict, in distance from the room's own level.
  // Measured on the built scene (background 0.070): flat wall 0.007, door
  // 0.044, picture frame 0.110, lamp 0.573. The band has to clear the wall
  // and admit the door, and those two are a factor of six apart — that
  // margin is the whole of what this control spends.
  const bodyLo = 0.060 - 0.052 * Math.min(1, Math.max(0, fill.sensitivity));
  return `const float FILL_REFERENCE = ${glslFloat(FILL_REFERENCE)};
const float FILL_BROAD = ${glslFloat(broad)};
const float FILL_FINE = ${glslFloat(fine)};
const float FILL_BODY_LO = ${glslFloat(bodyLo)};
const float FILL_BODY_HI = ${glslFloat(bodyLo * 2.4)};
const float FILL_ROUGH_LO = ${glslFloat(ROUGH_LO)};
const float FILL_ROUGH_HI = ${glslFloat(ROUGH_HI)};
const float FILL_REJECT = ${glslFloat(fill.textureReject)};
const float FILL_STRENGTH = ${glslFloat(fill.strength)};

// Mean and variance of luma on a ring of eight. The variance is half the
// method and it costs nothing beyond the taps the mean already needs.
vec2 ringStats(vec2 uv, vec2 r) {
  float s = 0.0;
  float q = 0.0;
  float y;
  y = luma(texture2D(uFrame, uv + vec2( r.x, 0.0)).rgb); s += y; q += y * y;
  y = luma(texture2D(uFrame, uv + vec2(-r.x, 0.0)).rgb); s += y; q += y * y;
  y = luma(texture2D(uFrame, uv + vec2(0.0,  r.y)).rgb); s += y; q += y * y;
  y = luma(texture2D(uFrame, uv + vec2(0.0, -r.y)).rgb); s += y; q += y * y;
  vec2 d = r * 0.70710678;
  y = luma(texture2D(uFrame, uv + vec2( d.x,  d.y)).rgb); s += y; q += y * y;
  y = luma(texture2D(uFrame, uv + vec2( d.x, -d.y)).rgb); s += y; q += y * y;
  y = luma(texture2D(uFrame, uv + vec2(-d.x,  d.y)).rgb); s += y; q += y * y;
  y = luma(texture2D(uFrame, uv + vec2(-d.x, -d.y)).rgb); s += y; q += y * y;
  float mean = s * 0.125;
  return vec2(mean, max(q * 0.125 - mean * mean, 0.0));
}

float regionFill(vec2 uv) {
  vec2 unit = frameStep(FILL_REFERENCE);
  vec2 fine = ringStats(uv, unit * FILL_FINE);
  vec2 wide = ringStats(uv, unit * FILL_BROAD);

  /*
   * THE BODY: how far this patch's level stands from the ROOM's level.
   *
   * This is the line between a fill and a fat outline, and it took three
   * tries to find. Each of the first two was rejected by measurement on a
   * built scene, not by taste:
   *
   * 1. Broad-ring VARIANCE — "is there a boundary near me". True in a band
   *    around every outline and false in the middle of everything: a soft
   *    dilation wearing another name. It left a door and a picture frame at
   *    exactly 0.00.
   * 2. Broad-ring MEAN — "am I different from what surrounds me". Fills the
   *    lamp completely (0.00 → 1.00), but it is a band-pass, so a shape only
   *    fills while it is smaller than the ring: the door stayed at 0.00 while
   *    the empty WALL beside the lamp reached 0.90. Every object grew a halo
   *    and the background glowed as brightly as the objects did.
   * 3. This. Distance from the frame's prevailing level, which the middle of
   *    a slab answers as loudly as its rim, at any size — and which the
   *    background answers with zero by construction, because the background
   *    is what set that level.
   */
  float body = smoothstep(FILL_BODY_LO, FILL_BODY_HI, abs(wide.x - uBackground));

  // And is not simply rough at the scale of its own grain. Without this the
  // popcorn ceiling floods: measured, it goes from 0.31 to 1.00.
  float coherent = 1.0 - FILL_REJECT * smoothstep(FILL_ROUGH_LO, FILL_ROUGH_HI, sqrt(fine.y));
  return clamp(body * coherent, 0.0, 1.0) * FILL_STRENGTH;
}`;
}

function normaliseGlsl(name: string, binding: LensBinding): string {
  const gamma = binding.gamma > 0 ? binding.gamma : 1;
  return `float ${name}(float raw) {
  float low = ${glslFloat(binding.low)};
  float high = ${glslFloat(binding.high)};
  float span = high - low;
  if (abs(span) < 1e-6) return raw >= high ? 1.0 : 0.0;
  float t = clamp((raw - low) / span, 0.0, 1.0);
  return ${gamma === 1 ? 't' : `pow(t, ${glslFloat(gamma)})`};
}`;
}

/** The ramp as RGBA texels — the legacy LUT (RGB) with alpha added. */
export function lensRampRgba(lens: CustomLens): Uint8Array {
  const rgb = buildRampLut(lens.stops);
  const rgba = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/**
 * Compile a lens into a filter definition. Pure: the same lens always yields
 * the same shader text, ramp and metadata.
 */
/**
 * Two stateful channels in one lens is the one combination that cannot work.
 *
 * There is exactly ONE state texture per render, so a lens binding (say)
 * speed to colour and age to brightness would hand the second channel the
 * first one's memory and paint a confident wrong answer. Refusing is the only
 * honest option, and the reason says which two clashed.
 */
/** Channels other bodies call must be emitted first; edges is the only one. */
function channelRank(id: ChannelId): number {
  return id === 'edges' ? 0 : 1;
}

function twoStatefulChannels(lens: CustomLens): string {
  const used = [lens.color.channel, ...(lens.brightness ? [lens.brightness.channel] : [])]
    .filter((c) => STATEFUL_CHANNELS.includes(c));
  const distinct = [...new Set(used)];
  if (distinct.length < 2) return '';
  return `A lens can use only one of ${STATEFUL_CHANNELS.join(', ')} at a time — `
    + `this one asks for ${distinct.join(' and ')}, and they would share one memory.`;
}

export function compileLens(lens: CustomLens): FilterDefinition {
  const id = lensFilterId(lens);
  const revision = lensRevision(lens);
  const colour = channelAvailability(lens.color.channel);
  const bright = lens.brightness ? channelAvailability(lens.brightness.channel) : { available: true, reason: '' };
  const twoStates = twoStatefulChannels(lens);
  const unavailableReason = !colour.available ? colour.reason
    : !bright.available ? bright.reason : twoStates;
  if (unavailableReason) {
    return {
      id, name: lens.name, family: 'custom', temporal: false,
      supportsPhoto: false, supportsVideo: false,
      // An unavailable lens never renders anything that could pass for it.
      fragment: SHADER_HEADER + `void main() { gl_FragColor = vec4(texture2D(uFrame, vUv).rgb, 1.0); }`,
      lens, revision, unavailableReason
    };
  }

  const channels = new Set<ChannelId>([lens.color.channel]);
  if (lens.brightness) channels.add(lens.brightness.channel);
  // Relief is shading PLUS an edge term, so it needs the edges body emitted
  // alongside it — one definition of the Sobel, not a second copy inside
  // relief's own function (Rule 6).
  if (channels.has('relief')) channels.add('edges');
  const temporal = [...channels].some((c) => channelInfo(c).temporal);
  const stateful = [...channels].filter((c) => STATEFUL_CHANNELS.includes(c));
  // The fill measures every patch against the frame's prevailing level,
  // which rides on the same census the luma range does — so asking for one
  // asks for both, and a still rendered without it would fill against a
  // background of zero and light the whole picture.
  const needsLumaRange = channels.has('relief') || Boolean(lens.fill);
  const output = lens.output ?? 'paint';
  const needsGap = [...channels].some((c) => c === 'colourDistance' || c === 'backgroundDistance');
  const needsHsv = needsGap || output === 'swap'
    || [...channels].some((c) => c === 'hue' || c === 'saturation' || c === 'rarity'
      || c === 'chromaEdge');
  const needsReference = [...channels].some((c) => channelInfo(c).needsReference);
  const needsHistogram = [...channels].some((c) => channelInfo(c).needsHistogram);
  const reference = rgbToHsv(lens.reference ?? '#ffffff');
  const target = rgbToHsv(lens.target ?? '#ffffff');
  const base = lens.base === 'scene'
    ? 'vec3(sceneY)'
    : lens.base === 'grey' ? 'vec3(28.0 / 255.0)' : 'vec3(0.0)';
  const blend = Math.min(1, Math.max(0, lens.sceneBlend));
  /*
   * FILL IS A PAINT-MODE EFFECT. `mask` keeps the camera's own colours and
   * `swap` recolours matched pixels; in both, the picture on screen is the
   * scene rather than the ramp, and lifting a region toward a ramp colour
   * there would be a third thing the lens does rather than the same thing
   * done to a body. Ignored rather than refused: a lens is still a lens.
   */
  const fill = output === 'paint' ? lens.fill : undefined;
  // The second field DIMS to this and no further. At 0 (the default) it still
  // multiplies straight to black, which is what every lens written before the
  // floor existed meant; above 0 the colour field survives a second field
  // that reads nothing. See CustomLens.brightnessFloor for why.
  const floor = Math.min(1, Math.max(0, lens.brightnessFloor ?? 0));

  // The three outputs, each one line. `t` is the lens's own normalised
  // reading, so the range direction (low above high inverts it) is what
  // turns Isolate into Hide — one mode, not two features.
  const paint = {
    paint: 'vec3 c = texture2D(uRamp, vec2(t, 0.5)).rgb;',
    mask: '  // Keep the camera\'s colour where it reads high; grey elsewhere.\n'
      + '  vec3 c = mix(vec3(sceneY), scene, t);',
    swap: '  // The target\'s hue and strength, each pixel\'s own brightness.\n'
      + '  vec3 c = mix(scene, hsv2rgb(vec3(TARGET_HSV.x, TARGET_HSV.y, rgb2hsv(scene).z)), t);'
  }[output];

  const fragment = SHADER_HEADER
    + (channels.has('speed') ? 'uniform float uFps;\nuniform float uAnalysisWidth;\n' : '')
    + (needsHsv ? `vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
` : '')
    + (output === 'swap' ? `vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
` : '')
    + (needsGap ? `${COLOUR_GAP}\n` : '')
    + (needsReference ? `const vec3 REF_HSV = vec3(${reference.map(glslFloat).join(', ')});\n` : '')
    + (output === 'swap' ? `const vec3 TARGET_HSV = vec3(${target.map(glslFloat).join(', ')});\n` : '')
    // DEPENDENCY ORDER, not set order. GLSL wants a function declared before
    // it is called, and relief calls ch_edges — emitted in insertion order,
    // relief came first and would not compile.
    + [...channels].sort((a, b) => channelRank(a) - channelRank(b))
      .map(channelGlsl).join('\n') + '\n'
    + (fill ? fillGlsl(fill) + '\n' : '')
    + normaliseGlsl('normColour', lens.color) + '\n'
    + (lens.brightness ? normaliseGlsl('normBright', lens.brightness) + '\n' : '')
    + `void main() {
  vec3 scene = texture2D(uFrame, vUv).rgb;
  float sceneY = luma(scene);
  vec3 base = ${base};
  float raw = ch_${lens.color.channel}(vUv);
${lens.color.channel === 'speed' ? `  if (raw <= 0.0) { gl_FragColor = vec4(withAids(base, vUv), 1.0); return; }\n` : ''}\
  float t = normColour(raw);
  ${paint}
${lens.brightness ? `  c *= mix(${glslFloat(floor)}, 1.0, normBright(ch_${lens.brightness.channel}(vUv)));\n` : ''}\
${fill ? `  // THE BODY, UNDER THE EDGE. A per-channel max rather than a blend, so a
  // lit edge keeps every bit of its brightness and only the dark interior is
  // raised — outline at full, body at the fill's own strength, background
  // still black. The ramp is read at the same t the edge was painted from, so
  // a bright shape fills brighter and the palette stays one palette.
  c = max(c, texture2D(uRamp, vec2(t, 0.5)).rgb * regionFill(vUv));\n` : ''}\
${blend > 0 ? `  c = mix(c, vec3(sceneY), ${glslFloat(blend)});\n` : ''}\
  gl_FragColor = vec4(withAids(c, vUv), 1.0);
}`;

  return {
    id,
    name: lens.name,
    family: 'custom',
    temporal,
    // EVERY lens that renders can save a still, at the full sensor like any
    // other filter. A temporal field's memory lives at ANALYSIS resolution,
    // so its photo enlarges that rather than adding detail — but refusing the
    // shutter was the worse answer (Joshua, 2026-09-02).
    supportsPhoto: true,
    supportsVideo: true,
    fragment,
    state: stateful[0] === 'speed' ? SPEED_STATE
      : stateful[0] === 'age' ? AGE_STATE
        : stateful[0] === 'novelty' ? NOVELTY_STATE : undefined,
    ramp: lensRampRgba(lens),
    rampKey: JSON.stringify(lens.stops),
    lens,
    revision,
    needsHistogram,
    needsLumaRange,
    note: lens.note
  };
}
