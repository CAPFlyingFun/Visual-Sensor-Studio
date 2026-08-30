/**
 * Adaptive analysis-rate governor.
 *
 * The camera stream stays at whatever stable rate it negotiated. This governs
 * only how often the expensive IMAGE ANALYSIS runs, because renegotiating
 * camera constraints every time something moves is slow, visibly disruptive,
 * and on WebKit can drop the stream outright.
 *
 * The rate is chosen from how far the fastest thing in frame moves BETWEEN
 * analyses, not from a motion percentage. Analysing at 30 fps is pointless if
 * the subject crosses 40 px between frames — the tracker cannot associate it —
 * and wasteful if the subject moves a fraction of a pixel.
 */

export type AdaptiveState = 'idle' | 'watching' | 'active' | 'tracking' | 'burst';

export interface AdaptiveInputs {
  /** Global inter-frame change, 0..1. */
  motionScore: number;
  /** Fastest tracked object, in analysis-frame pixels per second. 0 when none. */
  fastestObjectPxPerSec: number;
  /** How many objects are currently tracked. */
  objectCount: number;
  /** Mean optical-flow magnitude in px per frame, where flow ran. */
  flowMagnitudePx: number;
  /** Most recent analysis cost, in ms. */
  processingCostMs: number;
  /** Measured delivered frame rate — the ceiling worth asking for. */
  deliveredFps: number;
  /** Frames the browser dropped since the last update. */
  droppedFrames: number;
}

export interface AdaptiveConfig {
  minFps: number;
  maxFps: number;
  /**
   * How far the fastest object may travel between analyses, in analysis-frame
   * pixels. Smaller means a higher rate. Two pixels keeps a track associable
   * without chasing frames that add nothing.
   */
  targetPixelsPerFrame: number;
  /** Fraction of the frame interval analysis may consume before backing off. */
  costCeiling: number;
}

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveConfig = {
  minFps: 8,
  maxFps: 60,
  targetPixelsPerFrame: 2,
  costCeiling: 0.7
};

/**
 * Rise fast, fall slow.
 *
 * Something crossing the frame is the event worth catching, and arriving at
 * the right rate two seconds late means missing it. Dropping back quickly is
 * never urgent, and a fast fall makes the rate oscillate on the boundary of
 * any threshold, which costs more than it saves.
 */
const RAMP_UP_PER_SECOND = 240;
const RAMP_DOWN_PER_SECOND = 22;

/** Demanded rate must exceed the current one by this factor before rising. */
const RISE_HYSTERESIS = 1.06;
/** ...and fall below it by this factor before dropping. */
const FALL_HYSTERESIS = 0.82;

export class AdaptiveGovernor {
  private readonly config: AdaptiveConfig;
  private current: number;
  private lastUpdate = 0;
  private smoothedDemand: number;
  private stateValue: AdaptiveState = 'idle';

  constructor(config: Partial<AdaptiveConfig> = {}) {
    this.config = { ...DEFAULT_ADAPTIVE_CONFIG, ...config };
    this.current = this.config.minFps;
    this.smoothedDemand = this.config.minFps;
  }

  get targetFps(): number {
    return this.current;
  }

  get state(): AdaptiveState {
    return this.stateValue;
  }

  reset(): void {
    this.current = this.config.minFps;
    this.smoothedDemand = this.config.minFps;
    this.lastUpdate = 0;
    this.stateValue = 'idle';
  }

  /**
   * The rate the scene is asking for, before ramping and hysteresis.
   * Exposed separately so the demand and the applied rate can be compared.
   */
  demandFor(inputs: AdaptiveInputs): number {
    const { minFps, maxFps, targetPixelsPerFrame, costCeiling } = this.config;

    // Primary signal: keep the fastest object's per-frame travel bounded.
    const speed = Math.max(inputs.fastestObjectPxPerSec, 0);
    let demand = speed > 0 ? speed / Math.max(0.25, targetPixelsPerFrame) : 0;

    // Flow magnitude is px per analysed frame, so it says the last rate was
    // too low by roughly its ratio to the target.
    if (inputs.flowMagnitudePx > targetPixelsPerFrame) {
      demand = Math.max(demand, this.current * (inputs.flowMagnitudePx / targetPixelsPerFrame));
    }

    // Global motion keeps the rate up for movement no tracker locked onto.
    demand = Math.max(demand, minFps + inputs.motionScore * (maxFps - minFps) * 0.75);

    // More objects means more associations to keep straight.
    if (inputs.objectCount > 2) demand *= 1 + Math.min(0.35, (inputs.objectCount - 2) * 0.07);

    // A rate the device cannot actually sustain is not a target. Analysis must
    // fit inside the frame interval or the backlog grows without bound.
    if (inputs.processingCostMs > 0) {
      const affordable = (1000 / inputs.processingCostMs) * costCeiling;
      demand = Math.min(demand, affordable);
    }

    // Never ask for more analyses than there are distinct frames to analyse.
    if (inputs.deliveredFps > 0) demand = Math.min(demand, inputs.deliveredFps);
    if (inputs.droppedFrames > 0) demand *= 0.9;

    return Math.min(maxFps, Math.max(minFps, demand));
  }

  /** Advance the governor. `now` is a monotonic ms clock. */
  update(inputs: AdaptiveInputs, now: number): number {
    const demand = this.demandFor(inputs);

    // Demand is smoothed asymmetrically too, so a single noisy frame cannot
    // spike the rate, but a real burst still gets there within a few frames.
    this.smoothedDemand = demand > this.smoothedDemand
      ? this.smoothedDemand + (demand - this.smoothedDemand) * 0.6
      : this.smoothedDemand + (demand - this.smoothedDemand) * 0.12;

    const elapsed = this.lastUpdate > 0 ? Math.min(1, (now - this.lastUpdate) / 1000) : 0;
    this.lastUpdate = now;

    const target = this.smoothedDemand;
    if (target > this.current * RISE_HYSTERESIS) {
      this.current = Math.min(target, this.current + RAMP_UP_PER_SECOND * elapsed);
    } else if (target < this.current * FALL_HYSTERESIS) {
      this.current = Math.max(target, this.current - RAMP_DOWN_PER_SECOND * elapsed);
    }

    this.current = Math.min(this.config.maxFps, Math.max(this.config.minFps, this.current));
    this.stateValue = this.classify(inputs);
    return this.current;
  }

  private classify(inputs: AdaptiveInputs): AdaptiveState {
    const span = this.config.maxFps - this.config.minFps || 1;
    const level = (this.current - this.config.minFps) / span;
    if (inputs.fastestObjectPxPerSec > 0 && level > 0.75) return 'burst';
    if (inputs.objectCount > 0 && level > 0.3) return 'tracking';
    if (level > 0.45) return 'active';
    if (inputs.motionScore > 0.02 || inputs.objectCount > 0) return 'watching';
    return 'idle';
  }
}
