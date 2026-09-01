/**
 * NAV_ROUTES — the registry the dock is built from.
 *
 * Rule 5: repeated families of controls are data, and the same data drives the
 * buttons, the labels and the routing. Camera is the only implemented route in
 * Milestone A; the rest render an honest placeholder rather than pulling
 * legacy subsystems into the V2 bundle to make buttons look finished.
 */

export interface NavRoute {
  id: string;
  label: string;
  icon: string;
  implemented: boolean;
  /** Shown on the placeholder panel of a route that is not built yet. */
  plan: string;
}

export const NAV_ROUTES: readonly NavRoute[] = [
  {
    id: 'camera', label: 'Camera', icon: '◉', implemented: true,
    plan: ''
  },
  {
    id: 'sensors', label: 'Sensors', icon: '◌', implemented: false,
    plan: 'Motion, orientation and steadiness move here after Camera V2 is stable.'
  },
  {
    id: 'world', label: 'World', icon: '◎', implemented: false,
    plan: 'GPS, terrain and the 3D view stay in the legacy app for now.'
  },
  {
    id: 'data', label: 'Data', icon: '▤', implemented: false,
    plan: 'Depth scan and export stay in the legacy app for now.'
  },
  {
    // Settings & diagnostics: the truth table, capture measurements and the
    // encoder probe live here, off the main screen (Joshua, 2026-09-01).
    id: 'more', label: 'More', icon: '⋯', implemented: true,
    plan: ''
  }
];

export function routeById(id: string): NavRoute | null {
  return NAV_ROUTES.find((route) => route.id === id) ?? null;
}
