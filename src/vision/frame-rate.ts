/**
 * Frame-rate measurement, keeping four different rates apart.
 *
 *  CAMERA CAPTURE FPS   what the sensor is configured to run at (unobservable
 *                       from the web platform; only the track's claim is)
 *  DELIVERED FPS        video frames the page actually receives, measured here
 *  PROCESSING FPS       frames the vision pipeline actually analysed
 *  DISPLAY FPS          requestAnimationFrame rate, which is the screen's
 *                       refresh and has nothing to do with the camera
 *
 * These get conflated constantly. A rAF-driven loop measures the display, a
 * track's `getSettings().frameRate` reports an intention, and neither tells
 * you how many distinct images arrived. Only counting presented frames does.
 */

/** One presented video frame, as reported by requestVideoFrameCallback. */
export interface PresentedFrame {
  /** Page time the frame was presented, in ms. */
  now: number;
  /** Presentation timestamp within the stream. Identical values mean a repeat. */
  mediaTime: number;
  /** Running count of frames presented, where the browser reports it. */
  presentedFrames?: number;
}

export interface FrameRateReport {
  /** Distinct frames received per second, measured over the window. */
  deliveredFps: number;
  /** Frames analysed per second, measured over the window. */
  processingFps: number;
  /** Distinct frames seen since the last reset. */
  uniqueFrames: number;
  /** Callbacks that carried a mediaTime already seen — not new information. */
  repeatedFrames: number;
  /** Frames the browser presented but never handed to a callback. */
  droppedFrames: number;
  /** Delivered frames deliberately not analysed, because of the rate governor. */
  skippedFrames: number;
  averageProcessingMs: number;
  peakProcessingMs: number;
  /** Which signal is distinguishing frames, or 'none' once both proved useless. */
  identitySignal: 'presentedFrames' | 'mediaTime' | 'none';
}

const WINDOW = 90;
/**
 * Consecutive identical-looking frames before the identity signal is
 * abandoned. Eight is about 130 ms at 60 fps — long enough not to trip on a
 * genuinely duplicated frame, short enough that a broken signal costs only a
 * brief stall before the pipeline recovers on its own.
 */
const REPEAT_STREAK_LIMIT = 8;

/**
 * Sliding-window rate over recent event times. A window beats an exponential
 * average here because the readout is a measurement, and a measurement should
 * not still be drifting toward the truth a second after the rate changed.
 */
class RateWindow {
  private readonly times = new Float64Array(WINDOW);
  private count = 0;
  private head = 0;

  add(now: number): void {
    this.times[this.head] = now;
    this.head = (this.head + 1) % WINDOW;
    if (this.count < WINDOW) this.count++;
  }

  reset(): void {
    this.count = 0;
    this.head = 0;
  }

  /** Events per second, or 0 until at least two samples exist. */
  get fps(): number {
    if (this.count < 2) return 0;
    const newest = this.times[(this.head - 1 + WINDOW) % WINDOW];
    const oldest = this.times[(this.head - this.count + WINDOW) % WINDOW];
    const span = newest - oldest;
    if (span <= 0) return 0;
    return ((this.count - 1) * 1000) / span;
  }
}

export class FrameRateMeter {
  private readonly delivered = new RateWindow();
  private readonly processed = new RateWindow();

  private lastMediaTime = Number.NaN;
  private lastPresentedFrames = Number.NaN;
  /** Consecutive callbacks judged to be the same frame. */
  private repeatStreak = 0;
  /**
   * Whether frame identity can be trusted at all.
   *
   * Some WebKit builds hand the callback no metadata, or a mediaTime that
   * never advances. De-duplicating on a signal that never changes marks every
   * frame after the first as a repeat, and since a repeat is not analysed,
   * the entire pipeline stops on a camera that is delivering perfectly. A
   * long unbroken run of repeats means the signal is broken, not that the
   * scene is frozen, so identity is abandoned and every callback counts.
   */
  private identityTrusted = true;
  private identitySignal: 'presentedFrames' | 'mediaTime' | 'none' = 'mediaTime';

  private unique = 0;
  private repeated = 0;
  private dropped = 0;
  private skipped = 0;

  private processingSum = 0;
  private processingCount = 0;
  private processingPeak = 0;

  /**
   * Record a presented frame. Returns false when the frame carries a
   * mediaTime already seen, which means it is the same image again and
   * analysing it would inflate the processing rate with no new information.
   */
  /**
   * Record a presented frame. Returns false only when the frame is known to
   * be one already seen.
   *
   * De-duplication must never be able to stop the pipeline: when the identity
   * signal turns out to be useless, this reports every callback as new rather
   * than blocking analysis on a measurement detail.
   */
  recordDelivered(frame: PresentedFrame): boolean {
    const presented = typeof frame.presentedFrames === 'number' && Number.isFinite(frame.presentedFrames)
      ? frame.presentedFrames
      : Number.NaN;

    if (!Number.isNaN(presented) && Number.isFinite(this.lastPresentedFrames)) {
      // A gap larger than one means the browser presented frames that never
      // reached a callback: genuinely dropped, not merely unprocessed.
      const gap = presented - this.lastPresentedFrames - 1;
      if (gap > 0) this.dropped += gap;
    }

    // mediaTime identifies the DECODED frame and is the right signal for
    // uniqueness. presentedFrames counts compositions — it increments twice
    // for one frame on a 60 Hz display showing 30 fps video — so it is right
    // for drop accounting and wrong for identity, and is only used as a
    // fallback once mediaTime has proven useless.
    let sameFrame = false;
    if (this.identityTrusted) {
      this.identitySignal = 'mediaTime';
      sameFrame = Number.isFinite(this.lastMediaTime) && frame.mediaTime === this.lastMediaTime;
    } else if (!Number.isNaN(presented)) {
      this.identitySignal = 'presentedFrames';
      sameFrame = Number.isFinite(this.lastPresentedFrames) && presented === this.lastPresentedFrames;
    } else {
      this.identitySignal = 'none';
    }

    this.lastPresentedFrames = Number.isNaN(presented) ? this.lastPresentedFrames : presented;
    this.lastMediaTime = frame.mediaTime;

    if (sameFrame) {
      this.repeated++;
      this.repeatStreak++;
      if (this.repeatStreak < REPEAT_STREAK_LIMIT) return false;
      // The signal has not changed once across a long run of callbacks. That
      // is a broken identity signal, not a static scene: stop trusting it.
      this.identityTrusted = false;
    }

    this.repeatStreak = 0;
    this.unique++;
    this.delivered.add(frame.now);
    return true;
  }

  /** Record that a delivered frame was analysed, and how long that took. */
  recordProcessed(now: number, durationMs: number): void {
    this.processed.add(now);
    this.processingSum += durationMs;
    this.processingCount++;
    if (durationMs > this.processingPeak) this.processingPeak = durationMs;
  }

  /** Record that a delivered frame was deliberately not analysed. */
  recordSkipped(): void {
    this.skipped++;
  }

  reset(): void {
    this.delivered.reset();
    this.processed.reset();
    this.lastMediaTime = Number.NaN;
    this.lastPresentedFrames = Number.NaN;
    this.repeatStreak = 0;
    this.identityTrusted = true;
    this.identitySignal = 'mediaTime';
    this.unique = 0;
    this.repeated = 0;
    this.dropped = 0;
    this.skipped = 0;
    this.processingSum = 0;
    this.processingCount = 0;
    this.processingPeak = 0;
  }

  /** Forget the processing-cost peak, which otherwise never comes back down. */
  resetPeak(): void {
    this.processingPeak = 0;
  }

  get report(): FrameRateReport {
    return {
      deliveredFps: this.delivered.fps,
      processingFps: this.processed.fps,
      uniqueFrames: this.unique,
      repeatedFrames: this.repeated,
      droppedFrames: this.dropped,
      skippedFrames: this.skipped,
      averageProcessingMs: this.processingCount ? this.processingSum / this.processingCount : 0,
      peakProcessingMs: this.processingPeak,
      identitySignal: this.identitySignal
    };
  }
}
