/**
 * STREAM_TIERS — the deliberate live-stream trade, as data (Rule 5).
 *
 * docs/camera_rule.md: maximum-resolution modes are NORMALLY temporary, but a
 * deliberate mode that holds a larger stream with eyes open is allowed — what
 * is forbidden is the maximum arriving by accident. This registry is that
 * deliberate choice: the CAMERA STREAM tier, chosen by the user, measured by
 * the truth table. A bigger stream usually costs delivered fps (the sensor
 * cannot read 12 MP as fast as 0.7 MP), and RECORD IN follows the stream —
 * so this doubles as the instrument for "what does filtered recording
 * sustain at 1080? at the sensor's maximum?".
 *
 * Device measurements that motivated it (Joshua's iPhone): responsive
 * 720×960 recorded filtered at ~58–60 fps; the full 3024×4032 stream
 * delivered ~30. The tier turns that trade into a button instead of a guess.
 */

export interface StreamTier {
  id: string;
  /** Button label — the short side, or MAX for the sensor's largest mode. */
  label: string;
  /** Requested CAMERA STREAM short side; 'max' asks for the largest mode. */
  shortSide: number | 'max';
  /** How the SOURCE row describes a stream running under this tier. */
  streamLabel: string;
  /**
   * RECORD IN policy while this tier is chosen. 'source' records the stream
   * the user deliberately picked — the tier IS the eyes-open choice
   * (Joshua's decision, 2026-09-01: MAX means MAX for filtered clips too,
   * with the risk stated rather than a cap second-guessing the choice).
   */
  recordPolicy: 'source' | number;
  /** Shown beside the filter strip when a filtered clip carries known risk. */
  clipWarning?: string;
}

export const STREAM_TIERS: readonly StreamTier[] = [
  {
    id: 'speed',
    label: '720',
    shortSide: 720,
    streamLabel: 'responsive live stream',
    recordPolicy: 'source'
  },
  {
    id: 'detail',
    label: '1080',
    shortSide: 1080,
    streamLabel: 'detail live stream — chosen',
    recordPolicy: 'source'
  },
  {
    id: 'maximum',
    label: 'MAX',
    shortSide: 'max',
    streamLabel: 'maximum live stream — chosen, expect fewer fps',
    recordPolicy: 'source',
    // Measured on the reference iPhone: a 12 MP filtered clip can exceed the
    // device's memory and kill the recording (the app recovers, the clip may
    // not finalise). Stated, not prevented — the tier is the user's call.
    clipWarning: 'Filtered clips record at the full MAX stream. Depending on the device this '
      + 'can crash the recording — if it does, drop one tier. Photos always stay at MAX.'
  }
];

export const DEFAULT_STREAM_TIER = 'speed';

export function tierById(id: string): StreamTier | null {
  return STREAM_TIERS.find((tier) => tier.id === id) ?? null;
}
