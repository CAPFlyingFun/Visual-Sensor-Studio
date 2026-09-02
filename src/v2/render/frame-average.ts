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
 * camera frame; "3 frames" means each frame shown carries as much of the last
 * three as an average of three would, not that the screen refreshes three
 * times a second.
 *
 * FRAMES FOR READINGS, MILLISECONDS FOR EFFECTS — and the split is a real
 * difference of units rather than a compromise between two ways of saying
 * the same thing (raised by ChatGPT, 2026-09-02, and it is right).
 *
 *   A NOISE claim is a claim about INDEPENDENT SAMPLES. Averaging four frames
 *   halves the noise whether they arrived in 133 ms at 30 fps or 67 ms at 60,
 *   so a level labelled "4 frames" removes the same noise on any device. The
 *   smear it costs does shrink at a higher frame rate, which is the harmless
 *   direction: the same reading for less lag.
 *
 *   A LOOK is made of HOW LONG THE PAST LINGERS. Dizzy at a fixed ten frames
 *   would be a third of a second of history at 30 fps and half that at 60 —
 *   the same setting, visibly less dizzy, for no reason the person holding
 *   the phone could see. So an effect declares a persistence in
 *   milliseconds, and the frame count follows from the rate the camera is
 *   actually delivering.
 *
 * Both land in the same place: a frame count, and then the one weight below.
 * There is no second formula, and the note under the row prints the OTHER
 * unit as measured, so the conversion is visible rather than hidden.
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
  /**
   * Frames' worth of averaging; 1 is a single frame, i.e. no averaging.
   * A READING level declares this, because noise falls with the number of
   * independent samples and not with the clock. Exactly one of `frames` and
   * `persistenceMs` is set.
   */
  frames?: number;
  /**
   * How long the past lingers, in milliseconds. An EFFECT level declares
   * this, because a look is made of elapsed time: the frame count follows
   * from the rate the camera is measured to be delivering, so the effect
   * looks the same at 30 fps and at 60.
   */
  persistenceMs?: number;
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
    // TIME, not frames. At a fixed ten frames this would be a third of a
    // second of history at 30 fps and half that at 60 — the same setting,
    // visibly less dizzy, for no reason anyone holding the phone could see.
    persistenceMs: 300,
    effect: true,
    note: 'Three tenths of a second of the past in every frame, held to that '
      + 'whatever rate the camera runs at. Far too much to steady a reading, '
      + 'which is the point: everything stays legible but swims. Try RGB.'
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

/**
 * The rate assumed while the real one is still being measured.
 *
 * deliveredFps is measured from presented frames and reads 0 for the first
 * second or so. A time-based effect has to convert through SOMETHING in that
 * window, and 30 is the rate every camera this app has met has settled on.
 * It is a stand-in with a stated reason, not a configuration value: the
 * moment a real measurement exists the conversion uses it.
 */
export const NOMINAL_FPS = 30;

/**
 * Frames for the renderer. A reading level says how many outright; an effect
 * says how long, and the count follows from the rate actually being
 * delivered. An unknown id averages nothing.
 */
export function framesForLevel(id: string, deliveredFps: number): number {
  const level = frameAverageById(id);
  if (!level) return 1;
  if (level.frames !== undefined) return level.frames;
  if (level.persistenceMs === undefined) return 1;
  const fps = deliveredFps > 1 ? deliveredFps : NOMINAL_FPS;
  return Math.max(1, Math.round(level.persistenceMs / 1000 * fps));
}

/**
 * The other unit, measured — appended to the note under the row so the
 * conversion between frames and milliseconds is visible rather than hidden.
 * Empty for Off, which is one frame of no particular duration.
 */
export function conversionNote(id: string, deliveredFps: number): string {
  const level = frameAverageById(id);
  if (!level) return '';
  const frames = framesForLevel(id, deliveredFps);
  if (frames <= 1) return '';
  const measured = deliveredFps > 1;
  const fps = measured ? deliveredFps : NOMINAL_FPS;
  const ms = Math.round(frames / fps * 1000);
  const at = `at ${fps.toFixed(0)} fps${measured ? '' : ', assumed until measured'}`;
  return level.persistenceMs !== undefined
    ? `That is about ${frames} frames ${at}.`
    : `That is about ${ms} ms ${at}.`;
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
