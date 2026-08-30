/**
 * Computational long exposure.
 *
 * WebKit does not expose a hardware shutter, so a 30-second exposure is
 * assembled from the frames that arrive during those 30 seconds. Each frame is
 * folded into a fixed accumulator and then discarded — storing hundreds of
 * full frames would exhaust memory on a phone long before the exposure ended.
 *
 * Memory is therefore constant in exposure length: three Float32Arrays sized
 * to the analysis frame, whatever the duration.
 */

export type StackMode = 'clean' | 'brighten' | 'trails';

export interface IntegrationReport {
  mode: StackMode;
  framesIntegrated: number;
  elapsedMs: number;
  /** Target duration in ms; 0 means run until stopped. */
  targetMs: number;
  complete: boolean;
  /** Peak accumulated luminance, used to tone-map Brighten. */
  peak: number;
}

export class FrameIntegrator {
  private red = new Float32Array(0);
  private green = new Float32Array(0);
  private blue = new Float32Array(0);
  private width = 0;
  private height = 0;
  private frames = 0;
  // NaN, not 0: performance.now() is legitimately near zero just after page
  // load, so a 0 sentinel makes the first frame fail the "have I started?"
  // test and silently moves the exposure's start to the second frame.
  private startedAt = Number.NaN;
  private lastAt = Number.NaN;
  private peakValue = 0;

  constructor(private mode: StackMode = 'clean', private targetMs = 0) {}

  get framesIntegrated(): number {
    return this.frames;
  }

  get isEmpty(): boolean {
    return this.frames === 0;
  }

  setMode(mode: StackMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.reset();
  }

  setTarget(targetMs: number): void {
    this.targetMs = Math.max(0, targetMs);
  }

  reset(): void {
    this.red.fill(0);
    this.green.fill(0);
    this.blue.fill(0);
    this.frames = 0;
    this.startedAt = Number.NaN;
    this.lastAt = Number.NaN;
    this.peakValue = 0;
  }

  private ensure(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    const count = width * height;
    this.red = new Float32Array(count);
    this.green = new Float32Array(count);
    this.blue = new Float32Array(count);
    this.width = width;
    this.height = height;
    this.frames = 0;
    this.startedAt = Number.NaN;
    this.peakValue = 0;
  }

  /**
   * Fold one RGBA frame into the accumulator. Returns false once the target
   * duration has elapsed, so the caller can stop feeding it.
   */
  addFrame(rgba: ArrayLike<number>, width: number, height: number, now: number): boolean {
    this.ensure(width, height);
    if (!Number.isFinite(this.startedAt)) this.startedAt = now;
    if (this.targetMs > 0 && now - this.startedAt > this.targetMs) return false;

    const count = width * height;
    if (this.mode === 'trails') {
      // Lighten: keep the brightest value each pixel has ever shown, so a
      // moving light writes a continuous streak instead of averaging away.
      for (let i = 0; i < count; i++) {
        const p = i * 4;
        const r = rgba[p] ?? 0;
        const g = rgba[p + 1] ?? 0;
        const b = rgba[p + 2] ?? 0;
        if (r > this.red[i]) this.red[i] = r;
        if (g > this.green[i]) this.green[i] = g;
        if (b > this.blue[i]) this.blue[i] = b;
      }
    } else {
      for (let i = 0; i < count; i++) {
        const p = i * 4;
        this.red[i] += rgba[p] ?? 0;
        this.green[i] += rgba[p + 1] ?? 0;
        this.blue[i] += rgba[p + 2] ?? 0;
      }
    }

    this.frames++;
    this.lastAt = now;
    return true;
  }

  /**
   * Render the accumulated exposure.
   *
   * Clean divides by the frame count, so random sensor noise averages down
   * while stationary detail survives — the tripod case.
   *
   * Brighten keeps the sum and tone-maps against the observed peak, letting
   * dim signal climb out of the noise floor over time.
   *
   * Trails is already a per-pixel maximum and needs no scaling.
   */
  render(out?: Uint8ClampedArray): Uint8ClampedArray {
    const count = this.width * this.height;
    const rgba = out && out.length === count * 4 ? out : new Uint8ClampedArray(count * 4);
    if (count === 0 || this.frames === 0) return rgba;

    let scale = 1;
    if (this.mode === 'clean') {
      scale = 1 / this.frames;
    } else if (this.mode === 'brighten') {
      let peak = 0;
      for (let i = 0; i < count; i++) {
        const value = Math.max(this.red[i], this.green[i], this.blue[i]);
        if (value > peak) peak = value;
      }
      this.peakValue = peak;
      // Normalise to the brightest accumulated pixel rather than to the frame
      // count, which is what lets faint detail rise instead of staying at the
      // same relative level it had in a single frame.
      scale = peak > 0 ? 255 / peak : 1 / Math.max(1, this.frames);
    }

    for (let i = 0; i < count; i++) {
      const p = i * 4;
      rgba[p] = Math.min(255, this.red[i] * scale);
      rgba[p + 1] = Math.min(255, this.green[i] * scale);
      rgba[p + 2] = Math.min(255, this.blue[i] * scale);
      rgba[p + 3] = 255;
    }
    return rgba;
  }

  report(now: number): IntegrationReport {
    // Two different clocks, deliberately. `elapsedMs` is the span actually
    // integrated, which stops at the last accepted frame. Completion is wall
    // time since the start: once the last frame is refused, `lastAt` stops
    // advancing, so measuring completion from it would leave an exposure
    // permanently one frame short of done.
    const started = Number.isFinite(this.startedAt);
    const last = Number.isFinite(this.lastAt) ? this.lastAt : now;
    const integrated = started ? Math.max(0, last - this.startedAt) : 0;
    const sinceStart = started ? Math.max(0, now - this.startedAt) : 0;
    return {
      mode: this.mode,
      framesIntegrated: this.frames,
      elapsedMs: integrated,
      targetMs: this.targetMs,
      complete: this.targetMs > 0 && started && sinceStart >= this.targetMs,
      peak: this.peakValue
    };
  }
}
