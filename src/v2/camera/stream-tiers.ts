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
 * One bound sits above the tier, and it is the ENCODER's, not the camera's:
 * measured 2026-09-01 with the encoder probe, an H.264 frame above 36,864
 * macroblocks (Level 5.2) never decodes on the reference iPhone, at any
 * frame rate — the "12 MP crash" was never a crash, it was a file the level
 * cannot describe. So a tier still STREAMS what it streams, and RECORD IN
 * is held under the encoder envelope with the reason named
 * (capture/encoder-envelope.ts); the tiers whose streams can exceed it say
 * so beside the filter strip. Photos always escalate to the sensor's maximum
 * through the shutter regardless of tier — JPEG has no such level.
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
    // where the camera truly reaches it (tierAvailable); a running 4K stream
    // is ~14 MP, above any Level 5.2 encoder, so its clips hold under the
    // envelope like MAX's.
    shortSide: 3240,
    streamLabel: '4K-class live stream — chosen, expect fewer fps',
    recordPolicy: 'source',
    clipWarning: 'A 4K-class frame exceeds the H.264 encoder\'s frame limit on most devices — '
      + 'clips record at the largest frame this encoder can write (RECORD IN names it and why). '
      + 'Photos always stay at MAX.'
  },
  {
    id: 'maximum',
    label: 'MAX',
    shortSide: 'max',
    streamLabel: 'maximum live stream — chosen, expect fewer fps',
    recordPolicy: 'source',
    // Measured on the reference iPhone: a 12 MP H.264 frame is above the
    // encoder's Level 5.2 limit, so MAX clips are held under the envelope.
    clipWarning: 'Clips at MAX record at the largest frame this device\'s H.264 encoder can write — '
      + 'RECORD IN names the size and why. Photos always stay at MAX.'
  }
];

export const DEFAULT_STREAM_TIER = '1080';

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
