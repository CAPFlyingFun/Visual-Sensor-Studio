/**
 * Lenses a fresh device starts with — data, editable like any other.
 *
 * "Coloring Book Style" is Joshua's (2026-09-01). The rest arrived with the
 * colour fields (2026-09-02) and exist to show what those fields make
 * possible: most of the Lens Pack card's list is a RANGE and an OUTPUT MODE
 * away, not a feature away. Every one of them can be taken apart in the
 * workbench, which is the point.
 */
import type { CustomLens } from '../../vision/lens.js';

const MONO = [{ at: 0, color: '#000000' }, { at: 1, color: '#ffffff' }];
/** A red worth isolating — a berry, a jacket, a warning light. */
const RED = '#c81e28';

export const STARTER_LENSES: readonly CustomLens[] = [
  {
    version: 1,
    id: 'lens-mtjarl1w-pcpts4',
    note: 'Ink lines on cream: edge strength drawn as line art.',
    name: 'Coloring Book Style',
    color: { channel: 'edges', low: 0, high: 254, gamma: 1.6 },
    stops: [
      { at: 0, color: '#f6f2e8' },
      { at: 1, color: '#12100c' }
    ],
    base: 'black',
    sceneBlend: 0
  },
  {
    // Colour Isolation: the range runs BACKWARDS (90 → 0), so a close match
    // reads high and keeps its colour while everything else goes grey.
    version: 1,
    id: 'lens-v2-colour-splash',
    note: 'Keeps one colour and greys the rest. Pick the colour it should look for.',
    name: 'Colour Splash',
    color: { channel: 'colourDistance', low: 90, high: 0, gamma: 1 },
    stops: MONO,
    base: 'black',
    sceneBlend: 0,
    output: 'mask',
    reference: RED
  },
  {
    // Colour Hide: the same lens with the range the right way round.
    version: 1,
    id: 'lens-v2-colour-hide',
    note: 'Mutes one colour and leaves everything else — Colour Splash in reverse.',
    name: 'Colour Hide',
    color: { channel: 'colourDistance', low: 0, high: 90, gamma: 1 },
    stops: MONO,
    base: 'black',
    sceneBlend: 0,
    output: 'mask',
    reference: RED
  },
  {
    version: 1,
    id: 'lens-v2-paper-pink',
    note: 'Recolours whatever matches the reference: paper white becomes pink.',
    name: 'Paper → Pink',
    color: { channel: 'colourDistance', low: 80, high: 0, gamma: 1 },
    stops: MONO,
    base: 'black',
    sceneBlend: 0,
    output: 'swap',
    reference: '#f2f1ec',
    target: '#ff5ca8'
  },
  {
    // Hue as a map: the wheel laid out across the ramp, so like colours read
    // alike. Grey pixels have no hue and land at the ramp's foot.
    version: 1,
    id: 'lens-v2-hue-map',
    note: 'Every hue gets its own colour, so like colours read alike. Greys sit at the ramp’s foot.',
    name: 'Hue Map',
    color: { channel: 'hue', low: 0, high: 360, gamma: 1 },
    stops: [
      { at: 0, color: '#ff2d2d' },
      { at: 0.17, color: '#ffd93d' },
      { at: 0.33, color: '#3dff6e' },
      { at: 0.5, color: '#3dfaff' },
      { at: 0.67, color: '#3d6eff' },
      { at: 0.83, color: '#c83dff' },
      { at: 1, color: '#ff2d2d' }
    ],
    base: 'black',
    sceneBlend: 0
  },
  {
    version: 1,
    id: 'lens-v2-colour-strength',
    note: 'How far each pixel is from grey. Washed-out highlights read low, not high.',
    name: 'Colour Strength',
    color: { channel: 'saturation', low: 0, high: 200, gamma: 1 },
    stops: [
      { at: 0, color: '#0b1420' },
      { at: 0.5, color: '#d52078' },
      { at: 1, color: '#ffd93d' }
    ],
    base: 'black',
    sceneBlend: 0
  },
  {
    // Rare Colour Finder: keep the colour of whatever little else in the
    // frame shares — a berry in foliage, a jacket in a crowd.
    version: 1,
    id: 'lens-v2-rare-colour',
    note: 'Keeps the colour of whatever little else in view shares it.',
    name: 'Rare Colour',
    color: { channel: 'rarity', low: 110, high: 255, gamma: 1 },
    stops: MONO,
    base: 'black',
    sceneBlend: 0,
    output: 'mask'
  },
  {
    // Background Colour Subtract: the frame's prevailing colour goes quiet,
    // everything unlike it keeps its colour.
    version: 1,
    id: 'lens-v2-background-subtract',
    note: 'Quiets the frame’s prevailing colour; everything unlike it keeps its own.',
    name: 'Background Subtract',
    color: { channel: 'backgroundDistance', low: 0, high: 90, gamma: 1 },
    stops: MONO,
    base: 'black',
    sceneBlend: 0,
    output: 'mask'
  },
  {
    // The census itself, as a picture: how unusual each colour is.
    version: 1,
    id: 'lens-v2-rarity-map',
    note: 'How unusual each colour is in this frame, drawn as a map.',
    name: 'Rarity Map',
    color: { channel: 'rarity', low: 0, high: 255, gamma: 1 },
    stops: [
      { at: 0, color: '#07124a' },
      { at: 0.55, color: '#d52078' },
      { at: 1, color: '#ffd93d' }
    ],
    base: 'black',
    sceneBlend: 0
  },
  {
    // The lens Joshua described while making a saturation one: dark places
    // bright, bright places dark. This is brightness with the range run
    // backwards — a true inversion, where colour strength only resembles one.
    version: 1,
    id: 'lens-v2-inverted-brightness',
    note: 'Dark places bright and bright places dark — a true brightness inversion.',
    name: 'Inverted Brightness',
    color: { channel: 'luma', low: 255, high: 0, gamma: 1 },
    stops: MONO,
    base: 'black',
    sceneBlend: 0
  },
  {
    // RELIEF, the one V1 mode with no way to reach it from the strip.
    //
    // The V1-to-V2 audit classified relief as "B — math ported to the 'relief'
    // channel; no starter uses it, cheap to add", and cheap to add it stayed
    // for two days. The channel has been here the whole time; nothing shipped
    // in the app used it, so the only route to V1's Relief was the downloadable
    // Contour lens, which is not somewhere anyone looks first.
    //
    // WHAT IT IS, and the note says so because the picture is persuasive: a
    // SHADING estimate, not a depth reading. It is the frame's brightness
    // stretched into its own measured range plus an edge term, and bright
    // standing for near is how a lit surface usually behaves — not a
    // measurement. A white wall reads as near. There is no depth sensor on a
    // web page, and a convincing relief map is exactly the kind of picture
    // that gets believed.
    //
    // GAMMA 0.5, AND THE REASON IS MEASURED. ch_relief stretches into
    // uLumaRange, which is an absolute min and max — one bright thing in a
    // dark room pins it at 0..1 and the stretch becomes an identity. Measured
    // on Joshua's own room while fixing Grid: min 0.0000, max 1.0000, with
    // 62% of the rendered frame too dark to read. A square root was what
    // fixed Grid on that exact frame, and relief lands in the same place for
    // the same reason. He can edit it in the workbench like any other lens.
    version: 1,
    id: 'lens-v2-relief',
    note: 'Shading as height: bright reads as near, dark as far. An estimate from the light, not a depth measurement — a white wall reads as near.',
    name: 'Relief',
    color: { channel: 'relief', low: 0, high: 255, gamma: 0.5 },
    stops: [
      { at: 0, color: '#0b1020' },
      { at: 0.45, color: '#3f6d8c' },
      { at: 0.75, color: '#c8b184' },
      { at: 1, color: '#fff6e2' }
    ],
    base: 'black',
    sceneBlend: 0
  },
  {
    // The Lens Pack's Adaptive Camouflage Breaker, which was never one field:
    // colour from how UNUSUAL a pixel's hue is, brightness from whether it
    // sits on a colour boundary. A thing hiding by matching its background
    // fails both tests at once.
    //
    // RETUNED 2026-09-02, because on Joshua's device it was indistinguishable
    // from Colour Edges. Both colour fields are gated on saturation, and in a
    // dim, low-colour room the gate held rarity near zero while the edge term
    // — multiplying straight to black without a floor — was the only thing
    // left drawing anything. The lens was correct and unreadable: an edge map.
    // The floor stops the second field erasing the first, and the wider,
    // lower ranges let an ordinary indoor scene reach the ramp at all.
    version: 1,
    id: 'lens-v2-camouflage-breaker',
    note: 'Two questions at once: COLOUR says how unusual a hue is here, '
      + 'BRIGHTNESS says whether it sits on a colour boundary. Something '
      + 'hiding by matching its background fails both. Needs real colour in '
      + 'view — in a dull grey room everything reads ordinary.',
    name: 'Camouflage Breaker',
    color: { channel: 'rarity', low: 60, high: 220, gamma: 1 },
    brightness: { channel: 'chromaEdge', low: 5, high: 70, gamma: 1 },
    // Never darker than a third: the boundary field dims the rarity answer
    // rather than deleting it, which is the whole difference from Colour Edges.
    brightnessFloor: 0.35,
    stops: [
      { at: 0, color: '#0b1420' },
      { at: 0.6, color: '#3dfaff' },
      { at: 1, color: '#ffffff' }
    ],
    base: 'black',
    sceneBlend: 0
  },
  {
    version: 1,
    id: 'lens-v2-chroma-edge',
    note: 'ONLY boundaries, found by hue instead of brightness — a red shape '
      + 'on equally bright green still shows, where the Edges filter sees '
      + 'nothing. It says nothing about whether a colour is unusual; '
      + 'Camouflage Breaker is the one that does that.',
    name: 'Colour Edges',
    color: { channel: 'chromaEdge', low: 0, high: 140, gamma: 1 },
    stops: MONO,
    base: 'black',
    sceneBlend: 0
  },
  {
    version: 1,
    id: 'lens-v2-red-solo',
    note: 'The sensor’s red channel on its own, as grey.',
    name: 'Red Channel',
    color: { channel: 'red', low: 0, high: 255, gamma: 1 },
    stops: MONO,
    base: 'black',
    sceneBlend: 0
  }
];

/**
 * Starter documents that have been REPLACED, kept only so a device seeded
 * before the fingerprint record existed can be recognised.
 *
 * The shell refreshes a starter whose saved copy still matches what was
 * offered; from now on it knows what was offered because it recorded the
 * fingerprint. For devices seeded earlier there is no record, so the only
 * safe evidence that a copy is untouched is that it matches a definition
 * this app is known to have shipped — which is what this list is. The
 * note-less form of each is checked too, because notes were added to the
 * starters after they first shipped.
 *
 * This list only ever needs entries for starters changed BEFORE the
 * fingerprint record landed (2026-09-02). It can be emptied once no device
 * predates it.
 */
export const SUPERSEDED_STARTERS: readonly CustomLens[] = [
  {
    version: 1,
    id: 'lens-v2-camouflage-breaker',
    note: 'Unusual hue AND a colour boundary at once: what hides by blending in fails both tests.',
    name: 'Camouflage Breaker',
    color: { channel: 'rarity', low: 90, high: 255, gamma: 1 },
    brightness: { channel: 'chromaEdge', low: 10, high: 120, gamma: 1 },
    stops: [
      { at: 0, color: '#0b1420' },
      { at: 0.6, color: '#3dfaff' },
      { at: 1, color: '#ffffff' }
    ],
    base: 'black',
    sceneBlend: 0
  },
  {
    version: 1,
    id: 'lens-v2-chroma-edge',
    note: 'Boundaries found by hue, so a red shape on equally bright green still shows.',
    name: 'Colour Edges',
    color: { channel: 'chromaEdge', low: 0, high: 140, gamma: 1 },
    stops: MONO,
    base: 'black',
    sceneBlend: 0
  }
];
