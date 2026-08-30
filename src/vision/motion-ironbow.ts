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
  /** Of the moving pixels, the fraction whose speed came from a neighbouring cell. */
  inferredFraction: number;
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
  fullScale: 0
};

/** Slowest full scale auto mode will settle on, so a still scene stays calm. */
const MIN_AUTO_SCALE = 0.05;
const MAX_AUTO_SCALE = 4;
/** Auto scale opens quickly to catch a fast pass and closes slowly to stay readable. */
const AUTO_RISE = 0.5;
const AUTO_FALL = 0.04;

export interface FlowLike {
  vectors: ReadonlyArray<{ x: number; y: number; magnitude: number }>;
  cellSize: number;
}

/**
 * Per-pixel image speed, normalised for the colour ramp.
 *
 * Owns its buffers and resizes them only when the analysis frame changes, so a
 * running preview allocates nothing per frame.
 */
export class MotionSpeedField {
  /** Normalised speed per pixel, 0..1. Zero means still. */
  speed = new Float32Array(0);
  /** STILL, RESOLVED or UNRESOLVED per pixel. */
  state = new Uint8Array(0);
  /** Speed per flow cell, at cell resolution rather than pixel resolution. */
  private cellSpeed = new Float32Array(0);
  /** The same grid after a one-cell dilation. */
  private cellFilled = new Float32Array(0);
  private cellsX = 0;
  private cellsY = 0;
  private originX = 0;
  private originY = 0;
  private cellSize = 0;
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
    this.cellSpeed.fill(-1);
    this.cellFilled.fill(-1);
  }

  private ensure(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.speed = new Float32Array(width * height);
    this.state = new Uint8Array(width * height);
  }

  /**
   * Lay the accepted vectors onto a grid at cell resolution and dilate it by
   * one cell.
   *
   * At cell resolution this is a few hundred entries rather than a few tens of
   * thousands, so the dilation is free — the earlier version painted every
   * vector across its own box in the full-size frame, which cost far more and
   * could not reach past a cell edge at all.
   */
  private buildCellGrid(flow: FlowLike, width: number, height: number): boolean {
    const cellSize = Math.max(1, Math.round(flow.cellSize));
    let minX = Infinity;
    let minY = Infinity;
    for (const vector of flow.vectors) {
      if (vector.x < minX) minX = vector.x;
      if (vector.y < minY) minY = vector.y;
    }
    if (!Number.isFinite(minX)) return false;

    // Vector positions are cell centres at an offset the flow module picks, so
    // the grid takes its PHASE from the vectors but its extent from the frame.
    // Anchoring it to the vectors' own bounding box instead put every pixel
    // outside that box off the grid, where it read as unresolved no matter what
    // had been measured — the dilation then had nothing to reach into.
    this.cellSize = cellSize;
    this.originX = ((minX % cellSize) + cellSize) % cellSize;
    this.originY = ((minY % cellSize) + cellSize) % cellSize;
    this.cellsX = Math.max(1, Math.ceil((width - this.originX) / cellSize) + 1);
    this.cellsY = Math.max(1, Math.ceil((height - this.originY) / cellSize) + 1);

    const cells = this.cellsX * this.cellsY;
    if (this.cellSpeed.length < cells) {
      this.cellSpeed = new Float32Array(cells);
      this.cellFilled = new Float32Array(cells);
    }
    this.cellSpeed.fill(-1, 0, cells);
    this.cellFilled.fill(-1, 0, cells);
    return true;
  }

  /**
   * @param difference absolute frame difference, analysis resolution
   * @param flow block flow for the same pair of frames, or null
   * @param dtSeconds elapsed time between the two frames
   */
  update(
    difference: ArrayLike<number>,
    flow: FlowLike | null,
    width: number,
    height: number,
    dtSeconds: number,
    options: MotionSpeedOptions = {}
  ): MotionSpeedReport {
    this.ensure(width, height);
    const { speed, state } = this;
    speed.fill(0);
    state.fill(STILL);

    const threshold = options.motionThreshold ?? 18;
    // A dt of zero would divide every speed to infinity, and a very small one
    // amplifies a single pixel of jitter into a white streak. Both are reported
    // as "no measurement" rather than guessed at.
    if (!(dtSeconds > 0.004) || width < 2 || height < 2) {
      this.lastReport = { ...EMPTY_REPORT, fullScale: options.fullScale ?? this.autoScale };
      return this.lastReport;
    }

    const hasFlow = !!flow && flow.vectors.length > 0 && flow.cellSize > 0
      && this.buildCellGrid(flow, width, height);

    if (hasFlow && flow) {
      const { cellSpeed, cellsX, cellsY, originX, originY, cellSize } = this;
      for (const vector of flow.vectors) {
        // Pixels per frame -> frame widths per second: the frame-rate and
        // resolution independence this whole module rests on.
        const widthsPerSecond = vector.magnitude / width / dtSeconds;
        const col = Math.round((vector.x - originX) / cellSize);
        const row = Math.round((vector.y - originY) / cellSize);
        if (col < 0 || row < 0 || col >= cellsX || row >= cellsY) continue;
        const index = row * cellsX + col;
        // Two vectors in one grid slot keep the faster claim; a slow background
        // must not erase a fast object crossing the same cell.
        if (widthsPerSecond > cellSpeed[index]) cellSpeed[index] = widthsPerSecond;
      }

      // One-cell dilation, so a textured edge can explain the plain interior
      // it belongs to without reaching any further than that.
      const { cellFilled } = this;
      for (let row = 0; row < cellsY; row++) {
        for (let col = 0; col < cellsX; col++) {
          const index = row * cellsX + col;
          let best = cellSpeed[index];
          if (best < 0) {
            for (let dy = -1; dy <= 1; dy++) {
              const ny = row + dy;
              if (ny < 0 || ny >= cellsY) continue;
              for (let dx = -1; dx <= 1; dx++) {
                const nx = col + dx;
                if (nx < 0 || nx >= cellsX) continue;
                const neighbour = cellSpeed[ny * cellsX + nx];
                if (neighbour > best) best = neighbour;
              }
            }
          }
          cellFilled[index] = best;
        }
      }
    }

    let peak = 0;
    let speedSum = 0;
    let speedCount = 0;
    let moving = 0;
    let unresolved = 0;
    let inferred = 0;
    const pixels = width * height;
    const { cellSpeed, cellFilled, cellsX, cellsY, originX, originY, cellSize } = this;

    for (let y = 0; y < height; y++) {
      // A pixel takes the cell whose centre it is nearest, which bounds a
      // direct reading to half a cell and a carried one to one and a half.
      const row = hasFlow ? Math.round((y - originY) / cellSize) : -1;
      const rowInside = row >= 0 && row < cellsY;
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if ((difference[i] ?? 0) < threshold) continue;
        moving++;

        if (!rowInside) {
          unresolved++;
          state[i] = UNRESOLVED;
          continue;
        }
        const col = Math.round((x - originX) / cellSize);
        if (col < 0 || col >= cellsX) {
          unresolved++;
          state[i] = UNRESOLVED;
          continue;
        }

        const index = row * cellsX + col;
        const measured = cellSpeed[index];
        const carried = cellFilled[index];
        if (measured >= 0) {
          state[i] = RESOLVED;
          speed[i] = measured;
          speedSum += measured;
          speedCount++;
          if (measured > peak) peak = measured;
        } else if (carried >= 0) {
          inferred++;
          state[i] = INFERRED;
          speed[i] = carried;
          speedSum += carried;
          speedCount++;
          if (carried > peak) peak = carried;
        } else {
          unresolved++;
          state[i] = UNRESOLVED;
        }
      }
    }

    // Auto scale opens fast toward a new peak and closes slowly, so a single
    // quick pass is not immediately re-normalised into looking ordinary.
    if (options.autoScale !== false) {
      const target = Math.max(MIN_AUTO_SCALE, Math.min(MAX_AUTO_SCALE, peak));
      const rate = target > this.autoScale ? AUTO_RISE : AUTO_FALL;
      this.autoScale += (target - this.autoScale) * rate;
    }
    const fullScale = options.fullScale ?? Math.max(MIN_AUTO_SCALE, this.autoScale);

    // Normalise in place now that the scale is known.
    for (let i = 0; i < pixels; i++) {
      if (state[i] === RESOLVED || state[i] === INFERRED) {
        speed[i] = clamp(speed[i] / fullScale, 0, 1);
      }
    }

    this.lastReport = {
      peakWidthsPerSecond: peak,
      meanWidthsPerSecond: speedCount ? speedSum / speedCount : 0,
      peakPixelsPerSecond: peak * width,
      movingFraction: moving / pixels,
      unresolvedFraction: moving ? unresolved / moving : 0,
      inferredFraction: moving ? inferred / moving : 0,
      fullScale
    };
    return this.lastReport;
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
