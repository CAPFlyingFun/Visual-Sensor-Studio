/**
 * VIEWING AIDS — zebra and focus peaking. Milestone F's two overlays.
 *
 * Both answer a question the picture on a phone screen cannot: is this
 * highlight actually blown, and is this actually in focus? A 6-inch screen in
 * daylight is far too small and far too bright to judge either by eye, which
 * is exactly why every real camera draws these.
 *
 * THEY ARE NEVER CAPTURED. A viewing aid that ends up in the file is not an
 * aid, it is damage — nobody wants stripes baked into a photograph. The
 * renderer takes them as a per-render option and the preview is the only
 * caller that passes them; the photo and recording paths ask for none, the
 * same way they ask for no frame averaging. That is a structural guarantee
 * rather than a flag someone has to remember to clear.
 *
 * The cost is a uniform branch, so a disabled aid costs one comparison per
 * pixel. Peaking's Sobel is eight taps and is only paid for when it is on.
 */

export interface OverlayLevel {
  id: string;
  label: string;
  /**
   * The threshold, in the units of what it measures: luma 0..1 for zebra,
   * edge magnitude 0..1 for peaking. 0 means off.
   */
  threshold: number;
  note: string;
}

/**
 * ZEBRA — diagonal stripes over pixels at or above a luminance.
 *
 * 100% is the honest default: it marks what is actually LOST, where the
 * sensor cannot say what the value should have been. The lower settings are
 * for judging a shot you intend to grade later, where you want warning before
 * anything is gone rather than after.
 */
export const ZEBRA_LEVELS: readonly OverlayLevel[] = [
  {
    id: 'off',
    label: 'Off',
    threshold: 0,
    note: 'No stripes.'
  },
  {
    id: '100',
    label: '100%',
    // 250/255: at or above this the true value is unknowable, which is the
    // same line vision/exposure.ts counts as clipped.
    threshold: 0.98,
    note: 'Stripes only where detail is genuinely lost — the sensor cannot '
      + 'say what those pixels should have been, and nothing recovers them.'
  },
  {
    id: '90',
    label: '90%',
    threshold: 0.9,
    note: 'Warns before anything is lost. Useful when you mean to darken the '
      + 'shot later and want the headroom.'
  },
  {
    id: '70',
    label: '70%',
    threshold: 0.7,
    note: 'The old video convention for skin tones in good light. Most of a '
      + 'bright scene will stripe — that is expected, not a warning.'
  }
];

/**
 * FOCUS PEAKING — a colour over pixels sitting on a strong brightness edge.
 *
 * Focus IS local contrast: what is sharp has hard edges, what is soft does
 * not. So the same Sobel the Edges filter runs, thresholded and painted over
 * the picture rather than replacing it.
 *
 * IT CANNOT FIND FOCUS IN A FLAT AREA, and that is not a fault: a blank wall
 * has no edges to be sharp. Peaking marks where there is detail AND it is
 * crisp; silence means "nothing here to judge", never "out of focus".
 */
export const PEAKING_LEVELS: readonly OverlayLevel[] = [
  {
    id: 'off',
    label: 'Off',
    threshold: 0,
    note: 'No peaking.'
  },
  {
    id: 'low',
    label: 'Loose',
    threshold: 0.12,
    note: 'Marks any reasonably crisp edge. Best in dim light, where real '
      + 'edges are weaker — expect noise to be marked along with them.'
  },
  {
    id: 'medium',
    label: 'Normal',
    threshold: 0.25,
    note: 'Marks clearly focused detail. The setting to judge a shot by.'
  },
  {
    id: 'high',
    label: 'Strict',
    threshold: 0.45,
    note: 'Only the hardest edges. Almost nothing marked means almost nothing '
      + 'is critically sharp — or the scene simply has no fine detail in it.'
  }
];

export function zebraById(id: string): OverlayLevel | undefined {
  return ZEBRA_LEVELS.find((level) => level.id === id);
}

export function peakingById(id: string): OverlayLevel | undefined {
  return PEAKING_LEVELS.find((level) => level.id === id);
}

/** The threshold the renderer hands the shader; an unknown id is off. */
export function zebraThreshold(id: string): number {
  return zebraById(id)?.threshold ?? 0;
}

export function peakingThreshold(id: string): number {
  return peakingById(id)?.threshold ?? 0;
}
