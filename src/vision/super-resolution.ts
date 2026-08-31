/**
 * Multi-frame super-resolution — Phase 0: the forward model, the merge, and
 * the control it has to beat.
 *
 * Nothing here touches a camera. That is the point. The spec
 * (docs/multi-frame-super-resolution.md) rests on one claim that could be
 * false — that the binned stream still carries recoverable aliased detail —
 * and this module exists so that claim can be tested against synthetic data
 * with known ground truth before a single line of capture UI is written.
 *
 * THE FORWARD MODEL, and every symbol in it:
 *
 *   frame_i = noise( bin( blur( shift(scene, s_i) ) ) )
 *
 * where `scene` stands in for the 48MP sensor plane, `blur` is the lens point
 * spread function, `bin` is the 2x2 averaging the sensor actually performs,
 * and `s_i` is where hand tremor put the camera for that frame. Inverting
 * that chain is the whole idea; being honest about it is why the model is
 * written down rather than assumed.
 *
 * UNITS. Every shift in this module is in LOW-RESOLUTION pixels — the units a
 * real aligner would measure, working on the frames it actually receives.
 * Scene-space quantities (the PSF sigma, motion blur) are in scene pixels and
 * are named as such. Mixing the two is the easiest possible mistake here and
 * it silently produces a merge that looks like it half works.
 */

export interface Plane {
  readonly data: Float32Array;
  readonly width: number;
  readonly height: number;
}

export function createPlane(width: number, height: number): Plane {
  return { data: new Float32Array(width * height), width, height };
}

/** Bilinear sample with edge clamping, in the plane's own pixel coordinates. */
export function samplePlane(plane: Plane, x: number, y: number): number {
  const { data, width, height } = plane;
  const cx = Math.min(width - 1, Math.max(0, x));
  const cy = Math.min(height - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const top = data[y0 * width + x0] * (1 - fx) + data[y0 * width + x1] * fx;
  const bottom = data[y1 * width + x0] * (1 - fx) + data[y1 * width + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/** Catmull-Rom weight, for the bicubic control. */
function catmullRom(t: number): [number, number, number, number] {
  const t2 = t * t;
  const t3 = t2 * t;
  return [
    -0.5 * t3 + t2 - 0.5 * t,
    1.5 * t3 - 2.5 * t2 + 1,
    -1.5 * t3 + 2 * t2 + 0.5 * t,
    0.5 * t3 - 0.5 * t2
  ];
}

export function sampleBicubic(plane: Plane, x: number, y: number): number {
  const { data, width, height } = plane;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const wx = catmullRom(x - x0);
  const wy = catmullRom(y - y0);
  let total = 0;
  for (let j = 0; j < 4; j++) {
    const sy = Math.min(height - 1, Math.max(0, y0 - 1 + j));
    let row = 0;
    for (let i = 0; i < 4; i++) {
      const sx = Math.min(width - 1, Math.max(0, x0 - 1 + i));
      row += data[sy * width + sx] * wx[i];
    }
    total += row * wy[j];
  }
  return total;
}

/** out(x, y) = source(x - dx, y - dy). A positive shift moves content right. */
export function shiftPlane(source: Plane, dx: number, dy: number): Plane {
  const out = createPlane(source.width, source.height);
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      out.data[y * source.width + x] = sampleBicubic(source, x - dx, y - dy);
    }
  }
  return out;
}

/** Separable Gaussian, standing in for the lens point spread function. */
export function blurPlane(source: Plane, sigma: number): Plane {
  if (!(sigma > 0)) return source;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const { width, height } = source;
  const pass = createPlane(width, height);
  const out = createPlane(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let i = -radius; i <= radius; i++) {
        const sx = Math.min(width - 1, Math.max(0, x + i));
        acc += source.data[y * width + sx] * kernel[i + radius];
      }
      pass.data[y * width + x] = acc;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let i = -radius; i <= radius; i++) {
        const sy = Math.min(height - 1, Math.max(0, y + i));
        acc += pass.data[sy * width + x] * kernel[i + radius];
      }
      out.data[y * width + x] = acc;
    }
  }
  return out;
}

/**
 * Smear along a straight line, standing in for camera motion DURING exposure.
 *
 * This is the cost the stillness gate would buy off. Joshua's suggestion was
 * to let the motion sensors trigger the capture; the sharpest form of that is
 * to capture only while angular velocity is low, because a frame smeared
 * across the exposure has already lost the high frequencies the merge is
 * trying to recover, and no amount of merging puts them back.
 *
 * `lengthScenePixels` is the total travel during one exposure, in scene pixels.
 */
export function motionBlurPlane(
  source: Plane,
  lengthScenePixels: number,
  angleRadians = 0,
  samples = 9
): Plane {
  if (!(lengthScenePixels > 0)) return source;
  const { width, height } = source;
  const out = createPlane(width, height);
  const dx = Math.cos(angleRadians);
  const dy = Math.sin(angleRadians);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let s = 0; s < samples; s++) {
        // Centred on the pixel, so the smear does not also translate the image.
        const t = (s / (samples - 1) - 0.5) * lengthScenePixels;
        acc += samplePlane(source, x + dx * t, y + dy * t);
      }
      out.data[y * width + x] = acc / samples;
    }
  }
  return out;
}

/**
 * Average non-overlapping factor x factor blocks — what the sensor does.
 *
 * A box filter, deliberately, because that is what binning IS. Substituting a
 * gentler anti-aliasing filter here would model a sensor nobody sells and
 * would quietly remove the aliasing this whole exercise depends on.
 */
export function binPlane(source: Plane, factor: number): Plane {
  const width = Math.floor(source.width / factor);
  const height = Math.floor(source.height / factor);
  const out = createPlane(width, height);
  const area = factor * factor;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let j = 0; j < factor; j++) {
        for (let i = 0; i < factor; i++) {
          acc += source.data[(y * factor + j) * source.width + (x * factor + i)];
        }
      }
      out.data[y * width + x] = acc / area;
    }
  }
  return out;
}

/** Deterministic PRNG, so a failing test fails the same way twice. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function noisyPlane(source: Plane, sigma: number, seed: number): Plane {
  if (!(sigma > 0)) return source;
  const random = mulberry32(seed);
  const out = createPlane(source.width, source.height);
  for (let i = 0; i < source.data.length; i++) {
    // Box-Muller. Guarded against log(0), which is otherwise a rare -Infinity.
    const u = Math.max(1e-9, random());
    const v = random();
    const gauss = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    out.data[i] = source.data[i] + gauss * sigma;
  }
  return out;
}

/** One captured frame and where the camera was when it was taken. */
export interface BurstFrame {
  plane: Plane;
  /** Shift relative to the reference, in LOW-RESOLUTION pixels. */
  shiftX: number;
  shiftY: number;
}

export interface CaptureModel {
  /** Sensor binning. 2 means 2x2, which is what the phone delivers. */
  binFactor: number;
  /** Lens point spread, in SCENE pixels. The parameter that can kill the idea. */
  psfSigma: number;
  /** Read noise, in the same 0..255 units as the scene. */
  noiseSigma: number;
  /** Camera travel during one exposure, in SCENE pixels. Zero for a still hand. */
  motionBlurScenePixels?: number;
  seed?: number;
}

/**
 * Run the forward model over a set of camera positions.
 *
 * The order matters and is not arbitrary: the camera moves, THEN the lens
 * blurs, THEN the exposure smears, THEN the sensor bins, THEN the read adds
 * noise. Reordering blur and binning in particular would model a sensor that
 * filters before it samples, which is exactly the sensor that would make
 * super-resolution impossible — and would make this harness answer a question
 * nobody asked.
 */
export function synthesiseBurst(
  scene: Plane,
  shifts: ReadonlyArray<{ shiftX: number; shiftY: number }>,
  model: CaptureModel
): BurstFrame[] {
  const seed = model.seed ?? 1;
  return shifts.map((shift, index) => {
    const moved = shiftPlane(
      scene,
      shift.shiftX * model.binFactor,
      shift.shiftY * model.binFactor
    );
    const blurred = blurPlane(moved, model.psfSigma);
    const smeared = motionBlurPlane(
      blurred,
      model.motionBlurScenePixels ?? 0,
      // A fixed diagonal, so the smear cannot accidentally align with the
      // binning grid and read as cheaper than it is.
      Math.PI / 5
    );
    const binned = binPlane(smeared, model.binFactor);
    return {
      plane: noisyPlane(binned, model.noiseSigma, seed + index * 7919),
      shiftX: shift.shiftX,
      shiftY: shift.shiftY
    };
  });
}

/**
 * Where a low-resolution sample lands on the output grid.
 *
 * Output pixel p covers reference low-res coordinate (p + 0.5) / scale - 0.5,
 * so the inverse puts sample u of a frame shifted by s at
 * ((u - s) + 0.5) * scale - 0.5. Both the merge and the control use this, and
 * they must: a control fed a different geometry would be half a pixel out and
 * would lose to the merge for a reason that has nothing to do with resolution.
 */
function toOutputCoordinate(sample: number, shift: number, scale: number): number {
  return (sample - shift + 0.5) * scale - 0.5;
}

export interface MergeOptions {
  /** Output size relative to a single frame. Never usefully above binFactor. */
  scale: number;
  /** Splat kernel width in OUTPUT pixels. */
  kernelSigma?: number;
  kernelRadius?: number;
  /**
   * How hard to reject contributions that disagree with the reference, in
   * noise sigmas. Zero disables it.
   *
   * Not optional in practice: without it anything that moved in the scene
   * smears into a ghost, and the failure looks like a plausible photograph
   * rather than an error. It is switchable only so a test can show what it
   * costs and what it saves.
   */
  robustness?: number;
  /** Expected noise level, for scaling the robustness threshold. */
  noiseSigma?: number;
  /** Index of the frame everything aligns to. */
  referenceIndex?: number;
}

/**
 * Upscale one frame — THE CONTROL.
 *
 * Every claim this project could make reduces to beating this. It is
 * deliberately a good bicubic rather than a weak straw man, and it is placed
 * on the output grid by the same geometry the merge uses.
 */
export function upscaleFrame(frame: BurstFrame, scale: number): Plane {
  const width = Math.round(frame.plane.width * scale);
  const height = Math.round(frame.plane.height * scale);
  const out = createPlane(width, height);
  for (let y = 0; y < height; y++) {
    const sy = (y + 0.5) / scale - 0.5 + frame.shiftY;
    for (let x = 0; x < width; x++) {
      const sx = (x + 0.5) / scale - 0.5 + frame.shiftX;
      out.data[y * width + x] = sampleBicubic(frame.plane, sx, sy);
    }
  }
  return out;
}

/**
 * Merge a burst onto a finer grid by weighted splatting.
 *
 * Each low-resolution sample is deposited onto every nearby output pixel with
 * a Gaussian weight, and the accumulated values are divided by the accumulated
 * weight. Where the frames landed on genuinely different sub-pixel offsets,
 * the samples constrain the finer grid; where they did not, this reduces to an
 * expensive average and the result should — correctly — be no better than the
 * control.
 */
export function mergeBurst(frames: ReadonlyArray<BurstFrame>, options: MergeOptions): Plane {
  const { scale } = options;
  const kernelSigma = options.kernelSigma ?? 0.5;
  const kernelRadius = options.kernelRadius ?? 2;
  const robustness = options.robustness ?? 0;
  const noiseSigma = options.noiseSigma ?? 1;
  const reference = frames[options.referenceIndex ?? 0];

  const width = Math.round(reference.plane.width * scale);
  const height = Math.round(reference.plane.height * scale);
  const accumulator = new Float32Array(width * height);
  const weights = new Float32Array(width * height);

  // The reference upscaled is both the robustness yardstick and the fallback
  // for output pixels no sample reached. Holes are honest; invented pixels
  // are not.
  const guide = upscaleFrame(reference, scale);
  const twoSigmaSquared = 2 * kernelSigma * kernelSigma;
  const rejectScale = robustness > 0 ? robustness * Math.max(noiseSigma, 1e-6) : 0;

  for (const frame of frames) {
    const { plane, shiftX, shiftY } = frame;
    for (let v = 0; v < plane.height; v++) {
      const oy = toOutputCoordinate(v, shiftY, scale);
      const yStart = Math.max(0, Math.ceil(oy - kernelRadius));
      const yEnd = Math.min(height - 1, Math.floor(oy + kernelRadius));
      if (yStart > yEnd) continue;
      for (let u = 0; u < plane.width; u++) {
        const ox = toOutputCoordinate(u, shiftX, scale);
        const xStart = Math.max(0, Math.ceil(ox - kernelRadius));
        const xEnd = Math.min(width - 1, Math.floor(ox + kernelRadius));
        if (xStart > xEnd) continue;
        const value = plane.data[v * plane.width + u];

        for (let y = yStart; y <= yEnd; y++) {
          const dy = y - oy;
          for (let x = xStart; x <= xEnd; x++) {
            const dx = x - ox;
            let w = Math.exp(-(dx * dx + dy * dy) / twoSigmaSquared);
            if (rejectScale > 0) {
              // Attenuate smoothly rather than thresholding: a hard cut makes
              // the boundary between accepted and rejected regions visible as
              // an edge that was never in the scene.
              const disagreement = value - guide.data[y * width + x];
              w *= Math.exp(-(disagreement * disagreement) / (2 * rejectScale * rejectScale));
            }
            accumulator[y * width + x] += w * value;
            weights[y * width + x] += w;
          }
        }
      }
    }
  }

  const out = createPlane(width, height);
  // Below this much accumulated weight the estimate is one noisy sample rather
  // than a merge, so the guide is the better answer.
  const floor = 1e-3;
  for (let i = 0; i < out.data.length; i++) {
    out.data[i] = weights[i] > floor ? accumulator[i] / weights[i] : guide.data[i];
  }
  return out;
}

/** Peak signal-to-noise ratio in dB, against a 0..255 scale. */
export function psnr(a: Plane, b: Plane): number {
  if (a.data.length !== b.data.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) {
    const d = a.data[i] - b.data[i];
    sum += d * d;
  }
  const mse = sum / a.data.length;
  if (mse <= 0) return Number.POSITIVE_INFINITY;
  return 10 * Math.log10((255 * 255) / mse);
}

/**
 * PSNR of the high-frequency content alone.
 *
 * Overall PSNR is dominated by the low frequencies, which every method gets
 * right, so a merge can win on it by denoising while resolving nothing. This
 * removes what a blur can predict and scores only what is left — which is the
 * only part super-resolution is supposed to be about.
 */
export function highFrequencyPsnr(a: Plane, b: Plane, sigma = 1.5): number {
  return psnr(highPass(a, sigma), highPass(b, sigma));
}

export function highPass(source: Plane, sigma: number): Plane {
  const low = blurPlane(source, sigma);
  const out = createPlane(source.width, source.height);
  for (let i = 0; i < out.data.length; i++) {
    // Offset to mid-grey so the result stays in the range PSNR assumes.
    out.data[i] = source.data[i] - low.data[i] + 128;
  }
  return out;
}

/**
 * How well a set of shifts covers the sub-pixel grid, from 0 to 1.
 *
 * ONLY THE FRACTIONAL PART MATTERS. A shift of 4.3 pixels and one of 7.3
 * pixels sample the scene identically as far as the binning grid is concerned,
 * so a burst can move a long way and still carry one offset. This is the
 * quantity Joshua's motion trigger would be steering, and it is measured here
 * so the value of steering it can be established before it is built.
 *
 * Computed as the mean distance from each cell of a `bins` x `bins` grid to
 * the nearest sampled offset, normalised so that 1 is a perfect spread and 0
 * is every frame landing on one offset.
 */
export function offsetSpread(
  shifts: ReadonlyArray<{ shiftX: number; shiftY: number }>,
  bins = 4
): number {
  if (shifts.length === 0) return 0;
  const fractional = shifts.map((s) => ({
    x: s.shiftX - Math.floor(s.shiftX),
    y: s.shiftY - Math.floor(s.shiftY)
  }));
  let worst = 0;
  for (let j = 0; j < bins; j++) {
    for (let i = 0; i < bins; i++) {
      const cx = (i + 0.5) / bins;
      const cy = (j + 0.5) / bins;
      let nearest = Infinity;
      for (const f of fractional) {
        // Toroidal: offsets wrap, because 0.99 and 0.01 are neighbours.
        const dx = Math.min(Math.abs(f.x - cx), 1 - Math.abs(f.x - cx));
        const dy = Math.min(Math.abs(f.y - cy), 1 - Math.abs(f.y - cy));
        nearest = Math.min(nearest, Math.hypot(dx, dy));
      }
      worst = Math.max(worst, nearest);
    }
  }
  // Half the diagonal of the unit cell is the worst possible nearest distance.
  return Math.max(0, 1 - worst / (Math.SQRT2 / 2));
}

/**
 * Iterative back-projection — the estimator that actually inverts the model.
 *
 * WHY THIS EXISTS, since the splat above came first and looked reasonable.
 *
 * `mergeBurst` scatters each sample onto the output with a kernel and divides
 * by the accumulated weight. That is Shepard interpolation, and it convolves
 * the answer with the splat kernel ON TOP OF the box filter the sensor already
 * applied. Bicubic upscaling of one frame carries no such second blur, so the
 * splat starts at a deficit it has to make up before any recovered aliasing
 * counts as a win. Measured on synthetic data it never did: the splat lost to
 * bicubic at every lens blur and every kernel width tried, which is a fact
 * about the estimator and not about the physics.
 *
 * Back-projection inverts the forward model instead of approximating it:
 * simulate what each frame WOULD have looked like given the current estimate,
 * take the residual against what was actually captured, and push that residual
 * back into the estimate. Where the estimate is already right the residual is
 * noise and nothing moves; where it is blurred, the residual is exactly the
 * detail that was missing. Irani & Peleg, 1991.
 *
 * `psfSigma` and `binFactor` must match the capture. They are the model being
 * inverted, so a wrong value here is not a tuning error — it is inverting a
 * different camera.
 */
export interface RefineOptions {
  scale: number;
  binFactor: number;
  psfSigma: number;
  iterations?: number;
  /** Step size. Above about 1 the iteration rings; below it converges slowly. */
  gain?: number;
  /**
   * Blur applied to each correction before it lands.
   *
   * The back-projection kernel should be the transpose of the forward
   * operator; this is the practical stand-in. Zero sharpens fastest and
   * amplifies noise fastest with it.
   */
  correctionSigma?: number;
  referenceIndex?: number;
  /** Starting estimate. Defaults to the reference frame upscaled. */
  initial?: Plane;
}

export function refineBurst(
  frames: ReadonlyArray<BurstFrame>,
  options: RefineOptions
): Plane {
  const { scale, binFactor, psfSigma } = options;
  const iterations = options.iterations ?? 8;
  const gain = options.gain ?? 0.9;
  const correctionSigma = options.correctionSigma ?? 0;
  const reference = frames[options.referenceIndex ?? 0];

  let estimate = options.initial ?? upscaleFrame(reference, scale);
  const width = estimate.width;
  const height = estimate.height;

  for (let iteration = 0; iteration < iterations; iteration++) {
    const correction = new Float32Array(width * height);

    for (const frame of frames) {
      // Forward: exactly the model in synthesiseBurst, minus the noise, which
      // is unpredictable by definition and must not be chased.
      const moved = shiftPlane(estimate, frame.shiftX * binFactor, frame.shiftY * binFactor);
      const simulated = binPlane(blurPlane(moved, psfSigma), binFactor);

      const residual = createPlane(frame.plane.width, frame.plane.height);
      for (let i = 0; i < residual.data.length; i++) {
        residual.data[i] = frame.plane.data[i] - simulated.data[i];
      }

      // upscaleFrame carries the shift, so this both upsamples the residual
      // and returns it to the reference grid in one step — using the same
      // geometry the control uses, so no half-pixel can creep in between them.
      const projected = upscaleFrame({ plane: residual, shiftX: frame.shiftX, shiftY: frame.shiftY }, scale);
      const spread = correctionSigma > 0 ? blurPlane(projected, correctionSigma) : projected;
      for (let i = 0; i < correction.length; i++) correction[i] += spread.data[i];
    }

    const next = createPlane(width, height);
    const step = gain / frames.length;
    for (let i = 0; i < next.data.length; i++) {
      next.data[i] = estimate.data[i] + step * correction[i];
    }
    estimate = next;
  }
  return estimate;
}
