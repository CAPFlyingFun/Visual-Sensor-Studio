/**
 * Shutter choreography — the temporary maximum-stream window around a still.
 *
 * LIVE SOURCE != PHOTO OUTPUT (docs/camera_rule.md). The live camera stream
 * is a performance decision; a still is a quality decision. So the shutter
 * walks the EXISTING track up to its largest mode, confirms with decoded
 * frames, renders once, and walks it back — measured at every step:
 *
 *   remember the current stream mode
 *   ask the track for its maximum        (never a second getUserMedia)
 *   wait for a confirmed decoded frame AFTER the request, then use whatever
 *     dimensions actually arrived — a stream already at its maximum has no
 *     change to wait for, and that is a normal case, not a failure
 *   render from what the camera really granted, never from what was asked
 *   restore the responsive stream and confirm a decoded frame again
 *
 * A constraint promise resolving is not proof of anything — WebKit can accept
 * constraints and keep the mode, or change it a few frames later. Decoded
 * frames are the evidence. If the camera declines or keeps its mode, the
 * still is saved from the stream as it really is and the outcome says so;
 * nothing is upscaled and called detail.
 *
 * Every stage is timed, because "it seems fast" is not a measurement.
 *
 * Pure choreography: the stream operations and the renderer are injected, so
 * every branch of this is testable without a camera.
 */

export interface StreamDims {
  width: number;
  height: number;
}

/** The stream operations the choreography needs, narrowed for testability. */
export interface ShutterStream {
  /** Current DECODED dimensions, measured from the video element. */
  measure(): StreamDims;
  /** Ask the existing live track for its largest STREAM mode. */
  requestMax(): Promise<{ applied: boolean; reason?: string }>;
  /**
   * Ask the existing live track back to the given short side. Also returns
   * the engine's stored stream request to the responsive policy, so a later
   * engine-internal restart reopens responsive rather than at maximum.
   */
  restore(shortSide: number): Promise<{ applied: boolean; reason?: string }>;
  /**
   * Resolves with the dimensions of the NEXT decoded frame, or null when none
   * arrives within the timeout.
   */
  nextFrame(timeoutMs: number): Promise<StreamDims | null>;
}

/**
 * granted   — a decoded frame confirmed different dimensions after the ask
 * unchanged — frames kept arriving at the same dimensions (which is the
 *             correct, honest outcome for a stream already at its maximum)
 * declined  — the request itself was refused
 */
export type Escalation = 'granted' | 'declined' | 'unchanged';

/**
 * restored    — a decoded frame confirmed the stream left the capture mode
 * not needed  — the stream never changed, so there was nothing to walk back
 * refused     — the restore request failed; the camera stays at whatever
 *               valid mode remains (reported, never auto-restarted)
 * unconfirmed — the restore was accepted but no frame confirmed it in time
 */
export type Restoration = 'restored' | 'not needed' | 'refused' | 'unconfirmed';

/** Milliseconds from the moment the max request was issued (Joshua's ask). */
export interface ShutterTiming {
  /** First confirmed decoded frame after the request settled the question. */
  maxFrameReadyMs: number;
  /** renderStill finished (GPU render + encode; the split lives in R). */
  stillDoneMs: number;
  restoreRequestedMs: number;
  /** Confirmed live frame after restore; null when never confirmed. */
  liveRestoredMs: number | null;
  totalMs: number;
}

export interface ShutterOutcome<R> {
  still: R | null;
  /** The dimensions the still was rendered from — measured, never requested. */
  captureSource: StreamDims;
  escalation: Escalation;
  restoration: Restoration;
  timing: ShutterTiming;
}

export interface ShutterOptions {
  /** Hard ceiling on waiting for frames to confirm each mode change. */
  confirmTimeoutMs?: number;
  /**
   * "Unchanged" is concluded early once this many consecutive frames AND
   * settleMs have passed with the same dimensions — so a stream already at
   * its maximum costs a beat, not the whole timeout.
   */
  settleFrames?: number;
  settleMs?: number;
  now?: () => number;
}

function changed(a: StreamDims, b: StreamDims): boolean {
  return a.width !== b.width || a.height !== b.height;
}

/**
 * Wait for decoded frames after a mode request and report what arrived:
 * `changed` the moment a frame differs from `reference`, or `settled` once
 * enough same-dimension frames and time have passed to honestly call the
 * mode unchanged. The hard timeout is the backstop for a stalled stream.
 */
async function confirmAfterRequest(
  stream: ShutterStream,
  reference: StreamDims,
  options: Required<Pick<ShutterOptions, 'confirmTimeoutMs' | 'settleFrames' | 'settleMs'>>,
  now: () => number
): Promise<'changed' | 'settled' | 'no frames'> {
  const start = now();
  const deadline = start + options.confirmTimeoutMs;
  let sameFrames = 0;
  let sawFrame = false;
  for (;;) {
    const left = deadline - now();
    if (left <= 0) return sawFrame ? 'settled' : 'no frames';
    const frame = await stream.nextFrame(left);
    if (!frame) return sawFrame ? 'settled' : 'no frames';
    sawFrame = true;
    if (changed(frame, reference)) return 'changed';
    sameFrames += 1;
    if (sameFrames >= options.settleFrames && now() - start >= options.settleMs) {
      return 'settled';
    }
  }
}

export async function captureAtMaxStream<R>(
  stream: ShutterStream,
  renderStill: (source: StreamDims, escalation: Escalation) => Promise<R | null>,
  options: ShutterOptions = {}
): Promise<ShutterOutcome<R>> {
  const confirm = {
    confirmTimeoutMs: options.confirmTimeoutMs ?? 3500,
    settleFrames: options.settleFrames ?? 6,
    settleMs: options.settleMs ?? 600
  };
  const now = options.now ?? (() => Date.now());
  const t0 = now();
  const before = stream.measure();

  let escalation: Escalation = 'declined';
  let asked = { applied: false as boolean };
  try {
    asked = await stream.requestMax();
  } catch {
    // A failing engine bridge is a declined request, not a crashed shutter.
  }
  if (asked.applied) {
    escalation = (await confirmAfterRequest(stream, before, confirm, now)) === 'changed'
      ? 'granted'
      : 'unchanged';
  }
  const maxFrameReadyMs = now() - t0;

  // Render from what is REALLY there right now, whatever was requested.
  const captureSource = stream.measure();
  let still: R | null = null;
  try {
    still = await renderStill(captureSource, escalation);
  } catch {
    still = null;
  }
  const stillDoneMs = now() - t0;

  // ALWAYS walk back, even when nothing visibly changed or the ask was
  // refused: asking stores the request inside the engine either way, and
  // leaving it at maximum would make the next engine-internal restart reopen
  // at maximum — a permanently slower live camera, which a shutter must never
  // cause. Only a stream that actually changed needs a confirming frame.
  const restoreRequestedMs = now() - t0;
  let restoration: Restoration = 'not needed';
  let liveRestoredMs: number | null = null;
  let back = { applied: false as boolean };
  try {
    back = await stream.restore(Math.min(before.width, before.height));
  } catch {
    back = { applied: false };
  }
  if (escalation === 'granted') {
    if (!back.applied) {
      restoration = 'refused';
    } else if ((await confirmAfterRequest(stream, captureSource, confirm, now)) === 'changed') {
      restoration = 'restored';
      liveRestoredMs = now() - t0;
    } else {
      restoration = 'unconfirmed';
    }
  }

  return {
    still,
    captureSource,
    escalation,
    restoration,
    timing: {
      maxFrameReadyMs,
      stillDoneMs,
      restoreRequestedMs,
      liveRestoredMs,
      totalMs: now() - t0
    }
  };
}
