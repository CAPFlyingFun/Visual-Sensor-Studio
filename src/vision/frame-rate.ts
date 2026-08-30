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
}

const WINDOW = 90;

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
  recordDelivered(frame: PresentedFrame): boolean {
    if (typeof frame.presentedFrames === 'number') {
      if (Number.isFinite(this.lastPresentedFrames)) {
        // A gap larger than one means the browser presented frames that never
        // reached a callback: genuinely dropped, not merely unprocessed.
        const gap = frame.presentedFrames - this.lastPresentedFrames - 1;
        if (gap > 0) this.dropped += gap;
      }
      this.lastPresentedFrames = frame.presentedFrames;
    }

    if (Number.isFinite(this.lastMediaTime) && frame.mediaTime === this.lastMediaTime) {
      this.repeated++;
      return false;
    }

    this.lastMediaTime = frame.mediaTime;
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
      peakProcessingMs: this.processingPeak
    };
  }
}
