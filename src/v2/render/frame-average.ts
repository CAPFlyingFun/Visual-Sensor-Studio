/**
 * FRAME AVERAGING — how many camera frames are blended together before a
 * filter looks at the picture. One registry (Rule 5), one owner (Rule 1).
 *
 * This replaces a spatial blur that was the wrong tool, and Joshua's own
 * diagnosis is why (2026-09-02): "each little motion my phone makes even like
 * 0.2° will grab a new frame/pixel... the still images are fine because it
 * has a chance to grab one good frame". The speckle is TEMPORAL. Every frame
 * the sensor re-rolls its noise and the hand re-aims the lens a fraction of a
 * degree, so a hue-derived field re-decides every pixel thirty times a
 * second. A spatial blur cannot help with that: it throws away detail from
 * the one frame it can see, and — measured on his device — dims the picture
 * as well, because softening the frame lowers saturation and the colour
 * fields' own colourfulness gates then close.
 *
 * Averaging over TIME is the matching tool. Sensor noise is independent from
 * frame to frame, so it falls as 1/sqrt(frames), while anything actually
 * standing still in the picture is identical in every frame and survives
 * untouched — no softening, no dimming. What it costs is movement: a moving
 * thing is in a different place in each averaged frame, so it smears. That is
 * the honest trade, and it is why this is a control rather than a default.
 *
 * IT IS A ROLLING AVERAGE, NOT A HOLD. The preview still updates on every
 * camera frame; "5 frames" means each frame shown carries as much of the last
 * five as an average of five would, not that the screen refreshes five times
 * a second.
 *
 * The implementation is an exponential moving average — one texture, not N —
 * with the standard equivalence weight 2/(N+1). That is the weight at which
 * an EMA reduces noise by exactly as much as a true average of N frames, so
 * the labels mean what they say.
 */

export interface FrameAverageLevel {
  id: string;
  /** For the chip. */
  label: string;
  /** Frames' worth of averaging; 1 is a single frame, i.e. no averaging. */
  frames: number;
  /** What it does to the picture, in the one sentence under the row. */
  note: string;
}

export const FRAME_AVERAGE_LEVELS: readonly FrameAverageLevel[] = [
  {
    id: 'off',
    label: 'Off',
    frames: 1,
    note: 'Every frame exactly as the sensor delivered it — including the '
      + 'speckle that changes on every one of them.'
  },
  {
    id: 'low',
    label: '3 frames',
    frames: 3,
    note: 'Blends about three frames. Cuts the frame-to-frame speckle roughly '
      + 'in half with almost no smear on anything that moves.'
  },
  {
    id: 'medium',
    label: '5 frames',
    frames: 5,
    note: 'Blends about five frames. For a dim room, where hue is mostly '
      + 'noise; a hand moving through the picture leaves a short trail.'
  },
  {
    id: 'high',
    label: '10 frames',
    frames: 10,
    note: 'Blends about ten frames — a third of a second at 30 fps. Steadiest '
      + 'reading of a still scene, and anything moving smears badly.'
  }
];

/**
 * OFF by default (Joshua, 2026-09-02, of the spatial version this replaces:
 * "keep it off by default as only certain filters show it — most don't show
 * a lot of noise"). The instruction holds: brightness averages three channels
 * and barely moves, while hue is an argument between them and swings on a
 * count or two of noise, so the hue-derived fields are the ones that need
 * this and they say so in their own notes.
 */
export const DEFAULT_FRAME_AVERAGE = 'off';

export function frameAverageById(id: string): FrameAverageLevel | undefined {
  return FRAME_AVERAGE_LEVELS.find((level) => level.id === id);
}

/** Frames for the renderer; an unknown id averages nothing. */
export function frameAverageCount(id: string): number {
  return frameAverageById(id)?.frames ?? 1;
}

/**
 * The EMA weight that matches an average of `frames` frames.
 *
 * An EMA's variance is alpha / (2 - alpha) of the input's, so alpha =
 * 2 / (frames + 1) is the value at which it removes exactly as much noise as
 * a true average of that many frames. Using 1/frames instead — the obvious
 * guess — would quietly do about twice the smoothing the label promises.
 */
export function frameAverageWeight(frames: number): number {
  if (!(frames > 1)) return 1;
  return 2 / (frames + 1);
}
