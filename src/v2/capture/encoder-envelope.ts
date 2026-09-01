/**
 * ENCODER CAPABILITY — the largest frame this device's video encoder can
 * actually write, as a capability fact of its own.
 *
 * Measured on the reference iPhone, 2026-09-01, with the encoder probe: the
 * camera delivers 3024×4032, the GPU renders it, JPEG saves it — and every
 * H.264 file above 36,864 macroblocks (16×16 blocks) comes back undecodable,
 * at 5 fps as surely as at 30. 2592×3456 (34,992) decodes; 2688×3584
 * (37,632) does not. That is the H.264 Level 5.2 frame-size limit (MaxFS,
 * ITU-T H.264 Table A-1), and it is a property of the ENCODER, not of the
 * camera, the GPU or the container. A frame rate cannot fix it and neither
 * can restarting the recorder: each frame itself violates the level.
 *
 * So RECORD IN gets one more owner of a downgrade, with its reason named
 * (docs/camera_rule.md): the envelope. It is ASSUMED at the Level 5.2 line
 * until the probe measures a device, and a measurement overrides the
 * assumption in either direction — a device that encodes 47,628 gets its
 * MAX clips; one that fails lower gets a lower, honest ceiling.
 *
 * Pure module: numbers in, numbers out. Storage and DOM live in the shell.
 */

import type { FrameSize } from '../state.js';
import { fitShortSide } from '../camera/geometry.js';

/** H.264 Level 5.2 maximum frame size in macroblocks (MaxFS, ITU-T H.264 Table A-1). */
export const H264_LEVEL_5_2_MACROBLOCKS = 36_864;

export function macroblocks(width: number, height: number): number {
  return Math.ceil(width / 16) * Math.ceil(height / 16);
}

export interface EncoderEnvelope {
  /** Largest frame, in macroblocks, the encoder is trusted to write. */
  maxMacroblocks: number;
  /** True when a probe on THIS device set the number; false = assumed. */
  measured: boolean;
  reason: string;
}

/** What the probe learned: the largest frame that decoded, the smallest that did not (0 = none). */
export interface EnvelopeMeasurement {
  largestDecoded: number;
  smallestFailed: number;
}

export const ASSUMED_ENVELOPE: EncoderEnvelope = {
  maxMacroblocks: H264_LEVEL_5_2_MACROBLOCKS,
  measured: false,
  reason: 'H.264 Level 5.2 frame limit — assumed until the encoder probe measures this device'
};

/** Reduce probe rows to the two numbers that matter. Rows that never ran do not count. */
export function measurementFromRows(
  rows: readonly { macroblocks: number; decoded: boolean; error: string | null }[]
): EnvelopeMeasurement {
  let largestDecoded = 0;
  let smallestFailed = 0;
  for (const row of rows) {
    if (row.error) continue;
    if (row.decoded) largestDecoded = Math.max(largestDecoded, row.macroblocks);
    else smallestFailed = smallestFailed === 0 ? row.macroblocks : Math.min(smallestFailed, row.macroblocks);
  }
  return { largestDecoded, smallestFailed };
}

const n = (value: number): string => value.toLocaleString('en-US');

export function envelopeFromMeasurement(measurement: EnvelopeMeasurement | null): EncoderEnvelope {
  if (!measurement) return ASSUMED_ENVELOPE;
  const { largestDecoded, smallestFailed } = measurement;
  const spec = H264_LEVEL_5_2_MACROBLOCKS;
  if (largestDecoded === 0) {
    return smallestFailed === 0
      ? ASSUMED_ENVELOPE
      : { ...ASSUMED_ENVELOPE, reason: `the encoder probe decoded nothing (smallest failure ${n(smallestFailed)}) — Level 5.2 assumed` };
  }
  if (smallestFailed === 0) {
    // Everything decoded: no wall found up to the largest trial.
    return {
      maxMacroblocks: Math.max(largestDecoded, spec),
      measured: true,
      reason: `no encoder limit found up to ${n(largestDecoded)} macroblocks (encoder probe)`
    };
  }
  if (largestDecoded <= spec && smallestFailed > spec) {
    // The measurements bracket the standard line: adopt the line, explained.
    return {
      maxMacroblocks: spec,
      measured: true,
      reason: `H.264 Level 5.2 frame limit — measured: ${n(largestDecoded)} decoded, ${n(smallestFailed)} did not`
    };
  }
  return {
    maxMacroblocks: largestDecoded,
    measured: true,
    reason: `measured by the encoder probe: ${n(largestDecoded)} decoded, ${n(smallestFailed)} did not`
  };
}

/**
 * The largest frame at the source's aspect that fits the envelope — even
 * dimensions, never upscaled, walked down the short side through the one
 * shared resize arithmetic (fitShortSide).
 */
export function largestEncodable(source: FrameSize, maxMacroblocks: number): FrameSize {
  if (macroblocks(source.width, source.height) <= maxMacroblocks) return source;
  let shortSide = Math.min(source.width, source.height);
  while (shortSide > 2) {
    shortSide -= 2;
    const fitted = fitShortSide(source, shortSide);
    if (macroblocks(fitted.width, fitted.height) <= maxMacroblocks) return fitted;
  }
  return fitShortSide(source, 2);
}
