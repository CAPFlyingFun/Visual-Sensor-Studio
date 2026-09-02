/**
 * How to use the thing you just picked — as data (Rule 5).
 *
 * Some filters are a single tap and show their result at once. Others need a
 * step first, and without it they look broken while being perfectly correct:
 * Colour Splash pointed at a room with none of its reference colour in it
 * renders exactly what it should — a grey picture — and nothing on screen
 * says "tell me which colour to look for" (Joshua, 2026-09-02: "not sure if
 * Colour Splash is working, or I don't know how to use it").
 *
 * The tips are derived from what a filter REQUIRES rather than written per
 * filter, so a lens the user builds tomorrow is coached correctly without
 * anyone remembering to write copy for it.
 */

import type { FilterDefinition } from '../filters/registry.js';
import { channelInfo } from '../../vision/lens.js';

export interface CoachTip {
  /** Stable id — what "don't show this again" remembers. */
  id: string;
  title: string;
  steps: readonly string[];
  /** An action the tip can perform itself, rather than only describing it. */
  action?: { label: string; kind: 'pick' };
}

const PICK_STEPS = [
  'Tap ⌾ Pick colour under the filters.',
  'Point at the colour you care about and tap the viewfinder — or press ✛ Sample centre.',
  'Press “Use sample” in the lens editor to make that the colour this lens looks for.'
] as const;

export function tipFor(filter: FilterDefinition | null): CoachTip | null {
  if (!filter) return null;
  const lens = filter.lens;

  if (lens && (lens.output ?? 'paint') === 'swap') {
    return {
      id: 'lens-swap',
      title: `${filter.name}: choose what to catch, and what it becomes`,
      steps: [
        ...PICK_STEPS,
        'Then set “Recolour to” — matched pixels take that colour and keep their own brightness.'
      ],
      action: { label: 'Pick a colour', kind: 'pick' }
    };
  }

  if (lens && channelInfo(lens.color.channel).needsReference) {
    return {
      id: 'lens-reference',
      title: `${filter.name}: tell it which colour to look for`,
      steps: [
        ...PICK_STEPS,
        'The strip note shows how much of the frame is matching right now — if it reads 0%, nothing in view is that colour yet.'
      ],
      action: { label: 'Pick a colour', kind: 'pick' }
    };
  }

  if (filter.needsHistogram) {
    return {
      id: 'lens-histogram',
      title: `${filter.name}: measured against the whole frame`,
      steps: [
        'This reads every colour in view, so what stands out depends on what else is on screen.',
        'Point the camera at a scene with one odd colour in it — a berry in leaves, a jacket in a crowd.',
        'Move the camera and the reading moves with it; that is the measurement, not a glitch.'
      ]
    };
  }

  if (filter.temporal) {
    return {
      id: 'temporal',
      title: `${filter.name}: it measures movement`,
      steps: [
        'A still scene reads dark — that is the filter working, not a black screen.',
        'Wave a hand through the view, or move the camera slowly.',
        'Stills are declined for these; video is what they are for.'
      ]
    };
  }

  return null;
}
