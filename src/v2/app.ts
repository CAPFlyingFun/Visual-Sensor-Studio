/**
 * V2 entry — Milestone A: the trustworthy camera shell.
 *
 * Scope, per docs/V2-FABLE-HANDOFF.md and the V2 design spec's migration
 * order: `?scene=v2` routing, the experimental badge, camera
 * start/resume/switch/zoom through the EXISTING engine, the negotiated source
 * size, measured delivered FPS, a sticky viewfinder over normally-scrolling
 * controls, and an RGB preview. Nothing else — filters, geometry authority,
 * capture and recording arrive in later milestones on top of this shell.
 *
 * Camera acquisition is not owned here. public/camera-bootstrap.js owns the
 * <video>, every getUserMedia call and the whole lifecycle, exactly as it does
 * for the legacy app; this module talks to it through CameraController and
 * never touches getUserMedia — a V2 non-negotiable inherited from real iPhone
 * failures.
 */

import {
  CameraController, describeCameraError, type CameraStatus
} from '../sensors/camera.js';
import { FrameRateMeter } from '../vision/frame-rate.js';
import { zoomPresetStops } from '../sensors/zoom.js';
import { NAV_ROUTES } from './routes.js';
import { readState, subscribe, updateState, frameSize } from './state.js';
import { resolveGeometry, DEFAULT_GEOMETRY_INPUTS } from './camera/geometry.js';
import { captureAtMaxStream, type Escalation, type ShutterStream } from './capture/shutter.js';
import { ClipRecorder, type ClipResult } from './capture/record.js';
import { ENCODER_PROBE_LADDER, runEncoderProbe } from './capture/encoder-probe.js';
import {
  envelopeFromMeasurement, measurementFromRows, type EnvelopeMeasurement
} from './capture/encoder-envelope.js';
import { STREAM_TIERS, tierAvailable, tierById } from './camera/stream-tiers.js';
import { FILTERS, filterById } from './filters/registry.js';
import { GlRenderer } from './render/gl-renderer.js';
import { capturePhoto } from './capture/photo.js';

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`V2 markup is missing #${id}`);
  return element as T;
}

function setText(id: string, value: string): void {
  byId(id).textContent = value;
}

const video = byId<HTMLVideoElement>('cameraVideo');
const camera = new CameraController(video);
const meter = new FrameRateMeter();
const renderer = new GlRenderer(byId<HTMLCanvasElement>('v2PreviewCanvas'));
if (renderer.unavailableReason) setText('v2Stage', renderer.unavailableReason);

/* --- Geometry: resolved by the one authority, stored in the one state ----- */

/**
 * The VIEWFINDER's rectangle in device pixels — display geometry, measured
 * from layout, and the only layout read in V2 (docs/camera_rule.md). It feeds
 * PREVIEW only; the authority is what guarantees it can never touch PHOTO.
 */
function measureViewfinder(): { width: number; height: number; shortSide: number } {
  const box = byId('v2Viewfinder').getBoundingClientRect();
  const ratio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 4);
  const width = Math.round(box.width * ratio);
  const height = Math.round(box.height * ratio);
  return { width, height, shortSide: Math.min(width, height) };
}

function refreshGeometry(): void {
  const viewfinder = measureViewfinder();
  const { source } = readState();
  updateState({
    viewfinder: { width: viewfinder.width, height: viewfinder.height },
    geometry: source
      ? resolveGeometry(source, {
        ...DEFAULT_GEOMETRY_INPUTS,
        previewBoxShortSide: viewfinder.shortSide,
        // The chosen tier is the eyes-open trade; its record policy rides
        // along rather than a second opinion being formed here.
        recordPolicy: tierById(readState().streamTier)?.recordPolicy ?? 'source',
        // ENCODER CAPABILITY is the last bound on RECORD IN — measured by the
        // probe or assumed at the Level 5.2 line, and always with its reason.
        encoderMacroblocks: {
          limit: readState().encoderEnvelope.maxMacroblocks,
          reason: readState().encoderEnvelope.reason
        }
      })
      : null
  });
}
window.addEventListener('resize', refreshGeometry);

/* --- ENCODER CAPABILITY: assumed until this device's probe measures it ----- */

const ENVELOPE_STORE_KEY = 'vss.v2.encoderEnvelope.v1';

function storedEnvelopeMeasurement(): EnvelopeMeasurement | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ENVELOPE_STORE_KEY) ?? 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const { largestDecoded, smallestFailed } = parsed as Record<string, unknown>;
    if (typeof largestDecoded !== 'number' || typeof smallestFailed !== 'number') return null;
    return { largestDecoded, smallestFailed };
  } catch {
    return null;
  }
}

function rememberEnvelopeMeasurement(measurement: EnvelopeMeasurement): void {
  try {
    localStorage.setItem(ENVELOPE_STORE_KEY, JSON.stringify(measurement));
  } catch {
    // Storage is optional; the session keeps the measured envelope in state.
  }
}

// The stored measurement (a previous probe run on this device) outranks the
// assumption from the first frame, so RECORD IN never has to be corrected.
updateState({ encoderEnvelope: envelopeFromMeasurement(storedEnvelopeMeasurement()) });

/* --- The pipeline: one frame in, explicit products out -------------------- */

const previewMeter = new FrameRateMeter();

/**
 * True while a stopped recording is still finalising — the encoder draining
 * its backlog and writing the file's index. Declared up here because
 * renderPreview reads it every frame to stop feeding a draining encoder.
 */
let stoppingClip = false;
/** Frames handed to the encoder during the current clip — the FED rate. */
let framesFedThisClip = 0;
let clipStartedAt = 0;
/**
 * Fed frames bucketed per second of the clip. Measured 2026-09-01: a clip
 * whose strip read "30 fps" carried a 25 fps average — the difference was
 * ~1.3 s of stalls somewhere, and only a per-second series can say where
 * (a spin-up at the start reads differently from a dip every chunk).
 */
let fedPerSecond: number[] = [];

function renderPreview(now: number): void {
  const { source, geometry, activeFilter, recording } = readState();
  if (!source) return;
  // Resolve geometry HERE, for the frame being rendered — not by diffing
  // source at the delivery site. The status subscription can record the
  // negotiated size before the first frame arrives, and a "did it change?"
  // check there would then never fire at all (it didn't; measured).
  if (!geometry || geometry.source.width !== source.width || geometry.source.height !== source.height) {
    refreshGeometry();
  }
  const resolved = readState().geometry;
  if (!resolved) return;
  if (!renderer.uploadFrame(video)) return;
  // A filtered recording FREEZES the render target at the RECORD IN size the
  // encoder was promised — resizing a canvas mid-recording corrupts the clip.
  // The viewfinder shows this render scaled by CSS, so the preview stays
  // honest: what you see is what the file receives.
  //
  // While the encoder is DRAINING after stop, feeding it more frames only
  // deepens the backlog it is trying to flush — hold the last frame (and the
  // canvas size the encoder was promised) until finalisation completes.
  if (recording?.path === 'filtered' && stoppingClip) return;
  const target = recording?.path === 'filtered' ? recording.input : resolved.preview;
  // Stateful filters (Speed, Trails) advance their memory at the ANALYSIS
  // size — the same bounded size the frame history uses.
  if (renderer.render(activeFilter, target, resolved.analysis)) {
    if (recording?.path === 'filtered') {
      framesFedThisClip += 1;
      const second = Math.max(0, Math.floor((now - clipStartedAt) / 1000));
      fedPerSecond[second] = (fedPerSecond[second] ?? 0) + 1;
    }
    byId('v2PreviewCanvas').hidden = false;
    previewMeter.recordProcessed(now, 0);
    updateState({ previewFps: previewMeter.report.processingFps });
    // Temporal filters compare against the PREVIOUS frame: store this one as
    // next frame's history, bounded at the ANALYSIS geometry — the honesty
    // rule for temporal history, and the memory envelope's requirement alike.
    if (filterById(activeFilter)?.temporal) {
      renderer.snapshotHistory({
        width: resolved.analysis.width,
        height: resolved.analysis.height
      });
    }
  }
}

/* --- Camera events flow INTO the state; the UI renders FROM it (Rule 7). -- */

/**
 * CAPABILITY has two honest sources, tried in order:
 *
 *   advertised  the track's own getCapabilities() numbers.
 *   measured    V2's scan — this WebKit build advertises nothing at all
 *               (measured on device, 2026-09-01: the retry read stayed null
 *               forever and the 4K grey-out never engaged), so once the
 *               camera is LIVE and advertises nothing, the shutter's own
 *               choreography runs with a no-op still: ask the live track for
 *               its maximum, confirm with a decoded frame, restore. The
 *               result is remembered per camera label, so each camera pays
 *               for its scan once per device — and switching front/rear
 *               scans the NEW camera instead of wearing the old answer.
 */
const CAPABILITY_STORE_KEY = 'vss.v2.measuredCapability.v1';

function storedCapabilities(): Record<string, { width: number; height: number }> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CAPABILITY_STORE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object'
      ? parsed as Record<string, { width: number; height: number }>
      : {};
  } catch {
    return {};
  }
}

function rememberMeasuredCapability(label: string, size: { width: number; height: number }): void {
  if (!label) return;
  try {
    const all = storedCapabilities();
    all[label] = size;
    localStorage.setItem(CAPABILITY_STORE_KEY, JSON.stringify(all));
  } catch {
    // Storage is optional; the session-scanned value in state still stands.
  }
}

let capabilityCameraLabel = '';
let scanningCapability = false;
const capabilityScanAttempted = new Set<string>();

function scheduleCapabilityScan(label: string): void {
  const { camera: status, captureActive, recording } = readState();
  if (scanningCapability || capabilityScanAttempted.has(label)) return;
  if (status?.state !== 'live' || captureActive || recording) return;
  capabilityScanAttempted.add(label);
  scanningCapability = true;
  // The scan IS a temporary maximum-stream window — the same busy state the
  // shutter holds, so nothing renegotiates underneath it.
  updateState({ captureActive: true });
  void (async () => {
    try {
      const outcome = await captureAtMaxStream(shutterStream(), async () => null, {
        // The scan needs the SIZE confirmed, not the exposure settled.
        exposureStableFrames: 1,
        exposureTimeoutMs: 1
      });
      const measured = frameSize(outcome.captureSource.width, outcome.captureSource.height);
      if (measured && outcome.escalation !== 'declined') {
        rememberMeasuredCapability(label, { width: measured.width, height: measured.height });
        updateState({ capability: measured, capabilitySource: 'measured' });
      }
    } finally {
      scanningCapability = false;
      updateState({ captureActive: false });
    }
  })();
}

/** Resolve CAPABILITY for the CURRENT camera — advertised, stored, or scan. */
function reconcileCapability(): void {
  const d = camera.diagnostics;
  const label = d.trackLabel || '';
  const switched = label !== capabilityCameraLabel;
  if (switched) capabilityCameraLabel = label;
  const advertised = frameSize(d.capabilityWidth, d.capabilityHeight);
  if (advertised) {
    updateState({ capability: advertised, capabilitySource: 'advertised' });
    return;
  }
  const stored = label ? storedCapabilities()[label] : undefined;
  const measured = stored ? frameSize(stored.width, stored.height) : null;
  if (measured) {
    if (switched || !readState().capability) {
      updateState({ capability: measured, capabilitySource: 'measured' });
    }
    return;
  }
  // A different camera must not wear the previous one's capability.
  if (switched && readState().capabilitySource !== null) {
    updateState({ capability: null, capabilitySource: null });
  }
  scheduleCapabilityScan(label);
}

/**
 * V2's LIVE-SOURCE policy is RESPONSIVE (docs/camera_rule.md): the engine's
 * default stream request stands, because the live stream is a performance
 * decision — on the reference device it negotiates ~720×960 at ~60 delivered
 * fps. A SOURCE smaller than CAPABILITY is a healthy state, not an error;
 * maximum resolution exists only inside the shutter's temporary window. The
 * negotiated size and measured rate below stay authoritative either way.
 */
camera.subscribe((status: CameraStatus) => {
  const d = camera.diagnostics;
  updateState({
    camera: status,
    zoom: status.zoom,
    source: frameSize(d.videoWidth, d.videoHeight)
  });
  reconcileCapability();
});

/**
 * Delivered FPS is measured from PRESENTED frames, not assumed from the
 * track's claim — the legacy app's hard-won distinction. Where
 * requestVideoFrameCallback is unavailable the readout says "unmeasured"
 * rather than showing the display's refresh rate as the camera's.
 */
let deliveryRunning = false;
function startDeliveryMeter(): void {
  if (deliveryRunning) return;
  deliveryRunning = camera.startFrameDelivery((frame) => {
    meter.recordDelivered(frame);
    const d = camera.diagnostics;
    updateState({
      deliveredFps: meter.report.deliveredFps,
      // The negotiated size can settle a beat after `live`; re-read it on
      // frames so SOURCE is the stream's own answer, not a stale one.
      source: frameSize(d.videoWidth, d.videoHeight)
    });
    // Capability rides on frames too: advertised numbers can arrive late,
    // and where none ever arrive the per-frame reconcile launches the scan.
    reconcileCapability();
    renderPreview(frame.now);
  });
}

/* --- Actions ------------------------------------------------------------- */

async function startCamera(): Promise<void> {
  setText('v2Stage', 'Requesting camera…');
  try {
    await camera.start();
    startDeliveryMeter();
  } catch (error) {
    setText('v2Stage', describeCameraError(error, isStandalone()));
  }
}

async function switchCamera(): Promise<void> {
  try {
    await camera.switchCamera();
  } catch (error) {
    setText('v2Stage', describeCameraError(error, isStandalone()));
  }
}

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

/* --- The stream tier: a deliberate trade, applied and then measured ------- */

/**
 * Ask the engine for the chosen tier — before start and, when live, on the
 * running track (WebKit granting a live raise is device-verified). What
 * actually arrives is read back from the stream per frame, never assumed;
 * a tier the camera declines simply shows its refusal in the SOURCE row.
 */
/**
 * A size presented the way the phone is currently held — the STREAM's
 * orientation, the one display-independent fact V2 has about "which way
 * round" (the display itself is read in exactly one place, measureViewfinder).
 * Capability arrives as the sensor reports it (4032×3024) while a portrait
 * stream stands 3024×4032 — the same pixels, and the toast read "tops out at
 * 4032×3024" on a portrait phone (Joshua, 2026-09-01). Every user-facing size
 * goes through here; the numbers never change, only which is printed first.
 * With no stream yet there is nothing honest to orient against, so the size
 * is shown as reported.
 */
function orientedToLayout(size: { width: number; height: number }): { width: number; height: number } {
  const { source } = readState();
  if (!source) return size;
  const portrait = source.height > source.width;
  return (size.height > size.width) === portrait ? size : { width: size.height, height: size.width };
}

function dims(size: { width: number; height: number }): string {
  const o = orientedToLayout(size);
  return `${o.width}×${o.height}`;
}

/** The advertised CAPABILITY's short side — null where the browser withholds it. */
function capabilityShortSide(): number | null {
  const cap = readState().capability;
  return cap ? Math.min(cap.width, cap.height) : null;
}

function applyStreamTier(id: string): void {
  const tier = tierById(id);
  if (!tier || readState().recording || readState().captureActive) return;
  if (!tierAvailable(tier, capabilityShortSide())) return;
  updateState({ streamTier: id });
  // The tier's record policy applies immediately, even if the camera later
  // declines the stream change itself.
  refreshGeometry();
  if (tier.shortSide === 'max') {
    camera.preferMaxCaptureSize();
    if (camera.active) void camera.applyMaxCaptureSize();
  } else {
    camera.setPreferredCaptureHeight(tier.shortSide);
    if (camera.active) void camera.setCaptureHeight(tier.shortSide);
  }
}

/** Transient explanation, self-dismissing — shown when a tap needs a why. */
let toastTimer = 0;
function showToast(message: string): void {
  const toast = byId('v2Toast');
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 5000);
}

function buildStreamTiers(): void {
  const holder = byId('v2StreamTiers');
  for (const tier of STREAM_TIERS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = tier.label;
    button.dataset.streamTier = tier.id;
    if (tier.id === readState().streamTier) button.classList.add('active');
    // An unavailable tier stays TAPPABLE — the tap answers with a toast
    // instead of applying (Joshua, 2026-09-01: no standing text under the
    // options; red is the state, the tap explains it for ~5 s).
    button.addEventListener('click', () => {
      if (!tierAvailable(tier, capabilityShortSide())) {
        const cap = readState().capability;
        showToast(`${tier.label} is not available — this camera's output tops out at `
          + `${cap ? dims(cap) : 'a smaller size'}. MAX is already its largest.`);
        return;
      }
      applyStreamTier(tier.id);
    });
    holder.appendChild(button);
  }
}

let renderedTierKey = '';
function renderStreamTiers(): void {
  const { streamTier, recording, captureActive } = readState();
  const busy = recording !== null || captureActive;
  const capShort = capabilityShortSide();
  const key = `${streamTier}|${busy}|${capShort ?? 'unknown'}`;
  if (key === renderedTierKey) return;
  renderedTierKey = key;
  // A class this camera cannot fill shows RED (Joshua, 2026-09-01) — the
  // color is the state, and the tap explains itself via toast, so the button
  // stays enabled and no standing text crowds the strip. Only properties
  // change here; the buttons themselves stay stable under fingers.
  for (const button of byId('v2StreamTiers').querySelectorAll<HTMLButtonElement>('[data-stream-tier]')) {
    const tier = tierById(button.dataset.streamTier ?? '');
    const available = tier !== null && tierAvailable(tier, capShort);
    button.classList.toggle('active', button.dataset.streamTier === streamTier);
    button.classList.toggle('unavailable', !available);
    // A tier change renegotiates the camera mode — it waits for the clip or
    // the shutter, exactly like the other mode-changing controls.
    button.disabled = busy;
  }
}

/* --- Zoom: presets derived from the engine's own reported range ---------- */

/**
 * REBUILD ONLY WHEN THE RANGE CHANGES; highlight in place otherwise.
 *
 * The root cause of dead controls on iOS (measured on device, DuckDuckGo/
 * WebKit): this used to replaceChildren() on EVERY state broadcast — twice
 * per camera frame, ~120 rebuilds a second — so the button under a finger
 * was routinely deleted between touchstart and the click it would have
 * produced. Interactive DOM must be stable while a finger may be on it;
 * only a genuinely new zoom range (a camera switch) may replace the buttons.
 */
let builtZoomRange = '';
function renderZoomStops(): void {
  const holder = byId('v2ZoomStops');
  const zoom = readState().zoom;
  const range = zoom && zoom.kind !== 'none' ? `${zoom.kind}:${zoom.min}:${zoom.max}` : 'none';
  if (range !== builtZoomRange) {
    builtZoomRange = range;
    holder.replaceChildren();
    if (zoom && zoom.kind !== 'none') {
      // zoomPresetStops is the legacy app's own arithmetic, reused rather
      // than re-derived (Rule 6): the stops come from the engine's range.
      for (const stop of zoomPresetStops(zoom.min, zoom.max)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = `${stop}×`;
        button.dataset.zoomStop = String(stop);
        button.addEventListener('click', () => { void camera.setZoom(stop); });
        holder.appendChild(button);
      }
    }
  }
  if (!zoom) return;
  // classList.toggle to an unchanged state mutates nothing.
  for (const button of holder.querySelectorAll<HTMLButtonElement>('[data-zoom-stop]')) {
    button.classList.toggle('active', Math.abs(Number(button.dataset.zoomStop) - zoom.value) < 0.05);
  }
}

/* --- Rendering: everything below reads the state, never the engine ------- */

function renderHud(): void {
  const { camera: status, source, deliveredFps, zoom, recording, capability } = readState();
  const live = status?.state === 'live';
  // While a clip runs, the viewfinder says what the FILE is receiving — in
  // the stream's own orientation — beside what a photo would be, because
  // on a device with an encoder ceiling those two numbers differ and the
  // difference should be visible while it is happening (Joshua, 2026-09-01).
  const recHud = byId('v2RecHud');
  if (recording) {
    recHud.hidden = false;
    // The rate shown is the CLIP AVERAGE of what reaches the encoder — the
    // number the file will carry — not the instantaneous render rate, which
    // read 30 on device while the file carried 25 (measured 2026-09-01).
    const elapsed = (performance.now() - clipStartedAt) / 1000;
    const feeding = recording.path === 'filtered'
      ? (elapsed >= 1 ? framesFedThisClip / elapsed : 0)
      : deliveredFps;
    const photo = capability ? dims(capability) : '';
    recHud.textContent = `🔴 Recording in ${recording.input.width}×${recording.input.height}`
      + (feeding > 0 ? ` · ${feeding.toFixed(0)} fps avg` : '')
      + (photo ? ` · Photo ${photo}` : '');
  } else {
    recHud.hidden = true;
  }
  byId('v2HudDot').dataset.state = status?.state ?? 'idle';
  setText('v2HudState', live ? 'LIVE' : (status?.state ?? 'idle').toUpperCase());
  setText('v2HudSource', source ? `${source.width}×${source.height}` : '—');
  // A rate is only a measurement while frames are arriving; a suspended
  // camera showing its last number would be a frozen claim, not a reading.
  setText('v2HudFps', live && deliveredFps > 0 ? `${deliveredFps.toFixed(1)} fps` : '— fps');
  setText('v2HudZoom', zoom && zoom.kind !== 'none'
    ? `${zoom.value.toFixed(1)}× ${zoom.kind}`
    : '—');
}

function renderDiagnostics(): void {
  const {
    camera: status, source, capability, deliveredFps,
    geometry, previewFps, viewfinder, lastPhoto, captureActive
  } = readState();
  const d = camera.diagnostics;
  const live = status?.state === 'live';
  // Each row is its own fact with its own policy label (docs/camera_rule.md).
  // SOURCE below CAPABILITY is the healthy responsive state, never flagged;
  // the maximum belongs to the shutter's window alone. Rates render only
  // while frames arrive — a suspended camera keeps no frozen numbers.
  setText('v2DiagSource', source
    ? `${source.width}×${source.height} · ${live && deliveredFps > 0 ? deliveredFps.toFixed(1) : '—'} delivered fps · `
      + (captureActive
        ? scanningCapability
          ? 'measuring this camera\'s maximum'
          : 'maximum stream for this shot'
        : tierById(readState().streamTier)?.streamLabel ?? 'live stream')
    : 'not started');
  setText('v2DiagCapability', capability
    ? `${dims(capability)} · ${readState().capabilitySource === 'measured'
      ? 'measured maximum — scanned on this camera'
      : 'the track\'s advertised maximum'}`
      + (dims(capability) !== `${capability.width}×${capability.height}`
        ? ` (reported ${capability.width}×${capability.height})` : '')
    : scanningCapability
      ? 'measuring — asking this camera for its maximum…'
      : 'not exposed by this browser');
  setText('v2DiagViewfinder', viewfinder
    ? `${viewfinder.width}×${viewfinder.height} device px · display geometry, PREVIEW’s only input`
    : '—');
  const row = (entry: { width: number; height: number } | null | undefined) =>
    entry ? `${entry.width}×${entry.height}` : '—';
  setText('v2DiagAnalysis', geometry
    ? `${row(geometry.analysis)} · ${filterById(readState().activeFilter)?.temporal
      ? 'holding frame history for the active filter'
      : 'independent vision buffer (idle)'}`
    : '—');
  setText('v2DiagPreview', geometry
    ? `${row(geometry.preview)} · ${live && previewFps > 0 ? previewFps.toFixed(1) : '—'} rendered fps · sized for the viewfinder`
    : '—');
  setText('v2DiagPhotoPolicy', 'maximum available stream on shutter');
  setText('v2DiagLastPhoto', lastPhoto
    ? `${lastPhoto.width}×${lastPhoto.height} · ${(lastPhoto.bytes / 1e6).toFixed(2)} MB JPEG · as saved`
    : 'none yet');
  const { activeFilter, recording, lastClip, encoderEnvelope } = readState();
  // When the record policy binds, its REASON belongs on screen before the
  // button is pressed — a 12 MP view with a 1080 file must never read as a
  // silent shortfall (it read exactly that way on device, twice).
  const recordCapped = geometry !== null
    && Math.min(geometry.recordInput.width, geometry.recordInput.height)
      < Math.min(geometry.source.width, geometry.source.height);
  // RGB borrows the stream directly ONLY when the encoder can take the
  // stream as it is; above the envelope even RGB goes through the render,
  // because that is the only way to hand the encoder a frame it can write.
  const path = recording
    ? recording.path === 'native' ? 'camera stream direct' : `${activeFilter === 'rgb' ? 'RGB' : 'filtered'} render`
    : activeFilter !== 'rgb'
      ? 'filtered render'
      : recordCapped ? 'RGB render — the stream exceeds the encoder envelope' : 'camera stream direct';
  setText('v2DiagEncoder',
    `${encoderEnvelope.maxMacroblocks.toLocaleString('en-US')} macroblocks max frame · `
    + `${encoderEnvelope.measured ? 'MEASURED' : 'assumed'} · ${encoderEnvelope.reason}`);
  setText('v2DiagRecordIn', recording
    ? `${recording.input.width}×${recording.input.height} · RECORDING · ${path}`
    : geometry
      ? `${row(geometry.recordInput)} · ${path} on record`
        + (recordCapped ? ` · ${geometry.recordInput.reason}` : '')
      : '—');
  setText('v2DiagEncoded', lastClip
    ? lastClip.width > 0
      ? `${lastClip.width}×${lastClip.height} · ${lastClip.measuredMbps.toFixed(1)} Mb/s measured · `
        + `${lastClip.mimeType || 'container unreported'}${lastClip.resizedFromInput ? ' · ENCODER RESIZED' : ''}`
        + ` · ${lastClip.chunkCount} chunk${lastClip.chunkCount === 1 ? '' : 's'}`
        + (lastClip.encodedFps !== null
          ? ` · ${lastClip.encodedFps.toFixed(1)} fps in the file (fed ${lastClip.fedFps.toFixed(1)})`
          : '')
      : `truncated file — did not decode · ${lastClip.mimeType || 'container unreported'}`
        + ` · delivered as ${lastClip.chunkCount} chunk${lastClip.chunkCount === 1 ? '' : 's'}`
    : 'none yet');
  setText('v2DiagState', status ? `${status.state} · ${status.stage}` : 'idle');
  setText('v2DiagTrack', d.trackLabel
    ? `${d.trackLabel}${d.trackMuted ? ' · muted' : ''}`
    : '—');
}

/**
 * Controls change on TRANSITIONS, not on frames: this runs on every state
 * broadcast but touches the DOM only when one of its actual inputs changed,
 * so buttons stay byte-stable under a finger through the 60 fps live loop.
 */
let renderedControlsKey = '';
function renderControls(): void {
  const { camera: status, captureActive, recording, activeFilter } = readState();
  const state = status?.state ?? 'idle';
  const rec = recording !== null;
  // Capability comes from the filter's own metadata (Rule 10) — no second
  // allow/deny list anywhere.
  const filter = filterById(activeFilter);
  const photoCapable = filter?.supportsPhoto ?? true;
  const videoCapable = filter?.supportsVideo ?? true;
  const key = `${state}|${status?.stage ?? ''}|${status?.reason ?? ''}|${captureActive}|${rec}|`
    + `${photoCapable}|${videoCapable}|${renderer.unavailableReason}`;
  if (key === renderedControlsKey) return;
  renderedControlsKey = key;
  const enable = byId<HTMLButtonElement>('v2EnableCamera');
  enable.hidden = state === 'live' || state === 'requesting';
  enable.textContent = state === 'suspended' ? 'Resume Camera' : 'Enable Camera';
  // A camera switch or a shutter's mode change would resize the stream the
  // encoder was promised, so both wait until the recording stops.
  byId<HTMLButtonElement>('v2SwitchCamera').disabled = state !== 'live' || captureActive || rec;
  byId<HTMLButtonElement>('v2PhotoButton').disabled =
    state !== 'live' || captureActive || rec || !photoCapable || Boolean(renderer.unavailableReason);
  const record = byId<HTMLButtonElement>('v2RecordButton');
  record.disabled = state !== 'live' || captureActive || (!rec && !videoCapable);
  record.classList.toggle('recording', rec);
  record.title = rec ? 'Stop recording' : 'Record';
  if (status && state === 'error') setText('v2Stage', status.reason || 'Camera error.');
  // Empty when healthy; a shader compile/link failure surfaces here instead
  // of leaving a black canvas with no explanation.
  else if (state === 'live') setText('v2Stage', renderer.unavailableReason);
  else if (state === 'suspended') {
    setText('v2Stage', 'The camera was released (backgrounding or a system takeover). Resuming needs a tap.');
  }
}

/* --- The filter strip, built from FILTERS (Rules 4 and 5) ----------------- */

function buildFilterStrip(): void {
  const strip = byId('v2FilterStrip');
  for (const filter of FILTERS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'filter';
    button.dataset.filter = filter.id;
    // The strip is built after the first state broadcast, so it carries the
    // current selection itself rather than waiting for the next change.
    if (filter.id === readState().activeFilter) button.classList.add('active');
    const thumb = document.createElement('div');
    thumb.className = `thumb thumb-${filter.id}`;
    const label = document.createElement('small');
    label.textContent = filter.name;
    button.append(thumb, label);
    button.addEventListener('click', () => {
      updateState({ activeFilter: filter.id });
      renderPreview(performance.now());
    });
    strip.appendChild(button);
  }
}

let renderedFilterKey = '';
function renderFilterStrip(): void {
  const { activeFilter, recording, geometry, streamTier } = readState();
  const rec = recording !== null;
  // Recording risk and caps surface HERE, next to the choice that triggers
  // them — before the shutter, never as an explanation after the file. A
  // numeric policy shows its cap; the MAX tier shows its measured warning.
  const cap = geometry !== null
    && Math.min(geometry.recordInput.width, geometry.recordInput.height)
      < Math.min(geometry.source.width, geometry.source.height)
    ? `${geometry.recordInput.width}×${geometry.recordInput.height}`
    : '';
  const warning = !cap && activeFilter !== 'rgb'
    ? tierById(streamTier)?.clipWarning ?? ''
    : '';
  const key = `${activeFilter}|${rec}|${cap}|${warning}`;
  if (key === renderedFilterKey) return;
  renderedFilterKey = key;
  for (const button of byId('v2FilterStrip').querySelectorAll<HTMLButtonElement>('[data-filter]')) {
    button.classList.toggle('active', button.dataset.filter === activeFilter);
    // Switching filters mid-clip would change the recording path or shader
    // under the encoder; the strip waits for stop, honestly disabled.
    button.disabled = rec;
  }
  const FILTER_NOTES: Record<string, string> = {
    ironbow: 'False colour: visible-light brightness through the Ironbow ramp — not thermal.',
    difference: 'Change between frames through the ramp — history held at ANALYSIS resolution. '
      + 'Video is this filter’s product; stills are declined rather than upscaled.',
    speed: 'Motion along the brightness gradient (normal flow), smoothed over frames — '
      + 'texels per frame at ANALYSIS resolution, not a velocity. Stills are declined.',
    trails: 'Motion that fades over about half a second — the trail lives at ANALYSIS '
      + 'resolution. Stills are declined.'
  };
  // RECORD IN below SOURCE now has one cause on every path, RGB included:
  // the encoder's frame limit (measured 2026-09-01) — so the note names it
  // for every filter, and photos are exempt because JPEG has no such level.
  const capNote = cap
    ? `Clips at this stream size record at ${cap} — held under the encoder's frame limit `
      + '(RECORD IN names why). Photos stay at the full sensor.'
    : '';
  setText('v2FilterNote', rec
    ? 'Recording — stop to change filters.'
    : `${FILTER_NOTES[activeFilter] ?? ''} ${capNote || warning}`.trim());
}

/**
 * One subscriber, two speeds — and it lives BELOW every renderer it calls,
 * because subscribe() invokes the listener synchronously and a `let` above
 * would still be in its temporal dead zone (measured: it took the whole
 * module down at boot).
 *
 * Structural/control renderers run on every broadcast but are internally
 * gated on their real inputs, so they no-op through the frame loop. The
 * human-readable text panels are throttled: nobody can read 120 rewrites a
 * second, and — the measured iOS failure this fixes — that much DOM churn
 * under a live stream left every control effectively dead to touch. A
 * trailing render always catches the final state.
 */
const TEXT_RENDER_INTERVAL_MS = 250;
let lastTextRender = -Infinity;
let queuedTextRender = 0;

function renderTextPanels(): void {
  renderHud();
  renderDiagnostics();
}

subscribe(() => {
  renderControls();
  renderZoomStops();
  renderFilterStrip();
  renderStreamTiers();
  const now = performance.now();
  if (now - lastTextRender >= TEXT_RENDER_INTERVAL_MS) {
    lastTextRender = now;
    renderTextPanels();
  } else if (!queuedTextRender) {
    queuedTextRender = window.setTimeout(() => {
      queuedTextRender = 0;
      lastTextRender = performance.now();
      renderTextPanels();
    }, TEXT_RENDER_INTERVAL_MS - (now - lastTextRender));
  }
});

/* --- Photo: the shutter's temporary maximum-stream window ----------------- */

/**
 * The EXISTING track and the EXISTING renderer, adapted for the shutter
 * choreography. No second getUserMedia anywhere near this: requestMax and
 * restore both re-constrain the one live track through the engine, and
 * nextFrame proves changes with decoded frames rather than trusting a
 * constraint promise.
 */
/** Tiny reusable frame for exposure sampling — 48×64 is plenty for a mean. */
let lumaCanvas: HTMLCanvasElement | null = null;
function sampleStreamLuma(): number | null {
  if (video.videoWidth === 0) return null;
  lumaCanvas ??= document.createElement('canvas');
  lumaCanvas.width = 48;
  lumaCanvas.height = 64;
  const context = lumaCanvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  try {
    context.drawImage(video, 0, 0, 48, 64);
    const data = context.getImageData(0, 0, 48, 64).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
    return sum / ((data.length / 4) * 3 * 255);
  } catch {
    return null;
  }
}

function shutterStream(): ShutterStream {
  const withFrames = video as HTMLVideoElement & {
    requestVideoFrameCallback?: (callback: () => void) => number;
  };
  return {
    measure: () => ({ width: video.videoWidth, height: video.videoHeight }),
    sampleLuma: sampleStreamLuma,
    requestMax: async () => {
      try {
        return await camera.applyMaxCaptureSize();
      } catch {
        return { applied: false, reason: 'engine unavailable' };
      }
    },
    restore: async (shortSide: number) => {
      try {
        return await camera.setCaptureHeight(shortSide);
      } catch {
        return { applied: false, reason: 'engine unavailable' };
      }
    },
    nextFrame: (timeoutMs: number) => new Promise((resolve) => {
      let settled = false;
      const finish = (dims: { width: number; height: number } | null) => {
        if (!settled) {
          settled = true;
          resolve(dims);
        }
      };
      if (typeof withFrames.requestVideoFrameCallback === 'function') {
        withFrames.requestVideoFrameCallback(() =>
          finish({ width: video.videoWidth, height: video.videoHeight }));
      } else {
        // Honest fallback: a timer tick is not proof of a presented frame,
        // so it only samples the decoded size; the timeout stays the backstop.
        window.setTimeout(() =>
          finish({ width: video.videoWidth, height: video.videoHeight }), 120);
      }
      window.setTimeout(() => finish(null), timeoutMs);
    })
  };
}

/* --- Share: the iOS-native road to the camera roll ------------------------ */

/**
 * A browser download lands in the BROWSER'S sandbox (Files › browser ›
 * Downloads on iOS) and Photos never sees it — measured confusion on device.
 * The share sheet is the native road to "Save Image / Save Video", and it
 * must run inside a FRESH tap's activation — the capture's own tap has long
 * expired by the time the file exists — so each result holds its file and
 * offers a button. `onclick` assignment on purpose: a new result replaces
 * the old handler instead of stacking listeners.
 */
function offerShare(buttonId: string, file: File, reportTo?: string): void {
  const button = byId<HTMLButtonElement>(buttonId);
  const nav = navigator as Navigator & {
    canShare?: (data: { files: File[] }) => boolean;
    share?: (data: { files: File[] }) => Promise<void>;
  };
  if (typeof nav.share !== 'function' || nav.canShare?.({ files: [file] }) === false) {
    button.hidden = true;
    return;
  }
  button.hidden = false;
  button.onclick = () => {
    void nav.share?.({ files: [file] }).catch((error: unknown) => {
      // A dismissed sheet is a choice, not an error — WebKit reports that as
      // AbortError. Anything ELSE is the share itself refusing the file, and
      // that refusal is exactly the measurement a "didn't save" report
      // needs, so it goes on screen instead of vanishing.
      const name = error instanceof DOMException ? error.name : 'error';
      if (name === 'AbortError' || !reportTo) return;
      const message = error instanceof Error ? error.message : String(error);
      const target = byId(reportTo);
      const base = (target.textContent ?? '').split(' · SHARE FAILED')[0];
      setText(reportTo, `${base} · SHARE FAILED: ${name} — ${message}`);
    });
  };
}

/* --- Recording: two honest paths (docs/camera_rule.md, spec C) ------------ */

const clipRecorder = new ClipRecorder();

async function toggleRecording(): Promise<void> {
  const { camera: status, geometry, recording, activeFilter, deliveredFps } = readState();
  if (recording) {
    if (stoppingClip) return;
    stoppingClip = true;
    // Finalisation can take the encoder many seconds at very large frame
    // sizes — show the drain instead of looking hung, and count it up so a
    // slow finish and a dead one look different on screen.
    const finalizeStarted = performance.now();
    setText('v2RecordSummary', 'Finalizing — the encoder is draining and writing the file…');
    const ticker = window.setInterval(() => {
      setText('v2RecordSummary', 'Finalizing — the encoder is draining and writing the file… '
        + `${((performance.now() - finalizeStarted) / 1000).toFixed(0)}s`);
    }, 1000);
    let result: ClipResult | null = null;
    try {
      result = await clipRecorder.stop();
    } finally {
      window.clearInterval(ticker);
      stoppingClip = false;
    }
    // THREE rates, three facts (measured 2026-09-01: 30 fps viewfinder,
    // 17 fps file): what the camera delivered, what was FED to the encoder,
    // and what the encoder KEPT — the last counted from the file's own
    // sample tables, never inferred from the feed.
    const fedFps = result && result.seconds > 0
      ? (recording.path === 'filtered' ? framesFedThisClip / result.seconds : readState().deliveredFps)
      : 0;
    framesFedThisClip = 0;
    const fileFps = result && result.encodedFrames !== null
      ? result.encodedFrames / (result.encodedSeconds ?? result.seconds)
      : null;
    updateState({
      recording: null,
      lastClip: result
        ? {
          seconds: result.seconds,
          width: result.encodedWidth,
          height: result.encodedHeight,
          bytes: result.bytes,
          measuredMbps: result.measuredBitsPerSecond / 1e6,
          mimeType: result.mimeType,
          resizedFromInput: result.encodedWidth !== recording.input.width
            || result.encodedHeight !== recording.input.height,
          chunkCount: result.chunkCount,
          encodedFrames: result.encodedFrames,
          encodedFps: fileFps,
          fedFps
        }
        : readState().lastClip
    });
    // 0×0 from the decoder means the container never finalised — bytes exist
    // but the index does not, the signature of a process killed mid-encode.
    // Say that, instead of printing 0×0 as if it were a resolution.
    const dimsText = result && result.encodedWidth > 0
      ? `${result.encodedWidth}×${result.encodedHeight} measured in the file`
      : result?.encoderDied
        ? 'file DID NOT DECODE — the encoder died mid-clip, no index was ever written'
        : result?.finalizeTimedOut
          ? 'file DID NOT DECODE — the encoder never finished finalising (60s guard fired)'
          : 'file DID NOT DECODE — truncated container, likely killed mid-encode';
    const finalizeText = result
      ? (result.finalizeTimedOut
        ? 'finalise GAVE UP at 60s'
        : `finalised in ${(result.finalizeMs / 1000).toFixed(1)}s`)
        + (result.encoderDied ? ` · ENCODER DIED: ${result.encoderDied}` : '')
      : '';
    // The per-second feed series: where the stalls were. Whole seconds only
    // — the partial last bucket would read as a dip that never happened.
    const wholeSeconds = result ? Math.floor(result.seconds) : 0;
    const series = fedPerSecond.slice(0, wholeSeconds).map((count) => count ?? 0);
    const seriesText = series.length > 0
      ? ` · fed per second: ${series.slice(0, 12).join(' ')}${series.length > 12 ? ' …' : ''}`
        + ` (min ${Math.min(...series)})`
      : '';
    fedPerSecond = [];
    const rateText = result
      ? ` · fed ${fedFps.toFixed(1)} fps → file `
        + (fileFps !== null
          ? `${fileFps.toFixed(1)} fps (${result.encodedFrames} frames)`
            + (fedFps > 0 && fileFps < fedFps * 0.85 ? ' · ENCODER DROPPED FRAMES' : '')
          : 'frame count unreadable in this container')
        + seriesText
      : '';
    // The 1 s timeslice is a REQUEST. Whether this browser actually delivered
    // chunks is the fact that decides if a killed encoder loses a second or
    // the whole clip — measure and print it instead of assuming it.
    const chunkText = result
      ? result.chunkCount <= 1 && result.seconds >= 2.5
        ? '1 chunk — this browser held the whole clip to the end (timeslice not honored)'
        : `${result.chunkCount} chunk${result.chunkCount === 1 ? '' : 's'}`
      : '';
    // Main screen: the result. More: every measurement behind it.
    setText('v2RecordSummary', result
      ? result.encodedWidth > 0
        ? `Saved ${result.seconds.toFixed(1)}s · ${result.encodedWidth}×${result.encodedHeight}`
          + (fileFps !== null ? ` · ${fileFps.toFixed(0)} fps` : '')
          + ` · ${(result.bytes / 1e6).toFixed(1)} MB`
        : `Clip did not decode — see More for why`
      : 'The recording produced no data.');
    setText('v2RecordResult', result
      ? `Saved ${result.seconds.toFixed(1)}s · ${dimsText} · `
        + `${(result.bytes / 1e6).toFixed(2)} MB · ${(result.measuredBitsPerSecond / 1e6).toFixed(1)} Mb/s measured `
        + `(asked ${(result.requestedBitsPerSecond / 1e6).toFixed(1)}) · ${result.mimeType || 'container unreported'}`
        + ` · ${chunkText} · ${finalizeText}${rateText}`
      : 'The recording produced no data.');
    if (result) {
      offerShare('v2ShareClip',
        new File([result.blob], result.fileName, { type: result.mimeType || 'video/mp4' }),
        'v2RecordSummary');
    }
    return;
  }

  if (capturing || scanningCapability || !camera.active || status?.state !== 'live' || !geometry) return;
  const filtered = activeFilter !== 'rgb';
  // RGB borrows the camera stream directly — no render in the path, SOURCE
  // dimensions, zero cost — UNLESS the authority held RECORD IN under the
  // encoder envelope: then the stream itself is a frame the encoder cannot
  // write (measured: no H.264 file above Level 5.2 ever decoded here), and
  // the only honest road is the same render path a filter takes, at the
  // RECORD IN size, with the RECORD IN row naming why.
  const heldUnderEnvelope = geometry.recordInput.width !== geometry.source.width
    || geometry.recordInput.height !== geometry.source.height;
  const viaRender = filtered || heldUnderEnvelope;
  if (viaRender && renderer.unavailableReason) {
    setText('v2RecordSummary', renderer.unavailableReason);
    return;
  }
  const input = viaRender ? geometry.recordInput : geometry.source;
  let stream: MediaStream;
  if (viaRender) {
    // Size the canvas to RECORD IN before the encoder ever sees it; the
    // preview loop holds this target until stop.
    if (!renderer.uploadFrame(video) || !renderer.render(activeFilter, geometry.recordInput)) {
      setText('v2RecordSummary', 'No frame to start the recording from.');
      return;
    }
    stream = renderer.targetCanvas.captureStream();
  } else {
    const source = video.srcObject;
    if (!(source instanceof MediaStream)) {
      setText('v2RecordSummary', 'The camera stream is not available to record.');
      return;
    }
    stream = source;
  }
  const started = clipRecorder.start(stream, input, deliveredFps, activeFilter);
  if (!started.ok) {
    setText('v2RecordSummary', started.reason ?? 'The recorder refused to start.');
    return;
  }
  setText('v2RecordSummary', '');
  setText('v2RecordResult', '');
  framesFedThisClip = 0;
  fedPerSecond = [];
  clipStartedAt = performance.now();
  updateState({
    recording: {
      // 'filtered' here means "through the render" — RGB held under the
      // envelope takes that path too, and the RECORD IN row says so.
      path: viaRender ? 'filtered' : 'native',
      input: { width: input.width, height: input.height, aspect: input.aspect }
    }
  });
}

const CAPTURE_REASONS: Record<Escalation, string> = {
  granted: 'the largest stream the camera granted for this shot',
  unchanged: 'the camera kept its current mode',
  declined: 'the camera declined a larger mode'
};

let capturing = false;
async function takePhoto(): Promise<void> {
  const { camera: status, recording, activeFilter } = readState();
  // The shutter's temporary mode change would resize the stream a recording
  // is encoding; the button is disabled, and this guard backs it up. A
  // filter whose metadata declines stills (temporal history at analysis
  // resolution cannot honestly fill a 12 MP frame) is refused the same way.
  if (capturing || scanningCapability || recording || !camera.active || status?.state !== 'live') return;
  if (!(filterById(activeFilter)?.supportsPhoto ?? true)) return;
  capturing = true;
  // captureActive drives the button states through renderControls — one
  // direction of flow, no direct disabled-flag fiddling to fight it.
  updateState({ captureActive: true });
  byId('v2ShutterFlash').classList.add('firing');
  setText('v2PhotoResult', 'Capturing at the camera’s maximum…');
  setText('v2PhotoTiming', '');
  try {
    const outcome = await captureAtMaxStream(shutterStream(), async (dims, escalation) => {
      const source = frameSize(dims.width, dims.height);
      if (!source) return null;
      // The same authority, evaluated on the stream ACTUALLY delivering right
      // now — requested numbers never reach the render or the file name.
      const photo = resolveGeometry(source, DEFAULT_GEOMETRY_INPUTS).photo;
      return capturePhoto(renderer, video, readState().activeFilter, {
        ...photo,
        reason: CAPTURE_REASONS[escalation]
      });
    }, { now: () => performance.now() });
    if (outcome.still) {
      updateState({
        lastPhoto: {
          width: outcome.still.width,
          height: outcome.still.height,
          bytes: outcome.still.bytes
        }
      });
      offerShare('v2SharePhoto',
        new File([outcome.still.blob], outcome.still.fileName, { type: 'image/jpeg' }),
        'v2PhotoResult');
    }
    const restoreNote = outcome.restoration === 'refused' || outcome.restoration === 'unconfirmed'
      ? ` · live stream not confirmed back (${outcome.restoration})`
      : '';
    setText('v2PhotoResult', outcome.still
      ? `Saved ${outcome.still.width}×${outcome.still.height} · `
        + `${(outcome.still.bytes / 1e6).toFixed(2)} MB JPEG · ${outcome.still.reason}${restoreNote}`
      : 'The photo could not be rendered.');
    setText('v2PhotoTiming', shutterTimingReport(outcome));
  } finally {
    capturing = false;
    updateState({ captureActive: false });
    byId('v2ShutterFlash').classList.remove('firing');
  }
}

/**
 * The measured shutter timeline, in Joshua's requested shape — so "it seems
 * fast" becomes "switching took 146 ms, rendering 38, JPEG 91, restore 122".
 */
function shutterTimingReport(outcome: {
  still: { timing: { renderMs: number; encodeMs: number } } | null;
  escalation: string;
  restoration: string;
  timing: {
    maxFrameReadyMs: number; exposureSettledMs: number | null; stillDoneMs: number;
    restoreRequestedMs: number; liveRestoredMs: number | null; totalMs: number;
  };
}): string {
  const t = outcome.timing;
  const ms = (value: number) => `+${Math.round(value)} ms`;
  const lines = [
    'Shutter timing',
    'Max request 0 ms',
    `Max frame ready ${ms(t.maxFrameReadyMs)}`
  ];
  // Only a granted mode change resets auto-exposure, so only then is there
  // a convergence to wait for and report.
  if (outcome.escalation === 'granted') {
    lines.push(t.exposureSettledMs !== null
      ? `Exposure settled ${ms(t.exposureSettledMs)}`
      : 'Exposure settled — not confirmed (timeout)');
  }
  if (outcome.still) {
    const renderDone = t.stillDoneMs - outcome.still.timing.encodeMs;
    lines.push(`GPU render done ${ms(renderDone)}`);
    lines.push(`JPEG ready ${ms(t.stillDoneMs)}`);
  } else {
    lines.push(`Render failed ${ms(t.stillDoneMs)}`);
  }
  lines.push(`Restore requested ${ms(t.restoreRequestedMs)}`);
  if (t.liveRestoredMs !== null) {
    lines.push(`Live frame restored ${ms(t.liveRestoredMs)}`);
  } else if (outcome.restoration === 'not needed') {
    lines.push('Live stream unchanged — nothing to restore');
  } else {
    lines.push(`Live frame restored — not confirmed (${outcome.restoration})`);
  }
  lines.push(`Total ${Math.round(t.totalMs)} ms`);
  return lines.join('\n');
}

/* --- The dock, built from NAV_ROUTES (Rule 5) ---------------------------- */

function buildDock(): void {
  const dock = byId('v2Dock');
  for (const route of NAV_ROUTES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.route = route.id;
    if (route.id === activeRoute) button.classList.add('active');
    const icon = document.createElement('i');
    icon.textContent = route.icon;
    const label = document.createElement('span');
    label.textContent = route.label;
    button.append(icon, label);
    button.addEventListener('click', () => showRoute(route.id));
    dock.appendChild(button);
  }
}

let activeRoute = 'camera';

function showRoute(id: string): void {
  activeRoute = id;
  const route = NAV_ROUTES.find((r) => r.id === id);
  byId('v2CameraRoute').hidden = id !== 'camera';
  byId('v2MoreRoute').hidden = id !== 'more';
  const placeholder = byId('v2RoutePlaceholder');
  placeholder.hidden = route?.implemented ?? false;
  if (route && !route.implemented) {
    setText('v2PlaceholderTitle', route.label);
    setText('v2PlaceholderPlan', route.plan);
  }
  for (const button of byId('v2Dock').querySelectorAll<HTMLButtonElement>('[data-route]')) {
    button.classList.toggle('active', button.dataset.route === id);
  }
}

/* --- Wiring -------------------------------------------------------------- */

byId('v2EnableCamera').addEventListener('click', () => void startCamera());
byId('v2PhotoButton').addEventListener('click', () => void takePhoto());
byId('v2RecordButton').addEventListener('click', () => void toggleRecording());

/**
 * The encoder envelope probe: an instrument, not a feature. It runs the
 * same ClipRecorder the clips use against a synthetic canvas, so its verdict
 * is about the ENCODER alone — see capture/encoder-probe.ts for the two
 * hypotheses it is built to separate.
 */
let probing = false;
byId('v2EncoderProbe').addEventListener('click', () => {
  if (probing || readState().recording) return;
  probing = true;
  const button = byId<HTMLButtonElement>('v2EncoderProbe');
  const out = byId('v2EncoderProbeOut');
  button.disabled = true;
  out.hidden = false;
  out.textContent = `Encoder envelope probe — camera live: ${readState().camera?.state === 'live' ? 'yes' : 'no'} `
    + `· ${ENCODER_PROBE_LADDER.length} trials, ~30 s, nothing saved\n`;
  void runEncoderProbe(ENCODER_PROBE_LADDER, (_row, text) => {
    out.textContent += `${text}\n`;
  }).then((rows) => {
    const decoded = rows.filter((row) => row.decoded).length;
    // The probe's verdict becomes this device's ENCODER CAPABILITY: stored,
    // written into the state, and RECORD IN re-resolved under it now.
    const measurement = measurementFromRows(rows);
    rememberEnvelopeMeasurement(measurement);
    const envelope = envelopeFromMeasurement(measurement);
    updateState({ encoderEnvelope: envelope });
    refreshGeometry();
    out.textContent += `Done — ${decoded}/${rows.length} trials produced a decodable file.\n`
      + `ENCODER CAPABILITY set: ${envelope.maxMacroblocks.toLocaleString('en-US')} macroblocks max frame — `
      + `${envelope.reason}. RECORD IN now holds under it (see the truth table).`;
  }).catch((error: unknown) => {
    out.textContent += `Probe failed: ${error instanceof Error ? error.message : String(error)}`;
  }).finally(() => {
    probing = false;
    button.disabled = false;
  });
});
byId('v2SwitchCamera').addEventListener('click', () => void switchCamera());
byId('v2LegacyLink').addEventListener('click', () => {
  const back = new URL(location.href);
  back.searchParams.delete('scene');
  back.pathname = back.pathname.replace(/v2\.html$/, 'index.html');
  location.href = back.toString();
});

buildFilterStrip();
buildStreamTiers();
buildDock();
showRoute('camera');

// If the engine survived a reload already live (its whole reason to exist),
// pick its state up rather than showing an Enable button over a running feed.
if (camera.active) startDeliveryMeter();
updateState({
  camera: {
    state: camera.state,
    stage: camera.diagnostics.stage,
    reason: camera.diagnostics.reason,
    facing: camera.currentFacing,
    zoom: camera.zoom
  },
  zoom: camera.zoom,
  source: frameSize(camera.diagnostics.videoWidth, camera.diagnostics.videoHeight)
});
