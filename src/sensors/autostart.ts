/**
 * Remembering that you wanted a sensor on.
 *
 * IMPORTANT, because the wording matters: a web app cannot hold, extend or
 * renew a browser permission. The grant belongs to Safari and to iOS, and
 * nothing here changes how long it lasts. What this does is remember the
 * INTENT — "you wanted the camera running when the app opens" — and then start
 * silently in the cases where the browser already says yes, so the button does
 * not have to be found and pressed on every launch.
 *
 * That distinction is the whole design. A sensor that claims to have held a
 * permission and then silently fails is worse than one that says plainly which
 * of the four situations it is in.
 */

export type PermissionState = 'granted' | 'prompt' | 'denied' | 'unknown';

export type AutoStartDecision =
  /** Already granted: start now, with no prompt and no tap. */
  | 'start'
  /**
   * Allowed, but the browser will not act without a gesture. iOS motion is
   * always here — requestPermission() throws unless a tap is in progress — and
   * a camera whose state is merely 'prompt' belongs here too, because
   * auto-requesting would fire a permission dialog at a user who has just
   * opened the app and asked for nothing.
   */
  | 'needs-gesture'
  /** Refused at the browser or OS level. Only settings can fix this. */
  | 'blocked'
  /** Auto-start is off for this sensor. */
  | 'off';

export interface AutoStartInput {
  /** Has the user asked for this sensor to come up on open? */
  enabled: boolean;
  /** What the Permissions API says, where it is implemented. */
  permission: PermissionState;
  /**
   * True for a sensor whose start call must happen inside a user gesture, no
   * matter what the permission state says. iOS DeviceMotion is the case.
   */
  requiresGesture?: boolean;
  /** False when the platform has no such sensor at all. */
  supported?: boolean;
}

export function decideAutoStart(input: AutoStartInput): AutoStartDecision {
  if (input.supported === false) return 'blocked';
  if (!input.enabled) return 'off';
  if (input.permission === 'denied') return 'blocked';
  if (input.requiresGesture) return 'needs-gesture';
  if (input.permission === 'granted') return 'start';
  // 'prompt' and 'unknown' both land here. Safari does not implement
  // Permissions API queries for camera, so 'unknown' is the normal iOS answer
  // and must not be read as permission to go ahead: calling getUserMedia to
  // find out IS the prompt.
  return 'needs-gesture';
}

/** Plain description of a decision, for a status line the user can act on. */
export function describeAutoStart(decision: AutoStartDecision, sensor: string): string {
  switch (decision) {
    case 'start':
      return `${sensor} starting — already allowed for this site.`;
    case 'needs-gesture':
      return `${sensor} is armed. Tap anywhere to start it; the browser will not allow it without a tap.`;
    case 'blocked':
      return `${sensor} is blocked in Settings, so it cannot start on its own.`;
    case 'off':
      return `${sensor} auto-start is off.`;
  }
}

/**
 * Read a permission without ever letting the query itself be the failure.
 *
 * Safari implements `permissions.query` for geolocation but rejects on the
 * camera name, and older engines throw synchronously on an unknown name. Every
 * one of those is 'unknown', which the policy above already treats as "ask".
 */
export async function readPermission(
  name: string,
  permissions: Permissions | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator.permissions
): Promise<PermissionState> {
  if (!permissions || typeof permissions.query !== 'function') return 'unknown';
  try {
    const status = await permissions.query({ name } as unknown as PermissionDescriptor);
    const state = status?.state;
    return state === 'granted' || state === 'prompt' || state === 'denied' ? state : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Run `action` on the next real user gesture, once.
 *
 * The listeners are capturing and passive so an ordinary tap anywhere still
 * reaches the app's own controls: this arms a start, it does not swallow the
 * interaction that triggered it.
 */
export function onFirstGesture(action: () => void, target: EventTarget): () => void {
  const events = ['pointerdown', 'touchend', 'click', 'keydown'];
  let fired = false;
  const handler = (): void => {
    if (fired) return;
    fired = true;
    release();
    action();
  };
  const release = (): void => {
    for (const type of events) target.removeEventListener(type, handler, true);
  };
  for (const type of events) {
    target.addEventListener(type, handler, { capture: true, passive: true });
  }
  return release;
}
