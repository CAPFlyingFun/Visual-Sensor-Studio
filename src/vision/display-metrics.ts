/**
 * What the screen can show, against what the camera is sending.
 *
 * These are three different sizes that all get called "resolution", and
 * confusing them is what several rounds of guessing here came down to:
 *
 *   SOURCE   what the camera stream delivers        e.g. 3024x4032
 *   CONTENT  what the display can actually show it in    e.g. 1290x1720
 *   RENDER   what the app chose to draw             e.g. 734x979
 *
 * A phone reports its screen in CSS points, not pixels — an iPhone 15 Plus is
 * 932x430 points at a device pixel ratio of 3, which is 2796x1290 real ones.
 * And the canvas does not occupy the whole screen: it is fitted into a box
 * with `contain` or `cover`, so the content box is smaller again and which
 * axis limits it depends on both the fit and the aspect ratio.
 *
 * Nothing here reads the DOM or decides anything. It takes measurements and
 * returns arithmetic, so the numbers can be checked against a device whose
 * dimensions are known.
 */

export interface DisplayInputs {
  /** Screen size in CSS points, as the browser reports it. */
  screenWidth: number;
  screenHeight: number;
  devicePixelRatio: number;
  /** The canvas element's box in CSS points. */
  boxWidth: number;
  boxHeight: number;
  /** The camera stream. */
  sourceWidth: number;
  sourceHeight: number;
  /** The canvas backing store the app is currently drawing. */
  renderWidth: number;
  renderHeight: number;
  /** True for object-fit: cover, false for contain. */
  fill: boolean;
}

export interface Size {
  width: number;
  height: number;
}

export interface DisplayReport {
  /** The screen in real pixels. */
  screenDevice: Size;
  /** The canvas element's box in real pixels. */
  boxDevice: Size;
  /** The fitted picture inside that box, in real pixels — the honest ceiling. */
  contentDevice: Size;
  sourcePixels: number;
  contentPixels: number;
  renderPixels: number;
  /**
   * Render pixels per displayable pixel.
   *
   * Above 1 the app is drawing more than can be seen; below 1 the picture is
   * being stretched. Exactly the number the guessing was about.
   */
  overdraw: number;
  /** What the source would cost if drawn whole, per displayable pixel. */
  sourceOverdraw: number;
}

function round(value: number): number {
  return Math.max(0, Math.round(value));
}

export function measureDisplay(inputs: DisplayInputs): DisplayReport {
  const dpr = Number.isFinite(inputs.devicePixelRatio) && inputs.devicePixelRatio > 0
    ? inputs.devicePixelRatio
    : 1;

  const screenDevice: Size = {
    width: round(inputs.screenWidth * dpr),
    height: round(inputs.screenHeight * dpr)
  };
  const boxDevice: Size = {
    width: round(inputs.boxWidth * dpr),
    height: round(inputs.boxHeight * dpr)
  };

  const sourceAspect = inputs.sourceHeight > 0 ? inputs.sourceWidth / inputs.sourceHeight : 0;
  let contentDevice: Size = { width: 0, height: 0 };
  if (sourceAspect > 0 && inputs.boxWidth > 0 && inputs.boxHeight > 0) {
    const boxAspect = inputs.boxWidth / inputs.boxHeight;
    // contain fits the picture inside the box; cover fills it. The limiting
    // axis swaps between them, which is why this cannot be assumed.
    const heightLimited = inputs.fill ? boxAspect < sourceAspect : boxAspect > sourceAspect;
    const contentWidth = heightLimited ? inputs.boxHeight * sourceAspect : inputs.boxWidth;
    const contentHeight = heightLimited ? inputs.boxHeight : inputs.boxWidth / sourceAspect;
    contentDevice = { width: round(contentWidth * dpr), height: round(contentHeight * dpr) };
  }

  const sourcePixels = round(inputs.sourceWidth * inputs.sourceHeight);
  const contentPixels = contentDevice.width * contentDevice.height;
  const renderPixels = round(inputs.renderWidth * inputs.renderHeight);

  return {
    screenDevice,
    boxDevice,
    contentDevice,
    sourcePixels,
    contentPixels,
    renderPixels,
    overdraw: contentPixels > 0 ? renderPixels / contentPixels : 0,
    sourceOverdraw: contentPixels > 0 ? sourcePixels / contentPixels : 0
  };
}

/** Megapixels to one decimal, for a readout. */
export function megapixels(pixels: number): string {
  return `${(pixels / 1e6).toFixed(2)} MP`;
}


/* ------------------------------------------------------------------ *
 * Turning a measurement into a choice
 * ------------------------------------------------------------------ */

export interface TierProjection {
  /** Short side in pixels, or 0 for the analysis frame. */
  shortSide: number;
  label: string;
  pixels: number;
  /** Frames a second this device should manage, from its measured rate. */
  fps: number;
}

/**
 * How fast this device draws, in megapixels per second.
 *
 * One number that predicts every tier, because the work is per-pixel: a
 * device that renders 0.72 MP in 55 ms will render 2.22 MP in about 170. It
 * is the difference between "try it and see" and knowing before you look.
 */
export function throughputMegapixelsPerSecond(renderPixels: number, msPerFrame: number): number {
  if (!(renderPixels > 0) || !(msPerFrame > 0)) return 0;
  return (renderPixels / 1e6) / (msPerFrame / 1000);
}

/**
 * What each tier would cost, at this device's measured rate.
 *
 * The aspect matters: a short side means a different pixel count in a 3:4
 * frame than in a 16:9 one, and it is the pixel count that costs.
 */
export function projectTiers(
  tiers: readonly { shortSide: number; label: string }[],
  sourceAspect: number,
  throughput: number,
  ceilingShortSide: number
): TierProjection[] {
  const aspect = sourceAspect > 0 ? sourceAspect : 1;
  const longOverShort = aspect > 1 ? aspect : 1 / aspect;
  return tiers
    // A tier above what the screen can show is not a choice, it is the same
    // picture with a different name.
    .filter((tier) => tier.shortSide === 0 || tier.shortSide <= ceilingShortSide)
    .map((tier) => {
      const pixels = tier.shortSide * tier.shortSide * longOverShort;
      return {
        shortSide: tier.shortSide,
        label: tier.label,
        pixels,
        fps: throughput > 0 && pixels > 0 ? (throughput * 1e6) / pixels : 0
      };
    });
}

/**
 * What the auto ladder should do next.
 *
 * TWO signals, because one is not enough and the obvious one is a trap.
 *
 * The trap: the ladder used to read the achieved analysis frame rate against a
 * fixed target. Frame rate is set by the SLOWER of two things — how fast the
 * camera hands frames over, and how fast we draw them — so on a
 * twelve-megapixel capture, where the camera itself manages about ten frames a
 * second, the rate sat below target no matter how small the render was. The
 * ladder read that as "too slow" at every rung and walked to the bottom,
 * showing a 166px analysis frame beside a "0 ms/frame" readout while an
 * explicit Full ran 609px smoothly on the same phone. Shrinking the picture
 * could not move a number the picture did not control.
 *
 * The correction that is also not enough: judge RENDER COST against the
 * camera's delivery interval. That is a number the rung genuinely moves —
 * halve the picture and it quarters. But on its own it reasons "a frame
 * arrives every 100ms and drawing costs 5ms, so there is 95ms going spare",
 * which is only true if the pipeline is in fact keeping up. When it is not,
 * that reads slack off a queue that is already behind.
 *
 * So: cost decides how much room there is, and the DELIVERED-TO-PROCESSED
 * RATIO decides whether that room is real. The ratio is used as a ratio and
 * never as an absolute rate, which is what makes it safe on a slow capture:
 * eight frames analysed out of ten delivered is keeping up, and it stays
 * keeping up whether those ten arrive in a second or a minute.
 */
export type DetailVerdict = 'back-off' | 'hold' | 'climb';

/** Spend below this share of the frame interval and there is room to grow. */
export const DETAIL_CLIMB_SHARE = 0.45;
/** Spend above this share and drawing is starting to hold frames up. */
export const DETAIL_BACK_OFF_SHARE = 0.75;
/**
 * A gap between those two is what stops oscillation: with one boundary every
 * rung would read as both too expensive and cheap enough to leave.
 */
/** Analysing at least this share of delivered frames counts as keeping up. */
export const DETAIL_KEEPING_UP = 0.8;
/**
 * Below this share of the interval, the render is not a plausible cause of
 * dropped frames and must not be blamed for them.
 *
 * This is the guard that stops the original bug reappearing in a new form. A
 * pipeline can fall behind for reasons no rung can fix — a twelve-megapixel
 * decode, a thermally throttled phone — and without this clause, dropping
 * frames would walk the ladder down for a render that was costing a third of
 * a millisecond, which is exactly the failure this rewrite is here to remove.
 */
export const DETAIL_BLAMEABLE_SHARE = 0.2;

export interface DetailLoad {
  /** Rolling cost of the display render alone, in ms. */
  renderMs: number;
  /** Frames the camera hands over per second. */
  deliveredFps: number;
  /** Frames actually analysed per second. */
  processingFps: number;
}

export function detailVerdict(load: DetailLoad): DetailVerdict {
  const { renderMs, deliveredFps, processingFps } = load;
  // Nothing measured yet — a fresh rung has no cost reading until it has drawn
  // a frame, and guessing at that point is how a ladder moves twice on one
  // piece of evidence.
  if (!(renderMs > 0)) return 'hold';

  // Clamped because both ends are untrustworthy: a stalled camera reports a
  // near-zero rate that would license an unbounded render, and 120fps delivery
  // does not mean the render has to fit in 8ms when no eye resolves the
  // difference.
  const interval = deliveredFps > 0
    ? Math.min(250, Math.max(33, 1000 / deliveredFps))
    : 100;

  // Unknown rates are treated as keeping up rather than as failing: an absent
  // measurement is not evidence of a problem, and treating it as one is how
  // the ladder ends up at the bottom on a device that never reported.
  const keepingUp = !(deliveredFps > 0 && processingFps > 0)
    || processingFps >= deliveredFps * DETAIL_KEEPING_UP;
  const blameable = renderMs > interval * DETAIL_BLAMEABLE_SHARE;

  if (renderMs > interval * DETAIL_BACK_OFF_SHARE) return 'back-off';
  // Dropping frames while the render is a real share of the budget: the render
  // is a plausible cause, so give back a rung and see.
  if (!keepingUp && blameable) return 'back-off';
  // Room to grow only counts while the pipeline is actually keeping up with
  // what the camera gives it.
  if (renderMs < interval * DETAIL_CLIMB_SHARE && keepingUp) return 'climb';
  return 'hold';
}
