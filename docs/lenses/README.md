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
