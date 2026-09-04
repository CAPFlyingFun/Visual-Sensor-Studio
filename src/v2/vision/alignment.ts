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
 * displacement of a small rotation is `focal length in pixels × angle`. No
 * browser reports the field of view, so the focal length is either MEASURED
 * (vision/focal-fit.ts fits it from gyro rotation against image displacement
 * across a burst) or stood in for and marked as assumed — never quietly
 * guessed. At ~2800 px, one tenth of a degree is 2800 × 0.00175 ≈ 4.9 pixels.
 * Five pixels of smear is the difference between a sharp stack and a soft
 * one, and it is far below what a hand can feel.
 *
 * THE NOISE FLOOR IS NOT OPTIONAL. A resting phone still reports orientation
 * that wanders by hundredths of a degree, and treating that as real movement
 * would have the aligner chasing its own sensor — warping every frame by a
 * pixel or two of nonsense and rejecting good ones. So anything inside the
 * floor is reported as NO MOVEMENT rather than as a small movement. The floor
 * here is a default until a calibration replaces it: sensors/stability.ts
 * already measures a stationary floor from THIS phone in THIS grip, and until
 * that is wired in every reading says which of the two it used.
 *
 * WHAT THIS CANNOT DO, stated because the gap is invisible in the output:
 * gyro gives ROTATION only. Moving the phone sideways — translation — shifts
 * near things more than far ones, and no amount of orientation data can
 * predict that. A prediction here is therefore a starting point for visual
 * refinement, never the final word, and the residual after visual matching is
 * the honest measure of how much translation there was.
 */

import type { QuaternionLike } from '../../core/math.js';

/**
 * The focal length assumed while none has been measured.
 *
 * Displacement is focal x angle, so without a focal length there is no
 * prediction at all — and NO BROWSER REPORTS THE FIELD OF VIEW, which is why
 * vision/focal-fit.ts exists to fit one from a burst. Until that has run,
 * this stands in: a phone's main camera is around a 26 mm equivalent, giving
 * roughly a 70 degree horizontal field, and f = (width/2) / tan(35 degrees).
 *
 * It is a STAND-IN WITH A STATED REASON, not a configuration value — the same
 * shape as render/frame-average.ts's NOMINAL_FPS. Every reading derived from
 * it is marked `assumed`, and the moment a real fit exists the measurement
 * replaces it.
 */
export const NOMINAL_FOCAL_RATIO = 0.5 / Math.tan(35 * Math.PI / 180);

/**
 * ZOOM MULTIPLIES IT, and leaving that out was a real bug.
 *
 * Focal length in pixels IS the magnification: it is what turns a rotation
 * into a pixel displacement. Zooming to 10x makes the same small turn sweep
 * the image ten times further, but the frame is still the same 3024 pixels
 * wide — so a focal estimate taken from the WIDTH alone does not move when
 * the lens does, and the aligner then predicts a tenth of the real shift.
 *
 * Measured consequence (Joshua, 2026-09-04, at 10.0x with Stabilization on
 * 2 frames): the correction under-shot by the zoom factor, so averaging two
 * frames of an unaligned hand-held view smeared them instead of steadying
 * them, and the picture came back BLURRIER with stabilisation than without.
 * The same error made the steady-hand gate far too lenient at zoom, since it
 * judges a hold in pixels of shake.
 *
 * Optional so an older caller keeps working; 1 is the identity, which is
 * exactly what every 1x reading was already getting.
 */
export function nominalFocalPixels(frameWidth: number, zoom = 1): number {
  const magnification = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return frameWidth > 0 ? frameWidth * NOMINAL_FOCAL_RATIO * magnification : 0;
}

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
  /** Pixels the scene has moved towards the frame's RIGHT edge. */
  dx: number;
  /** Pixels the scene has moved towards the frame's BOTTOM edge. */
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
 * How far the phone has turned FROM the reference orientation, IN THE
 * CAMERA'S OWN FRAME.
 *
 * Quaternions rather than three independent Euler angles, because Euler
 * angles do not subtract: near the poles a tenth of a degree of real movement
 * can appear as a large change in one angle and a compensating change in
 * another, and differencing them reports a rotation that never happened. The
 * relative quaternion has no such seam.
 *
 * THE ORDER IS THE WHOLE POINT, and it is easy to get backwards. `current x
 * reference-inverse` is the same rotation expressed about WORLD axes; `
 * reference-inverse x current` expresses it about the CAMERA'S axes, and only
 * the second one predicts where the picture goes. Measured here, on this
 * app's own quaternions: a phone lying flat on a table and spun one degree
 * reads as a one-degree YAW in world axes — a pan — and as a one-degree ROLL
 * in camera axes. The camera is pointing at the table; spinning the phone
 * turns that picture in its own plane and pans nothing. The world reading
 * would have sent the aligner sliding the frame sideways to correct a
 * sideways movement that never happened.
 *
 * The two agree exactly when the phone is held upright, which is why this was
 * worth checking rather than assuming: the pose a test is most likely to be
 * written in is the one pose where the wrong answer looks right.
 */
export function rotationSince(
  reference: QuaternionLike, current: QuaternionLike
): RotationDelta {
  // Camera-frame, not world-frame: see above. Getting these two the wrong way
  // round costs nothing when the phone is upright and everything when it is not.
  const delta = multiply(conjugate(reference), current);
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
 * displacement = focal length × angle, the small-angle form.
 *
 * THE AXES ARE THE PICTURE'S OWN, not the screen's and not the phone's: +dx
 * is towards the right-hand edge of the delivered frame and +dy is towards
 * its BOTTOM edge, which is the direction texture rows run and therefore the
 * direction the shader's offset has to be in. Naming them after the picture
 * is what makes the conversion to UV a division and nothing else.
 *
 * THE SIGNS, derived rather than guessed, in the camera frame the corrected
 * quaternion produces (looking down −Z, +X right, +Y up):
 *
 *   yaw +θ turns the camera LEFT, so the scene slides RIGHT   → dx = +f·yaw
 *   pitch +θ points the camera UP, so the scene slides DOWN   → dy = +f·pitch
 *
 * Both are "opposite to the turn" in the ordinary sense — the world does not
 * move, so it appears to move the other way — and both come out POSITIVE
 * because dy is measured down the picture rather than up it. Getting either
 * backwards would not merely fail to align: it would move each frame the
 * wrong way and double the error it was there to remove.
 *
 * REAR CAMERA. A front camera looks the other way along the optical axis and
 * its raster handedness follows, so dx's sign flips — but which way round the
 * delivered (unmirrored) frame comes is a thing to MEASURE on a device, not
 * to reason out and ship. `alignmentUv` therefore declines to align a
 * front-facing frame rather than guessing at it.
 */
export function predictShift(
  delta: RotationDelta, focalPixels: number
): PredictedShift {
  if (!(focalPixels > 0)) {
    return { dx: 0, dy: 0, roll: 0, distance: 0, smallAngle: true };
  }
  const dx = focalPixels * delta.yaw;
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
 * `floor` is the stationary noise level, calibrated where a calibration
 * exists and DEFAULT_NOISE_FLOOR_RADIANS where none does — the caller knows
 * which, and says so. Anything inside it counts as no movement at all: a
 * resting phone must produce a still stack, not a stack of one-pixel
 * corrections.
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
      reason: 'Inside the noise floor — the phone did not move.'
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

/**
 * The shift as the averaging shader wants it: a UV offset.
 *
 * The accumulation stays in the orientation it began at and is never itself
 * warped — a re-warped accumulation would be resampled again on every frame
 * and would soften without limit. Instead the ARRIVING frame is sampled at an
 * offset, which puts the scene back where the accumulation already holds it.
 * That is why the offset is `+shift` rather than `−shift`: to find, in this
 * frame, the scene that used to be at UV `p`, look where it has moved TO.
 *
 * Texture rows run down the picture, so `dy` divides straight into `v` with
 * no sign change — see predictShift's axes.
 *
 * Null for a front-facing camera (its raster handedness is unmeasured, and a
 * wrong sign there would double the error) and null wherever the size or the
 * prediction is not usable. Null means DO NOT ALIGN, which is exactly the
 * behaviour frame averaging already had.
 */
export function alignmentUv(
  shift: PredictedShift,
  width: number,
  height: number,
  facing: string
): [number, number] | null {
  if (facing !== 'environment') return null;
  if (!(width > 0) || !(height > 0) || !shift.smallAngle) return null;
  if (!Number.isFinite(shift.dx) || !Number.isFinite(shift.dy)) return null;
  return [shift.dx / width, shift.dy / height];
}

/**
 * How far the picture may drift before the accumulation is thrown away and
 * started again, as a share of the frame's shorter side.
 *
 * There is no crop here, so this is not a crop margin — it is an EDGE BUDGET.
 * Sampling an arriving frame at an offset asks for content past its edge,
 * where there is nothing photographed; the shader declines to average those
 * pixels at all, so they keep whatever the accumulation last had. Two per
 * cent keeps that stale band thin and brief. Past it the honest move is to
 * restart rather than to hold an accumulation the current view no longer
 * overlaps: a restart costs the noise reduction for a few frames, and holding
 * on costs the picture.
 */
export const EDGE_BUDGET_SHARE = 0.02;

export interface AlignedFrame {
  verdict: FrameVerdict;
  delta: RotationDelta;
  shift: PredictedShift;
  reason: string;
  /** UV offset for the averaging pass; [0, 0] when there is nothing to undo. */
  align: [number, number];
  /** The accumulation must be thrown away and primed again from this frame. */
  restart: boolean;
}

export interface AlignerInputs {
  focalPixels: number;
  frameWidth: number;
  frameHeight: number;
  facing: string;
  floor?: number;
}

/**
 * The accumulation's anchor, and the running tally of what happened to it.
 *
 * A rolling average has no beginning and no end, so "the stack" here is
 * whatever has accumulated since the last prime — and its anchor is the
 * orientation the phone was at THEN. Every later frame is warped back to that
 * anchor. When the drift outgrows the edge budget the anchor is stale by
 * definition: the current view and the accumulation no longer describe the
 * same rectangle, so the accumulation restarts and the anchor moves with it.
 *
 * That restart is the answer to the complaint this whole feature came from —
 * unaligned averaging smeared whenever the phone moved. It now steadies a
 * still picture and lets go of the past when the picture is genuinely a
 * different picture, instead of blending the two.
 */
export class StackAligner {
  private reference: QuaternionLike | null = null;
  private stacked = 0;
  private rejected = 0;
  private still = 0;

  /** Frames warped back into the accumulation since the last restart. */
  get stackedCount(): number { return this.stacked; }
  /** Frames that ended the accumulation because the view had moved on. */
  get rejectedCount(): number { return this.rejected; }
  /** Frames inside the noise floor — the phone was not moving. */
  get stillCount(): number { return this.still; }
  /** True once an anchor exists to measure against. */
  get anchored(): boolean { return this.reference !== null; }

  reset(): void {
    this.reference = null;
    this.stacked = 0;
    this.rejected = 0;
    this.still = 0;
  }

  track(current: QuaternionLike, inputs: AlignerInputs): AlignedFrame {
    const margin = Math.min(inputs.frameWidth, inputs.frameHeight) * EDGE_BUDGET_SHARE;
    if (!this.reference) {
      // The first frame after a prime IS the anchor, so it is stacked at
      // zero offset by definition rather than by measurement.
      this.reference = current;
      this.stacked = 1;
      this.rejected = 0;
      this.still = 0;
      const zero = predictShift({ yaw: 0, pitch: 0, roll: 0, total: 0 }, inputs.focalPixels);
      return {
        verdict: 'stacked',
        delta: { yaw: 0, pitch: 0, roll: 0, total: 0 },
        shift: zero,
        reason: 'Anchor frame — the orientation everything after it is aligned to.',
        align: [0, 0],
        restart: true
      };
    }
    const delta = rotationSince(this.reference, current);
    const decision = decideFrame(delta, inputs.focalPixels, margin, inputs.floor);
    if (decision.verdict === 'rejected') {
      this.reference = current;
      this.rejected += 1;
      this.stacked = 1;
      return { ...decision, delta, align: [0, 0], restart: true };
    }
    if (decision.verdict === 'still') this.still += 1;
    this.stacked += 1;
    const uv = alignmentUv(decision.shift, inputs.frameWidth, inputs.frameHeight, inputs.facing);
    return {
      ...decision,
      delta,
      align: uv ?? [0, 0],
      restart: false
    };
  }
}
