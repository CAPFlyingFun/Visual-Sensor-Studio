/**
 * Phase 1 of docs/multi-frame-super-resolution.md — measuring a real burst.
 *
 * Phase 0 established, on synthetic data, that merging recovers real
 * resolution only when the frames' sub-pixel offsets are spread across the
 * grid, and that a random handheld burst scores BELOW simply upscaling one
 * frame. That is a fact about random offsets, not a fact about anyone's hand,
 * and the difference matters: whether a particular phone held by a particular
 * person produces usable spread is an empirical question this module exists to
 * answer on the device.
 *
 * IT ALSO CARRIES THE FIX Phase 0 implied and did not state. A burst does not
 * have to accept the offsets it is given. Capture more frames than are needed
 * and KEEP THE SUBSET THAT COVERS THE GRID BEST, and random tremor becomes
 * managed offsets without the hand having to cooperate.
 *
 * Nothing here merges anything. It measures what a burst is worth before any
 * of that is built.
 */

import type { Plane } from './super-resolution.js';
import { createPlane, samplePlane, offsetSpread } from './super-resolution.js';

export interface ShiftEstimate {
  /** Displacement of this frame relative to the reference, in frame pixels. */
  shiftX: number;
  shiftY: number;
  /**
   * How pronounced the match was, 0..1. Low means flat texture or a failed
   * search, and a low-confidence shift must not be treated as a measurement.
   */
  confidence: number;
}

/**
 * Sum of absolute differences over a centred window, at an integer offset.
 *
 * Deliberately over a window rather than the whole frame: the edges of a
 * shifted frame contain content the reference never saw, and including them
 * biases every estimate towards zero.
 */
function windowSad(
  reference: Plane,
  frame: Plane,
  dx: number,
  dy: number,
  margin: number
): number {
  const { width, height } = reference;
  let total = 0;
  let count = 0;
  // Step by 2: a quarter of the work for an estimate this coarse, and the
  // sub-pixel fit that follows is what sets the final precision anyway.
  for (let y = margin; y < height - margin; y += 2) {
    for (let x = margin; x < width - margin; x += 2) {
      const a = reference.data[y * width + x];
      const b = samplePlane(frame, x + dx, y + dy);
      total += Math.abs(a - b);
      count++;
    }
  }
  return count > 0 ? total / count : Number.POSITIVE_INFINITY;
}

/** Vertex of the parabola through three samples, as an offset from the middle. */
function parabolicPeak(left: number, middle: number, right: number): number {
  const denominator = left - 2 * middle + right;
  if (!(Math.abs(denominator) > 1e-9)) return 0;
  const offset = (0.5 * (left - right)) / denominator;
  // A fit that lands outside the bracket is a fit to noise, not a minimum.
  return Math.abs(offset) <= 1 ? offset : 0;
}

/** Halve a plane by 2x2 averaging, for the search pyramid. */
function halve(plane: Plane): Plane {
  const width = plane.width >> 1;
  const height = plane.height >> 1;
  const out = createPlane(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = plane.data[(y * 2) * plane.width + x * 2];
      const b = plane.data[(y * 2) * plane.width + x * 2 + 1];
      const c = plane.data[(y * 2 + 1) * plane.width + x * 2];
      const d = plane.data[(y * 2 + 1) * plane.width + x * 2 + 1];
      out.data[y * width + x] = (a + b + c + d) / 4;
    }
  }
  return out;
}

/** Best integer offset within a window, plus the surface's depth and extent. */
function searchWindow(
  reference: Plane,
  frame: Plane,
  centreX: number,
  centreY: number,
  radius: number,
  margin: number
): { x: number; y: number; best: number; worst: number; onEdge: boolean } {
  let bestX = centreX;
  let bestY = centreY;
  let best = Number.POSITIVE_INFINITY;
  let worst = 0;
  for (let dy = centreY - radius; dy <= centreY + radius; dy++) {
    for (let dx = centreX - radius; dx <= centreX + radius; dx++) {
      const score = windowSad(reference, frame, dx, dy, margin);
      if (score < best) { best = score; bestX = dx; bestY = dy; }
      if (score > worst) worst = score;
    }
  }
  return {
    x: bestX, y: bestY, best, worst,
    onEdge: Math.abs(bestX - centreX) === radius || Math.abs(bestY - centreY) === radius
  };
}

/**
 * Sub-pixel displacement of `frame` relative to `reference`.
 *
 * COARSE TO FINE, because a single flat search cannot be both wide and cheap.
 * Cost grows with the square of the radius, so the first version used a fixed
 * plus-or-minus eight pixels — and on Joshua's phone the burst travelled 8.5
 * to 11.7 pixels, putting most frames outside it. They were then correctly
 * refused (a match on the window edge is not a match) and the probe reported
 * only two to twenty-seven of thirty-two frames as measurable, discarding most
 * of the burst for no reason but the size of the window.
 *
 * A two-level pyramid buys four times the range for less work than the flat
 * search it replaces: a wide search on a half-size image, then a short refine
 * at full size, then the parabolic fit that sets the final precision.
 *
 * Phase 0 measured the precision this has to reach: at 0.1 px the merge keeps
 * most of its gain, at 0.4 px almost none, at 0.8 px merging is worse than not
 * merging. An estimate that cannot be trusted to a tenth of a pixel is worse
 * than no estimate, which is what `confidence` is for.
 */
export function estimateShift(
  reference: Plane,
  frame: Plane,
  maxShift = 24
): ShiftEstimate {
  const margin = 4;
  if (reference.width <= margin * 2 + 4 || reference.height <= margin * 2 + 4) {
    return { shiftX: 0, shiftY: 0, confidence: 0 };
  }

  // Coarse pass at half size, where one pixel of search covers two of frame.
  const coarseRadius = Math.max(1, Math.ceil(maxShift / 2));
  const smallReference = halve(reference);
  const smallFrame = halve(frame);
  let seedX = 0;
  let seedY = 0;
  let coarseOnEdge = false;
  if (smallReference.width > margin * 2 + coarseRadius * 2) {
    const coarse = searchWindow(smallReference, smallFrame, 0, 0, coarseRadius, margin);
    seedX = coarse.x * 2;
    seedY = coarse.y * 2;
    // Only the COARSE edge means the motion left the range entirely. The fine
    // pass sits on a seed, so its own edge is ordinary.
    coarseOnEdge = coarse.onEdge;
  }

  const fine = searchWindow(reference, frame, seedX, seedY, 2, margin);
  if (!Number.isFinite(fine.best)) return { shiftX: 0, shiftY: 0, confidence: 0 };

  const left = windowSad(reference, frame, fine.x - 1, fine.y, margin);
  const right = windowSad(reference, frame, fine.x + 1, fine.y, margin);
  const up = windowSad(reference, frame, fine.x, fine.y - 1, margin);
  const down = windowSad(reference, frame, fine.x, fine.y + 1, margin);

  // Depth of the minimum against the spread of the surface. A flat wall gives
  // a shallow basin and a meaningless argmin; this is what says so.
  const basin = fine.worst > 0 ? Math.min(1, Math.max(0, 1 - fine.best / fine.worst)) : 0;

  // A MATCH ON THE EDGE OF THE COARSE SEARCH IS NOT A MATCH. The frame moved
  // further than the range covers and the real match is outside it, so the
  // estimate is not "large" — it is wrong in the direction that looks like a
  // small, well-behaved shift, and nothing downstream could tell.
  return {
    shiftX: fine.x + parabolicPeak(left, fine.best, right),
    shiftY: fine.y + parabolicPeak(up, fine.best, down),
    confidence: coarseOnEdge ? 0 : basin
  };
}

/**
 * Image displacement implied by a rotation, in pixels.
 *
 * For rotation small enough that tan(t) is t — which hand tremor always is —
 * a pan of `radians` moves the image by focalPixels * radians. This is the
 * conversion Joshua's motion trigger needs, and `focalLengthPixels` in
 * baseline.ts already supplies the focal length from the field of view.
 */
export function rotationToPixels(radians: number, focalPixels: number): number {
  if (!(focalPixels > 0)) return 0;
  return focalPixels * radians;
}

/** The fractional part of a shift, which is all that carries new information. */
function fractional(value: number): number {
  return value - Math.floor(value);
}

/** Toroidal distance between two sub-pixel offsets: 0.99 and 0.01 are neighbours. */
function offsetDistance(
  a: { shiftX: number; shiftY: number },
  b: { shiftX: number; shiftY: number }
): number {
  const dx = Math.abs(fractional(a.shiftX) - fractional(b.shiftX));
  const dy = Math.abs(fractional(a.shiftY) - fractional(b.shiftY));
  return Math.hypot(Math.min(dx, 1 - dx), Math.min(dy, 1 - dy));
}

/**
 * Keep the `count` frames whose sub-pixel offsets cover the grid best.
 *
 * THIS IS WHAT MAKES A HANDHELD BURST USABLE. Phase 0 found that random
 * offsets underperform bicubic while evenly spread ones beat it by about
 * 5.7 dB, and concluded the capture had to be steered. Selection reaches the
 * same place from the other end: over-capture, then throw away the frames that
 * duplicate an offset already held. The hand does not have to cooperate — it
 * only has to wander, and it does.
 *
 * Greedy farthest-point: start from the reference, then repeatedly take the
 * candidate furthest from everything already kept. That maximises the minimum
 * separation, which is exactly what `offsetSpread` rewards.
 *
 * Returns indices into `shifts`, reference first.
 */
export function selectDiverseSubset(
  shifts: ReadonlyArray<{ shiftX: number; shiftY: number; confidence?: number }>,
  count: number,
  minConfidence = 0
): number[] {
  const usable = shifts
    .map((shift, index) => ({ shift, index }))
    .filter(({ shift, index }) => index === 0 || (shift.confidence ?? 1) >= minConfidence);
  if (usable.length === 0) return [];

  const chosen = [usable[0].index];
  const remaining = usable.slice(1);

  while (chosen.length < count && remaining.length > 0) {
    let bestAt = 0;
    let bestDistance = -1;
    for (let i = 0; i < remaining.length; i++) {
      let nearest = Number.POSITIVE_INFINITY;
      for (const index of chosen) {
        nearest = Math.min(nearest, offsetDistance(remaining[i].shift, shifts[index]));
      }
      if (nearest > bestDistance) {
        bestDistance = nearest;
        bestAt = i;
      }
    }
    chosen.push(remaining[bestAt].index);
    remaining.splice(bestAt, 1);
  }
  return chosen;
}

export interface BurstVerdict {
  frames: number;
  /** Frames whose shift could actually be measured. */
  confident: number;
  /** Grid coverage of the whole burst, 0..1. */
  rawSpread: number;
  /** Grid coverage after keeping the best subset. */
  selectedSpread: number;
  selected: number[];
  /** Largest displacement seen, in frame pixels. */
  travelPixels: number;
  /** True when nothing moved enough to sample a new offset. */
  stationary: boolean;
  /** Whether this burst is worth merging at all. */
  worthMerging: boolean;
  reason: string;
}

/**
 * Spread threshold below which Phase 0 says a merge will not pay for itself.
 *
 * Measured, not chosen: on 1/f noise and on a real photograph, offsets at
 * about this coverage were the point where merging stopped beating a plain
 * upscale of one frame.
 */
export const SPREAD_FLOOR = 0.55;

/**
 * Below this much total travel there is no reason to think any new offset was
 * sampled, and the honest answer is that a merge cannot help.
 */
export const STATIONARY_PIXELS = 0.05;

/**
 * How many frames to capture in order to keep `KEEP_FRAMES` good ones.
 *
 * Measured over 200 simulated bursts, as the share that clear SPREAD_FLOOR
 * after selection:
 *
 *     8 candidates -> 46%     (a coin flip)
 *    16            -> 91%
 *    24            -> 97%
 *    32            -> 99.5%
 *
 * Taking the first eight frames and hoping is the 46% case, which is why
 * selection exists. Four-to-one over-capture is what makes it dependable.
 */
export const CAPTURE_CANDIDATES = 32;
export const KEEP_FRAMES = 8;

/**
 * Judge a captured burst — the number this whole phase exists to produce.
 *
 * The verdict is allowed to be "no". A tripod, a propped phone or a webcam
 * bolted to a monitor genuinely cannot sample a new sub-pixel offset, and no
 * processing invents one. Saying so is the feature working correctly; quietly
 * returning an upscale labelled as a merge is not.
 */
/**
 * Confidence below which a shift is a guess about a flat surface.
 *
 * Measured rather than picked: a featureless wall plus read noise scores about
 * 0.024 on this metric, so anything at or under that is indistinguishable from
 * having nothing to match.
 */
export const MIN_CONFIDENCE = 0.08;

export function judgeBurst(
  shifts: ReadonlyArray<ShiftEstimate>,
  keep: number,
  minConfidence = MIN_CONFIDENCE
): BurstVerdict {
  const frames = shifts.length;
  const confident = shifts.filter((s) => s.confidence >= minConfidence).length;
  const travelPixels = shifts.reduce(
    (worst, s) => Math.max(worst, Math.hypot(s.shiftX, s.shiftY)),
    0
  );
  const selected = selectDiverseSubset(shifts, keep, minConfidence);
  // LIKE FOR LIKE. `rawSpread` is the spread of the first `keep` frames — what
  // taking the burst as it came would have given — NOT of all of them. More
  // points always cover more grid, so comparing thirty-two against a selected
  // eight makes selection look actively harmful, which is how it read in
  // Joshua's log: raw 68% against selected 59% on a burst selection had in
  // fact improved.
  const rawSpread = offsetSpread(shifts.slice(0, keep));
  const selectedSpread = offsetSpread(selected.map((i) => shifts[i]));
  const stationary = travelPixels < STATIONARY_PIXELS;

  let reason: string;
  let worthMerging = false;
  if (frames < 2) {
    reason = 'A burst needs at least two frames.';
  } else if (stationary) {
    reason = 'Nothing moved. On a tripod or a fixed mount there is no second '
      + 'viewpoint to merge, so a single frame is the honest answer.';
  } else if (confident < 2) {
    reason = 'Too little texture to measure movement. Point at something with detail.';
  } else if (confident < keep) {
    // Distinguished from a low spread because the fix is different: this is
    // about what the box is pointed at, not about how the phone was held.
    reason = `Only ${confident} of ${frames} frames had enough texture to measure, `
      + `fewer than the ${keep} a merge needs. Fill the box with detail — `
      + 'gravel, foliage, brickwork, fabric.';
  } else if (selectedSpread < SPREAD_FLOOR) {
    reason = `Offsets cover ${(selectedSpread * 100).toFixed(0)}% of the sub-pixel grid, `
      + `below the ${(SPREAD_FLOOR * 100).toFixed(0)}% where merging starts to pay. `
      + 'Hold it a little less rigidly, or capture more frames to choose from.';
  } else {
    worthMerging = true;
    reason = `Offsets cover ${(selectedSpread * 100).toFixed(0)}% of the sub-pixel grid. `
      + 'This burst carries more detail than any single frame in it.';
  }

  return {
    frames, confident, rawSpread, selectedSpread, selected,
    travelPixels, stationary, worthMerging, reason
  };
}
