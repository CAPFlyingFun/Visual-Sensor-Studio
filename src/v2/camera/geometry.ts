/**
 * FrameGeometryAuthority — the only place that decides or reports dimensions
 * for camera-derived work.
 *
 * Rules 1–3 of docs/V2-DATA-DRIVEN-RULES.md, made executable. Source, analysis,
 * preview and photo are different facts with different reasons; they are
 * resolved together, from the same inputs, and no renderer, canvas or panel
 * invents a ceiling of its own. RECORD IN and ENCODED join in Milestone C.
 *
 * This module is deliberately pure: inputs in, geometry out. The app shell
 * feeds it from the state store and writes the result back to the state store,
 * so every consumer reads one answer.
 */

import type { FrameSize } from '../state.js';

export interface SizedWithReason extends FrameSize {
  /** Why this size and not another — every downgrade names its cause. */
  reason: string;
}

export interface FrameGeometryState {
  source: FrameSize;
  analysis: SizedWithReason;
  preview: SizedWithReason;
  photo: SizedWithReason;
  /** What the video encoder RECEIVES; what the file contains is measured. */
  recordInput: SizedWithReason;
}

export interface GeometryInputs {
  /**
   * The viewfinder's box in DEVICE pixels (CSS size × devicePixelRatio).
   * A display fact, used for PREVIEW only: rendering more preview pixels than
   * the screen can show costs frame rate and shows nothing — the lesson the
   * legacy app measured — but it is never allowed to touch PHOTO.
   */
  previewBoxShortSide: number;
  /** ANALYSIS short side — a performance choice, not a display one. */
  analysisShortSide: number;
  /** 'source' records the negotiated size; a number caps the short side. */
  photoPolicy: 'source' | number;
  /**
   * RECORD IN policy. 'source' hands the encoder the responsive stream's own
   * size — the live policy already bounds the per-frame cost, so no second
   * ceiling is invented. A number caps the short side when measurement shows
   * a device needs one.
   */
  recordPolicy: 'source' | number;
}

export const DEFAULT_GEOMETRY_INPUTS: GeometryInputs = {
  previewBoxShortSide: 0,
  // 384 keeps motion/statistics work sustainable on a phone; Milestone D's
  // temporal tools consume this. Nothing renders from it yet in B.
  analysisShortSide: 384,
  photoPolicy: 'source',
  // The record policy follows the CHOSEN STREAM TIER (stream-tiers.ts): a
  // tier records what it streams — "if MAX is recorded in 1080, that's not
  // MAX" (Joshua, 2026-09-01). The 12 MP filtered crash measurement stands,
  // as the MAX tier's stated warning rather than a silent cap here; the
  // numeric form stays for any policy a future measurement demands.
  recordPolicy: 'source'
};

/** Even numbers survive encoders and texture copies; the cost is one row. */
function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * Fit a frame to a SHORT-SIDE target, preserving the source aspect exactly.
 * Shared arithmetic (Rule 6) — every resolved size below goes through it.
 */
export function fitShortSide(source: FrameSize, shortSide: number): FrameSize {
  const sourceShort = Math.min(source.width, source.height);
  const scale = sourceShort > 0 ? Math.min(1, shortSide / sourceShort) : 1;
  const width = even(source.width * scale);
  const height = even(source.height * scale);
  return { width, height, aspect: width / height };
}

export function resolveGeometry(
  source: FrameSize,
  inputs: GeometryInputs = DEFAULT_GEOMETRY_INPUTS
): FrameGeometryState {
  const sourceShort = Math.min(source.width, source.height);

  const analysis = {
    ...fitShortSide(source, inputs.analysisShortSide),
    reason: inputs.analysisShortSide >= sourceShort
      ? 'the full stream — it is already smaller than the analysis target'
      : `downsampled for sustainable per-frame vision work (${inputs.analysisShortSide} short side)`
  };

  const previewCap = inputs.previewBoxShortSide;
  const preview = previewCap > 0 && previewCap < sourceShort
    ? {
      ...fitShortSide(source, previewCap),
      reason: 'fitted to the viewfinder’s own device pixels — more would be invisible'
    }
    : {
      ...source,
      reason: previewCap > 0
        ? 'the stream is smaller than the viewfinder, so it is shown as it is'
        : 'viewfinder not measured yet'
    };

  const photo = inputs.photoPolicy === 'source' || inputs.photoPolicy >= sourceShort
    ? {
      ...source,
      reason: 'the negotiated stream — the most detail that exists to save'
    }
    : {
      ...fitShortSide(source, inputs.photoPolicy),
      reason: `capped at a ${inputs.photoPolicy} short side by the photo policy`
    };

  const recordInput = inputs.recordPolicy === 'source' || inputs.recordPolicy >= sourceShort
    ? {
      ...source,
      reason: 'the responsive stream — the live policy already bounds the cost'
    }
    : {
      ...fitShortSide(source, inputs.recordPolicy),
      reason: `capped at a ${inputs.recordPolicy} short side by the record policy`
    };

  return { source, analysis, preview, photo, recordInput };
}
