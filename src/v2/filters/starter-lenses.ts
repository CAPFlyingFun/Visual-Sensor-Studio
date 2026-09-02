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
    version: 1,
    id: 'lens-v2-red-solo',
    name: 'Red Channel',
    color: { channel: 'red', low: 0, high: 255, gamma: 1 },
    stops: MONO,
    base: 'black',
    sceneBlend: 0
  }
];
