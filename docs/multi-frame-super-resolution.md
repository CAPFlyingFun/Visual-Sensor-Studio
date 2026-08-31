# Multi-frame super-resolution — specification

Status: **Phase 1 complete. Gate passed on the device.** See "Phase 0 results"
at the foot of this document — it corrects three claims made above, which are
left in place so the corrections have something to point at.

## The question this answers

The browser gets 3024×4032 from a sensor that is physically 6048×8064. That
12 MP stream is the **2×2 binned** readout — four photosites averaged into one
output pixel — and the arithmetic is exact, not approximate:

```
sensor  6048 × 8064 = 48.77 MP
ours    3024 × 4032 = 12.19 MP   = sensor ÷ 2 in each dimension, exactly
native  4536 × 8064 = 36.58 MP   = a 9:16 crop of the full readout
```

`getUserMedia` does not offer the unbinned mode and no amount of processing
conjures pixels that were never transmitted. The question is narrower and more
interesting: **can many binned frames, each sampling the scene at a slightly
different sub-pixel offset, be merged into one frame that genuinely resolves
more than any of them?**

Not "looks sharper". Resolves more.

## Why it can work

Binning is a box filter followed by decimation, and a box filter is a poor
anti-aliasing filter. Scene frequencies above the 12 MP grid's Nyquist limit
are not removed — they **alias**, folding down into the sampled band. Which
frequencies fold where depends on where the sampling grid falls relative to the
scene, so two frames taken with the camera a third of a pixel apart carry
*different* aliased content about the same detail.

That difference is information. Given enough frames at enough distinct
sub-pixel offsets, the aliasing can be inverted and the true high frequencies
recovered. This is the classical result (Tsai & Huang 1984; see Park, Park &
Kang 2003 for the survey) and the basis of Google's handheld pipeline
(Wronski et al., *Handheld Multi-Frame Super-Resolution*, SIGGRAPH 2019).

Hand tremor supplies the offsets for free. It is a nuisance everywhere else in
this app and the necessary ingredient here.

## Why it might not — the one assumption to test first

**If the optical PSF plus binning already band-limit the signal below the 12 MP
Nyquist, there is little aliased content to recover and the gain is marginal.**

A 48 MP sensor behind a phone lens is close to the diffraction and focus limits
already; it is entirely possible that Apple's binned output is nearly
band-limited, in which case eight frames buy noise reduction and almost no
resolution. That is not a reason to skip the project — it is a reason to
**test it synthetically before writing any capture UI.** See Phase 0.

## The honest ceiling

At best this recovers toward the sensor's own 48 MP: **2× linear**, no further.
Beyond 2× there is no information at any offset, because the photosites do not
exist. Published handheld results land nearer **1.4–1.7× effective linear
gain** rather than the full 2×. Anything claiming more is interpolation.

## Pipeline

### Stage 0 — Burst capture

- N = 8 frames at full 12 MP, captured as fast as the loop allows (~1 s at 8 fps).
- Convert each to **luma Uint8 immediately** (12.2 MB/frame). Discard RGBA.
- Keep **chroma from the reference frame only**, upscaled. Human vision resolves
  chroma far more coarsely than luma; merging it triples the memory for
  something nobody can see. This is a standard shortcut, not a corner cut.
- Abort the burst if `MotionController` reports rotation beyond a threshold —
  a pan is not tremor and will not align.

### Stage 1 — Reference selection

Pick the sharpest frame via `estimateEffectiveResolution` from
`src/vision/sharpness.ts`. Everything aligns to it, and it is the fallback if
the merge fails. Its own upscale is the control the result must beat.

### Stage 2 — Alignment

Sub-pixel accuracy of roughly **0.1 px** is required; at 0.5 px error the merge
degenerates into a blur. `computeBlockFlow` is integer-shift SAD and is *not*
sufficient alone — it supplies the coarse stage only.

1. Build a 3-level pyramid per frame.
2. Coarse global translation at 1/8 scale via block matching.
3. Refine per **tile** (say 256×256) down to full resolution — per-tile rather
   than global so that small rotation and rolling-shutter skew are absorbed as
   locally-translational.
4. Sub-pixel by **parabolic fit on the 3×3 SAD neighbourhood** at the finest
   level.
5. Reject a tile whose SAD minimum is shallow (untextured) or whose shift is an
   outlier against its neighbours.

### Stage 3 — Merge

Accumulate onto a 2× output grid:

```
acc[p]    += w · value
weight[p] += w
out[p]     = acc[p] / weight[p]
```

- `w` is a Gaussian of the distance from the projected sample to the output
  pixel centre — σ ≈ 0.5 output px, radius 2. (Wronski's anisotropic
  gradient-aligned kernel is the refinement, not the starting point.)
- **Robustness weight, and this is not optional.** Compare each contribution
  against the reference upscaled to the output grid; attenuate it as the
  difference grows relative to local noise. Without this, anything that moved
  in the scene — a leaf, a person — smears into a ghost, and the failure looks
  like a plausible photograph rather than an error.
- Output pixels with too little accumulated weight fall back to the upscaled
  reference. Holes are honest; invented pixels are not.

### Stage 4 — Output

No sharpening by default. Deconvolution and unsharp masking make the result
*look* better while adding nothing measurable, which is precisely the failure
this whole document exists to avoid. If added later, it ships behind its own
control and is excluded from any resolution claim.

## Budgets

Memory, N = 8, luma-only, tiled merge:

| Item | Size |
|---|---|
| 8 luma planes at 12 MP | 98 MB |
| Reference chroma (half-res) | 6 MB |
| Per-tile accumulators (2048² out, 2×Float32) | 34 MB |
| **Peak** | **≈ 140 MB** |

Full-frame accumulators would be 390 MB and would take the tab down on iOS, so
**tiling is mandatory** for the full frame. Phases 0–2 work on a 1024×1024 crop
where none of this matters.

Time: plain JS, expect **seconds**, not milliseconds. That is acceptable — this
is a deliberate still capture with a progress indicator, not a live mode. WASM
or WebGL is a later optimisation, and only if the measurement justifies it.

## How we would know it worked

This is the part that makes the feature honest, and it is the part to build
first.

**1. Synthetic ground truth (unit test, no camera, runs in CI).**
Take a high-resolution test image. Generate N frames by shifting it
sub-pixel-wise, applying a PSF, 2×2 binning, and adding sensor noise. Run the
pipeline. Compare the output against the original at 2×. This proves the
algorithm before a single device measurement, and — critically — it can model
the **band-limiting question above** by varying the PSF width. If the pipeline
cannot beat bicubic upscale on synthetic data with a known-favourable PSF, it
will never beat it on a phone.

**2. Slanted-edge MTF (ISO 12233), on device.**
Photograph a slanted edge. Compute edge spread → line spread → MTF. Report
**MTF50 in cycles/pixel** for the merged result versus the single reference
upscaled 2×. This yields a number, not an impression. `estimateEffectiveResolution`
is too coarse for this job — it is a halving search that pegs — so it stays an
indicator beside the result, not the certificate.

**3. The control that must always be run.**
Single frame upscaled 2× by bicubic, same output size. If the merge does not
beat that control by a margin exceeding the measurement noise, **the merge
achieved nothing** and must not be presented as resolution.

## Labelling rules

Binding, and derived from the project's standing instruction not to fake
capability:

- Never call the output "48 MP" merely because it contains 48 M pixels.
- Report measured gain: *"merged from 8 frames · measured detail about
  1.6× a single frame"*.
- If the measurement shows no gain, **say so** and offer the single frame.
- The saved file's metadata says how it was made. A viewer must never have to
  guess whether pixels were captured or computed.

## Risks and kill criteria

| Risk | Kill criterion |
|---|---|
| Binned stream already band-limited | Phase 0 shows no gain over bicubic on a favourable synthetic PSF → **stop** |
| iOS memory | Burst reliably kills the tab at N=8 tiled → reduce N, else stop |
| Rolling shutter | Per-tile alignment cannot absorb the skew → restrict to static, braced shots |
| Scene motion ghosting | Robustness mask costs more detail than the merge gains → stop |
| Time cost | Multi-second merges the user will not wait for → needs WASM/GPU, re-gate |

## Phasing, with a gate between each

- **Phase 0 — Prove or kill it, cheaply.** Synthetic harness + MTF measurement.
  No camera, no UI, pure functions, all in tests. *Gate: beats bicubic on
  synthetic data, or the project stops here.*
- **Phase 1 — Alignment on real bursts.** Capture, align, report residuals.
  No merge, no UI. *Gate: sub-pixel residuals ≈ 0.1 px on a real handheld burst.*
- **Phase 2 — Merge on a crop, on device.** 1024×1024, behind a dev route.
  *Gate: measured MTF50 gain over the control on a real slanted edge.*
- **Phase 3 — Full frame, tiled, shipped.** Progress UI, the measurement shown
  beside the result, honest labelling.

Each gate is a real stop. Phase 0 is a day or so of work and can save the rest.

## What I would build first

Phase 0 only: `src/vision/super-resolution.ts` with the merge as a pure
function over synthetic input, plus `tests/super-resolution.test.mjs` carrying
the ground-truth harness and the bicubic control.

It touches no existing behaviour, needs no device time, and answers the one
question everything else depends on.


---

# Phase 0 results

Built as `src/vision/super-resolution.ts` and `tests/super-resolution.test.mjs`.
No camera, no interface. Scores are high-frequency PSNR against ground truth,
relative to bicubic upscaling of a single frame.

## The gate: passed, with a condition that changes the feature

Merging recovers **genuine resolution** — but only when the frames' sub-pixel
offsets are actively spread. Measured with noise off, so denoising cannot
flatter the result:

| Burst | Gain over bicubic |
|---|---|
| Clustered offsets (very steady hand) | **−11.9 dB** |
| Random hand tremor | **−1.9 dB** |
| Evenly spread offsets | **+5.7 dB** |

**Ordinary tremor is not enough.** A random handheld burst scores *below*
simply upscaling one frame. Joshua's proposal to trigger capture from the
motion sensors is therefore not a refinement — it is the mechanism that makes
the feature work at all, and Phase 1 is now about the trigger rather than
about alignment alone.

## Four corrections to the spec above

1. **"Naive shift-and-add is fine as a starting point."** It is not, and then
   it is. Splatting lost to bicubic on a zone plate at every setting tried;
   on 1/f noise and on a real photograph it *wins*. The estimator's ranking
   depends on the scene, so Phase 0 deliberately does not name a winner.
   Splat-then-back-project was best on the photograph (+2.9 dB), splat alone
   on 1/f noise (+3.0 dB).
2. **Back-projection is semi-convergent.** It improves for two to four
   iterations and then diverges — 12 iterations scored −18 dB. Early stopping
   is the regularisation, not a shortcut past it.
3. **"Alignment needs 0.1 px."** Correct after all. An intermediate
   measurement suggested 0.2 px was plenty and that the spec was too strict;
   that was a zone-plate artifact. On realistic content, 0.1 px costs 6% of
   the gain, 0.4 px costs nearly all of it, and 0.8 px is worse than not
   merging.
4. **Motion blur is second-order.** Four scene pixels of smear costs about
   a quarter of the gain and mild smear costs nothing — it slightly
   regularises the inversion. A stillness gate is worth having but is not
   what decides the feature.

## Two methodological findings worth more than the numbers

**The test scene decided the answer twice.** A zone plate produced two
confident, wrong conclusions — that splatting always loses, and that most of
the gain is single-frame deconvolution rather than multi-frame. Both reversed
on 1/f noise and on a real photograph. Any future measurement here uses at
least two scene types, one of them real.

**The high-frequency score cannot separate denoising from resolution.** It was
added precisely to do that, and it does the opposite: a pure denoise scores
+12.5 dB on it against +8.4 dB on overall PSNR. Merging eight frames denoises
by roughly 9 dB, so a burst can post a healthy number while resolving nothing.
Every resolution claim here is therefore measured with noise off — and the
on-device measurement **must** be a slanted-edge MTF, because on a real capture
there is no noise-free control to fall back on.

## Revised next step

Phase 1 is no longer "alignment on real bursts". It is:

1. **Confirm the frames are distinct.** `frame-rate.ts` already counts unique
   versus repeated frames; if iOS re-delivers a decoded frame, there are no new
   offsets and nothing downstream matters.
2. **Build the diversity gate** — accumulate gyro rotation, convert to image
   displacement through `focalLengthPixels`, and keep a frame only when its
   *fractional* offset is far from every offset already held. `offsetSpread`
   is the target function.
3. **Then** alignment, to 0.1 px, as originally specified.

The gate for Phase 1 is a measured `offsetSpread` above about 0.6 on a real
handheld burst. Below that, Phase 0 says the merge will not pay for itself.


---

# Phase 1 results — measured on the device

Joshua ran the Burst tab on an iPhone 15 Plus. **Grid coverage 55-70%, above the
55% floor.** A handheld burst on this device does carry more detail than any
single frame in it, so Phase 2 is unblocked.

## The first reading was the probe's fault, not the hand's

The first run returned 39-48% and would have retired the idea. The capture loop
polled on `requestAnimationFrame` plus 40ms, which on a twelve-megapixel capture
delivering 8-12 frames a second is faster than frames arrive — so much of the
burst was the same image recorded twice, and a repeated frame measures a shift
of exactly zero. The probe was reporting a steady hand when the truth was a fast
loop.

This was the FIRST check the phase specified ("confirm the frames are
distinct") and it shipped without it. The probe now waits on
`requestVideoFrameCallback` and reports the distinct-frame count beside the
rest, so the reading can be checked rather than trusted.

## Holding still beats moving deliberately

Joshua: "moving my hand less during it makes the results better than moving
more hoping to catch more offsets." Correct, for three separate reasons:

1. **Only the fractional part of a shift carries information.** Seven pixels
   and a fifth of a pixel are the same offset as far as the sampling grid is
   concerned, so deliberate travel contributes nothing.
2. **Travel blurs each frame.** Phase 0: four scene pixels of smear during
   exposure costs about a quarter of the gain.
3. **The aligner could not measure large motion**, and scored it as small.
   `estimateShift` searches a fixed window; when the frame moved further, the
   best score inside sat on the boundary and the true match was outside. That
   estimate is not "large", it is wrong in the direction that looks like a
   steady hand. Now refused with zero confidence rather than reported.

Point 3 was a real defect the device found. Points 1 and 2 make "hold it
normally" the right instruction regardless, and the tab now says so — it is the
opposite of what the feature sounds like it wants.

## Phase 2 is now the next gate

Merge on a 1024x1024 crop, behind a dev route, measured with a slanted-edge MTF
against the bicubic control. The estimator is still unsettled from Phase 0
(splat alone won on 1/f noise, splat-then-back-project on a real photograph), so
Phase 2 chooses between them on real captures rather than assuming.
