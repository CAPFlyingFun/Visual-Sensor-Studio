/**
 * Custom lenses — a false-colour mapping the user can design, save and share.
 *
 * Every built-in mode in this app is a hard-coded pairing of one measured
 * field with one palette: Ironbow is speed through a thermography ramp, relief
 * is shading through grey, trails are speed through hue and age through
 * brightness. A custom lens is the same idea with the pairing pulled out into
 * DATA — pick the field, pick the colours, pick what modulates the brightness.
 *
 * A lens is therefore a small JSON document, not code. That is what makes it
 * savable, exportable, and safe to load from someone else: nothing in a lens
 * can execute, and everything in one is validated and clamped on the way in.
 *
 * WHAT A LENS IS NOT. It cannot invent a measurement. The channel list below
 * is exactly the set of per-pixel fields this app actually computes, and a
 * lens can only recolour those. In particular there is no distance channel —
 * see `CHANNELS` for why.
 */

import { clamp } from '../core/math.js';

/* ------------------------------------------------------------------ *
 * Channels — the measured fields a lens may colour
 * ------------------------------------------------------------------ */

export type ChannelId =
  | 'luma'
  | 'speed'
  | 'change'
  | 'edges'
  | 'relief'
  | 'age'
  | 'novelty';

export interface ChannelInfo {
  id: ChannelId;
  /** Short name for a control. */
  label: string;
  /** What the number physically is. Shown in the editor; keep it honest. */
  meaning: string;
  /** Unit of the raw value, for the range controls. */
  unit: string;
  /** Sensible default low/high for a fresh binding, in raw units. */
  low: number;
  high: number;
  /** True when the field needs a previous frame, so it is blank when still. */
  temporal: boolean;
}

/**
 * The fields a lens can read.
 *
 * DEPTH IS ABSENT, DELIBERATELY. A browser on iOS gets camera frames and
 * nothing else — there is no depth buffer, no disparity map and no LiDAR
 * access from a web page, whatever the hardware behind the glass can do. The
 * closest honest thing here is `relief`, which is a SHADING estimate: it reads
 * bright-to-dark falloff as if it were a surface, which looks three
 * dimensional and is not a distance. Naming it depth would make every lens
 * built on it a lie, so it is named after what it measures.
 */
export const CHANNELS: readonly ChannelInfo[] = [
  {
    id: 'luma',
    label: 'Brightness',
    meaning: 'Scene luminance at each pixel.',
    unit: '0–255',
    low: 0,
    high: 255,
    temporal: false
  },
  {
    id: 'speed',
    label: 'Image speed',
    meaning: 'How fast the picture is moving at each pixel, in frame widths per second. Not the object’s real speed.',
    unit: 'widths/s',
    low: 0,
    high: 0.35,
    temporal: true
  },
  {
    id: 'change',
    label: 'Change',
    meaning: 'How much this pixel differs from the previous frame.',
    unit: '0–255',
    low: 0,
    high: 40,
    temporal: true
  },
  {
    id: 'edges',
    label: 'Edge strength',
    meaning: 'Local contrast — how strongly a boundary runs through this pixel.',
    unit: '0–255',
    low: 0,
    high: 160,
    temporal: false
  },
  {
    id: 'relief',
    label: 'Relief',
    meaning: 'Shading read as a surface. Looks three-dimensional; it is not distance, and there is no depth sensor available to a web page.',
    unit: '0–255',
    low: 0,
    high: 255,
    temporal: false
  },
  {
    id: 'age',
    label: 'Time since motion',
    meaning: 'Seconds since this pixel last moved, within the trail window.',
    unit: 'seconds',
    low: 0,
    high: 6,
    temporal: true
  },
  {
    id: 'novelty',
    label: 'Not normally here',
    meaning: 'How far this pixel departs from the learned background.',
    unit: '0–255',
    low: 0,
    high: 60,
    temporal: true
  }
];

const CHANNEL_BY_ID = new Map<ChannelId, ChannelInfo>(CHANNELS.map((c) => [c.id, c]));

export function channelInfo(id: ChannelId): ChannelInfo {
  return CHANNEL_BY_ID.get(id) ?? CHANNELS[0];
}

/* ------------------------------------------------------------------ *
 * The lens document
 * ------------------------------------------------------------------ */

export interface LensStop {
  /** Position along the ramp, 0..1. */
  at: number;
  /** '#rrggbb'. */
  color: string;
}

export interface LensBinding {
  channel: ChannelId;
  /** Raw value mapped to the low end of the ramp. */
  low: number;
  /** Raw value mapped to the high end. May be below `low` to invert. */
  high: number;
  /** Shaping exponent applied after normalisation. 1 is linear. */
  gamma: number;
}

/** What shows through where the lens paints nothing. */
export type LensBase = 'black' | 'grey' | 'scene';

export interface CustomLens {
  /** Document format, so an old export can be recognised rather than guessed. */
  version: 1;
  id: string;
  name: string;
  /** Optional note from whoever made it. */
  note?: string;
  /** The field that picks the colour, and the ramp it picks from. */
  color: LensBinding;
  stops: LensStop[];
  /** Optional second field that modulates brightness. */
  brightness?: LensBinding;
  base: LensBase;
  /** How much of the camera picture shows under the colour, 0..1. */
  sceneBlend: number;
}

export const MAX_STOPS = 8;
export const MIN_STOPS = 2;

/* ------------------------------------------------------------------ *
 * Colour
 * ------------------------------------------------------------------ */

export function parseHex(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return [0, 0, 0];
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex(rgb: [number, number, number]): string {
  const part = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`;
}

/**
 * Build a 256-entry lookup table for a ramp.
 *
 * Interpolation is straight sRGB, which is exactly what a CSS
 * `linear-gradient` does. That is not an accident and not a shortcut: the
 * editor draws its preview swatch with a CSS gradient built from the same
 * stops, so matching CSS is what makes the swatch tell the truth about the
 * picture. A perceptually-even space would look smoother and would no longer
 * be the thing on screen.
 */
export function buildRampLut(stops: readonly LensStop[]): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3);
  const sorted = [...stops]
    .map((s) => ({ at: clamp(s.at, 0, 1), rgb: parseHex(s.color) }))
    .sort((a, b) => a.at - b.at);
  if (!sorted.length) return lut;
  if (sorted.length === 1) {
    for (let i = 0; i < 256; i++) {
      lut[i * 3] = sorted[0].rgb[0];
      lut[i * 3 + 1] = sorted[0].rgb[1];
      lut[i * 3 + 2] = sorted[0].rgb[2];
    }
    return lut;
  }
  let segment = 0;
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    while (segment < sorted.length - 2 && t > sorted[segment + 1].at) segment++;
    const a = sorted[segment];
    const b = sorted[segment + 1];
    const span = b.at - a.at;
    // Coincident stops make a hard edge rather than a divide by zero.
    const f = span <= 1e-6 ? (t < a.at ? 0 : 1) : clamp((t - a.at) / span, 0, 1);
    lut[i * 3] = a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f;
    lut[i * 3 + 1] = a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f;
    lut[i * 3 + 2] = a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f;
  }
  return lut;
}

/** The same ramp as a CSS gradient, for the editor swatch. */
export function rampToCss(stops: readonly LensStop[]): string {
  const sorted = [...stops].sort((a, b) => a.at - b.at);
  if (!sorted.length) return '#000';
  if (sorted.length === 1) return sorted[0].color;
  const parts = sorted.map((s) => `${s.color} ${(clamp(s.at, 0, 1) * 100).toFixed(1)}%`);
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/**
 * One channel's data for a frame.
 *
 * `valid` is the part that keeps a lens honest. A speed field cannot resolve
 * every pixel — a moving edge seen along its own length genuinely has no
 * measurable speed — and painting those a colour would invent a reading. Where
 * `valid` is 0 the lens paints the base instead, so unmeasured stays visibly
 * unmeasured no matter what palette someone chooses.
 */
export interface ChannelData {
  values: ArrayLike<number>;
  valid?: ArrayLike<number> | null;
}

export type ChannelSource = Partial<Record<ChannelId, ChannelData>>;

function normalise(raw: number, binding: LensBinding): number {
  const span = binding.high - binding.low;
  if (Math.abs(span) < 1e-9) return raw >= binding.high ? 1 : 0;
  const t = clamp((raw - binding.low) / span, 0, 1);
  const g = binding.gamma > 0 ? binding.gamma : 1;
  return g === 1 ? t : Math.pow(t, g);
}

export interface LensRenderReport {
  /** Fraction of pixels the colour channel actually resolved, 0..1. */
  coverage: number;
  /** Mean normalised position along the ramp over the resolved pixels. */
  meanLevel: number;
}

/**
 * Paint one frame through a lens.
 *
 * `gray` is the camera picture, used for the base when the lens lets the scene
 * show through. Missing channels render as the base rather than as zero, so a
 * lens bound to a field the current frame has not produced looks empty instead
 * of looking like a confident reading of nothing.
 */
/**
 * Enlarge a channel to a target geometry for a full-resolution still.
 *
 * Some fields can be recomputed at full size from the frame itself — luma,
 * edges, relief, and a frame difference when two full frames were captured.
 * The temporal estimates cannot: speed, age and novelty are accumulated on
 * the analysis frame across time, and there is no full-resolution history to
 * re-derive them from. Enlarging is the honest option for those, and bilinear
 * enlarging is a far better one than repeating pixels — the measurement stays
 * an analysis-resolution measurement either way, but the picture stops being
 * a grid of blocks.
 *
 * THE VALID MASK IS ENLARGED CONSERVATIVELY. A target pixel counts as
 * measured only when every source sample feeding it was measured; otherwise
 * interpolating across the boundary between measured and unmeasured would
 * invent a reading in a place that never had one.
 */
export function upscaleChannel(
  channel: ChannelData,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number
): ChannelData {
  const values = new Float32Array(targetWidth * targetHeight);
  const valid = channel.valid ? new Uint8Array(targetWidth * targetHeight) : null;
  if (sourceWidth < 1 || sourceHeight < 1) {
    return { values, valid };
  }

  const scaleX = sourceWidth / targetWidth;
  const scaleY = sourceHeight / targetHeight;

  for (let y = 0; y < targetHeight; y++) {
    // Half-pixel centring, clamped at both ends: an unclamped negative
    // fraction extrapolates past the edge of the data instead of
    // interpolating within it, which puts out-of-range values along every
    // border.
    const sy = clamp((y + 0.5) * scaleY - 0.5, 0, sourceHeight - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(sourceHeight - 1, y0 + 1);
    const fy = sy - y0;

    for (let x = 0; x < targetWidth; x++) {
      const sx = clamp((x + 0.5) * scaleX - 0.5, 0, sourceWidth - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const fx = sx - x0;

      const iA = y0 * sourceWidth + x0;
      const iB = y0 * sourceWidth + x1;
      const iC = y1 * sourceWidth + x0;
      const iD = y1 * sourceWidth + x1;
      const target = y * targetWidth + x;

      const a = channel.values[iA] ?? 0;
      const b = channel.values[iB] ?? 0;
      const c = channel.values[iC] ?? 0;
      const d = channel.values[iD] ?? 0;
      const top = a + (b - a) * fx;
      const bottom = c + (d - c) * fx;
      values[target] = top + (bottom - top) * fy;

      if (valid && channel.valid) {
        const all = (channel.valid[iA] ?? 0) !== 0
          && (channel.valid[iB] ?? 0) !== 0
          && (channel.valid[iC] ?? 0) !== 0
          && (channel.valid[iD] ?? 0) !== 0;
        valid[target] = all ? 1 : 0;
      }
    }
  }

  return { values, valid };
}

export function renderLens(
  lens: CustomLens,
  sources: ChannelSource,
  gray: ArrayLike<number>,
  width: number,
  height: number,
  out: Uint8ClampedArray,
  lut?: Uint8ClampedArray
): LensRenderReport {
  const count = width * height;
  const ramp = lut ?? buildRampLut(lens.stops);
  const colorSource = sources[lens.color.channel];
  const brightnessBinding = lens.brightness;
  const brightnessSource = brightnessBinding ? sources[brightnessBinding.channel] : undefined;
  const blend = clamp(lens.sceneBlend, 0, 1);

  let resolved = 0;
  let levelTotal = 0;

  for (let i = 0; i < count; i++) {
    const scene = gray[i] ?? 0;
    let baseR: number;
    let baseG: number;
    let baseB: number;
    if (lens.base === 'scene') {
      baseR = baseG = baseB = scene;
    } else if (lens.base === 'grey') {
      baseR = baseG = baseB = 28;
    } else {
      baseR = baseG = baseB = 0;
    }

    const ok = colorSource && (!colorSource.valid || (colorSource.valid[i] ?? 0) !== 0);
    if (!ok) {
      // Unmeasured. The base, never a colour.
      out[i * 4] = baseR;
      out[i * 4 + 1] = baseG;
      out[i * 4 + 2] = baseB;
      out[i * 4 + 3] = 255;
      continue;
    }

    const t = normalise(colorSource.values[i] ?? 0, lens.color);
    resolved++;
    levelTotal += t;
    const index = clamp(Math.round(t * 255), 0, 255) * 3;
    let r = ramp[index];
    let g = ramp[index + 1];
    let b = ramp[index + 2];

    if (brightnessBinding && brightnessSource) {
      const validB = !brightnessSource.valid || (brightnessSource.valid[i] ?? 0) !== 0;
      const v = validB ? normalise(brightnessSource.values[i] ?? 0, brightnessBinding) : 0;
      r *= v;
      g *= v;
      b *= v;
    }

    // The scene shows THROUGH the colour rather than replacing it, so a lens
    // never loses the picture it is annotating.
    if (blend > 0 && lens.base !== 'scene') {
      r = r * (1 - blend) + scene * blend;
      g = g * (1 - blend) + scene * blend;
      b = b * (1 - blend) + scene * blend;
    } else if (blend > 0) {
      r = r * (1 - blend) + baseR * blend;
      g = g * (1 - blend) + baseG * blend;
      b = b * (1 - blend) + baseB * blend;
    }

    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  }

  return {
    coverage: count ? resolved / count : 0,
    meanLevel: resolved ? levelTotal / resolved : 0
  };
}
