/**
 * Device stability from the IMU, for computational long exposure.
 *
 * A multi-second integration only works if the camera did not move. The phone
 * already reports rotation rate and acceleration, so stability can be measured
 * rather than assumed — and the user warned when a stack is being ruined.
 */

export interface StabilitySample {
  /** Degrees per second on each axis. */
  rotationRate: { alpha: number; beta: number; gamma: number };
  /** m/s^2 excluding gravity, where the device reports it. */
  acceleration: { x: number; y: number; z: number };
}

export interface StabilityReport {
  /** 0..1, where 1 is perfectly still. */
  score: number;
  /** True once the device has been still enough for long enough to trust. */
  tripod: boolean;
  /** True when the most recent motion is large enough to blur an exposure. */
  disturbed: boolean;
  rotationMagnitude: number;
  accelerationMagnitude: number;
}

/**
 * Rotation, in deg/sec, treated as perfectly still when nothing better is
 * known. Sensor noise lives here.
 *
 * A guess, and a poor one for any specific device: gyro noise and the tremor of
 * the hand holding it vary enormously. `calibrate()` replaces it with a floor
 * measured from THIS phone in THIS grip.
 */
const ROTATION_FLOOR = 0.6;
/** Rotation at which stability reads zero. */
const ROTATION_CEILING = 26;
const ACCELERATION_FLOOR = 0.06;
const ACCELERATION_CEILING = 2.6;
/** Score above which the device counts as tripod-mounted. */
const TRIPOD_SCORE = 0.93;
/** Consecutive stable samples before claiming tripod, at ~60 Hz. */
const TRIPOD_SAMPLES = 45;

export class StabilityMonitor {
  private smoothed = 1;
  private stableRun = 0;
  private lastRotation = 0;
  private lastAcceleration = 0;

  reset(): void {
    this.smoothed = 1;
    this.stableRun = 0;
    this.lastRotation = 0;
    this.lastAcceleration = 0;
  }

  update(sample: StabilitySample): StabilityReport {
    const rotation = Math.hypot(
      sample.rotationRate.alpha || 0,
      sample.rotationRate.beta || 0,
      sample.rotationRate.gamma || 0
    );
    const acceleration = Math.hypot(
      sample.acceleration.x || 0,
      sample.acceleration.y || 0,
      sample.acceleration.z || 0
    );

    this.lastRotation = rotation;
    this.lastAcceleration = acceleration;

    // Below the floor is indistinguishable from sensor noise and must not be
    // treated as movement, or a phone on a table would never read as stable.
    const rotationPenalty = normalise(rotation, ROTATION_FLOOR, ROTATION_CEILING);
    const accelerationPenalty = normalise(acceleration, ACCELERATION_FLOOR, ACCELERATION_CEILING);
    const instant = Math.max(0, 1 - Math.max(rotationPenalty, accelerationPenalty));

    // Asymmetric: a knock drops the score at once, but recovering trust takes
    // sustained stillness, because the exposure it disturbed is already spoilt.
    this.smoothed = instant < this.smoothed
      ? instant
      : this.smoothed + (instant - this.smoothed) * 0.05;

    if (this.smoothed >= TRIPOD_SCORE) this.stableRun++;
    else this.stableRun = 0;

    return this.report;
  }

  get report(): StabilityReport {
    return {
      score: this.smoothed,
      tripod: this.stableRun >= TRIPOD_SAMPLES,
      disturbed: this.smoothed < 0.72,
      rotationMagnitude: this.lastRotation,
      accelerationMagnitude: this.lastAcceleration
    };
  }
}

function normalise(value: number, floor: number, ceiling: number): number {
  if (value <= floor) return 0;
  if (value >= ceiling) return 1;
  return (value - floor) / (ceiling - floor);
}


/**
 * A measured noise floor, in place of the guessed constants above.
 *
 * Taken by holding the phone as it will actually be held and sampling for a
 * few seconds. What comes back is not "how still a phone can be" but "how still
 * THIS phone is in THIS hand", which is the only number that can separate a
 * tremor worth ignoring from a movement worth reacting to.
 */
export interface StabilityCalibration {
  rotation: SignalStats;
  acceleration: SignalStats;
  /** Rotation below this counts as holding still, in deg/sec. */
  rotationDeadzone: number;
  /**
   * How far the acceleration magnitude may DEVIATE from its resting value, in
   * m/s^2, and still count as holding still.
   *
   * A deviation rather than an absolute level because the platform reports
   * acceleration including gravity wherever it can, so a phone sitting on a
   * table reads about 9.8 and a threshold on the absolute figure would measure
   * the planet rather than the hand. The resting value is `acceleration.mean`,
   * measured during calibration in whatever orientation the phone was held.
   */
  accelerationDeadzone: number;
  samples: number;
  durationMs: number;
  capturedAt: number;
}

export interface SignalStats {
  min: number;
  mean: number;
  max: number;
  standardDeviation: number;
}

/**
 * How far above the mean the deadzone sits, in standard deviations.
 *
 * Three covers virtually all of a settled tremor while staying well below a
 * deliberate movement. The max is also honoured, because a hand that drifted
 * once during calibration will drift again and a deadzone under the observed
 * maximum would fire on it.
 */
const DEADZONE_SIGMA = 3;

/**
 * Smallest acceleration deviation worth reacting to, in m/s^2.
 *
 * A calibration taken on a table has almost no spread, and a deadzone derived
 * purely from it would call the next sensor tick a movement.
 */
const ACCELERATION_DEADZONE_FLOOR = 0.15;

/** Never trust a deadzone from a sample this thin; the statistics are noise. */
export const MIN_CALIBRATION_SAMPLES = 20;

function stats(values: readonly number[]): SignalStats {
  if (!values.length) return { min: 0, mean: 0, max: 0, standardDeviation: 0 };
  let min = Infinity;
  let max = -Infinity;
  let total = 0;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
    total += value;
  }
  const mean = total / values.length;
  let variance = 0;
  for (const value of values) variance += (value - mean) ** 2;
  return {
    min,
    mean,
    max,
    standardDeviation: Math.sqrt(variance / values.length)
  };
}

/**
 * Collects samples for a fixed window and turns them into a deadzone.
 *
 * Deliberately NOT a live filter. The whole point is a deliberate act — hold
 * the phone the way you mean to hold it, for a known span — so the number can
 * be shown, kept, and disagreed with, rather than quietly adapting until it has
 * absorbed the very motion it was meant to reject.
 */
export class StabilityCalibrator {
  private rotations: number[] = [];
  private accelerations: number[] = [];
  private startedAt = Number.NaN;
  private lastAt = Number.NaN;

  get running(): boolean {
    return Number.isFinite(this.startedAt);
  }

  get samples(): number {
    return this.rotations.length;
  }

  /** 0..1 through the requested window. */
  progress(now: number, durationMs: number): number {
    if (!this.running || durationMs <= 0) return 0;
    return Math.min(1, (now - this.startedAt) / durationMs);
  }

  start(now: number): void {
    this.rotations = [];
    this.accelerations = [];
    // NaN rather than 0: performance.now() is legitimately near zero just after
    // load, and a 0 sentinel would make a calibration started then look like one
    // that never started.
    this.startedAt = now;
    this.lastAt = now;
  }

  cancel(): void {
    this.rotations = [];
    this.accelerations = [];
    this.startedAt = Number.NaN;
    this.lastAt = Number.NaN;
  }

  add(sample: StabilitySample, now: number): void {
    if (!this.running) return;
    this.lastAt = now;
    this.rotations.push(Math.hypot(
      sample.rotationRate.alpha || 0,
      sample.rotationRate.beta || 0,
      sample.rotationRate.gamma || 0
    ));
    this.accelerations.push(Math.hypot(
      sample.acceleration.x || 0,
      sample.acceleration.y || 0,
      sample.acceleration.z || 0
    ));
  }

  /**
   * Finish and produce the calibration, or null when too little was collected.
   *
   * Returning null rather than a calibration built from four samples matters:
   * a deadzone is used to decide what to IGNORE, so one derived from noise
   * would silently discard real movement.
   */
  finish(now: number): StabilityCalibration | null {
    if (!this.running || this.rotations.length < MIN_CALIBRATION_SAMPLES) {
      this.cancel();
      return null;
    }

    const rotation = stats(this.rotations);
    const acceleration = stats(this.accelerations);
    const durationMs = Math.max(0, this.lastAt - this.startedAt);
    // Read before cancelling: cancel() empties the arrays, so a count taken
    // after it is always zero.
    const samples = this.rotations.length;
    this.cancel();

    return {
      rotation,
      acceleration,
      // The larger of "mean plus three sigma" and the observed maximum. A hand
      // that drifted once during calibration will drift again, and a deadzone
      // under that maximum would report the drift as movement every time.
      rotationDeadzone: Math.max(
        rotation.mean + rotation.standardDeviation * DEADZONE_SIGMA,
        rotation.max
      ),
      // Deviation from rest, not an absolute level. The floor keeps a very
      // quiet calibration — a phone that was on a table rather than in a hand —
      // from producing a deadzone so tight that ordinary noise trips it.
      accelerationDeadzone: Math.max(
        ACCELERATION_DEADZONE_FLOOR,
        acceleration.standardDeviation * DEADZONE_SIGMA,
        acceleration.max - acceleration.mean
      ),
      samples,
      durationMs,
      capturedAt: Date.now()
    };
  }
}

/**
 * Is the device being held still, by its own measured standard?
 *
 * This is a GATE, not stabilisation. It does not remove camera movement from
 * the picture and cannot: once the phone has turned, the pixels have already
 * moved and no amount of knowing about it puts them back. What it does is let
 * the app tell the two situations apart, so a whole frame lighting up because
 * the hand drifted can be treated differently from a whole frame lighting up
 * because something crossed it.
 */
export function isSteady(
  report: StabilityReport,
  calibration: StabilityCalibration | null
): boolean {
  if (!calibration) return report.rotationMagnitude <= ROTATION_FLOOR;
  const drift = Math.abs(report.accelerationMagnitude - calibration.acceleration.mean);
  return report.rotationMagnitude <= calibration.rotationDeadzone
    && drift <= calibration.accelerationDeadzone;
}

/**
 * How far past the deadzone the device currently is.
 *
 * 0 while inside it, rising thereafter — a damper value, so a caller can fade
 * rather than switch and avoid a readout that flickers on the boundary.
 */
export function excursion(
  report: StabilityReport,
  calibration: StabilityCalibration | null
): number {
  const floor = calibration ? calibration.rotationDeadzone : ROTATION_FLOOR;
  if (floor <= 0) return report.rotationMagnitude;
  return Math.max(0, report.rotationMagnitude / floor - 1);
}
