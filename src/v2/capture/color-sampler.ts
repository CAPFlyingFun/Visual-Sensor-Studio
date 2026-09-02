/**
 * The colour sampler — read the real colour of a place in the scene.
 *
 * Milestone E, part two (the spec's "Custom Lens and Color Picker service").
 * A tap on the viewfinder becomes a reading from the CAMERA FRAME, not from
 * the filtered render: with Ironbow or a custom lens running, the pixel on
 * screen is a false colour chosen by a ramp, and reporting that as "the
 * colour" would be reporting the palette back to the person who picked it.
 * The picker therefore samples the source frame and says so.
 *
 * Everything here is pure geometry and arithmetic: box in, source point out.
 * The DOM work (drawing the patch, reading it back) lives in the shell.
 *
 * THE COVER CROP IS REAL. The viewfinder shows the stream with
 * `object-fit: cover`, so the picture is scaled up until it fills the box and
 * the overflow is cropped away. A tap therefore does NOT land where a naive
 * width-ratio would put it — off by the cropped margin, which on a portrait
 * phone showing a portrait stream is most of the frame's height. This module
 * exists so that mapping has one owner and a test.
 */

export interface Box {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface PatchRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SampledColor {
  r: number;
  g: number;
  b: number;
  /** Rec. 709 luminance of the sample, 0–255 — the same luma the shaders use. */
  luma: number;
}

/** The `object-fit: cover` scale: fill the box, crop the overflow. */
export function coverScale(box: Box, source: Box): number {
  if (source.width <= 0 || source.height <= 0) return 1;
  return Math.max(box.width / source.width, box.height / source.height);
}

/**
 * Where a tap inside the viewfinder lands in the SOURCE frame's pixels.
 * Null when the box or the source is degenerate — never a guessed point.
 */
export function tapToSource(tap: Point, box: Box, source: Box): Point | null {
  if (box.width <= 0 || box.height <= 0 || source.width <= 0 || source.height <= 0) return null;
  const scale = coverScale(box, source);
  // The displayed picture is centred, so the cropped margin is half the
  // overflow on each side.
  const offsetX = (box.width - source.width * scale) / 2;
  const offsetY = (box.height - source.height * scale) / 2;
  const x = (tap.x - offsetX) / scale;
  const y = (tap.y - offsetY) / scale;
  return {
    x: Math.min(source.width - 1, Math.max(0, x)),
    y: Math.min(source.height - 1, Math.max(0, y))
  };
}

/**
 * A square of source pixels around a point, clamped inside the frame. The
 * patch is what makes a reading steady: one pixel of a live camera frame is
 * mostly sensor noise, and an average over a small neighbourhood is the
 * colour a person means when they point at something.
 */
export function patchRect(center: Point, source: Box, size: number): PatchRect {
  const side = Math.max(1, Math.min(Math.round(size), Math.floor(Math.min(source.width, source.height))));
  const half = (side - 1) / 2;
  const x = Math.min(source.width - side, Math.max(0, Math.round(center.x - half)));
  const y = Math.min(source.height - side, Math.max(0, Math.round(center.y - half)));
  return { x, y, width: side, height: side };
}

/** Mean RGB over an RGBA buffer, with the luminance the shaders compute. */
export function averageRgb(data: ArrayLike<number>): SampledColor {
  const pixels = Math.floor(data.length / 4);
  if (pixels <= 0) return { r: 0, g: 0, b: 0, luma: 0 };
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < pixels; i++) {
    r += data[i * 4];
    g += data[i * 4 + 1];
    b += data[i * 4 + 2];
  }
  r = Math.round(r / pixels);
  g = Math.round(g / pixels);
  b = Math.round(b / pixels);
  return { r, g, b, luma: Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b) };
}
