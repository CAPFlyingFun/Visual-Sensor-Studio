/**
 * NIGHT — MILESTONE 1: does the stack itself land correctly?
 *
 * Joshua, 2026-09-03, after the V1/V2 audit confirmed his suspicion: V1's
 * Night had no gyro alignment at all, and its accumulator saved at analysis
 * resolution rather than the sensor's — restoring it as-is was never on the
 * table. What follows instead is new, and this file is its FIRST slice on
 * purpose: "Milestone 1's question is only: Does the ~0.25-second,
 * gyro-aligned finite stack work correctly on my actual iPhone PWA?"
 *
 * Everything downstream of a correct stack — brightness recovery, the
 * selected lens, a MAX-resolution save — is deliberately NOT here. This
 * module holds only the two things Milestone 1 needs that do not already
 * exist: the cadence/target constants, and the CONVERGING-MEAN weight
 * formula. The alignment itself is `vision/alignment.ts`'s StackAligner,
 * reused unchanged; the gate that decides when to start is
 * `vision/steadiness.ts`'s SteadyShutter, reused unchanged. Nothing here
 * reimplements either.
 *
 * WHY THE WEIGHT FORMULA IS NEW, not a reuse of render/frame-average.ts's
 * ladder. That ladder is a fixed-weight EMA (`2/(N+1)`), tuned for a SHORT
 * ROLLING window that keeps forgetting old frames at a constant rate — right
 * for steadying a live picture that may keep changing. Night wants the
 * opposite: a FINITE stack that CONVERGES, every accepted frame weighted
 * equally, exactly Joshua's own recurrence —
 *
 *   mean1 = frame1
 *   mean2 = mean1 + (frame2 - mean1) / 2
 *   mean3 = mean2 + (frame3 - mean2) / 3
 *   ...
 *
 * — which is `weight = 1/n` for the n-th accepted frame. Same GPU mechanism
 * (render/gl-renderer.ts's advanceNightStack, the same mix()-blend shader
 * already verified for live alignment) — only the number passed in differs.
 * A convex blend cannot run away upward regardless of which weight it is
 * given: mix(before, now, w) is bounded by its two inputs at every step, so
 * the "8-bit frame + frame + frame, clipping brighter" failure Joshua named
 * cannot happen here structurally, independent of this formula.
 */

/**
 * The MINIMUM GAP between candidate frames — a ceiling on the rate, not a
 * sampling period any more.
 *
 * It was 250 ms, and the tick has always run from the camera's own delivery
 * callback, so that gate was throwing away seven of every eight frames the
 * sensor handed over. On Joshua's phone that is 29.9 fps reduced to 4 — 87%
 * of the light-carrying frames discarded, which he spotted himself
 * (2026-09-04): "instead of sampling every 0.25s, do it every frame up to 30
 * frames per second".
 *
 * That matters because noise falls as the square root of the frame count, so
 * eight times the frames is about 2.8 times less noise — and noise is what a
 * dark stack has to spend before it can afford to be brightened.
 *
 * WHY 30 ms RATHER THAN THE 33.3 ms THAT 30 fps IMPLIES. The cap exists only
 * to stop a 60 fps stream doubling the accumulator's work; on a 30 fps stream
 * every frame should pass. Delivery jitters either side of its nominal
 * interval, and a floor set exactly AT that interval would reject every
 * slightly-early frame — and since the clock then runs on to the next one,
 * each rejection costs a whole frame. Set a little under, ordinary jitter
 * passes and a 60 fps stream still halves to about 33.
 */
export const NIGHT_TICK_MS = 30;

/**
 * Roughly how long a capture runs — the stop condition is wall-clock, not a
 * frame count.
 *
 * FOUR SECONDS. It was raised to ten on the reasoning that noise falls as the
 * square root of the frame count, so more light should mean less grain. The
 * device disagreed: Joshua, on the ten-second build, "it's worse... too
 * whitewashed and grainy" — flatter, hazier, with colour fringing along
 * high-contrast edges that the four-second version did not have. Reverted to
 * the last duration his device actually preferred.
 *
 * THE SQUARE-ROOT ARGUMENT IS STILL TRUE; it just is not the only thing that
 * changes with a longer hold, and two of the others push the other way:
 *
 * - DRIFT. Ten seconds of integration is about fourteen of holding still once
 *   the countdown and the gate are counted. The aligner corrects a predicted
 *   shift, and whatever it does not correct is smeared across every frame —
 *   which lowers contrast and reads as haze, not as grain. The colour
 *   fringing points here: the channels are landing in slightly different
 *   places.
 * - THE CAMERA'S OWN EXPOSURE. Nothing here holds it still. Over ten seconds
 *   in a dark room its automatic gain has time to travel, so the stack
 *   averages frames taken at different sensitivities, and the noisiest ones
 *   arrive last. Four seconds gives it less room to move.
 *
 * So a longer capture is not simply more light, and it should not be tried
 * again until the drift and the exposure are both pinned down. Raising this
 * is cheap; the reason it did not work is what was expensive to learn.
 */
export const NIGHT_TARGET_MS = 4000;

/**
 * The frame count the ceiling above implies, for display only. Not a target
 * to force to exactly: a shaky four seconds, or a device that cannot keep up
 * with a full-size blend every frame, should end up short of it and SAY SO
 * rather than pad itself out. The log's measured cadence is what says which
 * of those happened.
 */
export const NIGHT_TARGET_FRAMES = Math.round(NIGHT_TARGET_MS / NIGHT_TICK_MS);

/**
 * How long to wait, after the tap, before the steadiness gate even starts
 * watching — Joshua, on the phone, after Milestone 1 worked: "make a 3s
 * countdown before it actually starts because if not using a tripod, as
 * soon as you tap and release your finger, your hands are going to move a
 * little."
 *
 * This does NOT replace the gate he asked to have reused ("Shoot When
 * Steady can be reused as the gate that begins the Night stack") — it sits
 * BEFORE it. The gate still has to see an actual steady hold before the
 * stack begins; this only buys the hand a fixed, visible window to stop
 * moving from the tap itself before that gate starts judging it, so a
 * shaky first half-second right after release cannot fail the gate before
 * it settles.
 */
export const NIGHT_COUNTDOWN_MS = 3000;

/**
 * Seconds left to show on the button — always at least 1 while the
 * countdown is running, so it reads "3… 2… 1…" rather than ever touching
 * "0" on screen. Ceiling, not rounding: at 2.98s remaining the honest
 * answer for a whole-second display is still "3", not "2".
 */
export function nightCountdownSecondsLeft(elapsedMs: number): number {
  return Math.max(1, Math.ceil((NIGHT_COUNTDOWN_MS - elapsedMs) / 1000));
}

/**
 * The converging-mean weight for the n-th frame folded into the CURRENT
 * accumulator (n counted since the last restart, not since the capture
 * began — a restart really is a fresh accumulator with a fresh frame 1).
 *
 * n=1 is not a case this is meant to be called for: the first frame of a
 * fresh accumulator is a PRIME (adopt it whole, weight effectively 1),
 * handled by the renderer's own restart path rather than a blend. Defensive
 * for n<=1 anyway, matching render/frame-average.ts's frameAverageWeight —
 * a function total over its declared domain is one fewer thing to get wrong
 * at a call site.
 */
export function nightStackWeight(n: number): number {
  return n > 1 ? 1 / n : 1;
}

export interface NightCounters {
  /** Milliseconds since the accumulation began (the current run since the last restart-clearing anchor, i.e. since the gate fired). */
  elapsedMs: number;
  /** Every candidate frame attempted, cumulative for this capture — never reset by a restart. */
  candidateFrames: number;
  /** Ticks whose verdict was 'stacked' or 'still' — folded into the accumulator. Cumulative. */
  acceptedFrames: number;
  /** Ticks whose verdict was 'rejected' — not folded in. Cumulative. */
  rejectedFrames: number;
  /** Frames represented in the CURRENT accumulator content — resets to 1 on a restart. */
  stackCount: number;
  /** How many times the accumulator was thrown away and re-primed this capture. */
  restarts: number;
  /** The most recent accepted tick's predicted drift, in pixels. */
  offsetPixels: number;
  /** The largest predicted drift seen this capture, accepted or not. */
  maxOffsetPixels: number;
  /**
   * THE RESOLUTION STORY, in the sizes that actually differ (Joshua,
   * 2026-09-03: "link the resolution to what the setting is like 720, 1080,
   * 4K, MAX"). They are NOT the same number, and Milestone 2 lives in the
   * gap between the last two:
   *
   * - tierLabel  the SETTING chosen — 720 / 1080 / 2K / 4K / MAX.
   * - stream     what the camera actually granted under that setting.
   * - stacked    what Night really accumulated, frozen once when stacking
   *              begins: the PHOTO row, the same one the ordinary shutter
   *              saves at, so the tier chosen is the size produced. It read
   *              the preview row until 2026-09-03, which pinned every tier
   *              above 720 to one viewfinder-sized rectangle.
   * - sensor     the camera's advertised maximum: what a MAX photo would
   *              have to be, and so what Milestone 2 has to reach.
   */
  tierLabel: string;
  streamWidth: number;
  streamHeight: number;
  stackedWidth: number;
  stackedHeight: number;
  sensorWidth: number;
  sensorHeight: number;
  /** Measured mean interval between candidate ticks, ms — the "roughly 0.25s" claim, checked. */
  actualCadenceMs: number;
  /**
   * THE RECOVERY, measured from the finished stack rather than chosen.
   * `meanBefore` is the stacked frame's own mean luma (0..1); `gain` and
   * `lift` are what that reading asked for. gain 1.0 with lift 1.0 means the
   * frame was already well exposed and nothing was done to it — which is a
   * result, not a failure, and the readout says so plainly.
   */
  meanBefore: number;
  gain: number;
  lift: number;
  /**
   * WHAT THE ACCUMULATOR WAS ACTUALLY ALLOCATED AS — 'RGBA16F' or the
   * 'RGBA8' fallback, measured by the renderer at allocation rather than
   * predicted from an extension string. It belongs in the log because the
   * fallback is silent by design: a capture that quietly dropped to 8 bits
   * would otherwise look like a stacking failure instead of a memory one.
   */
  accumulatorFormat: string;
}

export function emptyNightCounters(): NightCounters {
  return {
    elapsedMs: 0, candidateFrames: 0, acceptedFrames: 0, rejectedFrames: 0,
    stackCount: 0, restarts: 0, offsetPixels: 0, maxOffsetPixels: 0,
    tierLabel: '', streamWidth: 0, streamHeight: 0,
    stackedWidth: 0, stackedHeight: 0, sensorWidth: 0, sensorHeight: 0,
    actualCadenceMs: 0, meanBefore: 0, gain: 1, lift: 1, accumulatorFormat: ''
  };
}

/**
 * The counters in one line, for the readout — every number MEASURED this
 * capture, nothing invented. No confidence score: Joshua was explicit that a
 * number nobody measured does not belong here.
 */
export function describeNightCounters(counters: NightCounters): string {
  const seconds = (counters.elapsedMs / 1000).toFixed(1);
  const cadence = counters.actualCadenceMs > 0 ? `${counters.actualCadenceMs.toFixed(0)} ms` : '—';
  const size = (w: number, h: number) => (w > 0 && h > 0 ? `${w}×${h}` : '—');
  return `${seconds}s · ${counters.candidateFrames} candidates · `
    + `${counters.acceptedFrames} accepted · ${counters.rejectedFrames} rejected · `
    + `stack ${counters.stackCount}${counters.restarts > 0 ? ` (${counters.restarts} restart${counters.restarts === 1 ? '' : 's'})` : ''} · `
    + `offset ${counters.offsetPixels.toFixed(1)} px (max ${counters.maxOffsetPixels.toFixed(1)} px) · `
    + `actual cadence ${cadence} · `
    + `tier ${counters.tierLabel || '—'} · stream ${size(counters.streamWidth, counters.streamHeight)} · `
    + `stacked ${size(counters.stackedWidth, counters.stackedHeight)} · `
    + `sensor ${size(counters.sensorWidth, counters.sensorHeight)} · `
    + (counters.accumulatorFormat ? `accumulator ${counters.accumulatorFormat} · ` : '')
    + (counters.gain > 1.001 || counters.lift > 1.001
      ? `lift ${counters.gain.toFixed(2)}× gain, ${counters.lift.toFixed(2)} shadows `
        + `(mean ${counters.meanBefore.toFixed(3)})`
      : `no lift needed (mean ${counters.meanBefore.toFixed(3)})`);
}
