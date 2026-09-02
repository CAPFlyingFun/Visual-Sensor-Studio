# Lens definitions kept for the V2 lens workbench (Milestone E)

Lenses Joshua authored in the legacy app, exported as `.lens.json`, kept
here so the V2 workbench can import them rather than asking for them to
be rebuilt by hand.

| file | channel | range | ramp | notes |
| --- | --- | --- | --- | --- |
| `coloring-book-style.lens.json` | edges | 0 → 254, gamma 1.6 | `#f6f2e8` → `#12100c`, base black, no scene blend | "Coloring Book Style" — line art on cream. Authored 2026-09-01. |

## Workbench requirement recorded with these (Joshua, 2026-09-01)

Every slider gets a paired numeric field for an exact value. The legacy
sliders could land on 254 or 256 but never 255 — a step/range bug that
turned a precise choice into a near miss. In V2 the number is the value
and the slider is a way to reach it, never the other way round.

## Two-field lenses and the brightness floor (2026-09-02)

A lens document can bind a SECOND field to brightness while the first
drives colour. That is what makes Camouflage Breaker two statements at
once: colour from how unusual a pixel's hue is, brightness from whether
it sits on a colour boundary.

The trap, found on device: brightness MULTIPLIES. Both colour fields are
gated on saturation, so in a dim, low-colour room the boundary term read
near zero almost everywhere, multiplied the rarity answer to black, and
the lens rendered as an edge map — indistinguishable from Colour Edges,
which is exactly what an edge map is. Both lenses were behaving
correctly and neither was readable.

`brightnessFloor` (0..1, default 0) is the fix: the second field dims to
the floor and no further, so it can shade the first field's answer
without deleting it. 0 is the historical behaviour, so every lens
written before this still means precisely what it meant.

The lesson generalises: a second field that can reach zero can erase the
first one's answer entirely, and the result looks like a simpler lens
rather than like a fault.

## Smoothing, and why its radii are half-integers (2026-09-02)

Noise is amplified by what a field DOES with it, not by how much of it
there is. Brightness averages three channels and barely moves. Hue is an
*argument* between them: at low colour strength a count or two of sensor
noise decides which channel won, and the hue swings across the whole
wheel. So the hue-derived fields — `hue`, `chromaEdge`, `rarity`,
`backgroundDistance`, marked `hueDerived` in `ChannelInfo` — measure
indoor sensor noise as faithfully as they measure the picture.

`render/denoise.ts` is the one control. It sets `uDenoise`, and every
filter reads the frame through the header's `frameAt` / `prevAt` rather
than sampling `uFrame` itself, so nothing can quietly opt out. Two
exceptions, both deliberate: RGB is the raw frame by definition, and the
`scene` colour a mask or swap HANDS BACK stays raw — smoothing changes
what a filter measures, never the colour it keeps.

The radii are 0.5 and 1.5 rather than 1 and 2, and that is the whole
trick. The shader takes four taps and each is cheap only because the
GPU's bilinear filter averages the texels it falls between. A tap at a
whole number of texels lands on a texel centre and averages *nothing*.
Measured against pure noise (sd 35.1 raw):

| radius | 0 | 0.5 | 0.75 | 1 | 1.25 | 1.5 | 2 | 3 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| noise sd | 35.1 | 13.4 | 12.4 | 17.8 | 11.3 | 9.1 | 17.4 | 17.7 |
| edge px | 0 | 2 | 2 | 2 | 4 | 4 | 4 | 6 |

The first ladder written here was 1, 2 and 3 — every one a worst case,
and the level above Medium did not reduce noise at all. There is no
level above 1.5 now: four bilinear taps average at most sixteen pixels
and by 1.5 they already do, so a wider radius smears the same sixteen
samples further apart. A stronger level needs more taps, which means
compiling the tap count into the shader instead of passing it as a
uniform.

Off is the default (Joshua, 2026-09-02): most filters show little noise,
and the ones that do now say so in their own note while smoothing is off.
