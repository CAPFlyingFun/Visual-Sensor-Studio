/**
 * GYRO ALIGNMENT — how far the picture has moved since the stack began, in
 * pixels, predicted from the phone's own orientation.
 *
 * The first half of Night, and deliberately the half that can be CHECKED
 * before any Night output exists to argue about. A night stack adds many dim
 * frames together so that weak light accumulates; if the phone rotated a
 * fraction of a degree between them, the light lands on different scene
 * pixels and the stack is a blur rather than a longer exposure. This app has
 * already proved that on itself: frame averaging without alignment is exactly
 * the smear that became the Dizzy effect.
 *
 * WHY A FRACTION OF A DEGREE MATTERS, in this app's own measured numbers. The
 * displacement of a small rotation is `focal length in pixels × angle`, and
 * the focal length is MEASURED here rather than assumed — vision/focal-fit.ts
 * fits it from gyro rotation against image displacement across a burst,
 * because no browser reports the field of view. At a typical fitted focal
 * length of ~2800 px, one tenth of a degree is 2800 × 0.00175 ≈ 4.9 pixels.
 * Five pixels of smear is the difference between a sharp stack and a soft
 * one, and it is far below what a hand can feel.
 *
 * THE NOISE FLOOR IS NOT OPTIONAL. A resting phone still reports orientation
 * that wanders by hundredths of a degree, and treating that as real movement
 * would have the aligner chasing its own sensor — warping every frame by a
 * pixel or two of nonsense and rejecting good ones. So a stack calibrates
 * first (sensors/stability.ts already measures a stationary noise floor the
 * same way) and anything inside that floor is reported as NO MOVEMENT rather
 * than as a small movement.
 *
 * WHAT THIS CANNOT DO, stated because the gap is invisible in the output:
 * gyro gives ROTATION only. Moving the phone sideways — translation — shifts
 * near things more than far ones, and no amount of orientation data can
 * predict that. A prediction here is therefore a starting point for visual
 * refinement, never the final word, and the residual after visual matching is
 * the honest measure of how much translation there was.
 */

import type { QuaternionLike } from '../../core/math.js';

/** Below this, a rotation is sensor noise unless calibration says otherwise. */
export const DEFAULT_NOISE_FLOOR_RADIANS = 0.0012;

/** Small-angle displacement stops being linear well before this. */
export const MAX_SMALL_ANGLE_RADIANS = 0.15;

export interface RotationDelta {
  /** Rotation about the image's vertical axis — moves the picture across. */
  yaw: number;
  /** Rotation about the image's horizontal axis — moves the picture up/down. */
  pitch: number;
  /** Rotation about the lens axis — turns the picture in its own plane. */
  roll: number;
  /** The total angle turned, however it was split. */
  total: number;
}

export interface PredictedShift {
  /** Pixels the scene has moved across the frame. */
  dx: number;
  /** Pixels the scene has moved up or down the frame. */
  dy: number;
  /** Radians the picture has turned in its own plane. */
  roll: number;
  /** How far the frame centre has travelled, in pixels. */
  distance: number;
  /**
   * False when the rotation is large enough that `f × angle` is no longer a
   * fair approximation — the number is still returned, but it is a guess and
   * the caller must not present it as a measurement.
   */
  smallAngle: boolean;
}

/** q⁻¹ for a unit quaternion: the same rotation, undone. */
function conjugate(q: QuaternionLike): QuaternionLike {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

function multiply(a: QuaternionLike, b: QuaternionLike): QuaternionLike {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  };
}

/**
 * How far the phone has turned FROM the reference orientation.
 *
 * Quaternions rather than three independent Euler angles, because Euler
 * angles do not subtract: near the poles a tenth of a degree of real movement
 * can appear as a large change in one angle and a compensating change in
 * another, and differencing them reports a rotation that never happened. The
 * relative quaternion has no such seam.
 */
export function rotationSince(
  reference: QuaternionLike, current: QuaternionLike
): RotationDelta {
  const delta = multiply(current, conjugate(reference));
  // The rotation angle is 2·acos(w); the axis is the vector part, normalised.
  const w = Math.min(1, Math.max(-1, Math.abs(delta.w)));
  const total = 2 * Math.acos(w);
  const sin = Math.sqrt(Math.max(0, 1 - w * w));
  if (sin < 1e-9 || total < 1e-9) return { yaw: 0, pitch: 0, roll: 0, total: 0 };
  // Sign follows w so that a rotation and its negative-quaternion twin — the
  // same rotation, written the other way round — do not report opposite axes.
  const flip = delta.w < 0 ? -1 : 1;
  const scale = (total * flip) / sin;
  return {
    yaw: delta.y * scale,
    pitch: delta.x * scale,
    roll: delta.z * scale,
    total
  };
}

/**
 * Where that rotation puts the picture, in pixels.
 *
 * displacement = focal length × angle, the small-angle form. `focalPixels`
 * must be a MEASURED focal length (vision/focal-fit.ts) — assuming one would
 * make every number below an invention wearing a unit.
 */
export function predictShift(
  delta: RotationDelta, focalPixels: number
): PredictedShift {
  if (!(focalPixels > 0)) {
    return { dx: 0, dy: 0, roll: 0, distance: 0, smallAngle: true };
  }
  // Yaw moves the scene ACROSS the frame and pitch moves it UP: both are
  // opposite to the phone's own turn, because turning right sends the scene
  // left across the sensor.
  const dx = -focalPixels * delta.yaw;
  const dy = focalPixels * delta.pitch;
  return {
    dx,
    dy,
    roll: delta.roll,
    distance: Math.hypot(dx, dy),
    smallAngle: delta.total <= MAX_SMALL_ANGLE_RADIANS
  };
}

/**
 * Is this rotation real, or is it the sensor talking to itself?
 *
 * `floor` is the calibrated stationary noise level. Anything inside it counts
 * as no movement at all — a resting phone must produce a still stack, not a
 * stack of one-pixel corrections.
 */
export function isRealMovement(
  delta: RotationDelta, floor = DEFAULT_NOISE_FLOOR_RADIANS
): boolean {
  return delta.total > Math.max(0, floor);
}

export type FrameVerdict = 'stacked' | 'still' | 'rejected';

export interface FrameDecision {
  verdict: FrameVerdict;
  shift: PredictedShift;
  /** One sentence, safe to show. */
  reason: string;
}

/**
 * Whether a frame belongs in the stack, and why.
 *
 * A frame that moved more than the crop margin can absorb cannot be warped
 * back into place — the warp would drag in edges that were never photographed
 * — so it is REJECTED rather than stacked with a fabricated border. Rejecting
 * is not a failure: it is the difference between a stack of eight good frames
 * and a stack of twelve where four are smeared.
 */
export function decideFrame(
  delta: RotationDelta,
  focalPixels: number,
  marginPixels: number,
  floor = DEFAULT_NOISE_FLOOR_RADIANS
): FrameDecision {
  const shift = predictShift(delta, focalPixels);
  if (!isRealMovement(delta, floor)) {
    return {
      verdict: 'still',
      shift: { ...shift, dx: 0, dy: 0, distance: 0, roll: 0 },
      reason: 'Inside the calibrated noise floor — the phone did not move.'
    };
  }
  if (!shift.smallAngle) {
    return {
      verdict: 'rejected',
      shift,
      reason: `Turned ${(delta.total * 180 / Math.PI).toFixed(1)}°, too far for a `
        + 'small-angle prediction to mean anything.'
    };
  }
  if (shift.distance > marginPixels) {
    return {
      verdict: 'rejected',
      shift,
      reason: `Moved ${Math.round(shift.distance)} px, past the ${Math.round(marginPixels)} px `
        + 'crop margin — warping it back would drag in edges that were never photographed.'
    };
  }
  return {
    verdict: 'stacked',
    shift,
    reason: `Moved ${Math.round(shift.distance)} px; warped back inside the margin.`
  };
}

/** The reading in one sentence, for the instrument row. */
export function describeShift(shift: PredictedShift, delta: RotationDelta): string {
  const degrees = (value: number): string => (value * 180 / Math.PI).toFixed(2);
  return `yaw ${degrees(delta.yaw)}° · pitch ${degrees(delta.pitch)}° · `
    + `roll ${degrees(delta.roll)}° → ${shift.dx.toFixed(1)}, ${shift.dy.toFixed(1)} px`
    + (shift.smallAngle ? '' : ' (beyond small-angle — a guess, not a measurement)');
}
