/**
 * STEADINESS — how still the phone is being held, and whether that is still
 * enough to photograph.
 *
 * Joshua, 2026-09-02: "with the stabilization with gyro, would be good to add
 * an auto picture take once it gets a stable over 70% hold still for best
 * image clarity."
 *
 * The gyro is already telling us. vision/alignment.ts turns a rotation into
 * the pixels it moves the picture by; this asks the same question of the
 * rotation RATE and answers the one thing that decides whether a still comes
 * out sharp: how far the scene travels across the sensor while the shutter is
 * open. Everything here is that one number wearing different clothes.
 *
 * WHY A RATE AND NOT AN ANGLE. The aligner cares how far the phone has drifted
 * FROM somewhere — a total. Blur does not care where the phone started: a
 * phone can be a long way from its anchor and perfectly still, which is a
 * sharp photograph, or back exactly where it began and swinging through, which
 * is not. So this is a derivative, and it comes from the same
 * `rotationSince` the aligner uses rather than from a second sensor path —
 * two readings of one movement that could disagree is a bug waiting for a
 * confusing screenshot.
 *
 * WHAT THE PERCENTAGE MEANS, because a bare percentage means nothing:
 *
 *     smear = focal length (px) x rotation rate (rad/s) x shutter (s)
 *
 * measured in pixels of the FULL-SIZE PHOTO, since that is the picture whose
 * clarity is in question. 100% is not moving at all; 0% is smearing by
 * BLUR_LIMIT_PIXELS, which is where a 12 MP frame stops looking sharp. The
 * readout shows the degrees per second and the pixels alongside, so the
 * percentage can always be checked against something real.
 *
 * THE SHUTTER TIME IS A STAND-IN. What actually smears a photo is the
 * exposure, and WebKit rarely reports it. The frame interval — one over the
 * delivered rate — is used instead, and every reading says so. It is the
 * right order of magnitude in daylight and an UNDERSTATEMENT in a dark room,
 * where the camera holds the shutter open longer than a frame: there the real
 * blur is worse than this says, never better.
 */

import { MAX_SMALL_ANGLE_RADIANS } from './alignment.js';

/**
 * The smear, in pixels of a full-size photo, at which steadiness reads zero.
 *
 * Six pixels across 4032 is about 1.8 pixels once the frame is fitted to a
 * phone screen — soft enough to see, and the point of calling it 0%. It is a
 * TUNING ANCHOR chosen to put Joshua's 70% at a hold a hand can actually
 * achieve (about 1.1 degrees a second), not a measured threshold of human
 * perception. If 70% turns out to be unreachable or too easy on a real hand,
 * this is the number to move.
 */
export const BLUR_LIMIT_PIXELS = 6;

/** Joshua's number: hold above this and the shutter fires. */
export const DEFAULT_STEADY_THRESHOLD = 0.7;

/**
 * How long the hold must last before firing.
 *
 * A single steady sample is not a steady hand — a phone swinging through the
 * middle of a movement reads as still for one frame at the moment it changes
 * direction. Requiring the reading to SURVIVE is what makes this "hold still"
 * rather than "be still for an instant".
 */
export const HOLD_MS = 400;

/**
 * Once holding, the reading may sag this far below the threshold without
 * resetting the clock.
 *
 * Without it a reading sitting exactly on 70% chatters across the line on
 * sensor noise alone and the hold never completes, which would look like the
 * feature simply not working.
 */
export const RELEASE_MARGIN = 0.05;

/**
 * Smoothing time constant for the rate, in milliseconds.
 *
 * Orientation events arrive around 60 a second and differencing them is
 * jumpy; without smoothing the meter flickers and a single noisy sample can
 * reset a hold. Well under HOLD_MS on purpose, so the meter still answers
 * "now" rather than lagging behind the hand.
 */
export const RATE_SMOOTHING_MS = 150;

export interface SteadyReading {
  /** 0..1, where 1 is not moving at all. */
  steadiness: number;
  /** The smoothed rotation rate, radians per second. */
  rate: number;
  /** Pixels the scene travels during one shutter, at the photo's own size. */
  smear: number;
}

export function readSteadiness(
  rate: number, focalPixels: number, shutterSeconds: number
): SteadyReading {
  if (!(rate > 0) || !(focalPixels > 0) || !(shutterSeconds > 0)) {
    return { steadiness: 1, rate: Math.max(0, rate) || 0, smear: 0 };
  }
  const smear = focalPixels * rate * shutterSeconds;
  const steadiness = Math.max(0, Math.min(1, 1 - smear / BLUR_LIMIT_PIXELS));
  return { steadiness, rate, smear };
}

/**
 * The smoothed rate, from one orientation sample to the next.
 *
 * Time-constant smoothing rather than a fixed blend, so the meter behaves the
 * same whether orientation events arrive at 30 a second or 120 — a fixed
 * weight would smooth twice as hard on a phone that reports twice as often.
 */
export function smoothRate(previous: number, sample: number, dtMs: number): number {
  if (!(dtMs > 0)) return previous;
  const alpha = 1 - Math.exp(-dtMs / RATE_SMOOTHING_MS);
  return previous + (sample - previous) * alpha;
}

/**
 * Rate from a rotation and the time it took, refusing what it cannot measure.
 *
 * A gap in the samples — a backgrounded tab, a resumed page, a dropped event —
 * would otherwise divide a large rotation by a large time and report a
 * confident middling rate for a movement nobody made.
 */
export function rateFrom(totalRadians: number, dtMs: number): number | null {
  if (!(dtMs > 0) || dtMs > 500) return null;
  if (totalRadians > MAX_SMALL_ANGLE_RADIANS * 4) return null;
  return totalRadians / (dtMs / 1000);
}

export type ShutterState = 'off' | 'waiting' | 'holding' | 'fired';

export interface ShutterProgress {
  state: ShutterState;
  /** True on the ONE update that completes a hold. */
  fire: boolean;
  /** How long the current hold has lasted, milliseconds. */
  heldMs: number;
  /** 0..1 through the hold — for a progress ring, and for the readout. */
  progress: number;
}

/**
 * Waits for a hold, fires once, and stops.
 *
 * ONCE, deliberately. A shutter that stayed armed would keep firing for as
 * long as the phone sat still on a table, and a burst of near-identical
 * photographs nobody asked for is a worse failure than having to tap again.
 */
export class SteadyShutter {
  private state: ShutterState = 'off';
  private holdingSince = 0;
  private threshold = DEFAULT_STEADY_THRESHOLD;

  get armed(): boolean {
    return this.state === 'waiting' || this.state === 'holding';
  }

  get current(): ShutterState {
    return this.state;
  }

  get steadyThreshold(): number {
    return this.threshold;
  }

  arm(threshold = DEFAULT_STEADY_THRESHOLD): void {
    this.threshold = threshold;
    this.state = 'waiting';
    this.holdingSince = 0;
  }

  disarm(): void {
    this.state = 'off';
    this.holdingSince = 0;
  }

  update(steadiness: number, now: number): ShutterProgress {
    if (!this.armed) {
      return { state: this.state, fire: false, heldMs: 0, progress: 0 };
    }
    // Hysteresis: entering a hold takes the full threshold, staying in one
    // forgives a small sag. A reading resting exactly on the line would
    // otherwise cross it on sensor noise and never finish a hold.
    const floor = this.state === 'holding' ? this.threshold - RELEASE_MARGIN : this.threshold;
    if (steadiness < floor) {
      this.state = 'waiting';
      this.holdingSince = 0;
      return { state: 'waiting', fire: false, heldMs: 0, progress: 0 };
    }
    if (this.state !== 'holding') {
      this.state = 'holding';
      this.holdingSince = now;
    }
    const heldMs = Math.max(0, now - this.holdingSince);
    if (heldMs >= HOLD_MS) {
      this.state = 'fired';
      this.holdingSince = 0;
      return { state: 'fired', fire: true, heldMs, progress: 1 };
    }
    return { state: 'holding', fire: false, heldMs, progress: heldMs / HOLD_MS };
  }
}

/** The reading in one sentence, with the numbers the percentage came from. */
export function describeSteadiness(
  reading: SteadyReading, shutterSeconds: number, measuredFps: boolean
): string {
  const degrees = (reading.rate * 180 / Math.PI).toFixed(2);
  const ms = Math.round(shutterSeconds * 1000);
  return `${Math.round(reading.steadiness * 100)}% steady · ${degrees}°/s · `
    + `~${reading.smear.toFixed(1)} px of smear on a full-size photo, over a `
    + `${ms} ms frame${measuredFps ? '' : ' (rate assumed until measured)'} — `
    + 'the frame stands in for the shutter, which WebKit does not report, so a '
    + 'dark room smears more than this says and never less.';
}
