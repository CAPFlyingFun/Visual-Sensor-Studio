/**
 * Viewfinder guides — the photographer's overlays, as data (Rule 5).
 *
 * Composition aids only: a guide draws over the picture and changes nothing
 * about what is captured. A photo or a clip is the full frame whatever guide
 * is showing, and the 1:1 guide in particular marks where a square crop
 * WOULD fall — this app never crops one for you.
 *
 * Coordinates are PERCENTAGES of the viewfinder box (0–100 on both axes), so
 * the lines need no display read: an SVG with `preserveAspectRatio: none`
 * stretches them to whatever box the layout produced. The one guide that
 * cares about the box's shape is the square, and it is handed the aspect
 * rather than measuring anything itself.
 */

export interface GuideLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface GuideDefinition {
  id: string;
  /** Button label — short, it sits in a scrolling row. */
  label: string;
  /** What the guide is for, in the strip's note. */
  note: string;
  /** Percent-space lines; `boxAspect` is width / height of the viewfinder. */
  lines(boxAspect: number): GuideLine[];
}

/*
 * The RETICLE is deliberately not a guide property. It is the colour
 * picker's target — an aiming frame around a ring that is the true size of
 * the sampled patch — and it has its own toggle, because a marker in the
 * middle of the picture is clutter when nobody is sampling (Joshua,
 * 2026-09-02: "shouldn't be on the screen all the time"). A guide draws
 * lines; the reticle marks a measurement. Two switches, two meanings.
 */

const line = (x1: number, y1: number, x2: number, y2: number): GuideLine => ({ x1, y1, x2, y2 });

/** Vertical and horizontal lines at the given percentages. */
function grid(columns: readonly number[], rows: readonly number[]): GuideLine[] {
  return [
    ...columns.map((x) => line(x, 0, x, 100)),
    ...rows.map((y) => line(0, y, 100, y))
  ];
}

const THIRD = 100 / 3;
/** The golden section: 1 : 0.618 : 1 across the frame. */
const PHI_LOW = 100 * (1 / (2 + 0.618));
const PHI_HIGH = 100 - PHI_LOW;

export const GUIDES: readonly GuideDefinition[] = [
  {
    id: 'off',
    label: 'Off',
    note: '',
    lines: () => []
  },
  {
    id: 'center',
    label: '✛ Centre',
    note: 'Centre crosshair — for centring a subject or levelling a horizon.',
    // Ticks rather than full lines: the middle of the picture stays visible.
    lines: () => [
      line(38, 50, 46, 50), line(54, 50, 62, 50),
      line(50, 38, 50, 46), line(50, 54, 50, 62)
    ]
  },
  {
    id: 'thirds',
    label: '⊞ Thirds',
    note: 'Rule of thirds — subjects on the lines, interest at the crossings.',
    lines: () => grid([THIRD, THIRD * 2], [THIRD, THIRD * 2])
  },
  {
    id: 'phi',
    label: 'φ Golden',
    note: 'Golden-section grid (1 : 0.618 : 1) — a tighter framing than thirds.',
    lines: () => grid([PHI_LOW, PHI_HIGH], [PHI_LOW, PHI_HIGH])
  },
  {
    id: 'diagonals',
    label: '✕ Diagonals',
    note: 'Corner-to-corner diagonals — for leading lines and symmetry.',
    lines: () => [line(0, 0, 100, 100), line(100, 0, 0, 100)]
  },
  {
    id: 'grid4',
    label: '▦ Fine grid',
    note: 'A 4×4 grid — for levelling verticals and repeating structure.',
    lines: () => grid([25, 50, 75], [25, 50, 75])
  },
  {
    id: 'square',
    label: '□ 1:1',
    note: 'Where a square crop would fall. Photos and clips still save the full frame.',
    lines: (boxAspect) => {
      // The largest centred square, in percent of a box that is not square.
      const inset = boxAspect >= 1
        // Wider than tall: the square is limited by the height.
        ? { x: (100 - 100 / boxAspect) / 2, y: 0 }
        : { x: 0, y: (100 - 100 * boxAspect) / 2 };
      const left = inset.x;
      const right = 100 - inset.x;
      const top = inset.y;
      const bottom = 100 - inset.y;
      return [
        line(left, top, right, top), line(right, top, right, bottom),
        line(right, bottom, left, bottom), line(left, bottom, left, top)
      ];
    }
  }
];

export const DEFAULT_GUIDE = 'off';

export function guideById(id: string): GuideDefinition | null {
  return GUIDES.find((guide) => guide.id === id) ?? null;
}
