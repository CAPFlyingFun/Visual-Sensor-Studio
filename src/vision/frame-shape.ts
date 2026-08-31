/**
 * The camera frame's shape, derived ONCE.
 *
 * Every quantity here is a fact about the same rectangle, and each was
 * previously recomputed wherever it was needed: the short side in four places,
 * the aspect ratio in three. They agreed only by coincidence — nothing made
 * them agree — and the coincidence had already failed twice.
 *
 * The first failure sized the auto ladder by WIDTH rather than by short side,
 * so a portrait phone rendered 1.78x the pixels of a landscape one at the same
 * named setting. The second is the reason this module exists: two of the three
 * aspect ratios were width/height and the third was long/short, and the
 * long/short one was being handed to a function expecting width/height.
 *
 * ASPECT IS WIDTH DIVIDED BY HEIGHT, and it is BELOW ONE IN PORTRAIT.
 *
 * That convention is not arbitrary — it is the one the display arithmetic
 * already uses (`contentWidth = boxHeight * aspect`), so it is the one that
 * makes those call sites correct. Use `long / short` when what is wanted is
 * the elongation regardless of orientation, and take it from `long` and
 * `short` rather than reconstructing it.
 */
export interface FrameShape {
  width: number;
  height: number;
  /** The smaller of the two sides. Names a resolution tier in either orientation. */
  short: number;
  /** The larger of the two sides. */
  long: number;
  /** WIDTH / HEIGHT. Below 1 in portrait. Zero when the shape is not known yet. */
  aspect: number;
  /** False before the camera has reported a size, so callers can hold rather than guess. */
  valid: boolean;
}

export const UNKNOWN_SHAPE: FrameShape = {
  width: 0, height: 0, short: 0, long: 0, aspect: 0, valid: false
};

export function frameShape(width: number, height: number): FrameShape {
  // A single guard, so no caller has to invent its own fallback. The four
  // sites this replaces had three different ones — `|| width`, a bare
  // `Math.min` that could yield zero, and an early return — which is what a
  // quantity with no owner looks like.
  if (!(width > 0) || !(height > 0)) return UNKNOWN_SHAPE;
  return {
    width,
    height,
    short: Math.min(width, height),
    long: Math.max(width, height),
    aspect: width / height,
    valid: true
  };
}

/** The width that produces this short side, in the frame's own orientation. */
export function widthForShortSide(shape: FrameShape, shortSide: number): number {
  if (!shape.valid) return shortSide;
  return Math.round(shortSide * (shape.width / shape.short));
}

/** Elongation, always at least 1, whichever way the frame is held. */
export function elongation(shape: FrameShape): number {
  return shape.valid ? shape.long / shape.short : 1;
}
