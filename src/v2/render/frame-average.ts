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
 * THE LADDER IS SHORT ON PURPOSE. It first went 3 / 5 / 10 and every rung
 * was too long: ten frames carries a third of a second of the past and the
 * picture swims (Joshua, 2026-09-02). Two to four frames is where the noise
 * falls without the world lagging behind the phone. Ten survives as Dizzy,
 * relabelled as the effect it turned out to be.
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
  /**
   * Chosen for the LOOK rather than for the reading.
   *
   * Dizzy is here because the first ladder went to ten frames, which was far
   * too much for steadying a picture and turned out to be a lovely effect
   * (Joshua, 2026-09-02: "the effect it gives is like a dizzy/drunk look
   * where you can see but it's a little blurred... could save this method").
   * The flag keeps the honest levels honest — an effect must not read as a
   * recommendation for a noisier room — while costing no second mechanism:
   * it is the same average, asked for on purpose.
   */
  effect?: boolean;
}

export const FRAME_AVERAGE_LEVELS: readonly FrameAverageLevel[] = [
  {
    id: 'off',
    label: 'Off',
    frames: 1,
    note: 'One frame, exactly as the sensor delivered it — including the '
      + 'speckle that changes on every one of them.'
  },
  {
    id: 'low',
    label: '2 frames',
    frames: 2,
    note: 'Blends about two frames. Takes the hardest edge off the speckle '
      + 'and you will not see it on anything that moves.'
  },
  {
    id: 'medium',
    label: '3 frames',
    frames: 3,
    note: 'Blends about three frames — roughly a tenth of a second at 30 fps. '
      + 'Steadies the hue lenses with a barely visible trail on movement.'
  },
  {
    id: 'high',
    label: '4 frames',
    frames: 4,
    note: 'Blends about four frames. The steadiest reading that still looks '
      + 'like a live picture; a hand waved through it leaves a short trail.'
  },
  {
    id: 'dizzy',
    label: '😵‍💫 Dizzy',
    frames: 10,
    effect: true,
    note: 'Ten frames — a third of a second of the past in every one. Far too '
      + 'much to steady a reading, which is the point: everything stays '
      + 'legible but swims. Try it on RGB.'
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
