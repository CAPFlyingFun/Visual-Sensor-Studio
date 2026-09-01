/**
 * Visual Sensor Studio - persistent plain-JavaScript camera engine.
 *
 * This file deliberately loads before, and stays independent of, the compiled
 * TypeScript application. It owns the <video> element, every getUserMedia call
 * and the whole camera lifecycle. The TypeScript side is only a bridge.
 *
 *
 * WHY THIS IS SHAPED THE WAY IT IS (iOS standalone PWA notes)
 * -----------------------------------------------------------
 * WebKit has a family of long-standing camera bugs that only bite when a page
 * is launched from the Home Screen in standalone display mode. The ones this
 * engine is built around:
 *
 *  1. Capture grants are bound to the top frame document's current URL. A
 *     hash or path change - including a same-document history update - can
 *     tear down the media environment and pause an active capture session
 *     (WebKit 215884, 212040). So this engine never changes the URL, and the
 *     app strips its own cache-busting query parameters before starting.
 *
 *  2. `getUserMedia()` can resolve with a track reporting readyState "live"
 *     while the <video> never receives a single decoded frame, because
 *     mediaserverd believes the capture session is backgrounded when it is
 *     not (WebKit 252465). Checking `track.readyState` or even `videoWidth`
 *     is therefore NOT proof of a working camera - both are satisfied by the
 *     broken state. This engine waits for evidence of an actual decoded
 *     frame and treats its absence as a failure.
 *
 *  3. Calling getUserMedia() again while a previous stream is alive can kill
 *     the first stream's video display (WebKit 179363), and in standalone
 *     mode each new request may re-prompt because the grant is not persisted.
 *     So this engine does NOT loop blindly through constraint profiles: it
 *     falls back only for genuine constraint errors, and a no-frames failure
 *     ends in a hard reset plus a user-driven retry rather than an automatic
 *     re-request. There is no automatic camera-request loop anywhere here.
 *
 *  4. Tracks are muted, and stay muted, across a background/foreground
 *     transition in a standalone PWA. Rather than nurse a corrupted stream,
 *     backgrounding fully releases the camera and the engine enters a
 *     `suspended` state that only a user gesture can leave.
 *
 * None of this fixes the underlying WebKit bugs. It makes them detectable and
 * recoverable instead of silently presenting a black rectangle labelled
 * "Camera Live".
 */
(() => {
  'use strict';

  const video = document.getElementById('cameraVideo');
  if (!(video instanceof HTMLVideoElement)) return;

  const captureCanvas = document.createElement('canvas');
  const captureContext = captureCanvas.getContext('2d', { willReadFrequently: true });
  if (!captureContext) return;

  const METADATA_TIMEOUT_MS = 4000;
  // iOS can take a couple of seconds to hand over the first decoded frame on a
  // cold camera start, so this is deliberately longer than a desktop would
  // need - but still bounded, because an unbounded wait is just a hang.
  const FIRST_FRAME_TIMEOUT_MS = 6000;
  // A track can mute briefly during a legitimate route or focus change. Only a
  // mute that persists past this window is treated as the iOS suspend bug.
  const MUTE_GRACE_MS = 1400;
  const DIGITAL_ZOOM_MAX = 5;
  /**
   * Rate requested by Auto Max before any capability has been read.
   *
   * 60 rather than 240: the first request happens before getCapabilities() can
   * be consulted, and over-asking measurably degrades delivery. Once the track
   * is live its advertised maximum is read and applied, so a device that can
   * genuinely do more still gets it.
   */
  const AUTO_FRAME_RATE_FALLBACK = 60;
  /**
   * Whether an explicit frame-rate constraint is currently on the live track.
   *
   * Returning to Auto has to release it, and releasing is only correct if
   * something was applied — otherwise "Auto" would clear the constraints the
   * stream was opened with for no reason.
   */
  let explicitRateApplied = false;

  /**
   * The camera's advertised maximum, remembered between launches.
   *
   * Capabilities can only be read from a track that already exists, which is
   * one negotiation too late to influence the request that created it. Storing
   * what was learned means the next launch can ask for this camera's real
   * shape and size instead of a generic guess — and a generic guess is what
   * put a phone advertising 4032x3024 onto a 1080x1080 square mode.
   */
  const MAX_SIZE_KEY = 'vss.camera.maxSize.v1';

  function rememberMaxSize(size) {
    if (!size || !(size.width > 0) || !(size.height > 0)) return;
    try {
      localStorage.setItem(MAX_SIZE_KEY, JSON.stringify({ width: size.width, height: size.height }));
    } catch {
      // Storage is optional; the generic fallback still works.
    }
  }

  function rememberedMaxSize() {
    try {
      const raw = localStorage.getItem(MAX_SIZE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const width = Number(parsed && parsed.width);
      const height = Number(parsed && parsed.height);
      if (!(width > 0) || !(height > 0)) return null;
      return { width, height };
    } catch {
      return null;
    }
  }
  /**
   * Floor for the DIGITAL zoom fallback.
   *
   * Digital zoom is a centre crop, and there is no cropping outward: below 1x
   * there is simply no more sensor to read, so a "0.5x digital" would be
   * upscaling nothing. A real 0.5x on an iPhone comes from the ultrawide,
   * which is a different physical camera — reachable only if the track
   * advertises a zoom capability whose min is below 1 (handled in
   * readZoomCapabilities, which uses whatever min is reported), or if WebKit
   * exposes the ultrawide as a separate video input that can be selected by
   * deviceId. It cannot be produced by changing this number.
   */
  const DIGITAL_ZOOM_MIN = 1;

  /** @type {MediaStream|null} */
  let stream = null;
  /** @type {MediaStreamTrack|null} */
  let videoTrack = null;
  let facing = 'environment';

  /** idle | requesting | live | suspended | error */
  let state = 'idle';
  let stage = 'idle';
  let reason = '';
  let lastErrorName = '';
  let lastErrorMessage = '';

  let startedAt = 0;
  let firstFrameMs = null;
  let firstFrameVia = 'none';
  let frameEvidence = false;
  let muteTimer = 0;
  let requestToken = 0;
  let captureFailures = 0;
  let lastCaptureError = '';
  // How long the most recent failure took. A NotAllowedError returned in a few
  // milliseconds cannot have involved a prompt a human dismissed - it is an
  // automatic refusal, which points at an OS-level block rather than a choice.
  let lastFailureMs = null;

  // Requested camera frame rate. 'auto' asks for the highest the active
  // configuration claims to support; a number requests that rate specifically.
  let requestedFrameRate = 'auto';
  /**
   * Requested capture resolution, as a target height in pixels.
   *
   * A higher resolution usually costs frame rate — the sensor cannot read out
   * 4032x3024 as fast as 1280x720 — so this is a deliberate trade the user
   * makes, and the negotiated result is always reported rather than assumed.
   */
  let requestedHeight = 720;
  /**
   * Requesting this asks for the camera's largest mode rather than a size.
   *
   * Expressed as a sentinel rather than a boolean so it travels through the
   * same one number every other part of the resolution path already carries.
   */
  const MAX_SIZE_SENTINEL = 10000;
  /**
   * Explicitly chosen camera, or null for facingMode selection.
   *
   * An iPhone exposes the ultrawide as its own input alongside the virtual
   * "Dual Wide" device. Asking the virtual device for zoom 0.5 does not
   * reliably switch lenses — it can scale the wide sensor instead, which
   * cannot add field of view and looks soft. Selecting the dedicated ultrawide
   * gets its real optics at its own native resolution.
   */
  let requestedDeviceId = null;
  /** Set only while an explicit side change is in flight. See buildProfiles(). */
  let strictFacing = false;
  let negotiatedFrameRate = 0;
  let frameRateCapability = null;
  /** Largest video-stream size the track advertises, or null when not exposed. */
  let resolutionCapability = null;
  let deliveryHandle = 0;
  let deliveryListener = null;
  // Counters maintained by whichever delivery loop is running, so anything
  // that needs a frame rate can read them instead of starting a second loop.
  /**
   * Frame counters for anything that needs a delivery rate.
   *
   * `identityTrusted` exists for the same reason as in the TypeScript meter:
   * some WebKit builds supply no callback metadata, so mediaTime is a constant
   * and every frame after the first looks like a repeat. Counting only
   * "unique" frames then reports one frame forever — which is exactly what
   * made the frame-rate benchmark report zero on a camera delivering 60 fps.
   * A long unbroken run of repeats means the signal is broken, not the camera.
   */
  const DELIVERY_REPEAT_LIMIT = 8;
  const delivery = {
    unique: 0,
    repeated: 0,
    lastMediaTime: Number.NaN,
    lastPresentedFrames: Number.NaN,
    repeatStreak: 0,
    identityTrusted: true,
    firstAt: 0,
    lastAt: 0
  };

  /** Fold one presented frame into the counters. Returns true when it is new. */
  function countDeliveredFrame(now, mediaTime, presentedFrames) {
    const presented = typeof presentedFrames === 'number' && Number.isFinite(presentedFrames)
      ? presentedFrames
      : Number.NaN;

    let sameFrame = false;
    if (delivery.identityTrusted) {
      sameFrame = Number.isFinite(delivery.lastMediaTime) && mediaTime === delivery.lastMediaTime;
    } else if (!Number.isNaN(presented)) {
      sameFrame = Number.isFinite(delivery.lastPresentedFrames) && presented === delivery.lastPresentedFrames;
    }

    delivery.lastMediaTime = mediaTime;
    if (!Number.isNaN(presented)) delivery.lastPresentedFrames = presented;

    if (sameFrame) {
      delivery.repeated++;
      delivery.repeatStreak++;
      if (delivery.repeatStreak < DELIVERY_REPEAT_LIMIT) return false;
      delivery.identityTrusted = false;
    }

    delivery.repeatStreak = 0;
    delivery.unique++;
    if (delivery.firstAt === 0) delivery.firstAt = now;
    delivery.lastAt = now;
    return true;
  }
  /**
   * The consumer's interest in frames, kept across restarts.
   *
   * Every start() begins with releaseStream(), which stops delivery. Callers
   * previously had to remember to start it again, and switchCamera() did not —
   * so switching cameras killed frame delivery permanently while the camera
   * itself carried on looking fine. Registration is a standing subscription
   * now, re-armed by the engine whenever it reaches the live state.
   */
  let persistentDeliveryListener = null;

  let zoomValue = 1;
  let zoomKind = 'none';
  let zoomMin = DIGITAL_ZOOM_MIN;
  let zoomMax = 1;
  let zoomStep = 0.1;

  const listeners = new Set();

  function snapshot() {
    return {
      state,
      stage,
      reason,
      facing,
      zoom: { value: zoomValue, min: zoomMin, max: zoomMax, step: zoomStep, kind: zoomKind }
    };
  }

  function emit() {
    const payload = snapshot();
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch {
        // A broken subscriber must never take the camera down with it.
      }
    }
  }

  function setState(next, nextReason = '') {
    if (state === next && reason === nextReason) return;
    state = next;
    reason = nextReason;
    emit();
  }

  function prepareVideo() {
    // Re-applied before every request: video.load() and a WebKit teardown can
    // both drop these, and losing playsinline is what turns an iPhone preview
    // into a fullscreen takeover.
    video.setAttribute('playsinline', 'true');
    video.setAttribute('webkit-playsinline', 'true');
    video.setAttribute('autoplay', 'true');
    video.setAttribute('muted', 'true');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.controls = false;
  }

  function detachTrackListeners() {
    if (!videoTrack) return;
    videoTrack.removeEventListener('ended', onTrackEnded);
    videoTrack.removeEventListener('mute', onTrackMuted);
    videoTrack.removeEventListener('unmute', onTrackUnmuted);
    videoTrack = null;
  }

  function onTrackEnded() {
    // The system took the camera away (another app, a hardware route change).
    // Nothing is recoverable without a fresh user-gesture request.
    clearTimeout(muteTimer);
    releaseStream();
    stage = 'track-ended';
    setState('suspended', 'The camera track was ended by the system. Tap Resume Camera to start a new stream.');
  }

  function onTrackMuted() {
    clearTimeout(muteTimer);
    muteTimer = window.setTimeout(() => {
      if (!videoTrack || !videoTrack.muted) return;
      // This is the standalone-PWA background/foreground failure: the track is
      // still "live" but permanently silent. Holding on to it only produces a
      // frozen preview, so release it and ask for a deliberate restart.
      releaseStream();
      stage = 'track-muted';
      setState('suspended', 'iOS muted the camera track and did not restore it. Tap Resume Camera for a fresh stream.');
    }, MUTE_GRACE_MS);
  }

  function onTrackUnmuted() {
    clearTimeout(muteTimer);
    if (state === 'live') return;
    if (videoTrack && videoTrack.readyState === 'live') {
      stage = 'live';
      setState('live');
    }
  }

  function attachTrackListeners(track) {
    detachTrackListeners();
    if (!track) return;
    videoTrack = track;
    track.addEventListener('ended', onTrackEnded);
    track.addEventListener('mute', onTrackMuted);
    track.addEventListener('unmute', onTrackUnmuted);
  }

  function releaseStream() {
    clearTimeout(muteTimer);
    stopFrameDelivery();
    detachTrackListeners();
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // A track can already be dead; stopping it twice is not an error here.
        }
      }
    }
    stream = null;
    frameEvidence = false;
    try {
      video.pause();
    } catch {
      // Some WebKit teardown states throw from pause().
    }
    video.srcObject = null;
  }

  /**
   * Full teardown of the media element, not just the stream.
   *
   * `video.load()` after clearing both srcObject and src is what actually
   * resets WebKit's internal media state; without it a video element that has
   * been through a failed capture can refuse to render the next stream.
   */
  function hardReset() {
    releaseStream();
    try {
      video.removeAttribute('src');
      video.load();
    } catch {
      // load() can throw mid-teardown on WebKit; the stream is already gone.
    }
    prepareVideo();
    resetZoomState();
    stage = 'reset';
    lastErrorName = '';
    lastErrorMessage = '';
    firstFrameMs = null;
    firstFrameVia = 'none';
    setState('idle', '');
  }

  function resetZoomState() {
    zoomValue = 1;
    zoomKind = 'none';
    zoomMin = DIGITAL_ZOOM_MIN;
    zoomMax = 1;
    zoomStep = 0.1;
    video.style.transform = '';
    video.style.transformOrigin = '';
  }

  function waitForMetadata(timeoutMs) {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth > 0) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.removeEventListener('loadedmetadata', onMeta);
        video.removeEventListener('loadeddata', onMeta);
        resolve(ok);
      };
      const onMeta = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      video.addEventListener('loadedmetadata', onMeta);
      video.addEventListener('loadeddata', onMeta);
    });
  }

  /**
   * Wait for evidence that a frame was actually decoded and presented.
   *
   * `requestVideoFrameCallback` is the direct signal and is available on
   * modern iOS Safari. Where it is missing, an advancing `currentTime` on a
   * live MediaStream is the next best proof: a stream that resolves but never
   * delivers frames leaves currentTime pinned at its starting value.
   *
   * Deliberately not used as evidence: `track.readyState`, `videoWidth` and
   * `video.readyState`. All three are satisfied by the WebKit fake-success
   * state this check exists to catch.
   */
  function waitForFirstFrame(timeoutMs) {
    const begin = performance.now();
    const startTime = video.currentTime;

    return new Promise((resolve) => {
      let settled = false;
      let rafId = 0;
      let frameHandle = 0;

      const finish = (ok, via) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cancelAnimationFrame(rafId);
        if (frameHandle && typeof video.cancelVideoFrameCallback === 'function') {
          try {
            video.cancelVideoFrameCallback(frameHandle);
          } catch {
            // Cancelling an already-fired callback is harmless.
          }
        }
        resolve({ ok, via, elapsedMs: Math.round(performance.now() - begin) });
      };

      const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);

      if (typeof video.requestVideoFrameCallback === 'function') {
        frameHandle = video.requestVideoFrameCallback(() => finish(true, 'requestVideoFrameCallback'));
      }

      const poll = () => {
        if (settled) return;
        if (video.videoWidth > 0
          && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
          && video.currentTime > startTime) {
          finish(true, 'currentTime');
          return;
        }
        rafId = requestAnimationFrame(poll);
      };
      rafId = requestAnimationFrame(poll);
    });
  }

  // --- Persistent attempt log ------------------------------------------
  //
  // The in-memory state is wiped by any reload, so a screenshot of the
  // diagnostics taken after a restart shows "idle" no matter what happened
  // before it. This log survives reloads and app restarts so the failing
  // attempt can still be read afterwards.
  //
  // The important record is the one written BEFORE getUserMedia is called.
  // If an entry is still "pending" when it is read back, the call was made
  // and never settled at all - it neither resolved nor rejected. That is a
  // different fault from a rejection, and nothing in the live state can
  // distinguish the two after the fact.

  const ATTEMPT_LOG_KEY = 'visual-sensor-camera-attempts-v1';
  const MAX_ATTEMPTS_LOGGED = 8;
  let currentAttempt = null;

  function readAttemptLog() {
    try {
      const raw = localStorage.getItem(ATTEMPT_LOG_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeAttemptLog(list) {
    try {
      localStorage.setItem(ATTEMPT_LOG_KEY, JSON.stringify(list.slice(0, MAX_ATTEMPTS_LOGGED)));
    } catch {
      // Private browsing or a full quota must not break the camera itself.
    }
  }

  function beginAttempt(profileIndex) {
    currentAttempt = {
      id: `${Date.now()}-${profileIndex}-${Math.random().toString(36).slice(2, 7)}`,
      at: new Date().toISOString(),
      standalone: isStandaloneDisplay(),
      profile: profileIndex,
      facing,
      outcome: 'pending',
      stage: 'getUserMedia',
      elapsedMs: null,
      errorName: '',
      errorMessage: '',
      firstFrameMs: null,
      firstFrameVia: 'none',
      trackState: 'none',
      trackMuted: false,
      videoWidth: 0,
      videoHeight: 0
    };
    const list = readAttemptLog();
    list.unshift(currentAttempt);
    writeAttemptLog(list);
    return currentAttempt;
  }

  function settleAttempt(outcome, error) {
    if (!currentAttempt) return;
    const track = stream ? stream.getVideoTracks()[0] || null : null;
    currentAttempt.outcome = outcome;
    currentAttempt.stage = stage;
    currentAttempt.elapsedMs = Math.round(performance.now() - startedAt);
    currentAttempt.errorName = error ? errorName(error) : '';
    currentAttempt.errorMessage = error
      ? (error instanceof Error ? error.message : String(error))
      : '';
    currentAttempt.firstFrameMs = firstFrameMs;
    currentAttempt.firstFrameVia = firstFrameVia;
    currentAttempt.trackState = track ? track.readyState : 'none';
    currentAttempt.trackMuted = track ? Boolean(track.muted) : false;
    currentAttempt.videoWidth = video.videoWidth || 0;
    currentAttempt.videoHeight = video.videoHeight || 0;

    const list = readAttemptLog();
    const index = list.findIndex((entry) => entry && entry.id === currentAttempt.id);
    if (index >= 0) list[index] = currentAttempt;
    else list.unshift(currentAttempt);
    writeAttemptLog(list);
    currentAttempt = null;
  }

  function errorName(error) {
    return error && typeof error === 'object' && 'name' in error ? String(error.name || '') : '';
  }

  function noFramesError() {
    const error = new Error('The camera stream opened but never delivered a decoded frame.');
    error.name = 'NotReadableError';
    return error;
  }

  function isConstraintError(name) {
    return name === 'OverconstrainedError'
      || name === 'ConstraintNotSatisfiedError'
      || name === 'NotFoundError'
      || name === 'DevicesNotFoundError'
      || name === 'TypeError';
  }

  function isStandaloneDisplay() {
    try {
      return window.matchMedia('(display-mode: standalone)').matches || Boolean(navigator.standalone);
    } catch {
      return Boolean(navigator.standalone);
    }
  }

  function describeError(error, standalone = isStandaloneDisplay()) {
    const name = errorName(error);
    const hint = standalone
      ? ' This is an installed standalone iOS web app, where WebKit has known camera bugs that do not affect the same page in a browser tab. Try Hard Reset Camera, then Retry Camera; if it keeps failing, open the site in Safari or Edge.'
      : '';

    if (name === 'NotAllowedError' || name === 'SecurityError') {
      // No human dismisses a permission sheet in a fraction of a second, so a
      // refusal this fast means no sheet was ever shown. That is an OS-level
      // block, and telling the user to "allow the prompt" is useless advice
      // when there is no prompt to allow.
      if (lastFailureMs !== null && lastFailureMs < 400) {
        // Ordered by what actually turned out to be the cause on a real
        // device: Safari's global Camera default set to Deny. An installed
        // web app does not inherit a per-site grant given to a Safari tab, so
        // it falls back to that global default - which is why the same page
        // can work in the browser and be refused here.
        return `iOS refused camera access in ${lastFailureMs} ms without showing a permission prompt, so this is a block outside the app rather than a choice you made in it.`
          + ' 1. Settings > Apps > Safari > Camera — set it to Ask. On Deny, every request is refused instantly with no prompt, and an installed web app does not inherit a grant you gave the same site in a Safari tab.'
          + ' 2. Settings > Screen Time > Content & Privacy Restrictions > Allowed Apps & Features — Camera must be on.'
          + ' 3. If both are already correct, delete this app from the Home Screen and add it again from Safari, which clears a remembered denial for the site.';
      }
      return `Camera permission was blocked or never granted.${standalone ? ' iOS does not persist camera permission for installed web apps, so the prompt can be expected again after each launch.' : ''}${hint}`;
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return `No usable camera was reported by this device.${hint}`;
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return `The camera opened but delivered no frames, so it was not reported as live. Another app may be holding the camera, or WebKit is in the known standalone capture-session failure state.${hint}`;
    }
    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') return `The requested camera mode was unavailable on this device.${hint}`;
    if (name === 'AbortError') return `Camera startup was interrupted before it completed.${hint}`;

    const message = error instanceof Error ? error.message : 'Unable to start the camera.';
    return `${message}${hint}`;
  }

  function readZoomCapabilities() {
    zoomKind = 'digital';
    zoomMin = DIGITAL_ZOOM_MIN;
    zoomMax = DIGITAL_ZOOM_MAX;
    zoomStep = 0.1;

    const track = videoTrack;
    if (!track || typeof track.getCapabilities !== 'function') return;

    let capabilities = null;
    try {
      capabilities = track.getCapabilities();
    } catch {
      return;
    }

    const zoom = capabilities && capabilities.zoom;
    if (!zoom || typeof zoom !== 'object') return;
    const min = Number(zoom.min);
    const max = Number(zoom.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return;

    zoomKind = 'camera';
    zoomMin = min;
    zoomMax = max;
    const step = Number(zoom.step);
    zoomStep = Number.isFinite(step) && step > 0 ? step : (max - min) / 40;
  }

  function applyDigitalZoomPreview() {
    if (zoomKind !== 'digital' || zoomValue <= 1.0001) {
      video.style.transform = '';
      video.style.transformOrigin = '';
      return;
    }
    video.style.transformOrigin = '50% 50%';
    video.style.transform = `scale(${zoomValue.toFixed(3)})`;
  }

  /**
   * Set zoom, preferring real MediaTrack zoom and falling back to a centre
   * crop. `kind` in the returned state says which one is actually in effect;
   * a digital crop is never reported as camera zoom.
   */
  async function setZoom(requested) {
    const value = Math.min(zoomMax, Math.max(zoomMin, Number(requested) || 1));

    if (zoomKind === 'camera' && videoTrack && typeof videoTrack.applyConstraints === 'function') {
      try {
        await videoTrack.applyConstraints({ advanced: [{ zoom: value }] });
        zoomValue = value;
        video.style.transform = '';
        emit();
        return snapshot().zoom;
      } catch {
        // The capability was advertised but refused. Fall through to a crop
        // rather than leaving the control dead, and relabel it honestly.
        zoomKind = 'digital';
        zoomMin = DIGITAL_ZOOM_MIN;
        zoomMax = DIGITAL_ZOOM_MAX;
        zoomStep = 0.1;
      }
    }

    zoomValue = Math.min(zoomMax, Math.max(zoomMin, value));
    applyDigitalZoomPreview();
    emit();
    return snapshot().zoom;
  }

  /**
   * Frame-rate ladder for a request.
   *
   * `exact` is never used for a high rate: on WebKit an unsatisfiable exact
   * constraint fails the whole getUserMedia call, so asking for exact 240
   * would take the camera down rather than fall back. `ideal` lets the browser
   * negotiate the closest rate it can actually deliver, and `max` keeps it
   * from picking something absurd.
   */
  function frameRateConstraint(requested) {
    if (requested === 'auto') {
      // Ask for the highest rate the ACTIVE configuration actually advertises,
      // not a hopeful 240.
      //
      // Device measurement: on a track advertising 1-60, requesting 240
      // delivered 38.3 fps while requesting 120 delivered 51.6 and requesting
      // 60 delivered 50. Asking for a rate the hardware cannot reach does not
      // get ignored — it destabilises delivery and makes things worse. Auto
      // Max means the maximum useful rate, so ask for the one on offer.
      const advertised = frameRateCapability && Number.isFinite(frameRateCapability.max)
        ? frameRateCapability.max
        : 0;
      const target = advertised > 0 ? advertised : AUTO_FRAME_RATE_FALLBACK;
      return { ideal: target, max: target };
    }
    const value = Number(requested);
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return { ideal: value, max: value };
  }

  function buildProfiles(requested) {
    const rate = frameRateConstraint(requested);
    const withRate = (facingConstraint, extra) => {
      const video = Object.assign({ facingMode: facingConstraint }, extra);
      if (rate) video.frameRate = rate;
      return { audio: false, video };
    };

    // `ideal` for resolution throughout, so a size the device cannot provide is
    // negotiated down rather than failing the request outright.
    //
    // THE REQUEST MUST NOT IMPOSE AN ORIENTATION, AND MUST NOT ASK FOR A
    // SQUARE. Three attempts, three different ways of getting this wrong.
    //
    // Hard-coding width = height * 16/9 asked a portrait camera for a
    // landscape mode. Guessing the orientation from the window forced the
    // opposite mistake on a device whose sensor disagreed. Then a SQUARE ideal
    // removed the orientation guess — and a phone turns out to have real
    // square capture modes, so asking for 1080x1080 got exactly that: a
    // 1080x1080 mode, a tenth of the sensor, on a camera advertising
    // 4032x3024.
    //
    // The reliable answer is not to guess a shape at all but to ask for the
    // shape this camera SAYS it has. `resolutionCapability` is read from
    // getCapabilities() once a track exists and remembered across launches, so
    // the first run asks for a wide 4:3 target — which beats a square on
    // fitness distance in either orientation — and every run after that asks
    // for the device's own advertised maximum, scaled to the chosen tier.
    const wantedShortSide = Number(requestedHeight) || 720;
    const known = rememberedMaxSize();
    // Native aspect from the advertised maximum, or 4:3 until one is known.
    // 4:3 matters: against a square ideal a square mode wins outright, and
    // against a 4:3 ideal it loses in both orientations.
    const aspect = known && known.width > 0 && known.height > 0
      ? Math.max(known.width, known.height) / Math.min(known.width, known.height)
      : 4 / 3;
    const shortSide = wantedShortSide >= MAX_SIZE_SENTINEL
      ? (known ? Math.min(known.width, known.height) : 6144)
      : wantedShortSide;
    const longSide = Math.round(shortSide * aspect);
    // Both axes are given, neither says which way up: the larger number goes
    // on the axis the camera is already using, because a mode matching in one
    // orientation scores the same as its transpose against these two ideals.
    const size = { width: { ideal: longSide }, height: { ideal: shortSide } };
    const device = requestedDeviceId ? { deviceId: { exact: requestedDeviceId } } : {};

    const profiles = [];

    // An explicit side change has to BIND the facing. `ideal` is only a hint,
    // and a hint is free to be satisfied by the camera already running — which
    // is a Switch Camera button that appears to do nothing. `exact` is tried
    // first and the ideal profiles below remain as the fallback, so a device
    // with only one camera still starts.
    if (strictFacing) {
      profiles.push(withRate({ exact: facing }, size));
      profiles.push(withRate({ exact: facing }, {}));
    }

    profiles.push(withRate({ ideal: facing }, Object.assign({}, size, device)));
    profiles.push(withRate({ ideal: facing }, device));
    // Then the same request without the device pin, so a camera that has
    // disappeared since it was chosen cannot leave the app with no camera.
    profiles.push(withRate({ ideal: facing }, {}));
    // Final fallback drops the frame-rate request entirely: a rate the
    // device cannot honour must never be the reason the camera fails.
    profiles.push({ audio: false, video: true });
    return profiles;
  }

  function readFrameRateCapability() {
    frameRateCapability = null;
    resolutionCapability = null;
    negotiatedFrameRate = 0;

    const track = videoTrack;
    if (!track) return;

    if (typeof track.getCapabilities === 'function') {
      try {
        const capabilities = track.getCapabilities();
        // What this camera says it can deliver AS A VIDEO STREAM. Worth
        // reporting beside the negotiated size, because the difference between
        // "this camera cannot do more" and "we did not ask for more" is
        // invisible otherwise — and the second one was a real bug here.
        const w = capabilities && capabilities.width;
        const h = capabilities && capabilities.height;
        if (w && h && Number.isFinite(Number(w.max)) && Number.isFinite(Number(h.max))) {
          resolutionCapability = { width: Number(w.max), height: Number(h.max) };
          rememberMaxSize(resolutionCapability);
        }
        const range = capabilities && capabilities.frameRate;
        if (range && typeof range === 'object') {
          const min = Number(range.min);
          const max = Number(range.max);
          if (Number.isFinite(max) && max > 0) {
            frameRateCapability = { min: Number.isFinite(min) ? min : 0, max };
          }
        }
      } catch {
        // Capability reporting is optional and absent on several WebKit builds.
      }
    }

    if (typeof track.getSettings === 'function') {
      try {
        negotiatedFrameRate = Number(track.getSettings().frameRate) || 0;
      } catch {
        negotiatedFrameRate = 0;
      }
    }
  }

  /**
   * Drive a callback from presented video frames.
   *
   * requestVideoFrameCallback fires once per frame the compositor actually
   * presents, which is the only honest source of delivered frame rate. A
   * requestAnimationFrame loop measures the DISPLAY instead, and a 30 fps
   * camera on a 120 Hz screen would report 120.
   *
   * Where rVFC is missing the caller gets nothing rather than a fabricated
   * number, and falls back to its own timing.
   */
  function startFrameDelivery(listener) {
    stopFrameDelivery();
    persistentDeliveryListener = listener;
    if (typeof video.requestVideoFrameCallback !== 'function') return false;

    deliveryListener = listener;
    const tick = (now, metadata) => {
      if (deliveryListener !== listener) return;
      deliveryHandle = video.requestVideoFrameCallback(tick);

      const mediaTime = metadata ? metadata.mediaTime : 0;
      countDeliveredFrame(now, mediaTime, metadata ? metadata.presentedFrames : undefined);

      try {
        listener({
          now,
          mediaTime,
          presentedFrames: metadata ? metadata.presentedFrames : undefined
        });
      } catch {
        // A failing consumer must not stop frame delivery.
      }
    };
    deliveryHandle = video.requestVideoFrameCallback(tick);
    return true;
  }

  function stopFrameDelivery() {
    deliveryListener = null;
    delivery.unique = 0;
    delivery.repeated = 0;
    delivery.lastMediaTime = Number.NaN;
    delivery.lastPresentedFrames = Number.NaN;
    delivery.repeatStreak = 0;
    delivery.identityTrusted = true;
    delivery.firstAt = 0;
    delivery.lastAt = 0;
    if (deliveryHandle && typeof video.cancelVideoFrameCallback === 'function') {
      try {
        video.cancelVideoFrameCallback(deliveryHandle);
      } catch {
        // Cancelling an already-fired handle is harmless.
      }
    }
    deliveryHandle = 0;
  }

  /**
   * Count distinct presented frames over a window.
   *
   * When a delivery loop is already running, this SAMPLES its counters rather
   * than registering a second requestVideoFrameCallback loop on the same
   * element. Two concurrent loops measured fine in Chromium but returned zero
   * frames for the second one on WebKit, which is why the frame-rate benchmark
   * reported "measured 0 fps" for every rate on a device whose camera was
   * plainly working. One loop, one source of truth.
   *
   * Only when nothing is delivering does it register its own loop.
   */
  function measureDelivery(durationMs) {
    if (deliveryListener) {
      const startUnique = delivery.unique;
      const startRepeated = delivery.repeated;
      const startAt = performance.now();

      return new Promise((resolve) => {
        setTimeout(() => {
          const unique = delivery.unique - startUnique;
          const repeated = delivery.repeated - startRepeated;
          const span = performance.now() - startAt;
          resolve({
            fps: unique > 0 && span > 0 ? (unique * 1000) / span : 0,
            unique,
            repeated,
            measurable: true
          });
        }, durationMs);
      });
    }

    return new Promise((resolve) => {
      if (typeof video.requestVideoFrameCallback !== 'function') {
        resolve({ fps: 0, unique: 0, repeated: 0, measurable: false });
        return;
      }

      let unique = 0;
      let repeated = 0;
      let firstAt = 0;
      let lastAt = 0;
      let lastMediaTime = Number.NaN;
      let repeatStreak = 0;
      let handle = 0;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (handle && typeof video.cancelVideoFrameCallback === 'function') {
          try {
            video.cancelVideoFrameCallback(handle);
          } catch {
            // Already fired.
          }
        }
        const span = lastAt - firstAt;
        const fps = unique > 1 && span > 0 ? ((unique - 1) * 1000) / span : 0;
        resolve({ fps, unique, repeated, measurable: unique > 0 });
      };

      const timer = setTimeout(finish, durationMs);

      const tick = (now, metadata) => {
        if (settled) return;
        handle = video.requestVideoFrameCallback(tick);
        const mediaTime = metadata ? metadata.mediaTime : 0;
        // Same reasoning as countDeliveredFrame: a signal that never changes
        // must not be allowed to report zero frames forever.
        if (Number.isFinite(lastMediaTime) && mediaTime === lastMediaTime && repeatStreak < DELIVERY_REPEAT_LIMIT) {
          repeated++;
          repeatStreak++;
          return;
        }
        repeatStreak = 0;
        lastMediaTime = mediaTime;
        unique++;
        if (firstAt === 0) firstAt = now;
        lastAt = now;
        if (now - firstAt >= durationMs) {
          clearTimeout(timer);
          finish();
        }
      };
      handle = video.requestVideoFrameCallback(tick);
    });
  }

  async function requestStream(constraints, profileIndex) {
    // getUserMedia is invoked before anything else in this function, and
    // nothing is awaited between the user's tap and this line. The pending
    // record is written from the returned promise rather than before the
    // call, so the localStorage round-trip cannot sit between the gesture
    // and the permission request.
    const pending = navigator.mediaDevices.getUserMedia(constraints);
    beginAttempt(profileIndex);

    const nextStream = await pending;
    stream = nextStream;
    attachTrackListeners(nextStream.getVideoTracks()[0] || null);
    video.srcObject = nextStream;
    return nextStream;
  }

  async function attempt(constraints, profileIndex, token) {
    await requestStream(constraints, profileIndex);
    if (token !== requestToken) throw new DOMException('Superseded camera request.', 'AbortError');

    stage = 'metadata';
    emit();
    await waitForMetadata(METADATA_TIMEOUT_MS);
    if (token !== requestToken) throw new DOMException('Superseded camera request.', 'AbortError');

    stage = 'playback';
    emit();
    try {
      const playPromise = video.play();
      if (playPromise && typeof playPromise.then === 'function') await playPromise;
    } catch {
      // A rejected play() is not fatal on its own: WebKit sometimes rejects
      // while still going on to render the stream. The first-frame check
      // below is the real verdict.
    }

    stage = 'first-frame';
    emit();
    const frame = await waitForFirstFrame(FIRST_FRAME_TIMEOUT_MS);
    if (token !== requestToken) throw new DOMException('Superseded camera request.', 'AbortError');

    firstFrameMs = frame.elapsedMs;
    firstFrameVia = frame.via;
    frameEvidence = frame.ok;

    const track = stream && stream.getVideoTracks()[0];
    if (!track || track.readyState !== 'live' || track.muted || !frame.ok) {
      throw noFramesError();
    }
  }

  /**
   * Start the camera. Call this from a user gesture: nothing is awaited before
   * getUserMedia, so the gesture's transient activation is still in effect
   * when WebKit decides whether to show the permission prompt.
   */
  async function start(requestedFacing = facing, deviceId = requestedDeviceId) {
    requestedDeviceId = deviceId || null;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const error = new Error('This browser context does not expose getUserMedia.');
      error.name = 'NotAllowedError';
      stage = 'unsupported';
      lastErrorName = error.name;
      lastErrorMessage = error.message;
      startedAt = performance.now();
      beginAttempt(-1);
      settleAttempt('unsupported', error);
      setState('error', describeError(error));
      throw error;
    }

    const token = ++requestToken;
    releaseStream();
    resetZoomState();
    prepareVideo();

    facing = requestedFacing === 'user' ? 'user' : 'environment';
    startedAt = performance.now();
    firstFrameMs = null;
    firstFrameVia = 'none';
    lastErrorName = '';
    lastErrorMessage = '';
    stage = 'getUserMedia';
    setState('requesting', '');

    const profiles = buildProfiles(requestedFrameRate);

    let lastError = new Error('Unable to start the camera.');

    for (let i = 0; i < profiles.length; i++) {
      try {
        await attempt(profiles[i], i, token);
        readZoomCapabilities();
        readFrameRateCapability();
        applyDigitalZoomPreview();
        // Re-arm the standing subscription: releaseStream() stopped it at the
        // top of this call, and nothing else is going to put it back.
        if (persistentDeliveryListener) startFrameDelivery(persistentDeliveryListener);
        // Capabilities are only readable once the track exists, so Auto Max
        // re-applies here against the ceiling the device actually advertises.
        if (requestedFrameRate === 'auto'
          && frameRateCapability
          && Number.isFinite(frameRateCapability.max)
          && frameRateCapability.max > AUTO_FRAME_RATE_FALLBACK
          && videoTrack
          && typeof videoTrack.applyConstraints === 'function') {
          const ceiling = frameRateCapability.max;
          void videoTrack.applyConstraints({ frameRate: { ideal: ceiling, max: ceiling } })
            .then(readFrameRateCapability)
            .catch(() => undefined);
        }
        readActualFacing();
        stage = 'live';
        settleAttempt('live');
        setState('live', '');
        return facing;
      } catch (error) {
        if (token !== requestToken) {
          settleAttempt('superseded', error);
          throw error;
        }

        lastError = error;
        lastErrorName = errorName(error);
        lastErrorMessage = error instanceof Error ? error.message : String(error);
        lastFailureMs = Math.round(performance.now() - startedAt);
        // Settled before releaseStream() so the track state at the moment of
        // failure is what gets recorded, not the state after teardown.
        settleAttempt('failed', error);
        releaseStream();

        // A denied permission is final; retrying only produces another prompt.
        if (lastErrorName === 'NotAllowedError' || lastErrorName === 'SecurityError') break;

        // A stream that opened but delivered nothing is the WebKit capture
        // failure. Immediately calling getUserMedia again is known to make it
        // worse, so stop here and let the user retry deliberately.
        if (!isConstraintError(lastErrorName)) break;
      }
    }

    hardResetQuietly();
    stage = 'failed';
    setState('error', describeError(lastError));
    throw lastError;
  }

  function hardResetQuietly() {
    releaseStream();
    try {
      video.removeAttribute('src');
      video.load();
    } catch {
      // See hardReset().
    }
    prepareVideo();
  }

  /**
   * Correct the recorded facing from the track that actually started.
   *
   * A constraint is a request, not a result. Trusting the request means the
   * app can believe it is on the front camera while showing the back one, and
   * every later decision built on that — the label, the next toggle — is wrong
   * in the same direction.
   */
  function readActualFacing() {
    if (!videoTrack || typeof videoTrack.getSettings !== 'function') return;
    try {
      const actual = videoTrack.getSettings().facingMode;
      if (actual === 'user' || actual === 'environment') facing = actual;
    } catch {
      // Settings are not always readable; the requested value stands.
    }
  }

  async function switchCamera() {
    const next = facing === 'environment' ? 'user' : 'environment';
    strictFacing = true;
    try {
      // The device pin is cleared explicitly rather than inherited. A deviceId
      // names ONE physical camera, so carrying a chosen back lens into a
      // request for the front camera pins the request straight back to the
      // camera being switched away from.
      await start(next, null);
    } finally {
      strictFacing = false;
    }
    // Report what the track actually is, not what was asked for. A wrong
    // record here also picks the wrong direction for the NEXT press, which is
    // how a toggle ends up only working one way.
    return facing;
  }

  function stop() {
    requestToken++;
    releaseStream();
    resetZoomState();
    stage = 'idle';
    setState('idle', '');
  }

  /**
   * Release the camera because the app is going away, and remember that it was
   * running so the UI can offer an explicit Resume rather than silently
   * restarting. There is intentionally no automatic re-request here.
   */
  function suspend(why) {
    if (state !== 'live' && state !== 'requesting') return;
    requestToken++;
    releaseStream();
    stage = 'suspended';
    setState('suspended', why);
  }

  function captureFrame(targetWidth = 192) {
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    const track = stream && stream.getVideoTracks()[0];

    if (state !== 'live' || !track || track.readyState !== 'live' || track.muted || !sourceWidth || !sourceHeight) {
      // Counted rather than only thrown: the consumer swallows these, so a
      // permanent stall would otherwise be invisible in diagnostics.
      captureFailures++;
      lastCaptureError = `state ${state}, track ${track ? track.readyState : 'none'}, video ${sourceWidth}x${sourceHeight}`;
      throw new Error('No live camera frame is ready yet.');
    }

    // Camera zoom already happened in the sensor, so only a digital crop needs
    // to be reproduced here - otherwise the processed views would disagree
    // with the preview.
    const crop = zoomKind === 'digital' ? Math.max(1, zoomValue) : 1;
    const cropWidth = sourceWidth / crop;
    const cropHeight = sourceHeight / crop;
    const cropX = (sourceWidth - cropWidth) / 2;
    const cropY = (sourceHeight - cropHeight) / 2;

    const safeWidth = Math.max(32, Math.min(960, Math.round(targetWidth)));
    const height = Math.max(24, Math.round((cropHeight / cropWidth) * safeWidth));
    if (captureCanvas.width !== safeWidth) captureCanvas.width = safeWidth;
    if (captureCanvas.height !== height) captureCanvas.height = height;
    captureContext.drawImage(video, cropX, cropY, cropWidth, cropHeight, 0, 0, safeWidth, height);

    return {
      imageData: captureContext.getImageData(0, 0, safeWidth, height),
      width: safeWidth,
      height
    };
  }

  // --- Lifecycle -----------------------------------------------------------
  //
  // Backgrounding a standalone iOS web app is where the camera goes wrong, so
  // the camera is fully released on the way out rather than preserved and
  // repaired on the way back in.

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      suspend('The app was backgrounded, so the camera was released. Tap Resume Camera when you return.');
      return;
    }

    // Coming back to the foreground: never auto-request. If a stream somehow
    // survived but is muted or dead, drop it so the UI cannot claim it is live.
    if (state === 'live') {
      const track = stream && stream.getVideoTracks()[0];
      if (!track || track.readyState !== 'live' || track.muted) {
        suspend('The camera did not survive returning to the foreground. Tap Resume Camera for a fresh stream.');
      }
    }
  });

  window.addEventListener('pagehide', () => {
    suspend('The page was hidden, so the camera was released.');
  });

  window.addEventListener('pageshow', (event) => {
    // A back-forward-cache restore hands back a document whose media state
    // WebKit may consider stale, so treat it exactly like a resume.
    if (event.persisted && state === 'live') {
      suspend('The page was restored from cache, so the camera was released. Tap Resume Camera.');
    }
  });

  // Page Lifecycle `freeze` fires on the document, not the window.
  document.addEventListener('freeze', () => {
    suspend('The app was frozen by the system, so the camera was released.');
  });

  const VisualCamera = {
    start,
    switchCamera,
    stop,
    suspend,
    hardReset,
    captureFrame,
    setZoom,
    describeError,
    startFrameDelivery,
    stopFrameDelivery() {
      persistentDeliveryListener = null;
      stopFrameDelivery();
    },

    /**
     * Change the requested frame rate on the live track without a new
     * getUserMedia call.
     *
     * applyConstraints renegotiates the existing track, so a rate the device
     * cannot honour degrades to whatever it can do instead of re-prompting for
     * permission or dropping the stream. The returned value is what the track
     * then REPORTS, which still has to be checked against measured delivery.
     */
    /**
     * Change the capture resolution on the live track.
     *
     * Uses applyConstraints, so it renegotiates the existing track rather than
     * re-prompting for permission. The result is whatever the device settles
     * on, which the caller must read back rather than assume.
     */
    /**
     * Switch to a specific camera by deviceId.
     *
     * A device change cannot go through applyConstraints, so this restarts the
     * stream. Permission is already granted for the origin, so it does not
     * re-prompt, and the standing frame-delivery subscription is re-armed by
     * start() itself.
     */
    async selectDevice(deviceId) {
      return start(facing, deviceId || null);
    },

    get selectedDeviceId() {
      return requestedDeviceId;
    },

    /**
     * Record the wanted capture height WITHOUT touching a live track.
     *
     * This exists to be called before `start()`. A resolution asked for after
     * the stream is open goes through `applyConstraints`, and WebKit will
     * happily negotiate a live track DOWN but routinely ignores a request to
     * raise it — the format is already chosen. So a stream opened at the 720
     * default stayed at 720 for the session no matter what the setting said,
     * and the only reliable place to ask for more is the getUserMedia call
     * itself.
     *
     * Synchronous on purpose: the start path must not await anything before
     * getUserMedia or the tap's transient activation is gone and WebKit stops
     * showing the permission prompt.
     */
    setPreferredCaptureHeight(height) {
      requestedHeight = Number(height) || 720;
      return requestedHeight;
    },

    /**
     * Ask the NEXT request for this camera's largest mode, whatever its size
     * turns out to be. Synchronous for the same transient-activation reason as
     * setPreferredCaptureHeight. The sentinel stays private to the engine —
     * callers state the intent, not a number.
     */
    preferMaxCaptureSize() {
      requestedHeight = MAX_SIZE_SENTINEL;
    },

    /** Ask a LIVE track for the largest mode. The result must be read back. */
    async applyMaxCaptureSize() {
      return this.setCaptureHeight(MAX_SIZE_SENTINEL);
    },

    async setCaptureHeight(height) {
      requestedHeight = Number(height) || 720;
      const track = videoTrack;
      if (!track || typeof track.applyConstraints !== 'function') {
        return { applied: false, reason: 'no live track' };
      }
      try {
        // The same shape as the opening request. A square here would undo it:
        // a phone has real square modes, and asking for one gets one.
        const known = rememberedMaxSize();
        const aspect = known && known.width > 0 && known.height > 0
          ? Math.max(known.width, known.height) / Math.min(known.width, known.height)
          : 4 / 3;
        const shortSide = requestedHeight >= MAX_SIZE_SENTINEL
          ? (known ? Math.min(known.width, known.height) : 6144)
          : requestedHeight;
        await track.applyConstraints({
          width: { ideal: Math.round(shortSide * aspect) },
          height: { ideal: shortSide }
        });
        readFrameRateCapability();
        return { applied: true };
      } catch (error) {
        return { applied: false, reason: errorName(error) || 'refused' };
      }
    },

    async setFrameRate(requested) {
      requestedFrameRate = requested === 'auto' ? 'auto' : Number(requested) || 'auto';
      const track = videoTrack;
      if (!track || typeof track.applyConstraints !== 'function') {
        return { applied: false, reason: 'no live track', reported: negotiatedFrameRate };
      }

      // AUTO DOES NOT RE-CONSTRAIN A LIVE TRACK, and this is the whole fix for
      // a resolution that collapsed half a second after the camera opened.
      //
      // Frame rate and resolution are not independent: a camera has a set of
      // modes, and asking for 60 fps on a track that opened at 3024x4032 makes
      // WebKit re-select a mode that can actually sustain 60 — which at twelve
      // megapixels it cannot, so it drops to a much smaller one. The opening
      // request already asked for a rate, so applying it again here buys
      // nothing and silently spends the resolution to pay for it.
      //
      // An explicitly chosen rate still applies: that is the user asking for
      // the trade with their eyes open. Auto means "whatever this camera is
      // comfortable with", which is exactly what it already negotiated.
      if (requestedFrameRate === 'auto') {
        if (!explicitRateApplied) {
          readFrameRateCapability();
          return { applied: true, reason: 'auto keeps the negotiated mode', reported: negotiatedFrameRate };
        }
        // An explicit rate WAS applied earlier — by the benchmark, or by the
        // user before switching back to Auto — so going back to auto has to
        // RELEASE that constraint rather than do nothing. An empty set clears
        // the track's requirements; the settings it currently holds stay, but
        // it is free to re-select. Without this the benchmark would restore
        // "auto" and leave the last rate it tried in force.
        try {
          await track.applyConstraints({});
          explicitRateApplied = false;
          readFrameRateCapability();
          return { applied: true, reason: 'released the rate constraint', reported: negotiatedFrameRate };
        } catch (error) {
          readFrameRateCapability();
          return { applied: false, reason: errorName(error) || 'refused', reported: negotiatedFrameRate };
        }
      }

      const constraint = frameRateConstraint(requestedFrameRate);
      try {
        await track.applyConstraints(constraint ? { frameRate: constraint } : {});
        explicitRateApplied = Boolean(constraint);
        readFrameRateCapability();
        return { applied: true, reported: negotiatedFrameRate };
      } catch (error) {
        // The old rate stays in force; a refused constraint is not a failure
        // of the camera, only of that particular request.
        readFrameRateCapability();
        return {
          applied: false,
          reason: errorName(error) || 'refused',
          reported: negotiatedFrameRate
        };
      }
    },

    /**
     * Apply a manual camera control to the live track.
     *
     * Only ever called for a capability the track advertised, and it reports
     * the refusal rather than swallowing it — a control that silently does
     * nothing is worse than one that says it could not.
     */
    async applyCameraSetting(name, value) {
      const track = videoTrack;
      if (!track || typeof track.applyConstraints !== 'function') {
        return { applied: false, reason: 'no live track' };
      }
      try {
        await track.applyConstraints({ advanced: [{ [name]: value }] });
        return { applied: true };
      } catch (error) {
        return { applied: false, reason: errorName(error) || 'refused' };
      }
    },

    /**
     * Everything WebKit actually exposes about the live track.
     *
     * Reports three distinct things per capability: `supported` (advertised
     * and usable), `unsupported` (the browser reports capabilities but not
     * this one) and `not exposed` (no capability reporting at all). Conflating
     * the last two would invent support that was never claimed.
     */
    get capabilityReport() {
      const track = videoTrack;
      if (!track || typeof track.getCapabilities !== 'function') {
        return { available: false, fields: {}, settings: {} };
      }

      let capabilities = null;
      let currentSettings = {};
      try {
        capabilities = track.getCapabilities();
      } catch {
        return { available: false, fields: {}, settings: {} };
      }
      try {
        currentSettings = typeof track.getSettings === 'function' ? track.getSettings() : {};
      } catch {
        currentSettings = {};
      }

      const names = [
        'zoom', 'torch', 'focusMode', 'focusDistance', 'exposureMode',
        'exposureCompensation', 'exposureTime', 'iso', 'whiteBalanceMode',
        'frameRate', 'width', 'height'
      ];
      const fields = {};
      for (const name of names) {
        const value = capabilities ? capabilities[name] : undefined;
        if (value === undefined) {
          fields[name] = { state: 'not exposed' };
        } else if (Array.isArray(value)) {
          fields[name] = value.length
            ? { state: 'supported', options: value }
            : { state: 'unsupported' };
        } else if (value && typeof value === 'object') {
          fields[name] = { state: 'supported', min: value.min, max: value.max, step: value.step };
        } else {
          fields[name] = { state: 'supported', value };
        }
      }
      return { available: true, fields, settings: currentSettings };
    },

    /**
     * Try a series of frame rates and report what each one really did.
     *
     * Runs on the LIVE track via applyConstraints — it never calls
     * getUserMedia, so it cannot re-prompt for permission or drop the stream,
     * and the preview keeps running throughout. Each rate is measured by
     * counting presented frames rather than trusting the track's claim, and
     * the original setting is restored at the end.
     *
     * Verdicts:
     *   accepted   - measured within 15% of the request
     *   negotiated - the browser settled on a materially different rate
     *   unstable   - reported and measured disagree by more than 25%
     *   unsupported- the constraint was refused outright
     */
    async benchmarkFrameRates(rates, sampleMs, onProgress) {
      const list = Array.isArray(rates) && rates.length ? rates : [30, 60, 120, 240];
      const perRate = Math.max(400, Number(sampleMs) || 1200);
      const previous = requestedFrameRate;
      const results = [];

      if (!videoTrack || typeof videoTrack.applyConstraints !== 'function') {
        return { supported: false, reason: 'No live track to benchmark.', results };
      }
      if (typeof video.requestVideoFrameCallback !== 'function') {
        return {
          supported: false,
          reason: 'requestVideoFrameCallback is unavailable, so delivered frames cannot be counted honestly.',
          results
        };
      }

      for (const rate of list) {
        if (typeof onProgress === 'function') {
          try {
            onProgress({ rate, phase: 'testing' });
          } catch {
            // Progress reporting must not abort the benchmark.
          }
        }

        const applied = await this.setFrameRate(rate);
        const measured = await measureDelivery(perRate);
        const reported = negotiatedFrameRate;

        let verdict;
        if (!applied.applied) {
          verdict = 'unsupported';
        } else if (!measured.measurable || measured.unique === 0) {
          // No frames were counted. That says nothing about the camera, which
          // may be running perfectly — it says the measurement failed. Calling
          // it "unstable" would be a claim about the device that the data does
          // not support.
          verdict = 'not measured';
        } else if (measured.fps <= 0) {
          verdict = 'unstable';
        } else if (Math.abs(measured.fps - rate) / rate <= 0.15) {
          verdict = 'accepted';
        } else if (reported > 0 && Math.abs(measured.fps - reported) / reported > 0.25) {
          verdict = 'unstable';
        } else {
          verdict = 'negotiated';
        }

        results.push({
          requested: rate,
          reported,
          measuredFps: Math.round(measured.fps * 10) / 10,
          uniqueFrames: measured.unique,
          repeatedFrames: measured.repeated,
          verdict,
          reason: applied.applied
            ? (verdict === 'not measured' ? 'no presented frames were counted' : '')
            : applied.reason || ''
        });
      }

      await this.setFrameRate(previous);
      return { supported: true, results };
    },

    /**
     * Video inputs as WebKit reports them.
     *
     * Labels stay hidden until camera permission has been granted, so an empty
     * or unlabelled list before a grant says nothing about what the device has.
     * This is how we find out whether the ultrawide is separately selectable —
     * which is the only route to a genuine 0.5x, since a digital crop cannot
     * widen the field of view.
     */
    async videoInputs() {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
        return { available: false, devices: [] };
      }
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return {
          available: true,
          devices: devices
            .filter((device) => device.kind === 'videoinput')
            .map((device) => ({
              deviceId: device.deviceId,
              label: device.label || '',
              groupId: device.groupId || ''
            }))
        };
      } catch {
        return { available: false, devices: [] };
      }
    },

    get frameRateInfo() {
      return {
        requested: requestedFrameRate,
        reported: negotiatedFrameRate,
        capability: frameRateCapability
      };
    },

    get attempts() {
      return readAttemptLog();
    },
    async permissionState() {
      try {
        if (!navigator.permissions || typeof navigator.permissions.query !== 'function') {
          return 'Permissions API not exposed';
        }
        const status = await navigator.permissions.query({ name: 'camera' });
        return status.state;
      } catch (error) {
        // WebKit throws for unsupported permission names rather than
        // returning anything, so this is expected on some iOS versions.
        return `not queryable (${errorName(error) || 'error'})`;
      }
    },
    clearAttempts() {
      writeAttemptLog([]);
    },
    subscribe(listener) {
      listeners.add(listener);
      try {
        listener(snapshot());
      } catch {
        // See emit().
      }
      return () => listeners.delete(listener);
    },
    get state() {
      return state;
    },
    get active() {
      const track = stream && stream.getVideoTracks()[0];
      return state === 'live' && Boolean(track) && track.readyState === 'live' && !track.muted;
    },
    get ready() {
      return this.active;
    },
    get currentFacing() {
      return facing;
    },
    get sourceKind() {
      return this.active ? 'live' : 'none';
    },
    get zoom() {
      return snapshot().zoom;
    },
    get diagnostics() {
      const track = stream ? stream.getVideoTracks()[0] || null : null;
      let settings = {};
      try {
        settings = track && typeof track.getSettings === 'function' ? track.getSettings() : {};
      } catch {
        settings = {};
      }

      return {
        state,
        stage,
        reason,
        sourceKind: this.active ? 'live' : 'none',
        facing,
        trackState: track ? track.readyState : 'none',
        trackMuted: track ? Boolean(track.muted) : false,
        trackEnabled: track ? Boolean(track.enabled) : false,
        trackLabel: track && track.label ? track.label : '',
        capabilityWidth: resolutionCapability ? resolutionCapability.width : 0,
        capabilityHeight: resolutionCapability ? resolutionCapability.height : 0,
        settingsWidth: Number(settings.width) || 0,
        settingsHeight: Number(settings.height) || 0,
        settingsFrameRate: Number(settings.frameRate) || 0,
        videoWidth: video.videoWidth || 0,
        videoHeight: video.videoHeight || 0,
        readyState: video.readyState,
        paused: video.paused,
        currentTime: video.currentTime,
        frameEvidence,
        firstFrameMs,
        firstFrameVia,
        startedAt,
        lastErrorName,
        lastErrorMessage,
        standalone: isStandaloneDisplay(),
        deliveryActive: Boolean(deliveryListener),
        deliverySubscribed: Boolean(persistentDeliveryListener),
        deliveredUnique: delivery.unique,
        deliveredRepeated: delivery.repeated,
        captureFailures,
        lastCaptureError,
        zoomKind,
        zoomValue,
        zoomMin,
        zoomMax
      };
    }
  };

  prepareVideo();
  window.VisualCamera = VisualCamera;
})();
