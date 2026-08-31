/**
 * The One-Euro filter.
 *
 * The problem it solves is the one that makes hand-driven animation look wrong:
 * a fixed low-pass forces a choice between jitter and lag. Smooth enough to
 * kill tremor and every deliberate movement arrives late; responsive enough to
 * feel direct and the model shivers when you hold still.
 *
 * One-Euro escapes that by varying its cutoff with SPEED. Slow movement is
 * mostly noise, so it filters hard; fast movement is mostly intent, so it barely
 * filters at all. The result is a signal that sits still when you do and follows
 * you when you move.
 *
 * Casiez, Roussel & Vogel, CHI 2012.
 */

export interface OneEuroOptions {
  /**
   * Cutoff at rest, in Hz. Lower is steadier and slower to react.
   *
   * This is the dial that decides how still a held pose looks.
   */
  minCutoff?: number;
  /**
   * How much speed raises the cutoff.
   *
   * Zero makes this an ordinary low-pass. Raising it trades steadiness during
   * fast movement — where nobody can see it — for lower lag.
   */
  beta?: number;
  /** Cutoff for the speed estimate itself, in Hz. Rarely worth changing. */
  derivativeCutoff?: number;
}

const DEFAULTS: Required<OneEuroOptions> = {
  minCutoff: 1.2,
  beta: 0.05,
  derivativeCutoff: 1
};

/** Smoothing factor for a cutoff frequency at a given sample interval. */
function alpha(cutoff: number, deltaSeconds: number): number {
  const tau = 1 / (2 * Math.PI * Math.max(1e-6, cutoff));
  return 1 / (1 + tau / Math.max(1e-6, deltaSeconds));
}

class LowPass {
  private value = Number.NaN;

  get initialised(): boolean {
    return Number.isFinite(this.value);
  }

  get last(): number {
    return this.value;
  }

  reset(): void {
    this.value = Number.NaN;
  }

  filter(input: number, a: number): number {
    // The first sample IS the answer. Starting from zero would make every
    // channel swing up from the origin over its first second.
    this.value = this.initialised ? a * input + (1 - a) * this.value : input;
    return this.value;
  }
}

export class OneEuroFilter {
  private readonly value = new LowPass();
  private readonly derivative = new LowPass();
  private lastTime = Number.NaN;
  private options: Required<OneEuroOptions>;

  constructor(options: OneEuroOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  configure(options: OneEuroOptions): void {
    this.options = { ...this.options, ...options };
  }

  reset(): void {
    this.value.reset();
    this.derivative.reset();
    this.lastTime = Number.NaN;
  }

  /**
   * @param timeSeconds a monotonic clock, in seconds
   */
  filter(input: number, timeSeconds: number): number {
    const elapsed = Number.isFinite(this.lastTime) ? timeSeconds - this.lastTime : Number.NaN;
    this.lastTime = timeSeconds;

    // A missing or absurd interval means the rate is unknown. Guessing at it
    // would make the filter's strength depend on a number nobody measured, so
    // a nominal 60 Hz stands in and the next real interval corrects it.
    const dt = Number.isFinite(elapsed) && elapsed > 0 && elapsed < 1 ? elapsed : 1 / 60;

    const speed = this.value.initialised ? (input - this.value.last) / dt : 0;
    const smoothedSpeed = this.derivative.filter(speed, alpha(this.options.derivativeCutoff, dt));

    const cutoff = this.options.minCutoff + this.options.beta * Math.abs(smoothedSpeed);
    return this.value.filter(input, alpha(cutoff, dt));
  }
}

export interface QuaternionLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * One-Euro over a rotation.
 *
 * Filtered per component and renormalised, which is the usual practical
 * approach and is accurate for the small frame-to-frame steps a hand produces.
 *
 * The sign alignment matters more than it looks: q and -q are the SAME
 * rotation, and a device can hand you either. Filtering across that flip
 * averages a rotation with its own negation and swings the bone through a full
 * turn — a spin that looks like a bug in the model rather than in the filter.
 */
export class QuaternionSmoother {
  private readonly axes = [
    new OneEuroFilter(),
    new OneEuroFilter(),
    new OneEuroFilter(),
    new OneEuroFilter()
  ];
  private previous: QuaternionLike | null = null;

  configure(options: OneEuroOptions): void {
    for (const axis of this.axes) axis.configure(options);
  }

  reset(): void {
    for (const axis of this.axes) axis.reset();
    this.previous = null;
  }

  filter(input: QuaternionLike, timeSeconds: number): QuaternionLike {
    let { x, y, z, w } = input;

    if (this.previous) {
      const dot = x * this.previous.x + y * this.previous.y
        + z * this.previous.z + w * this.previous.w;
      if (dot < 0) {
        x = -x;
        y = -y;
        z = -z;
        w = -w;
      }
    }

    const fx = this.axes[0].filter(x, timeSeconds);
    const fy = this.axes[1].filter(y, timeSeconds);
    const fz = this.axes[2].filter(z, timeSeconds);
    const fw = this.axes[3].filter(w, timeSeconds);

    const length = Math.hypot(fx, fy, fz, fw);
    const result = length > 1e-8
      ? { x: fx / length, y: fy / length, z: fz / length, w: fw / length }
      : { x: 0, y: 0, z: 0, w: 1 };

    this.previous = result;
    return result;
  }
}
