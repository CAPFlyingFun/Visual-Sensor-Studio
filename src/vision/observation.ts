/**
 * Event detection for unattended observation.
 *
 * The use case is a phone propped up watching a quiet scene: nothing happens
 * for minutes, then something crosses the frame. The detector's job is to say
 * when that began, when it peaked and when it ended, so the trail buffer can be
 * cleared to hold that one event rather than a smear of everything since the
 * mode was selected.
 *
 * Everything here is deliberately about MOTION, never identity. The detector
 * reports "something moved, this fast, for this long, on this path" and stops
 * there. It has no classifier behind it and must never be given wording that
 * suggests one.
 */

export interface EventThresholds {
  /** Fraction of the frame that must move for an event to begin, 0..1. */
  startFraction?: number;
  /**
   * Fraction it must fall below to end.
   *
   * Separate from the start value on purpose: with one threshold a subject
   * hovering right at it opens and closes an event every few frames.
   */
  endFraction?: number;
  /** Motion must hold above the start threshold this long before it counts. */
  minDurationMs?: number;
  /** Motion must stay below the end threshold this long before the event closes. */
  quietMs?: number;
}

const DEFAULTS: Required<EventThresholds> = {
  startFraction: 0.004,
  endFraction: 0.002,
  minDurationMs: 250,
  quietMs: 1200
};

export interface ObservationEvent {
  /** Wall-clock start, ms since epoch, for a record that outlives the session. */
  startedAt: number;
  endedAt: number | null;
  /** When the fastest speed was seen, ms since epoch. */
  peakAt: number;
  durationMs: number;
  /** Fastest speed during the event, in frame widths per second. */
  peakWidthsPerSecond: number;
  /** Mean of the per-frame peaks across the event. */
  meanWidthsPerSecond: number;
  peakMovingFraction: number;
  frames: number;
}

export type EventPhase = 'idle' | 'arming' | 'active' | 'closing';

export interface EventUpdate {
  phase: EventPhase;
  /** True on the single update where an event opened. */
  started: boolean;
  /** True on the single update where an event closed. */
  ended: boolean;
  current: ObservationEvent | null;
  /** The event that just closed, on the update where it closed. */
  completed: ObservationEvent | null;
}

const IDLE: EventUpdate = {
  phase: 'idle',
  started: false,
  ended: false,
  current: null,
  completed: null
};

/**
 * Opens and closes observation events from a motion signal.
 *
 * Two guards keep noise out, and both are necessary. A single threshold with no
 * duration floor fires on one noisy frame; a single threshold with no separate
 * closing level chatters open and closed while a subject sits near it. Together
 * they mean an event needs sustained motion to open and sustained quiet to
 * close.
 */
export class EventDetector {
  private phase: EventPhase = 'idle';
  private aboveSince = 0;
  private belowSince = 0;
  private event: ObservationEvent | null = null;
  private speedSum = 0;

  get currentPhase(): EventPhase {
    return this.phase;
  }

  get active(): ObservationEvent | null {
    return this.phase === 'active' || this.phase === 'closing' ? this.event : null;
  }

  reset(): void {
    this.phase = 'idle';
    this.aboveSince = 0;
    this.belowSince = 0;
    this.event = null;
    this.speedSum = 0;
  }

  /**
   * @param movingFraction fraction of the frame in motion, 0..1
   * @param widthsPerSecond fastest speed this frame
   * @param now monotonic clock, ms
   * @param wallClock ms since epoch, recorded so an event survives the session
   */
  update(
    movingFraction: number,
    widthsPerSecond: number,
    now: number,
    wallClock: number,
    thresholds: EventThresholds = {}
  ): EventUpdate {
    const start = thresholds.startFraction ?? DEFAULTS.startFraction;
    // An end threshold above the start one would close an event the instant it
    // opened, so it is clamped rather than trusted.
    const end = Math.min(thresholds.endFraction ?? DEFAULTS.endFraction, start);
    const minDuration = thresholds.minDurationMs ?? DEFAULTS.minDurationMs;
    const quiet = thresholds.quietMs ?? DEFAULTS.quietMs;

    const busy = movingFraction >= start;
    let started = false;
    let ended = false;
    let completed: ObservationEvent | null = null;

    if (this.phase === 'idle') {
      if (!busy) return IDLE;
      this.phase = 'arming';
      this.aboveSince = now;
    }

    if (this.phase === 'arming') {
      if (!busy) {
        this.phase = 'idle';
        return IDLE;
      }
      if (now - this.aboveSince >= minDuration) {
        this.phase = 'active';
        started = true;
        this.speedSum = 0;
        this.event = {
          // Backdated to when motion actually began, not to when the duration
          // floor was satisfied — the floor is a filter, not the start time.
          startedAt: wallClock - (now - this.aboveSince),
          endedAt: null,
          peakAt: wallClock,
          durationMs: 0,
          peakWidthsPerSecond: 0,
          meanWidthsPerSecond: 0,
          peakMovingFraction: 0,
          frames: 0
        };
      }
    }

    const event = this.event;
    if (event && (this.phase === 'active' || this.phase === 'closing')) {
      event.frames++;
      this.speedSum += widthsPerSecond;
      event.meanWidthsPerSecond = this.speedSum / event.frames;
      if (widthsPerSecond > event.peakWidthsPerSecond) {
        event.peakWidthsPerSecond = widthsPerSecond;
        event.peakAt = wallClock;
      }
      if (movingFraction > event.peakMovingFraction) event.peakMovingFraction = movingFraction;
      event.durationMs = wallClock - event.startedAt;

      if (movingFraction < end) {
        if (this.phase === 'active') {
          this.phase = 'closing';
          this.belowSince = now;
        } else if (now - this.belowSince >= quiet) {
          // The quiet period is how the end was DETECTED, not part of the
          // event, so it is subtracted back off rather than counted in.
          event.endedAt = wallClock - (now - this.belowSince);
          event.durationMs = Math.max(0, event.endedAt - event.startedAt);
          this.phase = 'idle';
          ended = true;
          completed = event;
          this.event = null;
        }
      } else if (this.phase === 'closing') {
        this.phase = 'active';
      }
    }

    return {
      phase: this.phase,
      started,
      ended,
      current: this.phase === 'active' || this.phase === 'closing' ? this.event : null,
      completed
    };
  }
}

/**
 * Convert an image speed to an angular one.
 *
 * Only valid with a field of view the user supplied — WebKit exposes no lens
 * geometry, so there is nothing to derive it from and nothing to guess it with.
 * Every readout built on this has to name the FOV it assumed, because the
 * number is exactly as good as that assumption.
 *
 * Zoom narrows the field it applies to, so the same image speed is a smaller
 * angular speed when zoomed in.
 */
export function degreesPerSecond(
  widthsPerSecond: number,
  horizontalFovDegrees: number,
  zoom = 1
): number | null {
  if (!(horizontalFovDegrees > 0) || !(zoom > 0)) return null;
  return widthsPerSecond * (horizontalFovDegrees / zoom);
}
