/**
 * Measure the lens's focal length from a burst, instead of asking for it.
 *
 * Joshua: "Do we need the FOV listed or does the camera show it?" It does not.
 * His own capability readout returned seven controls and no field of view, and
 * the MediaTrack specification has no such property — there is nowhere for a
 * browser to report it even if it wanted to, and frames from getUserMedia
 * carry no EXIF.
 *
 * But typing a number was never the right answer either. The app already
 * measures both halves of the relation that defines the focal length:
 *
 *     image displacement (pixels) = focal length (pixels) x rotation (radians)
 *
 * The aligner supplies the left side and the gyroscope the right, so a burst
 * that rotates at all SOLVES for the focal length. No prior estimate is needed
 * — this is not a refinement of a guess, it is a measurement that produces the
 * number from nothing.
 *
 * That is strictly better than a typed value: it is per-lens, so the 0.5x,
 * 1x and 2x cameras each get their own; it follows digital zoom, which changes
 * the effective focal length; and it does not depend on anyone knowing a
 * specification they have no way to look up.
 *
 * The small-angle approximation is used throughout — tan(t) is t to better
 * than a part in a thousand below five degrees, and hand tremor is a fraction
 * of one.
 */

export interface FocalSample {
  /** How far the image moved between this frame and the reference, in pixels. */
  imagePixels: number;
  /** How far the phone rotated over the same interval, in radians. */
  rotationRadians: number;
}

export interface FocalFit {
  /** Focal length in pixels of the full frame, or null when unmeasurable. */
  focalPixels: number | null;
  /** Horizontal field of view implied by it, in degrees. */
  fovDegrees: number | null;
  /** Pairs that carried enough rotation to say anything. */
  samples: number;
  /**
   * How well a straight line through the origin fits, 0..1.
   *
   * Low means the two measurements are not describing the same motion — which
   * happens when the scene itself moved, when the phone translated rather than
   * rotated, or when the gyroscope and the camera are not looking at the same
   * instants. A poor fit is a reason to discard the answer, not to average it
   * in.
   */
  quality: number;
  reason: string;
}

/**
 * Below this much rotation a sample says nothing about the focal length.
 *
 * The estimate divides by rotation, so a near-zero denominator turns sensor
 * noise into an arbitrarily large focal length. About a tenth of a degree.
 */
export const MIN_ROTATION_RADIANS = 0.0017;

/** Fewer pairs than this and one bad sample sets the answer. */
export const MIN_SAMPLES = 4;

/** Below this the fit is not describing one motion, whatever the numbers say. */
export const MIN_QUALITY = 0.8;

/**
 * Plausible bounds for a phone camera, in degrees.
 *
 * Not a correction — a REFUSAL. An answer outside this range means the fit
 * found something that is not a lens (the scene moved, the phone translated,
 * the clocks disagree), and clamping it into range would turn a detectable
 * failure into a plausible wrong number that everything downstream would then
 * trust.
 */
export const MIN_FOV_DEGREES = 20;
export const MAX_FOV_DEGREES = 150;

/**
 * Least squares through the origin, on magnitudes.
 *
 * Magnitudes rather than per-axis deliberately: which gyroscope axis maps to
 * which image axis depends on device orientation, mounting and the sign
 * conventions of two different specifications, and getting that wrong produces
 * a confident answer off by a rotation. |displacement| = focal x |rotation|
 * holds under any of those mappings for the small planar rotations involved,
 * so the ambiguity simply does not arise.
 *
 * Through the origin, not a free intercept: zero rotation must mean zero
 * displacement. An intercept would let the fit absorb a constant drift and
 * report a focal length that fits the residue rather than the physics.
 */
export function fitFocalLength(
  samples: ReadonlyArray<FocalSample>,
  frameWidth: number
): FocalFit {
  const usable = samples.filter((s) =>
    Number.isFinite(s.imagePixels)
    && Number.isFinite(s.rotationRadians)
    && Math.abs(s.rotationRadians) >= MIN_ROTATION_RADIANS
    && s.imagePixels >= 0);

  const empty = (reason: string): FocalFit => ({
    focalPixels: null, fovDegrees: null, samples: usable.length, quality: 0, reason
  });

  if (!(frameWidth > 0)) return empty('The camera frame size is not known yet.');
  if (usable.length < MIN_SAMPLES) {
    return empty(`Only ${usable.length} frames rotated enough to measure with. `
      + 'Let the phone turn a little during the burst — a few degrees is plenty.');
  }

  let numerator = 0;
  let denominator = 0;
  for (const s of usable) {
    const rotation = Math.abs(s.rotationRadians);
    numerator += s.imagePixels * rotation;
    denominator += rotation * rotation;
  }
  if (!(denominator > 0)) return empty('No usable rotation in this burst.');
  const focalPixels = numerator / denominator;

  // How much of the variation the straight line accounts for. Measured against
  // the total, not against a mean, because the model has no intercept to
  // subtract and comparing to a mean would flatter it.
  let residual = 0;
  let total = 0;
  for (const s of usable) {
    const predicted = focalPixels * Math.abs(s.rotationRadians);
    residual += (s.imagePixels - predicted) ** 2;
    total += s.imagePixels ** 2;
  }
  const quality = total > 0 ? Math.max(0, 1 - residual / total) : 0;

  const fovDegrees = 2 * Math.atan(frameWidth / (2 * focalPixels)) * (180 / Math.PI);

  if (quality < MIN_QUALITY) {
    return {
      focalPixels: null, fovDegrees: null, samples: usable.length, quality,
      reason: `The gyroscope and the picture disagree about how the phone moved `
        + `(fit ${(quality * 100).toFixed(0)}%). That happens when the scene itself `
        + 'moved, or when the phone slid rather than turned. Try again on something '
        + 'still.'
    };
  }
  if (!(fovDegrees >= MIN_FOV_DEGREES && fovDegrees <= MAX_FOV_DEGREES)) {
    return {
      focalPixels: null, fovDegrees: null, samples: usable.length, quality,
      reason: `That works out to a ${fovDegrees.toFixed(0)}° lens, which no phone has. `
        + 'Something other than a rotating camera produced this motion, so the '
        + 'reading is discarded rather than rounded into range.'
    };
  }

  return {
    focalPixels,
    fovDegrees,
    samples: usable.length,
    quality,
    reason: `Measured from ${usable.length} frames: ${fovDegrees.toFixed(1)}° across, `
      + `focal length ${focalPixels.toFixed(0)} px (fit ${(quality * 100).toFixed(0)}%).`
  };
}
