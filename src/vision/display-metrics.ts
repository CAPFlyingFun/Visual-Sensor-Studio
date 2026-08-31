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
