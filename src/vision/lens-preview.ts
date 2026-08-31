/**
 * A known signal to design a lens against.
 *
 * Designing a false-colour mapping while pointing a phone at a still room is
 * guesswork: a motion channel reads zero everywhere, so every palette looks
 * identical and nothing you change appears to do anything. This module
 * generates a synthetic scene with MEASURED, STATED properties — bars moving
 * at three known speeds, a static checkerboard, a smooth gradient — so the
 * effect of a range or a colour stop is visible immediately and comparable
 * against a number you can read off the caption.
 *
 * The important part: the synthetic frames are pushed through the SAME
 * modules the camera uses. The speed field really is `MotionSpeedField`, the
 * edges really are `sobelEdges`. Nothing here fakes a channel, so what the
 * preview shows is what the lens will do to a real frame carrying the same
 * values. A preview that synthesised its own channels would be a drawing of a
 * lens rather than a test of one.
 */

import { clamp } from '../core/math.js';
import { absoluteDifference, reliefField, sobelEdges } from './frame-processing.js';
import { MotionSpeedField, MotionTrailBuffer, UNRESOLVED } from './motion-ironbow.js';
import { BackgroundModel } from './layers.js';
import { renderLens, type ChannelSource, type CustomLens } from './lens.js';

/** The bars' speeds, in frame widths per second. Quoted to the user. */
export const TEST_BAR_SPEEDS = [0.05, 0.15, 0.30] as const;

/** Deterministic value noise, so the static texture never reads as motion. */
function staticNoise(x: number, y: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * Draw the test scene at a given moment.
 *
 * Everything is a function of `seconds` alone, so the same time always
 * produces the same frame and a preview cannot drift into a state that is
 * hard to reproduce.
 */
export function drawTestScene(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  seconds: number
): void {
  for (let y = 0; y < height; y++) {
    const v = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x++) {
      // A smooth vertical gradient plus fixed grain. The grain matters: the
      // speed estimate divides by the local image gradient, and a perfectly
      // flat region has none, so a scene without texture would read as
      // unresolved everywhere and teach the wrong lesson.
      const base = 26 + v * 54 + staticNoise(x, y) * 14;
      gray[y * width + x] = base;
    }
  }

  // A static high-contrast checkerboard. Strong edges, zero speed — the patch
  // that shows the difference between "an edge is here" and "something moved".
  const checkX = Math.round(width * 0.06);
  const checkY = Math.round(height * 0.62);
  const checkSize = Math.max(8, Math.round(Math.min(width, height) * 0.26));
  const cell = Math.max(2, Math.round(checkSize / 6));
  for (let y = 0; y < checkSize; y++) {
    for (let x = 0; x < checkSize; x++) {
      const px = checkX + x;
      const py = checkY + y;
      if (px >= width || py >= height) continue;
      const on = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      gray[py * width + px] = on ? 232 : 30;
    }
  }

  // Three bars crossing at known speeds, each wrapping around independently.
  const barHeight = Math.max(3, Math.round(height * 0.1));
  const barWidth = Math.max(4, Math.round(width * 0.09));
  TEST_BAR_SPEEDS.forEach((speed, index) => {
    const travel = width + barWidth * 2;
    const offset = ((seconds * speed * width) % travel + travel) % travel;
    const left = Math.round(offset - barWidth);
    const top = Math.round(height * (0.08 + index * 0.16));
    const shade = 200 + index * 18;
    for (let y = top; y < top + barHeight; y++) {
      if (y < 0 || y >= height) continue;
      for (let x = left; x < left + barWidth; x++) {
        if (x < 0 || x >= width) continue;
        // Textured, and the texture TRAVELS WITH THE BAR. A flat interior has
        // no gradient for the normal-flow estimate to divide by, so a plain
        // block is measurable only at its two edges and saturates everywhere
        // else — which made the fastest reading in the scene an artefact
        // rather than the bar's stated speed.
        const local = staticNoise(x - left + index * 31, y - top);
        gray[y * width + x] = shade - 70 * local;
      }
    }
  });

  // A circle rising and falling, so at least one thing moves across the bars
  // rather than with them.
  const radius = Math.max(3, Math.round(Math.min(width, height) * 0.09));
  const cx = Math.round(width * 0.86);
  const cy = Math.round(height * (0.5 + 0.34 * Math.sin(seconds * 1.6)));
  for (let y = cy - radius; y <= cy + radius; y++) {
    if (y < 0 || y >= height) continue;
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (x < 0 || x >= width) continue;
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) {
        gray[y * width + x] = 246 - 66 * staticNoise(x - cx + 17, y - cy);
      }
    }
  }

  // Something that is not normally there: a block that comes in from off the
  // left, pauses, and leaves again on a ten-second cycle. That is what the
  // background model is built to notice.
  //
  // It ENTERS THROUGH THE EDGE rather than appearing in place. An object that
  // pops into existence has moved infinitely far in one frame, which pins the
  // speed estimate at its saturation clamp and made the fastest thing in the
  // scene an artefact of the scene generator rather than a bar with a stated
  // speed. Sliding in is both physical and measurable.
  const vw = Math.max(5, Math.round(width * 0.11));
  const vh = Math.max(5, Math.round(height * 0.2));
  const cycle = 10;
  const phase = ((seconds % cycle) + cycle) % cycle / cycle;
  // Out and back, at rest at both ends of the cycle, off-frame at the start.
  const reach = width * 0.5;
  const vx = Math.round(-vw + (reach + vw) * (0.5 - 0.5 * Math.cos(phase * Math.PI * 2)));
  const vy = Math.round(height * 0.68);
  for (let y = vy; y < vy + vh && y < height; y++) {
    for (let x = Math.max(0, vx); x < vx + vw && x < width; x++) {
      gray[y * width + x] = 150 - 40 * staticNoise(x - vx + 5, y - vy);
    }
  }
}

/**
 * A self-contained pipeline over the test scene.
 *
 * It owns its own speed field, trail buffer and background model rather than
 * borrowing the camera's, so previewing a lens can never disturb what the
 * camera modes have accumulated — a preview that reset the live trail buffer
 * would destroy an observation in progress.
 */
export class LensPreview {
  private gray: Uint8ClampedArray;
  private previous: Uint8ClampedArray;
  private difference: Uint8ClampedArray;
  private edges: Uint8ClampedArray;
  private relief: Uint8ClampedArray;
  private valid: Uint8Array;
  private ageValid: Uint8Array;
  private rgba: Uint8ClampedArray;
  private speedField = new MotionSpeedField();
  private trails = new MotionTrailBuffer();
  private background = new BackgroundModel();
  private hasPrevious = false;
  private elapsed = 0;

  constructor(readonly width: number, readonly height: number) {
    const count = width * height;
    this.gray = new Uint8ClampedArray(count);
    this.previous = new Uint8ClampedArray(count);
    this.difference = new Uint8ClampedArray(count);
    this.edges = new Uint8ClampedArray(count);
    this.relief = new Uint8ClampedArray(count);
    this.valid = new Uint8Array(count);
    this.ageValid = new Uint8Array(count);
    this.rgba = new Uint8ClampedArray(count * 4);
  }

  reset(): void {
    this.hasPrevious = false;
    this.elapsed = 0;
    this.speedField.reset();
    this.trails.reset();
    this.background.reset();
  }

  /**
   * Advance by `dtSeconds` and paint the lens.
   *
   * The step is FIXED by the caller rather than read from a clock, so the
   * quoted bar speeds stay true even when the browser throttles the preview
   * in a background tab. A wall-clock step would make the caption a lie
   * exactly when nobody was looking.
   */
  step(lens: CustomLens, dtSeconds: number): Uint8ClampedArray {
    const { width, height } = this;
    this.previous.set(this.gray);
    this.elapsed += dtSeconds;
    drawTestScene(this.gray, width, height, this.elapsed);

    if (this.hasPrevious) {
      absoluteDifference(this.gray, this.previous, this.difference);
    } else {
      this.difference.fill(0);
    }

    this.speedField.update(this.difference, this.gray, width, height, this.hasPrevious ? dtSeconds : 0);
    this.trails.update(this.speedField.speed, this.speedField.state, width, height, dtSeconds, {
      exposureSeconds: 4
    });
    this.background.update(this.gray, width, height);
    this.hasPrevious = true;

    renderLens(lens, this.sources(lens), this.gray, width, height, this.rgba);
    return this.rgba;
  }

  private sources(lens: CustomLens): ChannelSource {
    const { width, height } = this;
    const count = width * height;
    const needed = new Set([lens.color.channel, lens.brightness?.channel]);
    const sources: ChannelSource = {};

    if (needed.has('luma')) sources.luma = { values: this.gray };
    if (needed.has('change') && this.hasPrevious) sources.change = { values: this.difference };
    if (needed.has('edges') || needed.has('relief')) {
      sobelEdges(this.gray, width, height, this.edges);
      if (needed.has('edges')) sources.edges = { values: this.edges };
      if (needed.has('relief')) {
        sources.relief = { values: reliefField(this.gray, width, height, this.relief, this.edges) };
      }
    }
    if (needed.has('speed')) {
      const state = this.speedField.state;
      for (let i = 0; i < count; i++) this.valid[i] = state[i] === UNRESOLVED ? 0 : 1;
      sources.speed = { values: this.speedField.rawSpeed, valid: this.valid };
    }
    if (needed.has('age')) {
      const trailSpeed = this.trails.speedFieldValues;
      for (let i = 0; i < count; i++) this.ageValid[i] = trailSpeed[i] > 0 ? 1 : 0;
      sources.age = { values: this.trails.ageField, valid: this.ageValid };
    }
    if (needed.has('novelty') && this.background.warmedUp) {
      sources.novelty = { values: this.background.deviation };
    }
    return sources;
  }
}

/**
 * Ready-made ramps, so a first lens is one tap rather than six colour pickers.
 *
 * These are STARTING POINTS. Every one of them is editable afterwards, which
 * is the whole point of the feature — a preset that could not be taken apart
 * would just be another built-in mode.
 */
export const RAMP_PRESETS: readonly { name: string; stops: { at: number; color: string }[] }[] = [
  {
    name: 'Ironbow',
    stops: [
      { at: 0, color: '#000018' },
      { at: 0.3, color: '#5c0f6e' },
      { at: 0.6, color: '#e04a1a' },
      { at: 0.85, color: '#ffc814' },
      { at: 1, color: '#ffffff' }
    ]
  },
  {
    name: 'Ice',
    stops: [
      { at: 0, color: '#03121f' },
      { at: 0.5, color: '#2f9fd6' },
      { at: 1, color: '#eafaff' }
    ]
  },
  {
    name: 'Meadow',
    stops: [
      { at: 0, color: '#120a2a' },
      { at: 0.45, color: '#1f7a5a' },
      { at: 0.8, color: '#9ed64a' },
      { at: 1, color: '#fdffd0' }
    ]
  },
  {
    name: 'Mono',
    stops: [
      { at: 0, color: '#000000' },
      { at: 1, color: '#ffffff' }
    ]
  },
  {
    name: 'Neon',
    stops: [
      { at: 0, color: '#05000f' },
      { at: 0.4, color: '#7b1fa2' },
      { at: 0.7, color: '#ff2d95' },
      { at: 1, color: '#3dfaff' }
    ]
  },
  {
    name: 'Paper',
    stops: [
      { at: 0, color: '#f6f2e8' },
      { at: 0.6, color: '#8a8474' },
      { at: 1, color: '#12100c' }
    ]
  }
];

/** Clamp a preview step so a paused tab cannot fast-forward the scene. */
export function previewStep(dtSeconds: number): number {
  return clamp(dtSeconds, 0, 0.2);
}
