# Colour lens ideas — parked, not built

Joshua's and ChatGPT's brainstorm, kept here so it is not lost while the mobile
layout is finished. **Nothing in this file is implemented.**

## What the lens system can express today

A lens maps one measured **field** through a colour **ramp**, optionally with a
second field driving brightness. The fields that exist are:

`luma` · `speed` · `change` · `edges` · `relief` · `age` · `novelty`

Every one of them is a **greyscale measurement**. That is the fault line running
through this whole list: the ideas below are mostly about **hue**, and the lens
pipeline currently has no hue, saturation or per-channel field at all. So they
split into two groups that cost very different amounts.

## Group A — new fields, then most of the list falls out

Adding these fields to `lens.ts` would make a large share of the ideas
expressible with the ramp editor that already exists, and no new UI:

| field | what it measures |
|---|---|
| `hue` | angle on the colour wheel, 0..1 |
| `saturation` | how far from grey |
| `hueDistance` | distance from a chosen hue (needs one parameter) |
| `red` / `green` / `blue` | the sensor channels on their own |
| `ratioRG` / `ratioBG` | channel ratios |
| `rarity` | how little of the frame shares this colour |
| `backgroundDistance` | distance from the frame's dominant colour |

With those, these become ramp settings rather than features:

- **Channel Solo** — `red`/`green`/`blue` through a grey ramp.
- **Heatmap by Hue** — `hue` through the Ironbow ramp.
- **Brightness Bands** — `luma` through a banded ramp.
- **Selective Saturation** — `hueDistance` driving brightness, `luma` for colour.
- **Colour Isolation / Colour Hide** — `hueDistance` with a narrow or inverted range.
- **Rare Colour Finder** — `rarity`.
- **Dominant Colour Suppression / Background Colour Subtract** — `backgroundDistance`.
- **Complement Boost** — `hueDistance` from the complement of the dominant hue.
- **Chroma Edge** — edges computed on hue rather than luma (a variant of `edges`).
- **Channel Ratio** — `ratioRG` / `ratioBG`.
- **Colour Threshold Mask** — any of the above with a hard two-stop ramp.

## Group B — genuinely new machinery

These need something the lens pipeline does not have: state across frames, a
sampled reference, or output that is not a recolouring of the current frame.

- **Object Colour Lock** — tap to sample, then track that hue. Needs a tap
  target and a stored sample.
- **Colour Memory / Colour Trail** — accumulate a chosen hue over time. The
  trail buffer exists; it is keyed on speed, not hue.
- **Blink Detector** — periodicity per pixel. Needs a short history and a
  frequency test, which is real signal processing rather than a mapping.
- **Flash / Spark Catcher** — brief spikes held on screen for a few seconds.
  Closest to the existing event detector.
- **Temporal Colour Change** — hue change without motion. Needs a previous-hue
  buffer.
- **Live Colour Swap / Hue Shift** — these write colour rather than mapping a
  measurement to colour, so they are a different kind of output.
- **Spectral-ish Split** — spatially offset channels; a compositing effect.
- **Adaptive Camouflage Breaker** — dominant-colour suppression + rarity + edge
  boost + optional motion weighting. The most interesting of the lot, and it is
  a *combination*, so it argues for lenses that can blend two fields rather than
  for one more field.

## Priority, if this is picked up

ChatGPT's shortlist, which I agree with: **Colour Isolation, Colour Hide,
Dominant Colour Suppression, Background Colour Subtract, Object Colour Lock,
Blink Detector, Flash Catcher, Channel Solo.**

Of those, `hue`, `saturation`, `hueDistance` and the three channel fields are
the cheapest first step: one pass over the frame, no state, and they unlock
five of the eight immediately.

## One honesty note to carry into it

Several of these will look like they reveal something the eye cannot see. They
do not. Every one is a remapping of the same three colour channels the camera
already recorded — no infrared, no ultraviolet, no spectroscopy. **Colour
Isolation** finds a red berry in green foliage because it makes the greens
quiet, not because it saw a wavelength your eye missed. The interface should
say that where it matters, the way the depth scan says it is not LiDAR.
