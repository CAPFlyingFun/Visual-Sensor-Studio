/**
 * SMOOTHING — how much sensor noise is averaged away before a filter looks
 * at the picture. One registry (Rule 5), one owner (Rule 1).
 *
 * Why this exists, measured on Joshua's device (2026-09-02). In a dim room
 * every pixel's colour jitters frame to frame. That jitter is small in RGB
 * and enormous in HUE: a near-grey pixel's hue is decided by which channel
 * happened to land a count higher, so it walks the whole colour wheel. Every
 * field built on hue therefore reads noise as signal — Colour Edges drew a
 * boundary at every grain of it, and Camouflage Breaker called half the room
 * an unusual colour. Both were measuring exactly what they were given.
 *
 * The radius is in TEXELS OF THE RENDER TARGET, not of the sensor, and that
 * is deliberate: sensor noise is per-pixel wherever it lands, so a smoothing
 * expressed in output pixels stays the same strength in the viewfinder and in
 * a full-size still, while one expressed as a fraction of the frame would be
 * four times wider in a photo than in the preview it was chosen from.
 *
 * THE RADII ARE HALF-INTEGERS, AND THAT IS THE WHOLE TRICK. The shader takes
 * four taps, and each one is cheap only because the GPU's own bilinear filter
 * averages the texels it falls between. A tap at a WHOLE number of texels
 * lands exactly on a texel centre and averages nothing — four taps then read
 * four single pixels. Measured on the shipped shader against pure noise
 * (sd 35.1 raw):
 *
 *     radius   0    0.5   0.75    1    1.25   1.5     2      3
 *     noise sd 35.1 13.4  12.4  17.8  11.3   9.1   17.4   17.7
 *     edge px   0    2     2     2     4      4      4      6
 *
 * The spikes at 1, 2 and 3 are that failure, and the first ladder written
 * here picked exactly those three values. 0.5 puts the four taps on a
 * contiguous 3x3; 1.5 puts them on four disjoint 2x2 blocks spanning 5x5.
 *
 * There is no level above that, on purpose. Four bilinear taps can average at
 * most sixteen pixels, and by 1.5 they already do — a wider radius spreads
 * the SAME sixteen samples further apart, which smears detail without
 * removing any more noise (radius 3 measures no better than radius 1). A
 * stronger level would need more taps, which means compiling the tap count
 * into the shader rather than passing it as a uniform.
 */

export interface DenoiseLevel {
  id: string;
  /** For the chip. */
  label: string;
  /** Half-width of the sampled neighbourhood, in render-target texels. */
  radius: number;
  /** What it does to the picture, in the one sentence under the row. */
  note: string;
}

export const DENOISE_LEVELS: readonly DenoiseLevel[] = [
  {
    id: 'off',
    label: 'Off',
    radius: 0,
    note: 'Every pixel exactly as the sensor reported it — including its noise.'
  },
  {
    id: 'low',
    label: 'Low',
    radius: 0.5,
    note: 'Averages a contiguous 3×3. Sensor grain stops reading as detail '
      + 'and fine texture survives; measured, it cuts the noise by about '
      + 'three fifths and widens a hard edge by two pixels.'
  },
  {
    id: 'medium',
    label: 'Medium',
    radius: 1.5,
    note: 'Averages sixteen pixels across a 5×5 area. For a dim room, where '
      + 'hue is mostly noise and the colour fields have nothing steady to '
      + 'measure; about three quarters of the noise goes, and so does some '
      + 'real detail.'
  }
];

/**
 * OFF by default (Joshua, 2026-09-02: "keep it off by default as only certain
 * filters show it — most don't show a lot of noise").
 *
 * He is right, and the reason is worth keeping: noise is amplified by what a
 * filter DOES with it, not by how much of it there is. Brightness is an
 * average over three channels and barely moves; HUE is an argument between
 * them, so at low colour strength it swings the whole wheel on a count or
 * two of sensor noise. The hue-derived fields — Colour Edges, Camouflage
 * Breaker, Rare Colour, Rarity Map — are the ones that need this row.
 * Everything else pays a real cost (four taps per sample) for a difference
 * nobody asked to see, and a raw reading is the honest default anyway.
 */
export const DEFAULT_DENOISE = 'off';

export function denoiseById(id: string): DenoiseLevel | undefined {
  return DENOISE_LEVELS.find((level) => level.id === id);
}

/** The radius the renderer hands the shader; an unknown id smooths nothing. */
export function denoiseRadius(id: string): number {
  return denoiseById(id)?.radius ?? 0;
}
