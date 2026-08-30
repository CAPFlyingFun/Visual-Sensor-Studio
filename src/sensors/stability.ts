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

/** Rotation, in deg/sec, treated as perfectly still. Sensor noise lives here. */
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
