/**
 * Lenses a fresh device starts with — data, editable like any other.
 * "Coloring Book Style" is Joshua's (2026-09-01): edges on cream, ink dark.
 * The same document lives in docs/lenses/ for reference.
 */
import type { CustomLens } from '../../vision/lens.js';

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
  }
];
