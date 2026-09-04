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
    lens.brightnessFloor ?? 0
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
  const needsLumaRange = channels.has('relief');
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
