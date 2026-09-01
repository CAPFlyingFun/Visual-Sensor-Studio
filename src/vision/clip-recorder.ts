/**
 * Continuous recording, cut into clips that are each a complete file.
 *
 * Joshua: "Maybe have it record continuously but in 30s max clips for size,
 * and temporary hold on the user's phone until you save it."
 *
 * WHY CUT AT ALL, rather than record one long file and split it later. A
 * MediaRecorder produces a container that is only finished when it stops —
 * an interrupted recording can leave an unplayable file, and the longer the
 * recording the more there is to lose. Stopping and restarting every thirty
 * seconds means what is already on the phone is always complete: a call, a
 * crash or the app being backgrounded costs the current clip and nothing else.
 * The size ceiling Joshua asked for falls out of the same decision.
 *
 * The cut is a stop and a start, not a pause, so each clip carries its own
 * header and can be played, saved or shared on its own. A frame or two is lost
 * at the seam — that is the honest cost, and it is why this is not the way to
 * record something continuous that must not have a gap in it.
 *
 * This class holds no browser objects. It decides WHEN to cut and the caller
 * does the cutting, which is what makes the timing testable without a camera.
 */

/** Joshua's ceiling, and the size budget follows from it. */
export const MAX_CLIP_SECONDS = 30;

export interface RollingHooks {
  /** Start a recorder. The caller supplies the stream and the format. */
  beginSegment(index: number): void;
  /** Stop it. The finished clip arrives through the caller's own handler. */
  endSegment(index: number, reason: SegmentEnd): void;
}

export type SegmentEnd = 'full' | 'stopped';

export class RollingRecorder {
  private startedAt = 0;
  private segmentStartedAt = 0;
  private active = false;
  private index = 0;

  constructor(
    private readonly hooks: RollingHooks,
    private readonly clipMs: number = MAX_CLIP_SECONDS * 1000
  ) {}

  get recording(): boolean { return this.active; }
  get segmentIndex(): number { return this.index; }

  segmentElapsedMs(now: number): number {
    return this.active ? Math.max(0, now - this.segmentStartedAt) : 0;
  }

  totalElapsedMs(now: number): number {
    return this.active ? Math.max(0, now - this.startedAt) : 0;
  }

  /** 0..1 through the current clip, for a progress ring. */
  segmentFraction(now: number): number {
    if (!this.active || !(this.clipMs > 0)) return 0;
    return Math.min(1, this.segmentElapsedMs(now) / this.clipMs);
  }

  start(now: number): void {
    if (this.active) return;
    this.active = true;
    this.startedAt = now;
    this.segmentStartedAt = now;
    this.index = 0;
    this.hooks.beginSegment(this.index);
  }

  /**
   * Called from the animation loop. Cuts when the clip is full.
   *
   * Driven by a clock the caller passes in rather than by a timer of its own:
   * a setTimeout in a backgrounded tab is throttled or deferred, and a clip
   * that ran long because the phone was in a pocket is exactly the oversized
   * file the thirty-second limit exists to prevent.
   */
  tick(now: number): void {
    if (!this.active) return;
    if (now - this.segmentStartedAt < this.clipMs) return;
    this.hooks.endSegment(this.index, 'full');
    this.index += 1;
    this.segmentStartedAt = now;
    this.hooks.beginSegment(this.index);
  }

  stop(now: number): void {
    if (!this.active) return;
    this.active = false;
    this.hooks.endSegment(this.index, 'stopped');
    this.segmentStartedAt = now;
  }
}
