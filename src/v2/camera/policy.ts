/**
 * Source-resolution policy — pure decisions about the REQUEST side.
 *
 * CAPABILITY (what the track advertises) and SOURCE (what was negotiated) are
 * different facts (Rule 2), and the difference between "this camera cannot do
 * more" and "we did not ask for more" was a real bug in the legacy app: a
 * default capture height quietly capped the stream at a fraction of the
 * sensor. V2 asks for the largest mode and then REPORTS any remaining gap,
 * and this module is the one owner of that comparison — the escalation
 * decision and the diagnostics row both read it (Rule 6).
 */

import type { FrameSize } from '../state.js';

/** Orientation-free: a 4032×3024 capability satisfies a 3024×4032 stream. */
function shortSide(size: FrameSize): number {
  return Math.min(size.width, size.height);
}

function longSide(size: FrameSize): number {
  return Math.max(size.width, size.height);
}

/**
 * Whether the negotiated stream is meaningfully below the advertised maximum.
 *
 * False when either fact is missing: without a capability there is no
 * evidence more exists, and asking again on faith would be a retry loop, not
 * a measurement. The 2% slack absorbs even-rounding and mode quantisation —
 * a camera that gave 3018 against an advertised 3024 did not decline, it
 * rounded. Note a capability is per-axis maxima, not necessarily one real
 * mode; a stream can honestly sit just under it forever, which is exactly
 * what the diagnostics row should show rather than hide.
 */
export function belowCapability(source: FrameSize | null, capability: FrameSize | null): boolean {
  if (!source || !capability) return false;
  return shortSide(source) < shortSide(capability) * 0.98
    || longSide(source) < longSide(capability) * 0.98;
}
