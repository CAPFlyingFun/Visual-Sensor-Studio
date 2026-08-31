/**
 * Slanted-edge MTF — the measurement Phase 2 is gated on.
 *
 * WHY NOT THE SCORE ALREADY IN THE PROJECT. Phase 0 added a high-frequency
 * PSNR to stop a method winning by denoising while resolving nothing, and then
 * measured that it does the opposite: a pure denoise scores +12.5 dB on it
 * against +8.4 dB on plain PSNR. Merging eight frames denoises by roughly 9 dB,
 * so a burst can post a healthy number while recovering no detail at all.
 * Every resolution claim in Phase 0 therefore had to be measured with the noise
 * switched off — which is possible in a simulation and impossible on a camera.
 *
 * On a real capture there is no noise-free control and no ground truth, so the
 * measurement has to come from the picture's own structure. A slanted edge
 * supplies it: a straight boundary is a step function, the camera's response to
 * a step is its edge spread, and the Fourier transform of the derivative of
 * that is the modulation transfer function — how much contrast survives at each
 * spatial frequency. It is the standard instrument (ISO 12233) precisely
 * because it needs nothing but the image.
 *
 * MTF50, the frequency where contrast falls to half, is reported in CYCLES PER
 * PIXEL. Nyquist is 0.5 by definition, so the number is directly comparable
 * between a merged frame and an upscaled one at the same size, which is the
 * whole comparison Phase 2 exists to make.
 *
 * THE SLANT IS NOT A DETAIL. A perfectly vertical edge is sampled at exactly
 * one phase by every row, so it reveals the response at that phase and nothing
 * else. A slight slant makes each row cross the edge at a different sub-pixel
 * position, and the rows together sample the edge far more finely than the
 * pixel grid does. That is the trick the method is built on, and it is why an
 * edge that is too straight has to be refused rather than measured.
 */

import type { Plane } from './super-resolution.js';

export interface MtfResult {
  /** Cycles per pixel at which contrast falls to half. Nyquist is 0.5. */
  mtf50: number | null;
  /** Rows that contributed a usable edge position. */
  samples: number;
  /** How far the edge leans from vertical, in degrees. */
  edgeAngleDegrees: number | null;
  /** Contrast across the edge, in grey levels. */
  contrast: number;
  reason: string;
}

/** Sub-pixel bins per pixel when building the edge spread function. */
const SUPERSAMPLE = 4;

/**
 * Usable slant, in degrees from vertical.
 *
 * Too straight and every row samples the same phase, so the fine detail the
 * method depends on is simply absent. Too slanted and a row crosses several
 * pixels of edge, smearing the very transition being measured.
 */
export const MIN_ANGLE_DEGREES = 1.5;
export const MAX_ANGLE_DEGREES = 15;

/** Below this the "edge" is texture, and its position means nothing. */
export const MIN_CONTRAST = 12;

/** Fewer rows than this and one bad row sets the slope. */
export const MIN_ROWS = 24;

/**
 * How far row positions may scatter about the fitted line, in pixels.
 *
 * THE GATE THAT SEPARATES AN EDGE FROM TEXTURE, and the one that was missing.
 * Grass, gravel and brickwork have strong gradients everywhere, so a "steepest
 * column" exists in every row and a line can always be fitted through them —
 * it just does not describe anything. Measured on pure random texture, that
 * spurious line reported a 2.5 degree edge, cleared every other guard, and the
 * merge report claimed 14.97x the detail of a plain upscale on a scene with no
 * edge in it at all.
 *
 * Scatter tells them apart with enormous margin: a real edge holds 0.29 px at
 * no noise and 0.52 px at sigma 8, while texture scatters about 70 px. Two
 * pixels sits between them by two orders of magnitude, so this rejects texture
 * without ever being close to rejecting a usable edge.
 */
export const MAX_ROW_SCATTER = 2;

function fail(reason: string, partial: Partial<MtfResult> = {}): MtfResult {
  return {
    mtf50: null, samples: 0, edgeAngleDegrees: null, contrast: 0, reason, ...partial
  };
}

/**
 * Where a row crosses the edge, to a fraction of a pixel.
 *
 * The centroid of the absolute derivative, not the steepest single difference:
 * the steepest difference can only ever land on a pixel boundary, which throws
 * away exactly the sub-pixel information the whole method is built to collect.
 *
 * SEARCHED IN A WINDOW, NOT ACROSS THE ROW. Noise contributes about 1.13 of
 * its own sigma to |gradient| at every pixel, so a full-row centroid weighs the
 * edge against noise from the entire width — at 512 px and sigma 2 that is
 * about 1157 of noise weight against 170 from the edge, and the centroid
 * collapses to the middle of the row regardless of where the edge is. Measured:
 * MTF50 fell from 0.186 to 0.037 at sigma 2, and got WORSE as the region grew,
 * which is the signature of a ratio problem rather than a sampling one.
 */
function edgeCentroid(
  plane: Plane,
  row: number,
  centre: number,
  halfWidth: number
): { at: number; weight: number } {
  const from = Math.max(1, Math.floor(centre - halfWidth));
  const to = Math.min(plane.width - 2, Math.ceil(centre + halfWidth));
  let moment = 0;
  let weight = 0;
  for (let x = from; x <= to; x++) {
    const gradient = Math.abs(
      plane.data[row * plane.width + x + 1] - plane.data[row * plane.width + x - 1]
    );
    moment += gradient * x;
    weight += gradient;
  }
  return { at: weight > 0 ? moment / weight : -1, weight };
}

/** Coarse edge column for a row: the strongest single transition. */
function steepestColumn(plane: Plane, row: number): { at: number; strength: number } {
  let at = -1;
  let strength = 0;
  for (let x = 1; x < plane.width - 1; x++) {
    const gradient = Math.abs(
      plane.data[row * plane.width + x + 1] - plane.data[row * plane.width + x - 1]
    );
    if (gradient > strength) { strength = gradient; at = x; }
  }
  return { at, strength };
}

/** Least-squares line through (row, column) pairs. Returns null if degenerate. */
function fitLine(
  points: ReadonlyArray<{ row: number; at: number }>
): { slope: number; meanRow: number; meanAt: number } | null {
  if (points.length < 2) return null;
  let sumRow = 0;
  let sumAt = 0;
  for (const p of points) { sumRow += p.row; sumAt += p.at; }
  const meanRow = sumRow / points.length;
  const meanAt = sumAt / points.length;
  let covariance = 0;
  let variance = 0;
  for (const p of points) {
    covariance += (p.row - meanRow) * (p.at - meanAt);
    variance += (p.row - meanRow) ** 2;
  }
  if (!(variance > 0)) return null;
  return { slope: covariance / variance, meanRow, meanAt };
}

/**
 * Measure the modulation transfer function across a near-vertical edge.
 *
 * The region should contain one edge and little else. Everything is refused
 * rather than approximated: no edge, too little contrast, too little or too
 * much slant, or a curve that never falls to half all return a null MTF50 with
 * the reason, because a resolution figure produced from a bad edge is worse
 * than no figure — it looks exactly like a good one.
 */
export function measureSlantedEdge(plane: Plane): MtfResult {
  const { width, height } = plane;
  if (width < 32 || height < MIN_ROWS) {
    return fail('The region is too small to measure an edge in.');
  }

  // Contrast first: without a real step there is nothing to measure, and every
  // later stage would return a confident number about noise.
  //
  // PERCENTILES, NOT MIN AND MAX. The extremes of a large sample are an
  // outlier statistic, not a contrast: over 25,600 pixels of sigma-3 noise the
  // range reaches about 24 grey levels with no edge present at all, and it
  // grows with the region rather than describing it. A flat noisy patch then
  // passed the contrast gate and was refused several stages later for the
  // wrong reason. The 5th to 95th percentile describes the step itself — a
  // real edge keeps roughly half its pixels on each side, so it barely moves.
  const sorted = Float64Array.from(plane.data).sort();
  const low = sorted[Math.floor(sorted.length * 0.05)];
  const high = sorted[Math.floor(sorted.length * 0.95)];
  const contrast = high - low;
  if (contrast < MIN_CONTRAST) {
    return fail(
      `Only ${contrast.toFixed(0)} grey levels across this region — point it at a `
      + 'clear straight edge, tilted a few degrees off vertical.',
      { contrast }
    );
  }

  // COARSE FIRST, then refine. The strongest transition in each row locates the
  // edge well enough to aim a narrow centroid window at it, and only then is
  // the sub-pixel position worth computing — see edgeCentroid for why a
  // full-row centroid measures the noise instead.
  const coarse: Array<{ row: number; at: number }> = [];
  for (let row = 0; row < height; row++) {
    const found = steepestColumn(plane, row);
    if (found.at >= 4 && found.at <= width - 5 && found.strength > contrast * 0.25) {
      coarse.push({ row, at: found.at });
    }
  }
  if (coarse.length < MIN_ROWS) {
    return fail(`Only ${coarse.length} rows had a clear edge; ${MIN_ROWS} are needed.`,
      { contrast, samples: coarse.length });
  }
  const coarseLine = fitLine(coarse);
  if (!coarseLine) return fail('The edge positions do not vary.', { contrast });

  // Do these positions actually lie on a line? See MAX_ROW_SCATTER — without
  // this, any textured scene yields a confident measurement of nothing.
  let scatter = 0;
  for (const c of coarse) {
    scatter += (c.at - (coarseLine.meanAt + coarseLine.slope * (c.row - coarseLine.meanRow))) ** 2;
  }
  scatter = Math.sqrt(scatter / coarse.length);
  if (scatter > MAX_ROW_SCATTER) {
    return fail(
      `The strongest transitions wander ${scatter.toFixed(0)} px about a line, so this `
      + 'is texture rather than an edge. Aim at something with one straight '
      + 'boundary across it — a door frame, a book, a sign — tilted a few degrees.',
      { contrast, samples: coarse.length }
    );
  }

  // Refined pass: centroid in a narrow window centred on the coarse line, and
  // rows whose refinement runs away from it are dropped rather than fitted.
  const WINDOW = 6;
  const rows: Array<{ row: number; at: number }> = [];
  for (const c of coarse) {
    const predicted = coarseLine.meanAt + coarseLine.slope * (c.row - coarseLine.meanRow);
    const found = edgeCentroid(plane, c.row, predicted, WINDOW);
    if (found.weight > 0 && Math.abs(found.at - predicted) <= WINDOW / 2) {
      rows.push({ row: c.row, at: found.at });
    }
  }
  if (rows.length < MIN_ROWS) {
    return fail(`Only ${rows.length} rows gave a stable edge position; `
      + `${MIN_ROWS} are needed.`, { contrast, samples: rows.length });
  }
  const line = fitLine(rows);
  if (!line) return fail('The edge positions do not vary.', { contrast });
  const { slope, meanRow, meanAt } = line;
  const angle = Math.abs(Math.atan(slope) * 180 / Math.PI);

  if (angle < MIN_ANGLE_DEGREES) {
    return fail(
      `The edge is only ${angle.toFixed(1)}° off vertical. Every row then samples it `
      + 'at the same sub-pixel position, so there is no fine detail to recover. '
      + 'Tilt the phone a few degrees.',
      { contrast, samples: rows.length, edgeAngleDegrees: angle }
    );
  }
  if (angle > MAX_ANGLE_DEGREES) {
    return fail(
      `The edge leans ${angle.toFixed(1)}°, so a single row crosses several pixels of `
      + 'it and smears the transition being measured. Straighten up a little.',
      { contrast, samples: rows.length, edgeAngleDegrees: angle }
    );
  }

  // Project every pixel onto the edge normal and bin at quarter-pixel spacing.
  // This is where the slant pays: rows crossing at different phases fill in
  // between the pixel centres.
  const span = 16;
  const bins = span * 2 * SUPERSAMPLE;
  const sums = new Float64Array(bins);
  const counts = new Float64Array(bins);
  for (const r of rows) {
    const centre = meanAt + slope * (r.row - meanRow);
    for (let x = 0; x < width; x++) {
      const distance = x - centre;
      if (distance < -span || distance >= span) continue;
      const bin = Math.floor((distance + span) * SUPERSAMPLE);
      if (bin < 0 || bin >= bins) continue;
      sums[bin] += plane.data[r.row * width + x];
      counts[bin]++;
    }
  }

  // Edge spread function. A gap means no row sampled that phase, and
  // interpolating across it would invent the very detail being measured, so a
  // gappy profile is refused.
  const esf = new Float64Array(bins);
  let filled = 0;
  for (let i = 0; i < bins; i++) {
    if (counts[i] > 0) { esf[i] = sums[i] / counts[i]; filled++; }
    else esf[i] = NaN;
  }
  if (filled < bins * 0.9) {
    return fail('The edge profile has gaps — not enough rows crossing it.',
      { contrast, samples: rows.length, edgeAngleDegrees: angle });
  }
  for (let i = 0; i < bins; i++) {
    if (!Number.isNaN(esf[i])) continue;
    let before = i - 1;
    while (before >= 0 && Number.isNaN(esf[before])) before--;
    let after = i + 1;
    while (after < bins && Number.isNaN(esf[after])) after++;
    esf[i] = before >= 0 && after < bins ? (esf[before] + esf[after]) / 2
      : before >= 0 ? esf[before] : esf[after];
  }

  // Line spread function: the derivative of the edge response.
  const lsf = new Float64Array(bins);
  for (let i = 1; i < bins - 1; i++) lsf[i] = (esf[i + 1] - esf[i - 1]) / 2;
  // A Hamming window, because the transform of an abruptly truncated profile
  // carries the truncation's own frequencies rather than the lens's.
  for (let i = 0; i < bins; i++) {
    lsf[i] *= 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (bins - 1));
  }

  // Discrete transform, magnitude, normalised by the zero frequency. Bins are
  // a quarter of a pixel apart, so bin k is 4k/bins cycles per pixel and
  // Nyquist (0.5) sits at k = bins/8.
  const nyquistBin = Math.floor(bins / 8);
  const curve = new Float32Array(nyquistBin + 1);
  let dc = 0;
  for (let i = 0; i < bins; i++) dc += lsf[i];
  if (!(Math.abs(dc) > 1e-9)) {
    return fail('The edge profile has no net transition.',
      { contrast, samples: rows.length, edgeAngleDegrees: angle });
  }
  for (let k = 0; k <= nyquistBin; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < bins; i++) {
      const phase = (-2 * Math.PI * k * i) / bins;
      re += lsf[i] * Math.cos(phase);
      im += lsf[i] * Math.sin(phase);
    }
    curve[k] = Math.hypot(re, im) / Math.abs(dc);
  }

  // Where it crosses half, interpolated between the bracketing bins.
  let mtf50: number | null = null;
  for (let k = 1; k <= nyquistBin; k++) {
    if (curve[k] <= 0.5 && curve[k - 1] > 0.5) {
      const t = (curve[k - 1] - 0.5) / (curve[k - 1] - curve[k]);
      mtf50 = ((k - 1 + t) * SUPERSAMPLE) / bins;
      break;
    }
  }
  if (mtf50 === null) {
    return fail(
      'Contrast never falls to half before Nyquist — the edge is sharper than the '
      + 'pixel grid can express, so this region cannot bound the resolution.',
      { contrast, samples: rows.length, edgeAngleDegrees: angle }
    );
  }

  return {
    mtf50,
    samples: rows.length,
    edgeAngleDegrees: angle,
    contrast,
    reason: `${mtf50.toFixed(3)} cycles/px from ${rows.length} rows across a `
      + `${angle.toFixed(1)}° edge (Nyquist is 0.500).`
  };
}
