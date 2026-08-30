/**
 * How far the phone moved between two captures, from the IMU alone.
 *
 * Parallax gives DISPARITY — which parts of the scene shifted more — and that
 * is enough to say what is nearer. Turning it into a distance needs two more
 * numbers: how far the camera moved between the shots (the baseline), and how
 * many pixels the lens puts in a degree (the focal length). This measures the
 * first.
 *
 * BE CLEAR ABOUT WHAT THIS IS. Displacement from an accelerometer is double
 * integration, and double integration of a noisy, biased signal drifts as the
 * SQUARE of elapsed time. Over the second or two a parallax capture takes, a
 * few centimetres of real movement is recoverable to maybe tens of percent.
 * Over ten seconds it is worthless. Every reading carries an uncertainty for
 * that reason, and the uncertainty is not decoration.
 *
 * Rotation is the opposite case: integrating a gyro over a second or two is
 * genuinely accurate, so the rotation figure can be trusted to reject a capture
 * that was a twist rather than a slide. That distinction matters more than the
 * distance does — a rotated pair produces disparity everywhere, which reads as
 * "everything is close" and is entirely an artefact.
 */

export interface BaselineSample {
  /** m/s^2, as the platform reports it — including gravity where it does. */
  acceleration: { x: number; y: number; z: number };
  /** Degrees per second. */
  rotationRate: { alpha: number; beta: number; gamma: number };
}

export interface BaselineEstimate {
  /** Straight-line distance travelled, in metres. */
  displacementMetres: number;
  /**
   * Rough one-sigma uncertainty on that displacement, in metres.
   *
   * Grows with the square of elapsed time, because that is how double
   * integration of a biased signal behaves. A baseline whose uncertainty
   * approaches its own size is not a measurement.
   */
  uncertaintyMetres: number;
  /** Total rotation over the window, in degrees. */
  rotationDegrees: number;
  durationSeconds: number;
  samples: number;
  /** False when the estimate is too uncertain, or too rotated, to build on. */
  usable: boolean;
}

/**
 * Residual accelerometer bias assumed when propagating uncertainty, m/s^2.
 *
 * Consumer MEMS accelerometers hold a bias of a few hundredths of a g even
 * after the gravity estimate has settled. 0.02 m/s^2 is a deliberately modest
 * figure; the point is that the uncertainty grows quadratically, not that this
 * constant is exact.
 */
const BIAS_ACCEL = 0.02;

/** Rotation past which a capture is a twist, not a slide, in degrees. */
export const MAX_BASELINE_ROTATION_DEGREES = 6;

/** Below this the movement is indistinguishable from holding still. */
const MIN_USABLE_METRES = 0.01;

/**
 * Time constant for the gravity estimate, in seconds.
 *
 * Gravity has to be removed before anything can be integrated, and the
 * platform reports acceleration WITH it wherever it can. A slow low-pass
 * tracks the gravity direction as the phone tilts while passing the brief
 * accelerations of an actual slide.
 */
const GRAVITY_TAU = 0.6;

export class BaselineTracker {
  private gravity = { x: 0, y: 0, z: 0 };
  private velocity = { x: 0, y: 0, z: 0 };
  private position = { x: 0, y: 0, z: 0 };
  private rotation = 0;
  private elapsed = 0;
  private count = 0;
  private primed = false;
  private active = false;

  get running(): boolean {
    return this.active;
  }

  start(): void {
    this.gravity = { x: 0, y: 0, z: 0 };
    this.velocity = { x: 0, y: 0, z: 0 };
    this.position = { x: 0, y: 0, z: 0 };
    this.rotation = 0;
    this.elapsed = 0;
    this.count = 0;
    this.primed = false;
    this.active = true;
  }

  stop(): void {
    this.active = false;
  }

  add(sample: BaselineSample, dtSeconds: number): void {
    if (!this.active) return;
    // A dt of zero contributes nothing; a huge one means the page was
    // backgrounded mid-capture and integrating across that gap would invent
    // metres of movement out of a pause.
    if (!(dtSeconds > 0) || dtSeconds > 0.25) return;

    const { acceleration, rotationRate } = sample;

    if (!this.primed) {
      // Seed gravity from the first sample rather than from zero, or the first
      // half second of every capture is a 9.8 m/s^2 acceleration that never
      // happened.
      this.gravity = { ...acceleration };
      this.primed = true;
    }

    const alpha = Math.min(1, dtSeconds / GRAVITY_TAU);
    this.gravity.x += (acceleration.x - this.gravity.x) * alpha;
    this.gravity.y += (acceleration.y - this.gravity.y) * alpha;
    this.gravity.z += (acceleration.z - this.gravity.z) * alpha;

    const ax = acceleration.x - this.gravity.x;
    const ay = acceleration.y - this.gravity.y;
    const az = acceleration.z - this.gravity.z;

    // Trapezoid would be marginally better, but the dominant error here is
    // bias, not integration order, and pretending otherwise would be false
    // precision.
    this.velocity.x += ax * dtSeconds;
    this.velocity.y += ay * dtSeconds;
    this.velocity.z += az * dtSeconds;

    this.position.x += this.velocity.x * dtSeconds;
    this.position.y += this.velocity.y * dtSeconds;
    this.position.z += this.velocity.z * dtSeconds;

    this.rotation += Math.hypot(
      rotationRate.alpha || 0,
      rotationRate.beta || 0,
      rotationRate.gamma || 0
    ) * dtSeconds;

    this.elapsed += dtSeconds;
    this.count++;
  }

  get estimate(): BaselineEstimate {
    const displacement = Math.hypot(this.position.x, this.position.y, this.position.z);
    // Double integration of a constant bias gives half a t squared, which is
    // why a long capture cannot produce a usable baseline however still it was.
    const uncertainty = 0.5 * BIAS_ACCEL * this.elapsed * this.elapsed;
    return {
      displacementMetres: displacement,
      uncertaintyMetres: uncertainty,
      rotationDegrees: this.rotation,
      durationSeconds: this.elapsed,
      samples: this.count,
      usable: this.count > 5
        && displacement >= MIN_USABLE_METRES
        && this.rotation <= MAX_BASELINE_ROTATION_DEGREES
        // A reading whose uncertainty is a large share of itself is not a
        // measurement, and saying so is the whole point of carrying it.
        && uncertainty < displacement * 0.5
    };
  }
}

/**
 * Focal length in pixels, from a field of view entered by hand.
 *
 * A pinhole camera puts half the sensor width at tan(half the field of view)
 * times the focal length, so inverting that gives focal length in pixels. It is
 * only ever as good as the field of view supplied, because WebKit exposes no
 * lens geometry to derive one from.
 */
export function focalLengthPixels(widthPixels: number, horizontalFovDegrees: number): number | null {
  if (!(widthPixels > 0) || !(horizontalFovDegrees > 0) || horizontalFovDegrees >= 180) return null;
  return widthPixels / 2 / Math.tan((horizontalFovDegrees * Math.PI) / 180 / 2);
}

/**
 * Distance to a feature, from stereo triangulation.
 *
 *     depth = baseline * focal / disparity
 *
 * Exact for a rectified pair. This pair is NOT rectified — it is two handheld
 * frames from one camera, so any residual rotation or forward motion violates
 * the assumption. The result is an estimate whose error is dominated by the
 * baseline's own uncertainty, which is why that is propagated through rather
 * than dropped.
 */
export function estimateDepthMetres(
  disparityPixels: number,
  baselineMetres: number,
  focalPixels: number
): number | null {
  if (!(disparityPixels > 0) || !(baselineMetres > 0) || !(focalPixels > 0)) return null;
  return (baselineMetres * focalPixels) / disparityPixels;
}

/** Fractional uncertainty on a depth carries the baseline's, at minimum. */
export function depthUncertaintyMetres(
  depthMetres: number,
  baseline: BaselineEstimate
): number {
  if (!(baseline.displacementMetres > 0)) return Number.POSITIVE_INFINITY;
  return depthMetres * (baseline.uncertaintyMetres / baseline.displacementMetres);
}
