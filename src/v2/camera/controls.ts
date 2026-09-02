/**
 * MANUAL CAMERA CONTROLS — what WebKit actually hands a web page, and what it
 * actually does when you ask.
 *
 * Milestone F's last piece. The engine already answers the first half: its
 * `capabilityReport` says, per control, `supported` / `unsupported` / `not
 * exposed`, and those three are deliberately not conflated. This module is the
 * second half, and it exists because of a gap the first half cannot see.
 *
 * APPLIED IS NOT APPLIED. `applyConstraints` resolves on success — and a
 * resolved promise means the browser accepted the request, NOT that the camera
 * changed. WebKit will advertise a capability, accept a constraint for it,
 * resolve happily, and leave the setting exactly where it was. A control built
 * on the promise alone would look like it worked every single time.
 *
 * So every change is verified the same way the stream tiers and the encoder
 * envelope are: apply, then read the track back, and report the DIFFERENCE
 * between what was asked and what happened. Five outcomes, because collapsing
 * them would hide the interesting ones:
 *
 *   took          the setting is now what was asked for
 *   clamped       it moved, but to something else — usually a real limit
 *   ignored       it resolved and nothing moved at all
 *   refused       applyConstraints itself rejected
 *   unverifiable  the browser does not report this key in getSettings(), so
 *                 the request cannot be checked either way
 *
 * `unverifiable` is not a failure and must never be shown as one. It is the
 * honest answer when WebKit accepts a constraint and then declines to say what
 * the setting is — which it does. Reporting that as success would be a guess;
 * reporting it as failure would be a different guess.
 *
 * AND WHAT AN ABSENT CONTROL MEANS, carried over from
 * vision/camera-capabilities.ts because it is the same boundary: nothing here
 * says the CAMERA cannot do a thing. Joshua's own observation — "everything
 * including depth is available, as different photo apps I have on my phone
 * allow more control than what's shown as available" — is right, and it is the
 * point. This measures what the BROWSER offers a web page. The gap between
 * that and the sensor is a browser boundary, not a hardware limit.
 *
 * ZOOM IS DELIBERATELY ABSENT. It already has its own control, built from the
 * engine's reported range; a second one here would be a second owner of the
 * same number.
 */

export type ControlKind = 'mode' | 'range' | 'toggle';

export interface CameraControl {
  /** The MediaTrackConstraint name — the id IS the constraint. */
  id: string;
  label: string;
  kind: ControlKind;
  /** What it does, in the one line shown under the control. */
  note: string;
  /** Appended to a range control's value in the readout. */
  unit?: string;
}

/**
 * Ordered as a photographer would reach for them: light first, then focus,
 * then colour. Only the ones a device actually advertises are ever shown.
 */
export const CAMERA_CONTROLS: readonly CameraControl[] = [
  {
    id: 'torch',
    label: 'Torch',
    kind: 'toggle',
    note: 'The rear lamp, held on. Not a flash — it stays lit, so what you see '
      + 'is what the capture gets.'
  },
  {
    id: 'exposureMode',
    label: 'Exposure',
    kind: 'mode',
    note: 'Continuous lets the camera keep adjusting; manual holds it still so '
      + 'a scene cannot brighten under you mid-measurement.'
  },
  {
    id: 'exposureCompensation',
    label: 'Exposure shift',
    kind: 'range',
    unit: 'EV',
    note: 'Biases automatic exposure without taking it over. Negative protects '
      + 'highlights, which the zebra will show you the moment it is enough.'
  },
  {
    id: 'exposureTime',
    label: 'Shutter',
    kind: 'range',
    unit: '×100µs',
    note: 'How long each frame is collected for. Longer gathers more light and '
      + 'blurs more motion; the unit is the spec\'s, not milliseconds.'
  },
  {
    id: 'iso',
    label: 'ISO',
    kind: 'range',
    note: 'Sensor gain. Higher lifts a dark scene and lifts its noise with it — '
      + 'which is the noise frame averaging is there to fight.'
  },
  {
    id: 'focusMode',
    label: 'Focus',
    kind: 'mode',
    note: 'Manual holds the focal plane where it is, which is what a tripod '
      + 'observation wants — autofocus hunting mid-session moves the picture.'
  },
  {
    id: 'focusDistance',
    label: 'Focus distance',
    kind: 'range',
    unit: 'm',
    note: 'Where the focal plane sits, when the browser lets it be set. Peaking '
      + 'is the fastest way to see the plane move.'
  },
  {
    id: 'whiteBalanceMode',
    label: 'White balance',
    kind: 'mode',
    note: 'Manual holds the colour interpretation still — worth having before '
      + 'any colour lens, whose reference colour shifts when this drifts.'
  },
  {
    id: 'colorTemperature',
    label: 'Colour temperature',
    kind: 'range',
    unit: 'K',
    note: 'The white point, in kelvin, where it can be set directly.'
  }
];

/** One control the live track really offers, with what it will accept. */
export interface OfferedControl extends CameraControl {
  /** For a 'mode' control: the modes this device lists. */
  options: string[];
  /** For a 'range' control. */
  min?: number;
  max?: number;
  step?: number;
  /** What the track reports right now, or null where it reports nothing. */
  current: string | number | boolean | null;
}

/** The engine's capabilityReport shape, as much of it as this module reads. */
export interface CapabilityFields {
  available: boolean;
  fields: Record<string, {
    state?: string;
    options?: unknown[];
    min?: number;
    max?: number;
    step?: number;
    value?: unknown;
  }>;
  settings: Record<string, unknown>;
}

/**
 * The controls this device will actually let a web page operate.
 *
 * Only `supported` counts. `unsupported` means the browser reports
 * capabilities but not this one, and `not exposed` means it reports none at
 * all — neither is an offer, and showing either as a control would put a
 * switch on screen that does nothing.
 */
export function offeredControls(report: CapabilityFields | null): OfferedControl[] {
  if (!report?.available) return [];
  const offered: OfferedControl[] = [];
  for (const control of CAMERA_CONTROLS) {
    const field = report.fields[control.id];
    if (!field || field.state !== 'supported') continue;
    const options = Array.isArray(field.options)
      ? field.options.filter((o): o is string => typeof o === 'string')
      : [];
    // A mode control with nothing to choose between is not a control.
    if (control.kind === 'mode' && options.length < 2) continue;
    // A toggle is offered when the capability exists at all; a range needs
    // two distinct ends or there is nothing to move.
    if (control.kind === 'range' && !(typeof field.max === 'number'
      && typeof field.min === 'number' && field.max > field.min)) continue;
    const current = report.settings[control.id];
    offered.push({
      ...control,
      options,
      min: field.min,
      max: field.max,
      step: field.step,
      current: typeof current === 'string' || typeof current === 'number'
        || typeof current === 'boolean' ? current : null
    });
  }
  return offered;
}

export type ApplyOutcome = 'took' | 'clamped' | 'ignored' | 'refused' | 'unverifiable';

export interface ApplyVerdict {
  outcome: ApplyOutcome;
  /** What the track reports after the attempt, where it reports anything. */
  actual: string | number | boolean | null;
  /** One sentence, safe to show as-is. */
  message: string;
}

/**
 * What actually happened, from the settings either side of the attempt.
 *
 * `applied` is whether applyConstraints resolved — which is the browser
 * accepting the REQUEST. Everything else here is about whether the camera
 * moved, which is a different question and the only one worth reporting.
 */
export function verifyApply(
  control: CameraControl,
  wanted: string | number | boolean,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  applied: boolean,
  reason = ''
): ApplyVerdict {
  const actualRaw = after[control.id];
  const actual = typeof actualRaw === 'string' || typeof actualRaw === 'number'
    || typeof actualRaw === 'boolean' ? actualRaw : null;

  if (!applied) {
    return {
      outcome: 'refused',
      actual,
      message: `${control.label}: the browser refused${reason ? ` — ${reason}` : ''}.`
    };
  }
  if (!(control.id in after)) {
    return {
      outcome: 'unverifiable',
      actual: null,
      message: `${control.label}: accepted, but this browser does not report `
        + `${control.id} back, so whether it took cannot be checked either way.`
    };
  }
  if (matches(actual, wanted)) {
    return { outcome: 'took', actual, message: `${control.label} is now ${show(actual)}.` };
  }
  if (matches(actual, before[control.id])) {
    return {
      outcome: 'ignored',
      actual,
      message: `${control.label}: accepted and nothing changed — it is still `
        + `${show(actual)}. The browser took the request and did not act on it.`
    };
  }
  return {
    outcome: 'clamped',
    actual,
    message: `${control.label}: asked for ${show(wanted)}, got ${show(actual)} — `
      + 'the device settled somewhere it could reach.'
  };
}

/** Numbers from a camera come back rounded; an exact compare would never hold. */
function matches(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    const scale = Math.max(1, Math.abs(a), Math.abs(b));
    return Math.abs(a - b) <= scale * 0.02;
  }
  return a === b;
}

function show(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return value === null || value === undefined ? 'unreported' : String(value);
}

/**
 * The line shown when a device offers nothing.
 *
 * It must not read as a fault or as a limit of the camera, because it is
 * neither: it is the browser declining to pass controls through to a page.
 */
export function noControlsNote(report: CapabilityFields | null): string {
  if (!report?.available) {
    return 'This browser reports no camera capabilities at all — which describes '
      + 'the browser, not the camera. Native apps on the same phone reach '
      + 'controls a web page is simply not handed.';
  }
  return 'This browser exposes no settable camera controls here. The sensor '
    + 'almost certainly has them; WebKit does not pass them through to a page.';
}
