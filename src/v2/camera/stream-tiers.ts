/**
 * STREAM_TIERS — the deliberate live-stream trade, as data (Rule 5).
 *
 * Joshua's ladder (2026-09-01): preset video classes — 720 / 1080 / 2K / 4K /
 * MAX — and a tier RECORDS WHAT IT STREAMS, maximum included. "If MAX is
 * recorded in 1080, that's not MAX, that's the middle setting." His ladder
 * doubles: 2K is twice the 1080 class (2160 short side), and 4K is twice the
 * 2K class — a 4320 long edge ("technically 4K is actually 4320"), which at
 * 4:3 is a 3240 short side. A class the camera cannot FILL is not offered:
 * its button greys out naming the reason ("should be grayed out saying
 * device's output is not big enough"), never a silently clamped stand-in.
 * MAX is always real because it promises the camera's own largest, whatever
 * that is — on the reference iPhone (3024×4032 capability) the live ladder
 * is 720/1080/2K/MAX with 4K grey. The SOURCE row reports what was actually
 * granted, and no tier ever invents pixels the sensor lacks.
 *
 * The risk stays a WARNING, not a cap: filtered recording at this device's
 * full 12 MP was measured to crash (three times, differently each time), so
 * the MAX tier says so beside the filter strip and leaves the choice made
 * with eyes open. Photos always escalate to the sensor's maximum through the
 * shutter regardless of tier.
 */

export interface StreamTier {
  id: string;
  /** Button label — the familiar video class, or MAX for the largest mode. */
  label: string;
  /** Requested CAMERA STREAM short side; 'max' asks for the largest mode. */
  shortSide: number | 'max';
  /** How the SOURCE row describes a stream running under this tier. */
  streamLabel: string;
  /**
   * RECORD IN policy while this tier is chosen — 'source' records the stream
   * the user deliberately picked. The numeric form exists for any future
   * measurement that demands a cap; today no tier uses one.
   */
  recordPolicy: 'source' | number;
  /** Shown beside the filter strip when a filtered clip carries known risk. */
  clipWarning?: string;
}

export const STREAM_TIERS: readonly StreamTier[] = [
  {
    id: '720',
    label: '720',
    shortSide: 720,
    streamLabel: 'responsive live stream',
    recordPolicy: 'source'
  },
  {
    id: '1080',
    label: '1080',
    shortSide: 1080,
    streamLabel: '1080-class live stream — chosen',
    recordPolicy: 'source'
  },
  {
    id: '2k',
    label: '2K',
    shortSide: 2160,
    streamLabel: '2K-class live stream — chosen, expect fewer fps',
    recordPolicy: 'source'
  },
  {
    id: '4k',
    label: '4K',
    // The 4K class is a 4320 long edge — 3240 short at 4:3. Only offered
    // where the camera truly reaches it (tierAvailable), so a running 4K
    // stream is at least ~14 MP and shares MAX's measured filtered-clip risk.
    shortSide: 3240,
    streamLabel: '4K-class live stream — chosen, expect fewer fps',
    recordPolicy: 'source',
    clipWarning: 'Filtered clips at 4K size can crash the recording on some devices — '
      + 'if it does, drop one tier. Photos always stay at MAX.'
  },
  {
    id: 'maximum',
    label: 'MAX',
    shortSide: 'max',
    streamLabel: 'maximum live stream — chosen, expect fewer fps',
    recordPolicy: 'source',
    // Measured on the reference iPhone: a 12 MP filtered clip can exceed the
    // device's memory and kill the recording. Stated, not prevented.
    clipWarning: 'Filtered clips record at the full MAX stream. Depending on the device this '
      + 'can crash the recording — if it does, drop one tier. Photos always stay at MAX.'
  }
];

export const DEFAULT_STREAM_TIER = '720';

export function tierById(id: string): StreamTier | null {
  return STREAM_TIERS.find((tier) => tier.id === id) ?? null;
}

/**
 * Can this camera genuinely FILL the tier's class? Compared on the short
 * side of the track's advertised CAPABILITY. 'max' is always available — it
 * promises the camera's own largest, not a number. An unknown capability
 * (some browsers withhold it) disables nothing: greying a button out on a
 * guess would state an unmeasured fact, so there the SOURCE row's measured
 * answer remains the check.
 */
export function tierAvailable(tier: StreamTier, capabilityShortSide: number | null): boolean {
  if (tier.shortSide === 'max') return true;
  if (capabilityShortSide === null || !(capabilityShortSide > 0)) return true;
  return capabilityShortSide >= tier.shortSide;
}
