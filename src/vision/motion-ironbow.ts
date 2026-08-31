/**
 * Motion speed visualisation — the Ironbow look, driven by image speed.
 *
 * This is NOT a thermal camera and nothing here measures temperature. A phone
 * camera has no long-wave infrared sensitivity whatsoever, so a warm object and
 * a cold one of the same brightness are identical to it. What the palette maps
 * is how fast each part of the image is MOVING, borrowing thermography's colour
 * language because it reads well: cool and dark for still, hot and bright for
 * fast. Any label shown beside it has to say so, or the picture lies.
 *
 * Speed is measured in FRAME WIDTHS PER SECOND rather than pixels per frame.
 * Both alternatives are traps:
 *
 *  - Pixels per FRAME changes with frame rate. The same hand waved at the same
 *    real speed would read twice as fast at 15 fps as at 30, so the colours
 *    would track the phone's workload rather than the scene.
 *  - Pixels per SECOND changes with analysis resolution, which this app varies
 *    deliberately — the adaptive governor moves it, and portrait and landscape
 *    differ. A gull would change colour when the governor stepped down.
 *
 * Frame widths per second is free of both, so a given real movement holds its
 * colour as the pipeline retunes underneath it.
 */

import { clamp } from '../core/math.js';

/**
 * Ironbow-style ramp: near-black blue through violet, magenta and red into
 * orange, yellow and finally white.
 *
 * Built once as a 256-entry table. The palette work in overlays.ts measured a
 * per-pixel ramp at 2.2 ms per frame against about a tenth of that through a
 * table, and this runs over every pixel of every analysed frame.
 */
const IRONBOW_STOPS: Array<[number, number, number, number]> = [
  [0.0, 4, 2, 34],
  [0.15, 32, 6, 92],
  [0.3, 96, 12, 140],
  [0.45, 176, 22, 132],
  [0.6, 226, 58, 62],
  [0.75, 249, 130, 12],
  [0.88, 255, 202, 22],
  [1.0, 255, 255, 236]
];

function buildIronbowTable(): Uint8ClampedArray {
  const table = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let stop = 0;
    while (stop < IRONBOW_STOPS.length - 2 && t > IRONBOW_STOPS[stop + 1][0]) stop++;
    const [t0, r0, g0, b0] = IRONBOW_STOPS[stop];
    const [t1, r1, g1, b1] = IRONBOW_STOPS[stop + 1];
    const span = t1 - t0;
    const f = span > 0 ? clamp((t - t0) / span, 0, 1) : 0;
    table[i * 3] = Math.round(r0 + (r1 - r0) * f);
    table[i * 3 + 1] = Math.round(g0 + (g1 - g0) * f);
    table[i * 3 + 2] = Math.round(b0 + (b1 - b0) * f);
  }
  return table;
}

const ironbowTable = buildIronbowTable();

/** Ironbow colour for a normalised 0..1 value. */
export function ironbowColor(value: number): [number, number, number] {
  const bin = Math.round(clamp(value, 0, 1) * 255) * 3;
  return [ironbowTable[bin], ironbowTable[bin + 1], ironbowTable[bin + 2]];
}

/**
 * Colour for a pixel that demonstrably CHANGED but whose speed no flow vector
 * could explain — a moving surface too flat to match, typically.
 *
 * Deliberately a desaturated slate rather than a point on the ramp. Painting it
 * "slow" would be inventing a measurement; painting it "still" would hide a real
 * event. It has its own swatch in the legend for the same reason.
 */
export const UNRESOLVED_COLOR: [number, number, number] = [104, 116, 132];

/**
 * Per-pixel motion state. Three states, not a resolved/unresolved pair: a pixel
 * that did not move and a pixel that moved unmeasurably are different findings,
 * and collapsing them would let a real event render as background.
 */
export const STILL = 0;
/** Speed measured directly in this pixel's own flow cell. */
export const RESOLVED = 1;
/** Changed, with no flow vector anywhere near it to explain the change. */
export const UNRESOLVED = 2;
/**
 * Speed carried in from an adjacent cell.
 *
 * Block matching only accepts a cell with enough texture to match, so a moving
 * object's plain interior — a coat, a wing, a car door — routinely has measured
 * speed all around its edges and none in the middle. Leaving that middle blank
 * renders half of every real subject as "unknown", which is a worse description
 * of the scene than carrying the neighbouring measurement in.
 *
 * The reach is bounded to ONE cell so this stays interpolation between nearby
 * measurements rather than extrapolation into empty space, and the report
 * counts these pixels separately from measured ones so the distinction survives
 * into the readout.
 */
export const INFERRED = 3;

export interface MotionSpeedOptions {
  /** Frame difference below this counts as no motion. Raise it in a noisy scene. */
  motionThreshold?: number;
  /** Speed mapped to the top of the ramp, in frame widths per second. */
  fullScale?: number;
  /** Let the full-scale value follow the scene instead of holding fixed. */
  autoScale?: boolean;
  /** How far, in pixels, a measurement may be carried into flat neighbours. */
  fillRadius?: number;
}

export interface MotionSpeedReport {
  /** Fastest resolved speed this frame, in frame widths per second. */
  peakWidthsPerSecond: number;
  /** Mean speed across the moving pixels that had one, in frame widths per second. */
  meanWidthsPerSecond: number;
  /** The same speed in analysis pixels per second, for readouts. */
  peakPixelsPerSecond: number;
  /** Fraction of the frame currently moving, 0..1. */
  movingFraction: number;
  /** Of the moving pixels, the fraction whose speed could not be resolved at all. */
  unresolvedFraction: number;
  /** Of the moving pixels, the fraction whose speed came from a neighbouring pixel. */
  inferredFraction: number;
  /**
   * Of the measured pixels, the fraction that hit the estimator's ceiling.
   *
   * A high value means the scene is moving faster than this method can resolve
   * and the speeds shown are floors, not readings.
   */
  saturatedFraction: number;
  /** Speed currently mapped to white, in frame widths per second. */
  fullScale: number;
}

const EMPTY_REPORT: MotionSpeedReport = {
  peakWidthsPerSecond: 0,
  meanWidthsPerSecond: 0,
  peakPixelsPerSecond: 0,
  movingFraction: 0,
  unresolvedFraction: 0,
  inferredFraction: 0,
  saturatedFraction: 0,
  fullScale: 0
};

/** Slowest full scale auto mode will settle on, so a still scene stays calm. */
const MIN_AUTO_SCALE = 0.05;
const MAX_AUTO_SCALE = 4;
/** Auto scale opens quickly to catch a fast pass and closes slowly to stay readable. */
const AUTO_RISE = 0.5;
const AUTO_FALL = 0.04;

/**
 * Bilinear sample of the cell grid at a continuous cell coordinate.
 *
 * Corners with no value are dropped from the weighting rather than counted as
 * zero — a missing neighbour means "not measured here", and averaging it in as
 * a zero would drag every speed near the edge of a moving object down toward
 * still. `fallback` is used when every corner is empty, which cannot happen for
 * a pixel that reached this function but keeps it total.
 */
function sampleCells(
  cells: ArrayLike<number>,
  cellsX: number,
  cellsY: number,
  cellX: number,
  cellY: number,
  fallback: number
): number {
  const x0 = Math.floor(cellX);
  const y0 = Math.floor(cellY);
  const fx = cellX - x0;
  const fy = cellY - y0;

  let total = 0;
  let weight = 0;
  for (let dy = 0; dy <= 1; dy++) {
    const cy = y0 + dy;
    if (cy < 0 || cy >= cellsY) continue;
    const wy = dy ? fy : 1 - fy;
    for (let dx = 0; dx <= 1; dx++) {
      const cx = x0 + dx;
      if (cx < 0 || cx >= cellsX) continue;
      const value = cells[cy * cellsX + cx];
      if (value < 0) continue;
      const w = wy * (dx ? fx : 1 - fx);
      total += value * w;
      weight += w;
    }
  }
  return weight > 0 ? total / weight : fallback;
}

/**
 * Largest displacement, in pixels per frame, this estimator will report.
 *
 * The normal-flow estimate below linearises the image around each pixel, and
 * that assumption holds for small displacements and degrades for large ones —
 * past a few pixels the temporal difference saturates against the intensity
 * range while the gradient does not, so the estimate UNDERSTATES fast motion
 * rather than overstating it. The cap makes the ceiling explicit instead of
 * letting a division by a small gradient produce an arbitrary number, and the
 * report counts how much of the frame hit it.
 */
const MAX_PIXELS_PER_FRAME = 12;

/**
 * Gradient magnitude, in intensity per pixel, below which speed is not
 * recoverable. Dividing by anything smaller amplifies sensor noise into a
 * confident-looking speed.
 */
const GRADIENT_FLOOR = 3;

/** How far a measured speed may be carried into neighbouring flat pixels. */
const DEFAULT_FILL_RADIUS = 6;

export class MotionSpeedField {
  /** Normalised speed per pixel, 0..1. Zero means still. */
  speed = new Float32Array(0);
  /** STILL, RESOLVED, INFERRED or UNRESOLVED per pixel. */
  state = new Uint8Array(0);
  private raw = new Float32Array(0);
  private scratch = new Uint8Array(0);
  private width = 0;
  private height = 0;
  private autoScale = MIN_AUTO_SCALE;
  private lastReport: MotionSpeedReport = EMPTY_REPORT;

  get report(): MotionSpeedReport {
    return this.lastReport;
  }

  reset(): void {
    this.autoScale = MIN_AUTO_SCALE;
    this.lastReport = EMPTY_REPORT;
    this.speed.fill(0);
    this.state.fill(0);
    this.raw.fill(0);
  }

  private ensure(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.speed = new Float32Array(width * height);
    this.state = new Uint8Array(width * height);
    this.raw = new Float32Array(width * height);
    this.scratch = new Uint8Array(width * height);
  }

  /**
   * Per-pixel speed from the normal-flow constraint.
   *
   * REPLACES a block-matching approach, and the reason is what the two can
   * resolve. Block matching searched 16-pixel cells, so a 256-pixel frame held
   * about sixteen real samples across — smooth once interpolated, but visibly a
   * grid, and worst on a front camera where fewer cells carry enough texture to
   * match at all. This estimate exists at every pixel, which is why Difference
   * always looked sharper than Speed did: Difference was per-pixel and Speed
   * was not.
   *
   * The constraint is the standard one. For a patch that moves without changing
   * brightness, the intensity change over time equals the spatial gradient
   * times the displacement, so dividing one by the other recovers the
   * displacement along the gradient:
   *
   *     speed = |I_t| / |grad I|
   *
   * Two honest limits come with it, and both are reported rather than hidden.
   * It measures NORMAL flow — only the component across the local edge — so an
   * edge sliding along its own direction reads as slower than it is; that is
   * the aperture problem, and no local method escapes it. And the linearisation
   * degrades past a few pixels of displacement, so genuinely fast motion is
   * understated and clipped at MAX_PIXELS_PER_FRAME.
   *
   * @param difference |I_t|, the absolute frame difference
   * @param gray the current frame, for the spatial gradient
   */
  update(
    difference: ArrayLike<number>,
    gray: ArrayLike<number>,
    width: number,
    height: number,
    dtSeconds: number,
    options: MotionSpeedOptions = {}
  ): MotionSpeedReport {
    this.ensure(width, height);
    const { speed, state, raw } = this;
    speed.fill(0);
    state.fill(STILL);
    raw.fill(0);

    const threshold = options.motionThreshold ?? 18;
    // A dt of zero would divide every speed to infinity, and a very small one
    // amplifies a single pixel of jitter into a white streak. Both are reported
    // as "no measurement" rather than guessed at.
    if (!(dtSeconds > 0.004) || width < 3 || height < 3) {
      this.lastReport = { ...EMPTY_REPORT, fullScale: options.fullScale ?? this.autoScale };
      return this.lastReport;
    }

    let peak = 0;
    let speedSum = 0;
    let speedCount = 0;
    let moving = 0;
    let unresolved = 0;
    let saturated = 0;

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        const change = difference[i] ?? 0;
        if (change < threshold) continue;
        moving++;

        // Central differences: a symmetric estimate of the local slope, which
        // is what the constraint needs. (High-frequency BLINDNESS is a real
        // property of central differences, but that matters when measuring
        // spectral energy, not when estimating a slope for this division.)
        const gx = ((gray[i + 1] ?? 0) - (gray[i - 1] ?? 0)) * 0.5;
        const gy = ((gray[i + width] ?? 0) - (gray[i - width] ?? 0)) * 0.5;
        const gradient = Math.hypot(gx, gy);

        if (gradient < GRADIENT_FLOOR) {
          // Something changed here with no edge to explain how far it went.
          // Dividing anyway would turn sensor noise into a confident speed.
          unresolved++;
          state[i] = UNRESOLVED;
          continue;
        }

        let pixelsPerFrame = change / gradient;
        if (pixelsPerFrame > MAX_PIXELS_PER_FRAME) {
          pixelsPerFrame = MAX_PIXELS_PER_FRAME;
          saturated++;
        }

        // Pixels per frame -> frame widths per second, so the reading survives
        // a change of frame rate or of analysis resolution.
        const widthsPerSecond = pixelsPerFrame / width / dtSeconds;
        raw[i] = widthsPerSecond;
        state[i] = RESOLVED;
        speedSum += widthsPerSecond;
        speedCount++;
        if (widthsPerSecond > peak) peak = widthsPerSecond;
      }
    }

    // Edges of the frame have no full neighbourhood, so any change there is
    // unmeasurable rather than still. They count toward `moving` as well: a
    // border pixel left out of that total while counted as unresolved makes the
    // unresolved FRACTION exceed one.
    for (let x = 0; x < width; x++) {
      moving += this.markBorder(difference, threshold, x, 0, width);
      moving += this.markBorder(difference, threshold, x, height - 1, width);
    }
    for (let y = 1; y < height - 1; y++) {
      moving += this.markBorder(difference, threshold, 0, y, width);
      moving += this.markBorder(difference, threshold, width - 1, y, width);
    }

    const filled = this.fillFlat(width, height, options.fillRadius ?? DEFAULT_FILL_RADIUS);
    unresolved = 0;
    for (let i = 0; i < width * height; i++) if (state[i] === UNRESOLVED) unresolved++;

    // Auto scale opens fast toward a new peak and closes slowly, so a single
    // quick pass is not immediately re-normalised into looking ordinary.
    if (options.autoScale !== false) {
      const target = Math.max(MIN_AUTO_SCALE, Math.min(MAX_AUTO_SCALE, peak));
      const rate = target > this.autoScale ? AUTO_RISE : AUTO_FALL;
      this.autoScale += (target - this.autoScale) * rate;
    }
    const fullScale = options.fullScale ?? Math.max(MIN_AUTO_SCALE, this.autoScale);

    for (let i = 0; i < width * height; i++) {
      if (state[i] === RESOLVED || state[i] === INFERRED) {
        speed[i] = clamp(raw[i] / fullScale, 0, 1);
      }
    }

    this.lastReport = {
      peakWidthsPerSecond: peak,
      meanWidthsPerSecond: speedCount ? speedSum / speedCount : 0,
      peakPixelsPerSecond: peak * width,
      movingFraction: moving / (width * height),
      unresolvedFraction: moving ? unresolved / moving : 0,
      inferredFraction: moving ? filled / moving : 0,
      saturatedFraction: speedCount ? saturated / speedCount : 0,
      fullScale
    };
    return this.lastReport;
  }

  /** @returns 1 if this border pixel was moving, so the caller can count it. */
  private markBorder(
    difference: ArrayLike<number>,
    threshold: number,
    x: number,
    y: number,
    width: number
  ): number {
    const i = y * width + x;
    if (this.state[i] !== STILL) return 0;
    if ((difference[i] ?? 0) < threshold) return 0;
    this.state[i] = UNRESOLVED;
    return 1;
  }

  /**
   * Carry measured speed into neighbouring pixels that had no gradient.
   *
   * A moving object's plain interior — a cheek, a wall, a coat — changes
   * brightness without carrying an edge to measure it by, so it lands in
   * UNRESOLVED with speed all around its rim. Growing that rim inward by a
   * bounded number of pixels describes the object better than leaving it
   * hollow, and the pixels it reaches are counted separately so an inference
   * never passes for a measurement.
   */
  private fillFlat(width: number, height: number, radius: number): number {
    if (radius <= 0) return 0;
    const { state, raw, scratch } = this;
    let filled = 0;

    for (let pass = 0; pass < radius; pass++) {
      scratch.set(state);
      let grew = 0;
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const i = y * width + x;
          if (scratch[i] !== UNRESOLVED) continue;
          let best = -1;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const n = i + dy * width + dx;
              if (scratch[n] !== RESOLVED && scratch[n] !== INFERRED) continue;
              if (raw[n] > best) best = raw[n];
            }
          }
          if (best < 0) continue;
          raw[i] = best;
          state[i] = INFERRED;
          grew++;
        }
      }
      filled += grew;
      // Nothing left adjacent to a measurement; further passes cannot help.
      if (!grew) break;
    }
    return filled;
  }
}

/**
 * Paint a normalised speed field as Ironbow over a dimmed grayscale scene.
 *
 * The scene stays faintly visible so a trail can be read against what it
 * crossed; without it a trail floats in a void and says nothing about where.
 */
export function renderMotionIronbow(
  gray: ArrayLike<number>,
  speed: ArrayLike<number>,
  state: ArrayLike<number>,
  out: Uint8ClampedArray,
  sceneDim = 0.22
): Uint8ClampedArray {
  const pixels = Math.floor(out.length / 4);
  for (let i = 0, p = 0; i < pixels; i++, p += 4) {
    if (state[i] === RESOLVED || state[i] === INFERRED) {
      const bin = Math.round(clamp(speed[i] ?? 0, 0, 1) * 255) * 3;
      out[p] = ironbowTable[bin];
      out[p + 1] = ironbowTable[bin + 1];
      out[p + 2] = ironbowTable[bin + 2];
    } else if (state[i] === UNRESOLVED) {
      out[p] = UNRESOLVED_COLOR[0];
      out[p + 1] = UNRESOLVED_COLOR[1];
      out[p + 2] = UNRESOLVED_COLOR[2];
    } else {
      const value = (gray[i] ?? 0) * sceneDim;
      out[p] = value;
      out[p + 1] = value;
      out[p + 2] = value;
    }
    out[p + 3] = 255;
  }
  return out;
}

export interface MotionTrailOptions {
  /** How long a trail takes to fade to nothing, in seconds. */
  exposureSeconds?: number;
  /** Keep the highest speed a pixel ever showed instead of the most recent. */
  keepFastest?: boolean;
  /** Dim a trail as it ages. Off holds every trail at full strength. */
  fade?: boolean;
}

export interface MotionTrailReport {
  /** Seconds the buffer has been accumulating without a reset. */
  elapsedSeconds: number;
  /** Fraction of the frame currently holding any trail, 0..1. */
  coverage: number;
  /** Fastest speed anywhere in the trail, normalised 0..1. */
  peakSpeed: number;
  exposureSeconds: number;
  framesAccumulated: number;
}

/**
 * Persistent motion trails at constant memory cost.
 *
 * A 60-second trail does not hold 60 seconds of frames: it holds two arrays the
 * size of one analysis frame — the speed seen at each pixel and how bright that
 * memory still is — and every frame decays the second and updates the first.
 * Memory is therefore identical at one second and at sixty.
 *
 * Two independent dimensions carry two independent facts, which is the whole
 * point of the mode:
 *
 *   hue        = how fast it was moving
 *   brightness = how long ago
 *
 * Decay is LINEAR over the exposure window rather than exponential, so
 * "30 seconds" means a trail is actually gone after thirty seconds instead of
 * merely faint. The window rolls continuously; there is no shutter to close.
 */
export class MotionTrailBuffer {
  private trailSpeed = new Float32Array(0);
  private trailAge = new Float32Array(0);
  private width = 0;
  private height = 0;
  private frames = 0;
  private elapsed = 0;
  private lastExposure = 0;

  /**
   * Seconds since each pixel last moved, within the trail window.
   *
   * Exposed so a custom lens can bind brightness to age the way the built-in
   * trail rendering does, rather than that pairing being available only from
   * inside this class.
   */
  get ageField(): Float32Array {
    return this.trailAge;
  }

  /** Speed recorded at each pixel when it last moved, in widths per second. */
  get speedFieldValues(): Float32Array {
    return this.trailSpeed;
  }

  get framesAccumulated(): number {
    return this.frames;
  }

  reset(): void {
    this.trailSpeed.fill(0);
    this.trailAge.fill(0);
    this.frames = 0;
    this.elapsed = 0;
  }

  private ensure(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.trailSpeed = new Float32Array(width * height);
    this.trailAge = new Float32Array(width * height);
    this.frames = 0;
    this.elapsed = 0;
  }

  update(
    speed: ArrayLike<number>,
    state: ArrayLike<number>,
    width: number,
    height: number,
    dtSeconds: number,
    options: MotionTrailOptions = {}
  ): MotionTrailReport {
    this.ensure(width, height);
    const exposure = Math.max(0.25, options.exposureSeconds ?? 5);
    const keepFastest = options.keepFastest ?? true;

    // Changing the window mid-run would otherwise leave trails decaying at the
    // old rate for a full cycle, which reads as the control having done nothing.
    if (this.lastExposure && Math.abs(exposure - this.lastExposure) > 1e-6) {
      const rescale = this.lastExposure / exposure;
      for (let i = 0; i < this.trailAge.length; i++) {
        if (this.trailAge[i] > 0) this.trailAge[i] = clamp(this.trailAge[i] * rescale, 0, 1);
      }
    }
    this.lastExposure = exposure;

    const dt = Math.max(0, dtSeconds);
    const decay = dt / exposure;
    const { trailSpeed, trailAge } = this;
    const pixels = width * height;

    let coverage = 0;
    let peak = 0;
    for (let i = 0; i < pixels; i++) {
      let age = trailAge[i] - decay;
      if (age < 0) age = 0;

      if (state[i] === RESOLVED || state[i] === INFERRED) {
        const value = speed[i] ?? 0;
        // A fresh mark always restores full brightness; only the recorded speed
        // is subject to keepFastest, so an object slowing down still leaves a
        // continuous, readable path.
        if (!keepFastest || age === 0 || value > trailSpeed[i]) trailSpeed[i] = value;
        age = 1;
      } else if (state[i] === UNRESOLVED && age === 0) {
        // Movement with no speed behind it still marks the path, at the floor of
        // the ramp, so an untrackable object is not silently erased.
        trailSpeed[i] = 0;
        age = 1;
      }

      trailAge[i] = age;
      if (age > 0) {
        coverage++;
        if (trailSpeed[i] > peak) peak = trailSpeed[i];
      }
    }

    this.frames++;
    this.elapsed += dt;
    return {
      elapsedSeconds: this.elapsed,
      coverage: pixels ? coverage / pixels : 0,
      peakSpeed: peak,
      exposureSeconds: exposure,
      framesAccumulated: this.frames
    };
  }

  render(
    gray: ArrayLike<number>,
    out: Uint8ClampedArray,
    options: MotionTrailOptions = {},
    sceneDim = 0.16
  ): Uint8ClampedArray {
    const fade = options.fade ?? true;
    const { trailSpeed, trailAge } = this;
    const pixels = Math.floor(out.length / 4);
    for (let i = 0, p = 0; i < pixels; i++, p += 4) {
      const age = trailAge[i] ?? 0;
      if (age <= 0) {
        const value = (gray[i] ?? 0) * sceneDim;
        out[p] = value;
        out[p + 1] = value;
        out[p + 2] = value;
        out[p + 3] = 255;
        continue;
      }
      const bin = Math.round(clamp(trailSpeed[i] ?? 0, 0, 1) * 255) * 3;
      // Age dims the trail toward the scene rather than toward black, so an old
      // trail settles into the picture instead of punching a hole in it.
      const strength = fade ? age : 1;
      const base = (gray[i] ?? 0) * sceneDim;
      out[p] = base + (ironbowTable[bin] - base) * strength;
      out[p + 1] = base + (ironbowTable[bin + 1] - base) * strength;
      out[p + 2] = base + (ironbowTable[bin + 2] - base) * strength;
      out[p + 3] = 255;
    }
    return out;
  }
}

/**
 * Resample a speed field onto a larger frame.
 *
 * A full-resolution still cannot re-run the flow at full resolution: cell size,
 * patch radius and search range all scale with the image, so a 4K still would
 * either match 125-pixel cells — which paints the sampling grid as huge flat
 * rectangles rather than the motion — or cost hundreds of millions of
 * operations to keep them fine.
 *
 * So the measurement stays at analysis resolution, where it was made, and only
 * the picture is enlarged: speed is interpolated smoothly, state is taken from
 * the nearest source pixel because "measured" and "inferred" are categories
 * that cannot be averaged. The saved frame is then the one that was on screen,
 * at full size, over a full-resolution scene.
 */
export function upscaleSpeedField(
  speed: ArrayLike<number>,
  state: ArrayLike<number>,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number
): { speed: Float32Array; state: Uint8Array } {
  const outSpeed = new Float32Array(targetWidth * targetHeight);
  const outState = new Uint8Array(targetWidth * targetHeight);
  if (sourceWidth < 1 || sourceHeight < 1) return { speed: outSpeed, state: outState };

  const scaleX = sourceWidth / targetWidth;
  const scaleY = sourceHeight / targetHeight;

  for (let y = 0; y < targetHeight; y++) {
    // Clamped at both ends. Half-pixel centring puts the first sample below
    // zero, and an unclamped negative fraction extrapolates past the edge of
    // the data instead of interpolating within it — which produced speeds
    // below zero and above full scale along every border.
    const sy = clamp((y + 0.5) * scaleY - 0.5, 0, sourceHeight - 1);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(sourceHeight - 1, y0 + 1);
    const fy = sy - y0;
    const ny = Math.min(sourceHeight - 1, Math.max(0, Math.round(sy)));

    for (let x = 0; x < targetWidth; x++) {
      const sx = clamp((x + 0.5) * scaleX - 0.5, 0, sourceWidth - 1);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const fx = sx - x0;
      const nx = Math.min(sourceWidth - 1, Math.max(0, Math.round(sx)));

      const target = y * targetWidth + x;
      outState[target] = state[ny * sourceWidth + nx] ?? STILL;

      const a = speed[y0 * sourceWidth + x0] ?? 0;
      const b = speed[y0 * sourceWidth + x1] ?? 0;
      const c = speed[y1 * sourceWidth + x0] ?? 0;
      const d = speed[y1 * sourceWidth + x1] ?? 0;
      const top = a + (b - a) * fx;
      const bottom = c + (d - c) * fx;
      outSpeed[target] = top + (bottom - top) * fy;
    }
  }

  return { speed: outSpeed, state: outState };
}
