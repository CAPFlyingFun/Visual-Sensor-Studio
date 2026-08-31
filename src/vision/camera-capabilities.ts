/**
 * What this camera will actually let us set.
 *
 * The question behind it is whether real HDR capture is possible here at all.
 * HDR from a burst needs frames at DIFFERENT EXPOSURES, and there are only two
 * ways to get them: ask the camera for them, or wait for auto-exposure to
 * wander and take what it gives. The first is a real feature; the second is
 * hoping. Which one is available is a property of the browser and the device,
 * not something that can be looked up in a version table — WebKit's support
 * for the media capture constraints is patchy and has changed between point
 * releases.
 *
 * So it is measured on the device, and the result decides what gets built.
 * Nothing here assumes an answer.
 */

/** The constraints that decide whether exposure can be commanded. */
export const EXPOSURE_CONTROLS = [
  'exposureMode',
  'exposureCompensation',
  'exposureTime',
  'iso'
] as const;

/** Everything else worth knowing, reported because it is free to ask. */
export const OTHER_CONTROLS = [
  'whiteBalanceMode',
  'focusMode',
  'focusDistance',
  'torch',
  'zoom',
  'frameRate',
  'width',
  'height'
] as const;

export interface ControlReport {
  name: string;
  supported: boolean;
  /** Human-readable range or option list, when the browser gives one. */
  range: string;
  /** What it is set to now, where that is reported. */
  current: string;
}

export type HdrPath = 'bracketed' | 'opportunistic' | 'tone-map-only';

export interface CapabilityReport {
  available: boolean;
  controls: ControlReport[];
  exposure: ControlReport[];
  /**
   * Which dynamic-range approach this device permits.
   *
   *  bracketed      — exposure can be commanded, so a real bracket is possible.
   *  opportunistic  — it cannot, but auto-exposure drift can still be measured
   *                   and frames sorted by brightness after the fact.
   *  tone-map-only  — no capability data at all; a single frame can still be
   *                   tone-mapped, which is NOT the same thing and must not be
   *                   labelled HDR.
   */
  hdrPath: HdrPath;
  summary: string;
}

function describeRange(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.join(' | ');
  if (typeof value === 'object') {
    const range = value as { min?: number; max?: number; step?: number };
    if (typeof range.min === 'number' || typeof range.max === 'number') {
      const step = typeof range.step === 'number' && range.step > 0 ? ` step ${range.step}` : '';
      return `${range.min ?? '?'}…${range.max ?? '?'}${step}`;
    }
    return '';
  }
  return String(value);
}

function describeCurrent(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}

/**
 * Read a capabilities/settings pair into something a person can act on.
 *
 * Both arguments are whatever `getCapabilities()` and `getSettings()` returned,
 * which on WebKit is routinely a near-empty object. An empty result is a real
 * answer — it means the controls are not there — and is reported as such
 * rather than as a failure.
 */
export function readCapabilities(
  capabilities: Record<string, unknown> | null,
  settings: Record<string, unknown> | null
): CapabilityReport {
  const caps = capabilities ?? {};
  const live = settings ?? {};
  const names = [...EXPOSURE_CONTROLS, ...OTHER_CONTROLS];

  const controls: ControlReport[] = names.map((name) => ({
    name,
    // Present-and-not-undefined is the test. A key holding an empty array is
    // the browser saying "this exists but offers no options", which is not
    // the same as support and must not read as it.
    supported: name in caps && caps[name] !== undefined
      && !(Array.isArray(caps[name]) && (caps[name] as unknown[]).length === 0),
    range: describeRange(caps[name]),
    current: describeCurrent(live[name])
  }));

  const exposure = controls.filter((c) =>
    (EXPOSURE_CONTROLS as readonly string[]).includes(c.name));
  const commandable = exposure.some((c) =>
    c.supported && c.name !== 'exposureMode');

  const available = Object.keys(caps).length > 0;
  let hdrPath: HdrPath;
  let summary: string;
  if (commandable) {
    const which = exposure.filter((c) => c.supported).map((c) => c.name).join(', ');
    hdrPath = 'bracketed';
    summary = `Exposure can be set (${which}), so a real bracket is possible: `
      + 'frames captured at chosen exposures and merged.';
  } else if (available) {
    hdrPath = 'opportunistic';
    summary = 'Exposure cannot be set on this device. Auto-exposure drift during a '
      + 'burst can still be measured and the frames sorted by brightness, which is '
      + 'weaker and depends on the scene.';
  } else {
    hdrPath = 'tone-map-only';
    summary = 'This browser reports no camera capabilities at all. Only single-frame '
      + 'tone mapping is possible — that redistributes the range one frame captured '
      + 'and is not HDR, so it would not be labelled as such.';
  }

  return { available, controls, exposure, hdrPath, summary };
}

/** One line for the shareable log. */
export function capabilityLogLine(report: CapabilityReport): string {
  const supported = report.controls.filter((c) => c.supported).map((c) => c.name);
  return `caps ${report.hdrPath} · ${supported.length}/${report.controls.length} · `
    + (supported.length > 0 ? supported.join(',') : 'none reported');
}
