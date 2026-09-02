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
import { SHADER_HEADER, SPEED_STATE, type FilterDefinition } from './registry.js';

/** Channels V2 computes on the GPU, in legacy units. */
export const V2_CHANNELS: readonly ChannelId[] = [
  'luma', 'edges', 'change', 'speed',
  // The colour fields — one pass over the frame, no state, no history.
  'hue', 'saturation', 'red', 'green', 'blue', 'colourDistance',
  // Fed by the frame histogram the shell measures each few frames.
  'rarity', 'backgroundDistance'
];

/** Hue 0..1, saturation 0..1, value 0..1 — the shader's own convention. */
export function rgbToHsv(hex: string): [number, number, number] {
  const [r255, g255, b255] = parseHex(hex);
  const r = r255 / 255;
  const g = g255 / 255;
  const b = b255 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const span = max - min;
  let hue = 0;
  if (span > 0) {
    if (max === r) hue = ((g - b) / span + 6) % 6;
    else if (max === g) hue = (b - r) / span + 2;
    else hue = (r - g) / span + 4;
    hue /= 6;
  }
  return [hue, max > 0 ? span / max : 0, max];
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
    lens.output ?? 'paint', lens.reference ?? '', lens.target ?? ''
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
      return `float ch_edges(vec2 uv) {
  float tl = luma(texture2D(uFrame, uv + uTexel * vec2(-1.0, -1.0)).rgb);
  float  l = luma(texture2D(uFrame, uv + uTexel * vec2(-1.0,  0.0)).rgb);
  float bl = luma(texture2D(uFrame, uv + uTexel * vec2(-1.0,  1.0)).rgb);
  float tr = luma(texture2D(uFrame, uv + uTexel * vec2( 1.0, -1.0)).rgb);
  float  r = luma(texture2D(uFrame, uv + uTexel * vec2( 1.0,  0.0)).rgb);
  float br = luma(texture2D(uFrame, uv + uTexel * vec2( 1.0,  1.0)).rgb);
  float  t = luma(texture2D(uFrame, uv + uTexel * vec2( 0.0, -1.0)).rgb);
  float  b = luma(texture2D(uFrame, uv + uTexel * vec2( 0.0,  1.0)).rgb);
  float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  float gy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
  return clamp(length(vec2(gx, gy)) * 255.0, 0.0, 255.0);
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
const COLOUR_GAP = `float colourGap(vec3 hsv, vec3 ref) {
  float dh = abs(hsv.x - ref.x);
  dh = min(dh, 1.0 - dh) * 2.0;
  float ds = abs(hsv.y - ref.y);
  float dv = abs(hsv.z - ref.z);
  float hueWeight = min(hsv.y, ref.y);
  return clamp(sqrt(dh * dh * hueWeight + ds * ds * 0.5 + dv * dv * 0.35), 0.0, 1.0);
}`;

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
export function compileLens(lens: CustomLens): FilterDefinition {
  const id = lensFilterId(lens);
  const revision = lensRevision(lens);
  const colour = channelAvailability(lens.color.channel);
  const bright = lens.brightness ? channelAvailability(lens.brightness.channel) : { available: true, reason: '' };
  const unavailableReason = !colour.available ? colour.reason : !bright.available ? bright.reason : '';
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
  const temporal = [...channels].some((c) => channelInfo(c).temporal);
  const needsSpeed = channels.has('speed');
  const output = lens.output ?? 'paint';
  const needsGap = [...channels].some((c) => c === 'colourDistance' || c === 'backgroundDistance');
  const needsHsv = needsGap || output === 'swap'
    || [...channels].some((c) => c === 'hue' || c === 'saturation' || c === 'rarity');
  const needsReference = [...channels].some((c) => channelInfo(c).needsReference);
  const needsHistogram = [...channels].some((c) => channelInfo(c).needsHistogram);
  const reference = rgbToHsv(lens.reference ?? '#ffffff');
  const target = rgbToHsv(lens.target ?? '#ffffff');
  const base = lens.base === 'scene'
    ? 'vec3(sceneY)'
    : lens.base === 'grey' ? 'vec3(28.0 / 255.0)' : 'vec3(0.0)';
  const blend = Math.min(1, Math.max(0, lens.sceneBlend));

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
    + (needsSpeed ? 'uniform float uFps;\nuniform float uAnalysisWidth;\n' : '')
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
    + [...channels].map(channelGlsl).join('\n') + '\n'
    + normaliseGlsl('normColour', lens.color) + '\n'
    + (lens.brightness ? normaliseGlsl('normBright', lens.brightness) + '\n' : '')
    + `void main() {
  vec3 scene = texture2D(uFrame, vUv).rgb;
  float sceneY = luma(scene);
  vec3 base = ${base};
  float raw = ch_${lens.color.channel}(vUv);
${lens.color.channel === 'speed' ? `  if (raw <= 0.0) { gl_FragColor = vec4(base, 1.0); return; }\n` : ''}\
  float t = normColour(raw);
  ${paint}
${lens.brightness ? `  c *= normBright(ch_${lens.brightness.channel}(vUv));\n` : ''}\
${blend > 0 ? `  c = mix(c, vec3(sceneY), ${glslFloat(blend)});\n` : ''}\
  gl_FragColor = vec4(c, 1.0);
}`;

  return {
    id,
    name: lens.name,
    family: 'custom',
    temporal,
    // Stills are honest only when every channel is recomputed at full size;
    // change and speed live at ANALYSIS resolution and are declined.
    supportsPhoto: !temporal,
    supportsVideo: true,
    fragment,
    state: needsSpeed ? SPEED_STATE : undefined,
    ramp: lensRampRgba(lens),
    rampKey: JSON.stringify(lens.stops),
    lens,
    revision,
    needsHistogram
  };
}
