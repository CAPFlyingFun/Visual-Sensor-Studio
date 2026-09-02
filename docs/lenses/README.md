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

## Frame averaging, and why the blur was the wrong tool (2026-09-02)

Noise is amplified by what a field DOES with it, not by how much of it
there is. Brightness averages three channels and barely moves. Hue is an
*argument* between them: at low colour strength a count or two of sensor
noise decides which channel won, and the hue swings across the whole
wheel. So the hue-derived fields — `hue`, `chromaEdge`, `rarity`,
`backgroundDistance`, marked `hueDerived` in `ChannelInfo` — read indoor
sensor noise as faithfully as they read the picture.

The first attempt at this was a SPATIAL blur, and it was the wrong tool.
Joshua's diagnosis is why: "each little motion my phone makes even like
0.2° will grab a new frame/pixel... the still images are fine because it
has a chance to grab one good frame and not moving." The speckle is
**temporal**. A spatial blur cannot reach it — it throws away detail
from the one frame it can see, and on device it *dimmed* the picture as
well, because softening a frame lowers its saturation and the colour
fields' own colourfulness gates then close.

`render/frame-average.ts` is the replacement and the one owner. Sensor
noise is independent frame to frame, so averaging over TIME drops it as
1/√frames while anything actually standing still is identical in every
frame and survives untouched — no softening, no dimming. The cost is
movement: a moving thing is in a different place in each frame and
smears. That trade is why it is a control and not a default.

The ladder is short — off, 2, 3, 4 frames — because the first one
(3/5/10) was too long at every rung: ten frames carries a third of a
second of the past and the picture swims. Ten survives as **Dizzy**,
relabelled as the effect it turned out to be (Joshua: "like a
dizzy/drunk look where you can see but it's a little blurred"). It is
the same average asked for on purpose, marked `effect: true` so it reads
as a look rather than as the top of the ladder, and set apart in the row.

**Frames for readings, milliseconds for effects.** This is a real
difference of units, not a compromise between two ways of saying the
same thing (raised by ChatGPT, 2026-09-02):

- A **noise** claim is a claim about *independent samples*. Averaging
  four frames halves the noise whether they arrived in 133 ms at 30 fps
  or 67 ms at 60, so "4 frames" removes the same noise on any device.
  The smear it costs shrinks at a higher frame rate — the harmless
  direction: the same reading for less lag.
- A **look** is made of *how long the past lingers*. Dizzy at a fixed
  ten frames would be a third of a second of history at 30 fps and half
  that at 60 — the same setting, visibly less dizzy, for no reason the
  person holding the phone could see. So it declares 300 ms and the
  frame count follows from the measured rate.

Both land on a frame count and then the one weight below; there is no
second formula. The note under the row prints the *other* unit as
measured ("about 133 ms at 30 fps", "about 9 frames at 30 fps"), so the
conversion is visible rather than hidden, and says "assumed until
measured" while `deliveredFps` is still 0.

Three things worth keeping:

- **It is a rolling average, not a hold.** The preview updates on every
  camera frame; "5 frames" means each frame shown carries as much of the
  last five as an average of five would, not that the screen refreshes
  five times a second.
- **The weight is 2/(N+1), not 1/N.** It is an exponential average — one
  texture, not N, because a ten-frame stack at record size is ten
  full-resolution buffers and this device has already lost a GPU context
  to memory once. An EMA's variance is `α/(2−α)` of its input's, so
  `α = 2/(N+1)` is where it removes exactly as much noise as a true
  N-frame average. The obvious guess, `1/N`, quietly does about twice
  the smoothing the label promises.
- **Stills never use it.** A photo already gets one good frame, by
  Joshua's own observation; blending a moving frame into it would only
  smear a picture that was sharp. `capturePhoto` passes no frame count,
  on purpose.

The display pass, the state pass and the history copy all read the frame
through one `sourceTexture` accessor. Three separate bindings would let
an averaged present be compared against a raw past, which reads as
motion everywhere.

Off is the default (Joshua): most filters show little noise, and the
ones that do say so in their own note while averaging is off.
