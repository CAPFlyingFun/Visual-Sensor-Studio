/**
 * STREAM_TIERS — the deliberate live-stream trade, as data (Rule 5).
 *
 * Joshua's ladder (2026-09-01): preset video classes — 720 / 1080 / 2K / 4K /
 * MAX — and a tier RECORDS WHAT IT STREAMS, maximum included. "If MAX is
 * recorded in 1080, that's not MAX, that's the middle setting." The classes
 * name the request by their standard short side (720p, 1080p, 1440p, 2160p);
 * the CAMERA decides both edges from its own aspect and modes, and the
 * SOURCE row reports what was actually granted — the preset adjusts to the
 * specific camera automatically, and never invents pixels the sensor lacks.
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
    shortSide: 1440,
    streamLabel: '2K-class live stream — chosen',
    recordPolicy: 'source'
  },
  {
    id: '4k',
    label: '4K',
    shortSide: 2160,
    streamLabel: '4K-class live stream — chosen, expect fewer fps',
    recordPolicy: 'source'
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
