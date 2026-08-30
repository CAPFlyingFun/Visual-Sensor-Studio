/**
 * Camera layers that work in TIME rather than in space.
 *
 * Every mode here holds state across frames, which is what separates them from
 * a filter: an edge map can be computed from one frame, but "what does this
 * scene normally look like" or "what is oscillating" cannot. They all keep
 * constant memory — a fixed number of frame-sized buffers — so a layer running
 * for an hour costs what it cost in the first second.
 */

import { clamp } from '../core/math.js';

/* ------------------------------------------------------------------ *
 * Motion amplification
 * ------------------------------------------------------------------ */

/**
 * Amplify movement too small to see.
 *
 * Two exponential averages of each pixel, one fast and one slow. Their
 * DIFFERENCE is a temporal band-pass: changes slower than the slow filter are
 * cancelled, changes faster than the fast one are not captured, and what
 * survives is movement in between. Multiply that band and add it back and a
 * wall breathing, a string humming or a tripod creeping becomes visible.
 *
 * This is the cheap relative of Eulerian video magnification — the temporal
 * filtering without the spatial pyramid, which is the part that costs.
 *
 * THREE LIMITS, all of which show up immediately if ignored:
 *  - It amplifies noise as readily as motion, because both live in the band.
 *  - It magnifies INTENSITY change, which corresponds to movement only where
 *    there is a gradient for movement to change. A flat wall that moves shows
 *    nothing; the edge of it shows a lot.
 *  - Large motion breaks it. The linear assumption holds for displacements
 *    small against the local edge, and past that it produces ghosting rather
 *    than a bigger version of the truth.
 */
export interface AmplifyOptions {
  /** How much the band is multiplied. */
  gain?: number;
  /** Fast filter coefficient, 0..1. Higher follows the frame more closely. */
  fast?: number;
  /** Slow filter coefficient, 0..1. Lower holds a longer memory. */
  slow?: number;
}

export class MotionAmplifier {
  private fastBuffer = new Float32Array(0);
  private slowBuffer = new Float32Array(0);
  private width = 0;
  private height = 0;
  private primed = false;
  private lastBand = 0;

  /** Mean absolute band strength, for a readout of how much is being added. */
  get bandStrength(): number {
    return this.lastBand;
  }

  reset(): void {
    this.primed = false;
    this.lastBand = 0;
  }

  private ensure(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.fastBuffer = new Float32Array(width * height);
    this.slowBuffer = new Float32Array(width * height);
    this.primed = false;
  }

  render(
    gray: ArrayLike<number>,
    width: number,
    height: number,
    out: Uint8ClampedArray,
    options: AmplifyOptions = {}
  ): Uint8ClampedArray {
    this.ensure(width, height);
    const gain = options.gain ?? 12;
    const fastRate = clamp(options.fast ?? 0.5, 0.01, 1);
    const slowRate = clamp(options.slow ?? 0.06, 0.001, 1);
    const { fastBuffer, slowBuffer } = this;
    const pixels = width * height;

    if (!this.primed) {
      // Seeded from the first frame, not from zero: starting at zero makes the
      // opening second a full-scale transient that never happened.
      for (let i = 0; i < pixels; i++) {
        fastBuffer[i] = gray[i] ?? 0;
        slowBuffer[i] = gray[i] ?? 0;
      }
      this.primed = true;
    }

    let bandTotal = 0;
    for (let i = 0, p = 0; i < pixels; i++, p += 4) {
      const value = gray[i] ?? 0;
      fastBuffer[i] += (value - fastBuffer[i]) * fastRate;
      slowBuffer[i] += (value - slowBuffer[i]) * slowRate;

      const band = fastBuffer[i] - slowBuffer[i];
      bandTotal += band < 0 ? -band : band;

      const amplified = value + band * gain;
      out[p] = amplified;
      out[p + 1] = amplified;
      out[p + 2] = amplified;
      out[p + 3] = 255;
    }
    this.lastBand = pixels ? bandTotal / pixels : 0;
    return out;
  }
}

/* ------------------------------------------------------------------ *
 * Background model
 * ------------------------------------------------------------------ */

export interface BackgroundReport {
  /** Fraction of the frame that differs from the learned background. */
  foregroundFraction: number;
  /** Frames folded into the model since it was last reset. */
  frames: number;
  /** True once the model has seen enough frames to be worth subtracting. */
  ready: boolean;
}

/** Frames before the background is trusted enough to subtract from. */
const BACKGROUND_WARMUP = 25;

/**
 * What this scene normally looks like, and what does not belong in it.
 *
 * Frame difference only compares ADJACENT frames, so anything moving slowly
 * almost vanishes — a person creeping, a shadow travelling, a cloud. Comparing
 * against a learned background instead makes "not normally here" visible
 * regardless of how slowly it arrived.
 *
 * The model is sigma-delta: the background steps one intensity level toward
 * each new observation per frame, and a variance estimate follows the same way.
 * No multiplication, no frame history, one byte per pixel — and because the
 * background can only move a level at a time, an object crossing faster than
 * that cannot drag the background along with it. A very slow mover eventually
 * IS absorbed, which is the honest trade for a model that adapts to daylight.
 */
export class BackgroundModel {
  private background = new Uint8ClampedArray(0);
  private variance = new Uint8ClampedArray(0);
  /** Foreground mask, 0 or 255. */
  mask = new Uint8ClampedArray(0);
  private width = 0;
  private height = 0;
  private frames = 0;

  get framesLearned(): number {
    return this.frames;
  }

  reset(): void {
    this.frames = 0;
  }

  private ensure(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.background = new Uint8ClampedArray(width * height);
    this.variance = new Uint8ClampedArray(width * height);
    this.mask = new Uint8ClampedArray(width * height);
    this.frames = 0;
  }

  update(gray: ArrayLike<number>, width: number, height: number): BackgroundReport {
    this.ensure(width, height);
    const { background, variance, mask } = this;
    const pixels = width * height;

    if (this.frames === 0) {
      // The first frame IS the background until there is evidence otherwise.
      for (let i = 0; i < pixels; i++) {
        background[i] = gray[i] ?? 0;
        variance[i] = 8;
      }
    }

    let foreground = 0;
    for (let i = 0; i < pixels; i++) {
      const value = gray[i] ?? 0;
      const bg = background[i];

      // One level per frame, in whichever direction: an approximation of a
      // running median that costs a comparison rather than a multiply.
      if (value > bg) background[i] = bg + 1;
      else if (value < bg) background[i] = bg - 1;

      const delta = Math.abs(value - background[i]);
      // The variance estimate tracks the usual size of that difference, so a
      // noisy or restless region needs a bigger excursion to count. A fixed
      // threshold would flag every leaf and no slow mover.
      const target = delta * 4;
      if (target > variance[i]) variance[i] = variance[i] + 1;
      else if (target < variance[i]) variance[i] = variance[i] - 1;

      const threshold = Math.max(12, variance[i]);
      const isForeground = this.frames >= BACKGROUND_WARMUP && delta > threshold;
      mask[i] = isForeground ? 255 : 0;
      if (isForeground) foreground++;
    }

    this.frames++;
    return {
      foregroundFraction: pixels ? foreground / pixels : 0,
      frames: this.frames,
      ready: this.frames >= BACKGROUND_WARMUP
    };
  }

  /** The scene with the background dimmed away and what does not belong lit. */
  render(gray: ArrayLike<number>, out: Uint8ClampedArray, sceneDim = 0.18): Uint8ClampedArray {
    const pixels = Math.floor(out.length / 4);
    for (let i = 0, p = 0; i < pixels; i++, p += 4) {
      const value = gray[i] ?? 0;
      if (this.mask[i]) {
        // Warm and bright for what is new, so it reads against the cold scene.
        out[p] = 255;
        out[p + 1] = clamp(120 + value * 0.5, 0, 255);
        out[p + 2] = clamp(value * 0.3, 0, 255);
      } else {
        const dim = value * sceneDim;
        out[p] = dim;
        out[p + 1] = dim;
        out[p + 2] = dim * 1.25;
      }
      out[p + 3] = 255;
    }
    return out;
  }
}

/* ------------------------------------------------------------------ *
 * Chronochrome
 * ------------------------------------------------------------------ */

/**
 * Three moments in time, one per colour channel.
 *
 * Red carries the oldest tap, green the middle, blue the newest. Anything that
 * has not moved lands identically in all three and comes out grey, so a static
 * scene simply looks like itself. Anything that moved lands in different places
 * and splits into coloured fringes — and because the channels are ordered in
 * time, the ORDER of the colours gives the direction. Red leading means the
 * object came from there; blue leading means it is heading there.
 *
 * That is the difference from Speed: this says which way, not how fast.
 */
export class Chronochrome {
  private ring: Uint8ClampedArray[] = [];
  private width = 0;
  private height = 0;
  private index = 0;
  private filled = 0;

  reset(): void {
    this.index = 0;
    this.filled = 0;
  }

  private ensure(width: number, height: number, spacing: number): void {
    const needed = spacing * 2 + 1;
    if (this.width === width && this.height === height && this.ring.length === needed) return;
    this.width = width;
    this.height = height;
    this.ring = Array.from({ length: needed }, () => new Uint8ClampedArray(width * height));
    this.index = 0;
    this.filled = 0;
  }

  render(
    gray: ArrayLike<number>,
    width: number,
    height: number,
    out: Uint8ClampedArray,
    spacing = 4
  ): Uint8ClampedArray {
    const gap = Math.max(1, Math.round(spacing));
    this.ensure(width, height, gap);
    const size = this.ring.length;

    this.ring[this.index].set(gray as ArrayLike<number> as Uint8ClampedArray);
    const newest = this.index;
    this.index = (this.index + 1) % size;
    if (this.filled < size) this.filled++;

    // Until the ring has filled, every tap resolves to the newest frame, so the
    // picture is grey rather than wrong — a false fringe from an empty buffer
    // would look exactly like real motion.
    const tap = (back: number): Uint8ClampedArray =>
      this.ring[this.filled >= size ? (newest - back + size * 2) % size : newest];

    const oldest = tap(gap * 2);
    const middle = tap(gap);
    const latest = this.ring[newest];

    const pixels = width * height;
    for (let i = 0, p = 0; i < pixels; i++, p += 4) {
      out[p] = oldest[i];
      out[p + 1] = middle[i];
      out[p + 2] = latest[i];
      out[p + 3] = 255;
    }
    return out;
  }
}

/* ------------------------------------------------------------------ *
 * Slit-scan
 * ------------------------------------------------------------------ */

/**
 * One column per frame, so the horizontal axis becomes TIME.
 *
 * The camera stops showing a place and starts showing a history of one line
 * through it. On a tripod this turns minutes into a single readable image: a
 * pendulum draws a sine wave, a passing object draws a slanted stripe whose
 * slope is its speed, and a periodic vibration draws a stack of even bands.
 *
 * Written into a ring so nothing is copied per frame — shifting the whole image
 * left every frame would be the obvious way and is pure waste.
 */
export class SlitScan {
  private strip = new Uint8ClampedArray(0);
  private width = 0;
  private height = 0;
  private cursor = 0;
  private filled = 0;

  get columnsCollected(): number {
    return this.filled;
  }

  reset(): void {
    this.cursor = 0;
    this.filled = 0;
    this.strip.fill(0);
  }

  private ensure(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.strip = new Uint8ClampedArray(width * height);
    this.cursor = 0;
    this.filled = 0;
  }

  /**
   * @param columnFraction where across the frame the sampled line sits, 0..1
   */
  render(
    gray: ArrayLike<number>,
    width: number,
    height: number,
    out: Uint8ClampedArray,
    columnFraction = 0.5
  ): Uint8ClampedArray {
    this.ensure(width, height);
    const source = clamp(Math.round(columnFraction * (width - 1)), 0, width - 1);
    const { strip } = this;

    for (let y = 0; y < height; y++) strip[y * width + this.cursor] = gray[y * width + source] ?? 0;
    this.cursor = (this.cursor + 1) % width;
    if (this.filled < width) this.filled++;

    // Read out so the newest column is at the right edge and time runs left to
    // right, which is the direction a reader expects a history to run.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const from = (this.cursor + x) % width;
        const value = strip[y * width + from];
        const p = (y * width + x) * 4;
        out[p] = value;
        out[p + 1] = value;
        out[p + 2] = value;
        out[p + 3] = 255;
      }
    }
    return out;
  }
}
