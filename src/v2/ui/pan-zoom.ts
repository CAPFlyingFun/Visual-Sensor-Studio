/**
 * PAN AND ZOOM over a picture that is already fitted to its frame.
 *
 * Joshua, 2026-09-21: "the image should be separate from the UI, which the
 * image can allow pan and zoom, but the UI is fixed, like the full screen
 * camera." The reason is the work he has been doing: judging whether a
 * sharpening setting put a white rind along an edge is not a question you can
 * answer on a 430-point-wide phone screen showing a 4032-pixel photograph. He
 * needs to get close to it.
 *
 * THE VIEW IS A TRANSFORM, NOT A CROP. The canvas is laid out by CSS to fit
 * its frame, and this describes what is done to it after that: a scale about
 * the centre and an offset. Scale 1 is exactly the fitted picture, which is
 * why FIT is the identity rather than a computed number — nothing here needs
 * to know the picture's pixel dimensions, only the size of the box CSS gave
 * it, and that keeps the maths independent of device pixel ratio, of the
 * photo's own size, and of whether the canvas was drawn from a render or
 * decoded back from a file.
 *
 * PURE, so it can be tested without a browser. The shell owns the pointers
 * and writes the transform; every decision about where the picture is allowed
 * to end up is made here.
 */

export interface View {
  /** 1 is the fitted picture. */
  scale: number;
  /** Offset from centred, in frame pixels, applied BEFORE the scale. */
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** The fitted picture, centred: what the review opens on. */
export const FIT: View = { scale: 1, x: 0, y: 0 };

/**
 * You cannot zoom out past the fit.
 *
 * A picture that can be made smaller than its frame floats in a void and has
 * to be put back by hand, and there is nothing to see out there. Pinching in
 * runs down to the fit and stops.
 */
export const MIN_SCALE = 1;

/**
 * And not past 8×.
 *
 * At the fit, a 4032-wide photograph on a 430-point screen is already showing
 * about nine of its pixels in every point; 8× puts roughly one photo pixel per
 * point, which is the closest look that still means anything. Past that the
 * screen is magnifying the display's own sampling, not the picture.
 */
export const MAX_SCALE = 8;

/** What a double tap goes to, and comes back from. */
export const TAP_SCALE = 3;

/**
 * How far the picture may be pushed off centre.
 *
 * Exactly as far as its own overhang: when the scaled picture is wider than
 * the frame, the offset may run to half the difference, which puts its edge
 * against the frame's edge and no further. When it is not wider — at the fit,
 * or on the short axis of a tall photograph — the overhang is zero and the
 * picture stays centred. This is what stops a picture being flicked into a
 * corner and abandoned there.
 */
export function overhang(frame: Size, fitted: Size, scale: number): Size {
  return {
    width: Math.max(0, (fitted.width * scale - frame.width) / 2),
    height: Math.max(0, (fitted.height * scale - frame.height) / 2)
  };
}

export function clampView(view: View, frame: Size, fitted: Size): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale));
  const limit = overhang(frame, fitted, scale);
  // The + 0 is not decoration. Clamping a negative drag against a zero
  // overhang yields -0, which compares unequal to 0 and writes itself into
  // the transform as "-0.00px"; adding zero normalises it.
  return {
    scale,
    x: Math.min(limit.width, Math.max(-limit.width, view.x)) + 0,
    y: Math.min(limit.height, Math.max(-limit.height, view.y)) + 0
  };
}

export function panBy(view: View, dx: number, dy: number, frame: Size, fitted: Size): View {
  return clampView({ scale: view.scale, x: view.x + dx, y: view.y + dy }, frame, fitted);
}

/**
 * Zoom about a point, keeping whatever is under it under it.
 *
 * `at` is measured from the CENTRE of the frame, because that is where the
 * transform's origin is; the shell subtracts the frame's midpoint before
 * calling. The picture point under `at` is (at - offset) / scale, and holding
 * it still across the change is what makes a pinch feel attached to the
 * fingers rather than to the middle of the screen.
 *
 * The clamp is applied AFTER, so a pinch that would have pushed the picture
 * past its own edge simply slides back — which is also what makes pinching
 * back out settle at centred rather than off in a corner.
 */
export function zoomAbout(
  view: View, factor: number, at: { x: number; y: number }, frame: Size, fitted: Size
): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
  // The effective factor after clamping, so the anchor maths agrees with the
  // scale actually used rather than the one asked for.
  const applied = scale / view.scale;
  return clampView({
    scale,
    x: at.x - (at.x - view.x) * applied,
    y: at.y - (at.y - view.y) * applied
  }, frame, fitted);
}

/**
 * A double tap: in to TAP_SCALE about the tapped point, or back to the fit.
 *
 * Anything above the fit comes all the way back, rather than stepping down by
 * one notch — a second tap should be an undo, and an undo that lands somewhere
 * new is not one.
 */
export function toggleZoom(
  view: View, at: { x: number; y: number }, frame: Size, fitted: Size
): View {
  if (view.scale > MIN_SCALE) return { ...FIT };
  return zoomAbout(view, TAP_SCALE, at, frame, fitted);
}

/** The transform this view becomes. Translate first, then scale about centre. */
export function transformOf(view: View): string {
  return `translate(${view.x.toFixed(2)}px, ${view.y.toFixed(2)}px) scale(${view.scale.toFixed(4)})`;
}
