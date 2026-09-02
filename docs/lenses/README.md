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
