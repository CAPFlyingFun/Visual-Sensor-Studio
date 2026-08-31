/**
 * Phase 2 — merge a real burst, and put it beside the thing it has to beat.
 *
 * Phase 0 deliberately did NOT name a winning estimator. Weighted splatting
 * scored best on 1/f noise and splat-then-back-projection best on a real
 * photograph, which is a disagreement about scene content rather than about
 * arithmetic, and no amount of further simulation settles it. So this computes
 * BOTH and measures BOTH against the same control, and the device decides.
 *
 * THE CONTROL IS THE POINT. Bicubic upscaling of the single sharpest frame, to
 * exactly the same size. Every claim this feature could make reduces to beating
 * that, and it is deliberately a good bicubic rather than a straw man. If
 * neither estimator beats it on a given shot, the honest output is the control
 * and a sentence saying so.
 *
 * The measurement is a slanted-edge MTF, because Phase 0 established that the
 * high-frequency score already in the project rewards denoising more than
 * resolution and a merge denoises heavily. See mtf.ts. Where the scene has no
 * usable edge there is no number, and the comparison falls back to what a
 * person can see — which is stated rather than papered over with a figure that
 * would not mean anything.
 */

import {
  createPlane, mergeBurst, refineBurst, upscaleFrame, type BurstFrame, type Plane
} from './super-resolution.js';
import { MIN_CONFIDENCE, selectDiverseSubset, type ShiftEstimate } from './burst-capture.js';
import { measureSlantedEdge, type MtfResult } from './mtf.js';

/** The sensor bins 2x2, so 2x is the whole of what is recoverable. */
export const MERGE_SCALE = 2;

export interface Candidate {
  plane: Plane;
  shift: ShiftEstimate;
}

export interface MergeReport {
  /** Bicubic upscale of the reference — what everything must beat. */
  control: Plane;
  /** Weighted splat. */
  splat: Plane | null;
  /** Splat, then back-projection against the forward model. */
  refined: Plane | null;
  /**
   * The reference alone, through the SAME estimator. Deconvolution without a
   * merge — see `deconvolved` for why this is the control that matters.
   */
  deconvolved: Plane | null;
  controlMtf: MtfResult;
  splatMtf: MtfResult;
  refinedMtf: MtfResult;
  deconvolvedMtf: MtfResult;
  /**
   * MTF50 ratio of the winner over SINGLE-FRAME DECONVOLUTION, which is the
   * only part attributable to having more than one frame.
   */
  multiFrameGain: number | null;
  /**
   * True when the result resolves beyond what one frame can represent.
   *
   * The single frame's Nyquist sits at 0.25 cycles per pixel on the 2x grid, so
   * detail above that cannot have come from any one of them.
   */
  beyondSingleFrame: boolean;
  /** Which output to present, chosen by measurement where one exists. */
  best: 'control' | 'splat' | 'refined';
  /** MTF50 ratio of the winner over the control, when both were measurable. */
  gain: number | null;
  framesUsed: number;
  /** Blur assumed when inverting the forward model, in output pixels. */
  psfSigma: number;
  verdict: string;
}

/**
 * Blur to assume when there is no measurement to derive one from.
 *
 * refineBurst inverts a forward model, so this is not a tuning knob — a wrong
 * value inverts a different camera. It is used only when the control's own MTF
 * could not be measured, and the report says so.
 */
export const FALLBACK_PSF_SIGMA = 0.9;

/** Gaussian sigma whose MTF50 is this, in the same pixel units. */
function sigmaFromMtf50(mtf50: number): number {
  return 0.1874 / mtf50;
}

/**
 * Merge, measure, and report — including when the answer is "it did not help".
 *
 * `candidates` should already be the frames worth using; this selects the
 * best-spread subset from them and merges those.
 */
/**
 * Called between stages so a caller can yield the thread.
 *
 * The whole merge takes about two seconds on a desktop and three to five times
 * that on a phone. Run as one synchronous block it freezes the interface for
 * ten seconds with no sign of life, which reads as a crash rather than as work
 * — so the stages are separated and the caller decides what to do between them.
 */
export type StageHook = (label: string) => Promise<void> | void;

export async function mergeAndCompare(
  candidates: ReadonlyArray<Candidate>,
  keep: number,
  onStage: StageHook = () => {}
): Promise<MergeReport | null> {
  const usable = candidates.filter((c, index) =>
    index === 0 || c.shift.confidence >= MIN_CONFIDENCE);
  if (usable.length === 0) return null;

  // The reference is the frame everything else was aligned to, so it is also
  // the one the control must be built from — a control upscaled from a
  // different frame would be sharper or softer for reasons unrelated to merging.
  const reference: BurstFrame = {
    plane: usable[0].plane,
    shiftX: usable[0].shift.shiftX,
    shiftY: usable[0].shift.shiftY
  };
  const control = upscaleFrame(reference, MERGE_SCALE);
  const controlMtf = measureSlantedEdge(control);

  if (usable.length < 2) {
    return {
      control, splat: null, refined: null, deconvolved: null,
      controlMtf,
      splatMtf: controlMtf, refinedMtf: controlMtf, deconvolvedMtf: controlMtf,
      best: 'control', gain: null, multiFrameGain: null, beyondSingleFrame: false,
      framesUsed: usable.length,
      psfSigma: FALLBACK_PSF_SIGMA,
      verdict: 'Only one frame could be used, so there is nothing to merge. '
        + 'This is a single frame upscaled.'
    };
  }

  const chosen = selectDiverseSubset(
    usable.map((c) => c.shift), keep, MIN_CONFIDENCE
  );
  const frames: BurstFrame[] = chosen.map((index) => ({
    plane: usable[index].plane,
    shiftX: usable[index].shift.shiftX,
    shiftY: usable[index].shift.shiftY
  }));

  // Derived from the control's own edge where possible, rather than assumed.
  // The control carries the bicubic's blur as well as the lens's, so this
  // slightly over-estimates the sigma — which errs towards a gentler inversion,
  // the safe direction for a method that diverges when pushed.
  const psfSigma = controlMtf.mtf50 !== null
    ? Math.min(3, Math.max(0.4, sigmaFromMtf50(controlMtf.mtf50)))
    : FALLBACK_PSF_SIGMA;

  await onStage(`Merging ${frames.length} frames…`);
  const splat = mergeBurst(frames, {
    scale: MERGE_SCALE, robustness: 0, noiseSigma: 1
  });

  await onStage('Back-projecting…');
  const refined = refineBurst(frames, {
    scale: MERGE_SCALE,
    binFactor: MERGE_SCALE,
    psfSigma,
    // Phase 0: back-projection is semi-convergent — it improves then diverges,
    // and twelve iterations scored -18 dB. Early stopping IS the regulariser.
    iterations: 3,
    gain: 0.4,
    correctionSigma: 0.5,
    initial: splat
  });

  /*
   * THE CONTROL THAT DECIDES WHAT THIS FEATURE IS.
   *
   * refineBurst inverts a blur, and inverting a blur SHARPENS — on one frame
   * as readily as on eight. MTF50 measures contrast at a frequency and rises
   * whether that contrast was recovered or merely amplified, so an unsharp mask
   * would score well on it too. Comparing a merge only against a plain upscale
   * therefore credits the merge with everything deconvolution did.
   *
   * Measured, and this is why the control exists: on a synthetic edge, CLUSTERED
   * offsets — which Phase 0 established carry no new information at all — scored
   * 1.29x against the upscale while spread offsets scored 1.32x. Nearly all of
   * that was sharpening, and a report without this control would have called it
   * super-resolution.
   *
   * The reference through the same estimator isolates it: whatever this
   * achieves needed only one frame, and only the margin above it is worth
   * capturing a burst for.
   */
  await onStage('Sharpening one frame, for the control…');
  const deconvolved = refineBurst([reference], {
    scale: MERGE_SCALE, binFactor: MERGE_SCALE, psfSigma,
    iterations: 3, gain: 0.4, correctionSigma: 0.5
  });

  await onStage('Measuring…');
  const splatMtf = measureSlantedEdge(splat);
  const refinedMtf = measureSlantedEdge(refined);
  const deconvolvedMtf = measureSlantedEdge(deconvolved);

  // Choose by measurement where there is one. Where there is not, the honest
  // position is that nothing has been shown to beat the control, so the control
  // is what gets presented — a merge is not preferred merely for existing.
  let best: MergeReport['best'] = 'control';
  let gain: number | null = null;
  let multiFrameGain: number | null = null;
  let beyondSingleFrame = false;
  let verdict: string;

  if (controlMtf.mtf50 === null) {
    verdict = `No straight edge to measure with — ${controlMtf.reason} `
      + 'The versions are all shown so they can be compared by eye, but nothing '
      + 'here is a measured gain.';
  } else {
    const scored: Array<[MergeReport['best'], number | null]> = [
      ['splat', splatMtf.mtf50],
      ['refined', refinedMtf.mtf50]
    ];
    let bestMtf = controlMtf.mtf50;
    for (const [name, value] of scored) {
      if (value !== null && value > bestMtf) { bestMtf = value; best = name; }
    }
    gain = bestMtf / controlMtf.mtf50;
    // Detail above the single frame's own Nyquist cannot have come from any one
    // frame, whatever sharpening was applied — sharpening amplifies what is
    // there and cannot put signal above the sampling limit.
    beyondSingleFrame = bestMtf > 0.5 / MERGE_SCALE;

    if (best === 'control') {
      verdict = `Neither merge beat a plain upscale on this shot `
        + `(control ${controlMtf.mtf50.toFixed(3)} cycles/px). The single frame is `
        + 'the honest answer here.';
    } else if (deconvolvedMtf.mtf50 === null) {
      verdict = `Resolves ${gain.toFixed(2)}x the detail of a plain upscale, but the `
        + 'single-frame control could not be measured, so how much of that needed '
        + 'more than one frame is unknown.';
    } else {
      multiFrameGain = bestMtf / deconvolvedMtf.mtf50;
      const label = best === 'splat' ? 'Weighted merge' : 'Back-projected merge';
      verdict = multiFrameGain > 1.05
        ? `${label}: ${gain.toFixed(2)}x a plain upscale, of which `
          + `${multiFrameGain.toFixed(2)}x needed more than one frame. `
          + (beyondSingleFrame
            ? 'It resolves past what a single frame can represent, so this is '
              + 'recovered detail rather than amplified contrast.'
            : 'Still within what one frame can represent, so treat it as a '
              + 'sharper rendering rather than as new detail.')
        : `${label} is ${gain.toFixed(2)}x a plain upscale, but sharpening ONE frame `
          + `achieves ${(deconvolvedMtf.mtf50 / controlMtf.mtf50).toFixed(2)}x on its `
          + 'own. The burst added almost nothing here — the gain is contrast, not '
          + 'resolution.';
    }
  }

  return {
    control, splat, refined, deconvolved,
    controlMtf, splatMtf, refinedMtf, deconvolvedMtf,
    best, gain, multiFrameGain, beyondSingleFrame,
    framesUsed: frames.length, psfSigma, verdict
  };
}

/** The chosen output, for saving or display. */
export function pickBest(report: MergeReport): Plane {
  if (report.best === 'splat' && report.splat) return report.splat;
  if (report.best === 'refined' && report.refined) return report.refined;
  return report.control;
}

/** Which output a panel of the comparison figure carries. */
export type PanelKey = 'control' | 'deconvolved' | 'splat' | 'refined';

export interface PanelPlacement {
  key: PanelKey;
  plane: Plane;
  x: number;
  y: number;
}

export interface ComparisonLayout {
  width: number;
  height: number;
  columns: number;
  rows: number;
  gap: number;
  panels: PanelPlacement[];
}

/** Gutter between panels, in output pixels. */
const PANEL_GAP = 4;

/**
 * WHERE THE PANELS GO — and why they are not in a row.
 *
 * Joshua, on the first build that showed this: "It showed it but zoomed way in
 * on the main model and then when I tried zooming out, I lost everything. It
 * needs to be clamped to screen size."
 *
 * Four 512-pixel panels side by side are 2060 pixels wide. No phone has a
 * viewport that wide, so the figure either overflowed the document — which is
 * what happened, and mobile Safari rescaled the whole app around it — or it had
 * to be scaled down by nearly five, which destroys the fine differences the
 * figure exists to show.
 *
 * A 2x2 grid is 1028 pixels wide instead, and that is the number that matters:
 * a 430pt screen at three device pixels to the point is 1290 device pixels
 * across, so the whole figure fits AT ONE OUTPUT PIXEL PER DEVICE PIXEL with
 * room to spare. Nothing is resampled and nothing overflows. Rows over columns
 * is not a taste decision here — it is the only arrangement that fits.
 *
 * Reading order is still the argument the figure makes: upscale and sharpened
 * single frame on the top row, the two merges beneath them, so each merge sits
 * directly under the control it has to beat.
 */
export function comparisonLayout(report: MergeReport): ComparisonLayout {
  const entries: Array<[PanelKey, Plane | null]> = [
    ['control', report.control],
    ['deconvolved', report.deconvolved],
    ['splat', report.splat],
    ['refined', report.refined]
  ];
  const present = entries.filter((e): e is [PanelKey, Plane] => e[1] !== null);
  const cellWidth = present[0][1].width;
  const cellHeight = present[0][1].height;
  const columns = Math.min(2, present.length);
  const rows = Math.ceil(present.length / columns);

  const panels = present.map(([key, plane], index) => ({
    key,
    plane,
    x: (index % columns) * (cellWidth + PANEL_GAP),
    y: Math.floor(index / columns) * (cellHeight + PANEL_GAP)
  }));

  return {
    width: cellWidth * columns + PANEL_GAP * (columns - 1),
    height: cellHeight * rows + PANEL_GAP * (rows - 1),
    columns,
    rows,
    gap: PANEL_GAP,
    panels
  };
}

/** Every version in one picture, each at its own full size. */
export function comparisonStrip(report: MergeReport): Plane {
  const layout = comparisonLayout(report);
  const figure = createPlane(layout.width, layout.height);
  // Mid-grey gutters, so the joins read as separators rather than as content.
  figure.data.fill(90);
  for (const panel of layout.panels) {
    const { width, height } = panel.plane;
    for (let y = 0; y < height; y++) {
      const target = (panel.y + y) * figure.width + panel.x;
      for (let x = 0; x < width; x++) {
        figure.data[target + x] = panel.plane.data[y * width + x];
      }
    }
  }
  return figure;
}
