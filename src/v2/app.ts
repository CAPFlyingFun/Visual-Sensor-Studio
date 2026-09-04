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
import {
  noControlsNote, offeredControls, verifyApply,
  type OfferedControl
} from './camera/controls.js';
import { registerServiceWorker } from './pwa.js';
import { APP_VERSION } from './version.js';
import {
  readState, subscribe, updateState, frameSize, type FrameSize, type V2State
} from './state.js';
import { MotionController } from '../sensors/motion.js';
import type { QuaternionLike } from '../core/math.js';
import {
  DEFAULT_NOISE_FLOOR_RADIANS, StackAligner, describeShift, nominalFocalPixels,
  rotationSince, type AlignedFrame
} from './vision/alignment.js';
import {
  DEFAULT_STEADY_THRESHOLD, HOLD_MS, SteadyShutter, describeSteadiness,
  rateFrom, readSteadiness, smoothRate, type SteadyReading
} from './vision/steadiness.js';
import {
  resolveGeometry, DEFAULT_GEOMETRY_INPUTS, type GeometryInputs
} from './camera/geometry.js';
import { captureAtMaxStream, type Escalation, type ShutterStream } from './capture/shutter.js';
import { ClipRecorder, type ClipResult } from './capture/record.js';
import { ENCODER_PROBE_LADDER, runEncoderProbe } from './capture/encoder-probe.js';
import {
  envelopeFromMeasurement, measurementFromRows, type EnvelopeMeasurement
} from './capture/encoder-envelope.js';
import { STREAM_TIERS, tierAvailable, tierById } from './camera/stream-tiers.js';
import {
  FILTERS, allFilters, canReverse, filterById, isReversed, setCustomFilters,
  setReversedFilters
} from './filters/registry.js';
import {
  compileLens, channelAvailability, lensFilterId, reverseStops, rgbToHsv
} from './filters/lens-shader.js';
import { STARTER_LENSES, SUPERSEDED_STARTERS } from './filters/starter-lenses.js';
import {
  CHANNELS, MAX_STOPS, MIN_STOPS, channelInfo, describeLens, normaliseBinding,
  rampToCss, toHex, type ChannelId, type CustomLens
} from '../vision/lens.js';
import {
  averageRgb, patchBoxPercent, patchRect, tapToSource,
  type Point, type SampledColor
} from './capture/color-sampler.js';
import { GUIDES, guideById } from './render/guides.js';
import {
  FRAME_AVERAGE_LEVELS, NOMINAL_FPS, conversionNote, frameAverageById, framesForLevel
} from './render/frame-average.js';
import {
  ZEBRA_LEVELS, PEAKING_LEVELS, peakingById, peakingThreshold, zebraById, zebraThreshold
} from './render/overlays.js';
import {
  EXPOSURE_BINS, buildExposure, describeExposure, emptyExposure, type ExposureReading
} from './vision/exposure.js';
import { buildHistogram, emptyHistogram } from './vision/frame-histogram.js';
import { matchShare } from './vision/colour-gap.js';
import { tipFor } from './ui/coach.js';
import { deleteLens, loadLenses, newLensId, sanitiseLens, saveLens } from '../vision/lens-store.js';
import { RAMP_PRESETS } from '../vision/lens-preview.js';
import { GlRenderer, type NightRecovery } from './render/gl-renderer.js';
import { capturePhoto } from './capture/photo.js';
import {
  NIGHT_COUNTDOWN_MS, NIGHT_TARGET_FRAMES, NIGHT_TARGET_MS, NIGHT_TICK_MS,
  describeNightCounters, emptyNightCounters, nightCountdownSecondsLeft,
  nightStackWeight, type NightCounters
} from './vision/night-stack.js';

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

/**
 * The inputs the geometry authority is asked with — ONE definition, so an
 * imported clip is measured by the same rules the camera is (Rule 6). It was
 * inline in refreshGeometry until the import needed to resolve rows for a
 * file rather than for the stream.
 */
function geometryInputs(): GeometryInputs {
  return {
    ...DEFAULT_GEOMETRY_INPUTS,
    previewBoxShortSide: measureViewfinder().shortSide,
    // The chosen tier is the eyes-open trade; its record policy rides
    // along rather than a second opinion being formed here.
    recordPolicy: tierById(readState().streamTier)?.recordPolicy ?? 'source',
    // ENCODER CAPABILITY is the last bound on RECORD IN — measured by the
    // probe or assumed at the Level 5.2 line, and always with its reason.
    //
    // NULL WHEN THE RECORDING IS FORCED TO MAX. Joshua, 2026-09-04: "don't
    // assume my phone can't as I am able to record at MAX at around 30fps."
    // A capability nobody measured on THIS install should not quietly take a
    // quarter of his frame, and the check is the only thing standing between
    // the chosen tier and the file. Skipping it is safe to offer because the
    // clip's real dimensions are decoded out of the finished file afterwards:
    // an encoder that cannot hold the frame reports "did not decode" rather
    // than being predicted away in advance.
    encoderMacroblocks: readState().forceMaxRecord ? null : {
      limit: readState().encoderEnvelope.maxMacroblocks,
      reason: readState().encoderEnvelope.reason
    }
  };
}

function refreshGeometry(): void {
  const viewfinder = measureViewfinder();
  const { source } = readState();
  updateState({
    viewfinder: { width: viewfinder.width, height: viewfinder.height },
    geometry: source ? resolveGeometry(source, geometryInputs()) : null
  });
}
window.addEventListener('resize', refreshGeometry);

/* --- ENCODER CAPABILITY: assumed until this device's probe measures it ----- */

const ENVELOPE_STORE_KEY = 'vss.v2.encoderEnvelope.v1';
const FORCE_MAX_STORE_KEY = 'vss.v2.forceMaxRecord.v1';

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

/**
 * The MAX-recording choice is remembered, because it is a preference about
 * this device rather than a per-session experiment: having decided his phone
 * records MAX, Joshua should not have to decide it again on every launch.
 * Read defensively — a missing or unreadable value is simply "off".
 */
function storedForceMaxRecord(): boolean {
  try {
    return localStorage.getItem(FORCE_MAX_STORE_KEY) === 'yes';
  } catch {
    return false;
  }
}
updateState({ forceMaxRecord: storedForceMaxRecord() });

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

/**
 * The frame's colour census, for lenses bound to rarity or to distance from
 * the background. Measured on a small sample every few frames: a scene's
 * prevailing colour does not change at thirty times a second, and a lens
 * that does not ask for it never pays for it.
 */
const HISTOGRAM_EVERY = 6;
const HISTOGRAM_SAMPLE = 64;
let histogram = emptyHistogram();
let histogramVersion = 0;
let framesSinceHistogram = 0;
let histogramCanvas: HTMLCanvasElement | null = null;
/**
 * How much of the frame the active lens is matching, 0..1, or null when the
 * question does not apply. This is the number that answers "is it working?" —
 * a Colour Splash pointed at a room with none of its colour in it renders a
 * correct grey picture, and only a measurement can tell that apart from a
 * broken lens.
 */
let matchingShare: number | null = null;
let exposure: ExposureReading = emptyExposure();

/**
 * ONE READ OF THE FRAME, several questions asked of it.
 *
 * Three censuses now want the same small sample — the colour histogram, the
 * exposure reading and a reference lens's match share — and each used to draw
 * and read the video itself. getImageData is the expensive half of that (it
 * stalls on the GPU), so doing it three times cost three stalls to answer
 * three questions about ONE frame. This takes the sample; the questions are
 * pure functions over it.
 */
function sampleFrame(): Uint8ClampedArray | null {
  if (video.videoWidth === 0) return null;
  histogramCanvas ??= document.createElement('canvas');
  histogramCanvas.width = HISTOGRAM_SAMPLE;
  histogramCanvas.height = HISTOGRAM_SAMPLE;
  const context = histogramCanvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  try {
    // Stretched to a square: every census counts SHARES, and a uniform
    // stretch leaves each pixel's weight — and so each share — unchanged.
    context.drawImage(video, 0, 0, HISTOGRAM_SAMPLE, HISTOGRAM_SAMPLE);
    return context.getImageData(0, 0, HISTOGRAM_SAMPLE, HISTOGRAM_SAMPLE).data;
  } catch {
    // A mid-switch video element can refuse a draw; the next pass recovers.
    return null;
  }
}

/**
 * Take the sample and answer whichever questions are being asked this frame.
 *
 * Each census is paid for only when something needs it: the colour histogram
 * when the active lens reads it, the match share when a reference lens is
 * running, exposure when an exposure instrument is on screen.
 */
function measureCensuses(
  needsColour: boolean, lens: CustomLens | null, needsRange = false
): void {
  const wantsExposure = readState().exposureShown || needsRange;
  if (!needsColour && !lens && !wantsExposure) {
    matchingShare = null;
    return;
  }
  const data = sampleFrame();
  if (!data) {
    if (lens) matchingShare = null;
    return;
  }
  if (needsColour) {
    histogram = buildHistogram(data);
    histogramVersion += 1;
  }
  if (wantsExposure) exposure = buildExposure(data);
  matchingShare = lens
    ? matchShare(data, rgbToHsv(lens.reference ?? '#ffffff'),
      (gap) => normaliseBinding(gap, lens.color))
    : null;
}

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
  // Night's finished stack stays exactly as renderNightResult() drew it —
  // "keep the result in the viewer after completion so I can inspect it"
  // (Joshua, 2026-09-03) — until the test is cleared. Same freeze shape as
  // the recording guard above, for the same reason: the ordinary per-frame
  // draw would otherwise overwrite it on the very next delivered frame.
  if (nightPhase === 'complete') return;
  // AN IMPORTED CLIP OWNS THE CANVAS WHILE IT PLAYS. There is one WebGL
  // context, one frame texture and one target canvas (Rule 4), so two
  // sources cannot draw at once — the camera would overwrite the clip's
  // frame and the clip the camera's, thirty times a second. The camera
  // stands down for the duration rather than a second renderer existing.
  if (importPlaying) return;
  const target = recording?.path === 'filtered' ? recording.input : resolved.preview;
  // A fresh census every few frames, for whoever is asking: a lens bound to
  // the whole frame's colours, a reference lens reporting its match share, or
  // the exposure instrument being open.
  //
  // THE EXPOSURE CLAUSE IS NOT OPTIONAL. Without it the census ran only while
  // a LENS was active, so the histogram was empty under RGB, Ironbow, Edges —
  // every ordinary filter — and drew a blank graph reading "mean 0%"
  // (Joshua's device, 2026-09-02).
  const active = filterById(activeFilter);
  const asking = active?.needsHistogram || active?.lens
    || active?.needsLumaRange || readState().exposureShown;
  if (asking && framesSinceHistogram++ % HISTOGRAM_EVERY === 0) {
    // A reference lens reports what it is currently catching. `active` may
    // be null here now, because the exposure instrument asks for a census on
    // its own account — it is about the CAMERA, not about the filter.
    const reference = active?.lens
      && channelInfo(active.lens.color.channel).needsReference ? active.lens : null;
    // Relief's contrast stretch needs the frame's luma range, which the
    // exposure census already measures on its way past.
    measureCensuses(active?.needsHistogram === true, reference,
      active?.needsLumaRange === true);
  }
  // Stateful filters (Speed, Trails) advance their memory at the ANALYSIS
  // size — the same bounded size the frame history uses.
  const frames = framesForLevel(readState().frameAverage, readState().deliveredFps);
  if (renderer.render(activeFilter, target, resolved.analysis, {
    fps: readState().deliveredFps,
    histogram: { bins: histogram.bins, dominant: histogram.dominant, version: histogramVersion },
    frames,
    // NIGHT. The average only removes noise while the scene stays put, so the
    // gyro puts each arriving frame back before it is blended — and says when
    // the view has moved on far enough that the accumulation should restart
    // rather than blend two different pictures.
    ...alignmentFor(frames, target),
    lumaRange: exposure.range,
    // VIEWING AIDS reach the preview and nothing else. The photo and clip
    // paths below pass none, so stripes can never be baked into a file.
    aids: {
      zebra: zebraThreshold(readState().zebra),
      peaking: peakingThreshold(readState().peaking)
    }
  })) {
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
    // TRUE only for a genuinely NEW decoded image. requestVideoFrameCallback
    // can fire at the display's rate rather than the camera's, so on a 60 Hz
    // screen showing a 30 fps stream about half of these callbacks carry the
    // frame already seen. The meter identifies them by mediaTime (and stops
    // trusting that signal if it ever proves static), so this is a reading,
    // not a guess.
    const freshFrame = meter.recordDelivered(frame);
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
    // On the DELIVERY loop, so an armed shutter only ever fires against a
    // picture the camera is really producing — never into a suspended stream
    // on a timer that kept running.
    updateSteadyShutter(frame.now);
    // Same delivery loop, same reasoning: Night's tick can only ever act on
    // a picture the camera is really producing right now.
    //
    // AND ONLY ON A NEW ONE. Night now takes every frame it is offered rather
    // than one every 250 ms, so a repeated callback would fold the SAME image
    // in a second time — which adds no light, yet advances 1/n and so dilutes
    // the frames that are real. It would inflate the count while making the
    // result worse. The 250 ms gate used to hide this; nothing hides it now.
    if (freshFrame) updateNightStack(frame.now);
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

/**
 * Installed app, or a browser tab? The camera's error advice differs — an iOS
 * standalone app has its own permission story — and so does what an update
 * means, which is why registerServiceWorker cares about resumes at all.
 */
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

/* --- Viewfinder guides: composition only, never a capture decision ------- */

const GUIDE_STORE_KEY = 'vss.v2.guide.v1';
const RETICLE_STORE_KEY = 'vss.v2.reticle.v1';
const FRAME_AVERAGE_STORE_KEY = 'vss.v2.frameAverage.v1';
const ZEBRA_STORE_KEY = 'vss.v2.zebra.v1';
const PEAKING_STORE_KEY = 'vss.v2.peaking.v1';

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage is optional; the choice still stands for this session.
  }
}

function buildGuides(): void {
  const holder = byId('v2GuideRow');
  for (const guide of GUIDES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = guide.label;
    button.dataset.guide = guide.id;
    if (guide.id === readState().guide) button.classList.add('active');
    button.addEventListener('click', () => {
      updateState({ guide: guide.id });
      remember(GUIDE_STORE_KEY, guide.id);
    });
    holder.appendChild(button);
  }
  byId('v2ReticleToggle').addEventListener('click', () => {
    const on = !readState().reticle;
    updateState({ reticle: on });
    remember(RETICLE_STORE_KEY, on ? '1' : '0');
  });
}

/**
 * The frame-averaging row, built from the registry like every other row.
 *
 * It sits with the guides rather than in the diagnostics drawer because it is
 * a shooting control: it changes what the picture in front of you says, and
 * the only way to choose a level is to watch the picture while changing it.
 */
function buildFrameAverage(): void {
  const holder = byId('v2AverageRow');
  for (const level of FRAME_AVERAGE_LEVELS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = level.label;
    button.dataset.average = level.id;
    // An effect is not a stronger setting, so it is marked rather than left
    // to look like the end of the ladder.
    if (level.effect) button.dataset.effect = 'true';
    button.addEventListener('click', () => {
      updateState({ frameAverage: level.id });
      remember(FRAME_AVERAGE_STORE_KEY, level.id);
    });
    holder.appendChild(button);
  }
}

/* --- Night, first half: the gyro steadies the average -------------------- */

/**
 * ALIGNMENT — the phone's own orientation, spent on the frame average.
 *
 * Frame averaging removes noise because the noise is different in every frame
 * and the scene is not. That second half stops being true the moment the
 * phone moves: a tenth of a degree puts the scene about five pixels along, so
 * the average blends a picture with a slightly different picture and softens
 * instead of steadying. It is the same mechanism that made Dizzy an effect.
 *
 * The gyro already knows. `vision/alignment.ts` turns the rotation since the
 * accumulation began into a pixel offset, the averaging pass samples each
 * arriving frame there, and when the drift outgrows the edge budget the
 * accumulation restarts rather than blending two different views.
 *
 * A SWITCH, NOT A LEVEL, for two reasons. iOS will not hand a page motion
 * data without a permission asked for from a real tap, so this cannot be a
 * silent improvement to an existing row; and the permission can be REFUSED,
 * which a ladder rung would have no way to say.
 */
const motion = new MotionController();
const aligner = new StackAligner();
const steadyShutter = new SteadyShutter();
let latestOrientation: QuaternionLike | null = null;
let alignedFrame: AlignedFrame | null = null;

/**
 * THE ROTATION RATE, smoothed — how fast the phone is turning right now.
 *
 * A different question from the aligner's, and deliberately derived from the
 * same `rotationSince`: a phone can be far from its anchor and perfectly
 * still (a sharp photograph) or back exactly where it started and swinging
 * through (a blurred one). Two sensor paths for one movement could disagree
 * on screen, so there is one.
 */
let orientationAt = 0;
let previousOrientation: QuaternionLike | null = null;
let turnRate = 0;

function stopMotion(status: V2State['motionStatus']): void {
  motion.stop();
  aligner.reset();
  steadyShutter.disarm();
  latestOrientation = null;
  previousOrientation = null;
  turnRate = 0;
  alignedFrame = null;
  updateState({ align: false, autoShot: false, motionStatus: status });
}

/**
 * Start the sensor, once, for whichever feature asked first.
 *
 * iOS hands a page motion data only after a permission asked for from a real
 * tap, and the permission can be REFUSED — so this returns whether it worked
 * rather than assuming, and both features read the same answer.
 */
async function ensureMotion(): Promise<boolean> {
  if (readState().motionStatus === 'on') return true;
  if (typeof DeviceOrientationEvent === 'undefined') {
    updateState({ motionStatus: 'unsupported' });
    return false;
  }
  updateState({ motionStatus: 'asking' });
  let granted = false;
  try {
    granted = await motion.requestPermission();
  } catch {
    // A throw here is a refusal like any other — the page still has no gyro.
    granted = false;
  }
  if (!granted) {
    updateState({ motionStatus: 'denied' });
    return false;
  }
  motion.start((sample) => {
    // NO READING IS NOT A READING. The controller emits once the moment it
    // starts, before any sensor event has arrived, and its angles are null —
    // which the quaternion maths turns into the phone lying flat on a table.
    // Anchoring on that and then meeting the first real orientation reads as
    // a ninety-degree swing and throws the accumulation away for nothing
    // (measured: one spurious restart at every start).
    if (sample.alpha === null && sample.beta === null && sample.gamma === null) return;
    // The quaternion arrives already corrected for the screen angle, so its
    // axes line up with the frame the camera is delivering.
    latestOrientation = sample.quaternion;
    if (previousOrientation) {
      const turned = rotationSince(previousOrientation, sample.quaternion);
      const dt = sample.timestamp - orientationAt;
      const rate = rateFrom(turned.total, dt);
      // A refused rate means the samples are too far apart to divide — a
      // resumed page, a dropped event. The old rate stands rather than a
      // confident middling number for a movement nobody made.
      if (rate !== null) turnRate = smoothRate(turnRate, rate, dt);
    }
    previousOrientation = sample.quaternion;
    orientationAt = sample.timestamp;
  });
  updateState({ motionStatus: 'on' });
  return true;
}

function buildAlignment(): void {
  byId('v2AlignToggle').addEventListener('click', () => {
    if (readState().align) {
      updateState({ align: false });
      aligner.reset();
      alignedFrame = null;
      // The sensor stays on only while something is still using it.
      if (!readState().autoShot) stopMotion('off');
      return;
    }
    void (async () => {
      if (await ensureMotion()) {
        aligner.reset();
        updateState({ align: true });
      }
    })();
  });
}

/**
 * The offset for THIS frame, and whether the accumulation should start again.
 *
 * Returns nothing at all unless alignment is on, a frame is actually being
 * averaged, and an orientation has arrived — an aligner with no gyro reading
 * would otherwise anchor itself to nothing and report a confident zero.
 */
function alignmentFor(frames: number, target: FrameSize):
{ align?: [number, number]; restartAverage?: boolean } {
  if (!readState().align || !latestOrientation || !(frames > 1)) {
    if (alignedFrame) {
      // Averaging stopped or the gyro went away: the anchor no longer
      // describes anything, so the next frame that needs one starts over.
      aligner.reset();
      alignedFrame = null;
    }
    return {};
  }
  const { camera, source } = readState();
  // MEASURED IN SENSOR PIXELS, not render-target pixels. The offset that
  // comes out is a UV fraction — a pixel shift divided by the width it was
  // computed against — so both give the identical warp, but only one gives a
  // readout whose "5 px" is the five pixels of the camera's own frame.
  // Reporting the preview's pixels would quietly shrink every number by the
  // ratio between the two.
  const frame = source ?? target;
  alignedFrame = aligner.track(latestOrientation, {
    // ASSUMED, not measured: no browser reports a field of view and V2 has no
    // visual fit yet, so this is the stated stand-in and every reading says
    // so. It sets the scale of the pixel numbers and, with the edge budget,
    // how far the view may drift before the accumulation restarts.
    focalPixels: nominalFocalPixels(frame.width),
    frameWidth: frame.width,
    frameHeight: frame.height,
    facing: camera?.facing ?? ''
  });
  return { align: alignedFrame.align, restartAverage: alignedFrame.restart };
}

function renderAlignment(): void {
  const { align, motionStatus, camera } = readState();
  const toggle = byId<HTMLButtonElement>('v2AlignToggle');
  toggle.textContent = align ? '🧭 Gyro steadying is on' : '🧭 Steady with the gyro';
  toggle.setAttribute('aria-pressed', align ? 'true' : 'false');
  setText('v2AlignNote', alignNote(motionStatus, camera?.facing ?? '', align));
  setText('v2AlignReading', align ? alignReading() : '');
}

function alignNote(status: V2State['motionStatus'], facing: string, on: boolean): string {
  const sensor = motionNote(status);
  if (sensor) return sensor;
  if (!on) {
    return 'Averaging blends this frame with the last few, which only removes '
      + 'noise while the scene stays put. The gyro says how far the phone '
      + 'turned, so each frame can be put back before it is blended.';
  }
  if (facing !== 'environment') {
    return 'On, but not aligning: the front camera looks the other way along '
      + 'its own axis and which way its frames come out is a thing to measure '
      + 'rather than assume. A wrong sign would double the error instead of '
      + 'removing it, so the front camera averages unaligned.';
  }
  return 'On. Each frame is put back where the last one was before it is '
    + 'blended, and the average starts again when the view has moved on.';
}

function alignReading(): string {
  const frame = alignedFrame;
  if (!frame) {
    return readState().frameAverage === 'off'
      ? 'Nothing to align: frame averaging is Off, so every frame stands alone.'
      : 'Waiting for the first orientation reading.';
  }
  const floor = (DEFAULT_NOISE_FLOOR_RADIANS * 180 / Math.PI).toFixed(3);
  const restarts = aligner.rejectedCount;
  return `${describeShift(frame.shift, frame.delta)} · ${frame.verdict} · `
    + `${frame.reason} · ${aligner.stackedCount} frames on this anchor, `
    + `${restarts} restart${restarts === 1 ? '' : 's'} · pixels are the `
    + 'camera\'s own, from an ASSUMED focal length — no browser reports a '
    + `field of view · floor ${floor}° is the default, not a calibration of `
    + 'this phone.';
}

/**
 * The two viewing aids, built from their registries like every other row.
 *
 * They sit on the MAIN screen rather than under More because they are
 * shooting aids: the only way to choose a threshold is to watch the picture
 * while changing it, which is the same reason the guides live here.
 */
function buildAids(): void {
  for (const [holderId, levels, key] of [
    ['v2ZebraRow', ZEBRA_LEVELS, 'zebra'],
    ['v2PeakingRow', PEAKING_LEVELS, 'peaking']
  ] as const) {
    const holder = byId(holderId);
    const caption = document.createElement('span');
    caption.textContent = key === 'zebra' ? 'Zebra' : 'Peaking';
    caption.style.cssText = 'align-self:center;font-size:11px;color:#7f91a0;padding-right:4px';
    holder.appendChild(caption);
    for (const level of levels) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = level.label;
      button.dataset[key] = level.id;
      button.addEventListener('click', () => {
        updateState(key === 'zebra' ? { zebra: level.id } : { peaking: level.id });
        remember(key === 'zebra' ? ZEBRA_STORE_KEY : PEAKING_STORE_KEY, level.id);
      });
      holder.appendChild(button);
    }
  }
  byId('v2ExposureToggle').addEventListener('click', () => {
    // Closing it stops the census: an instrument nobody is looking at should
    // not be reading a frame every few frames to answer nobody.
    updateState({ exposureShown: !readState().exposureShown });
  });
}

/* --- The steady shutter: wait for a hold, then take the photograph ------- */

/**
 * AUTO CAPTURE ON A STEADY HOLD.
 *
 * Joshua, 2026-09-02: "would be good to add an auto picture take once it gets
 * a stable over 70% hold still for best image clarity."
 *
 * The gyro is already measuring the rotation; vision/steadiness.ts turns its
 * RATE into the pixels a photograph would smear by, and waits for that to
 * stay good for long enough to be a hold rather than a moment. The shutter it
 * pulls is the ordinary one — same escalation to the camera's maximum, same
 * geometry, same file. Nothing about the picture changes; only what decides
 * WHEN.
 */
let steadyReading: SteadyReading = { steadiness: 1, rate: 0, smear: 0 };
let steadyProgress = 0;
let steadyFiredAt: SteadyReading | null = null;

/**
 * The shutter time the smear is computed over.
 *
 * WebKit almost never reports the real exposure, so the frame interval stands
 * in for it — right in daylight and an understatement in the dark, where the
 * camera holds the shutter open longer than one frame. Understating is the
 * safe direction for a warning: the real blur is worse than this says, never
 * better, so a reading that says "sharp" is not being generous.
 */
function shutterSeconds(): number {
  const fps = readState().deliveredFps;
  return 1 / (fps > 1 ? fps : NOMINAL_FPS);
}

/**
 * Update the meter, and fire when a hold completes.
 *
 * Runs on the FRAME loop rather than on a sensor event, so the reading the
 * shutter acts on belongs to a picture that is actually being delivered — an
 * armed shutter on a suspended camera must not fire into nothing.
 */
function updateSteadyShutter(now: number): void {
  const { camera: status, autoShot, capability, source } = readState();
  // The photo's own pixels, because its clarity is the question being asked.
  // CAPABILITY where the track advertises one, since that is the frame the
  // shutter escalates to; the negotiated stream otherwise.
  const photo = capability ?? source;
  steadyReading = readSteadiness(
    turnRate, nominalFocalPixels(photo?.width ?? 0), shutterSeconds()
  );
  if (!autoShot) {
    steadyProgress = 0;
    return;
  }
  if (status?.state !== 'live') {
    // Nothing to photograph. The hold is abandoned rather than held, so a
    // camera that comes back does not fire on a stale clock.
    steadyShutter.arm(DEFAULT_STEADY_THRESHOLD);
    steadyProgress = 0;
    return;
  }
  const progress = steadyShutter.update(steadyReading.steadiness, now);
  steadyProgress = progress.progress;
  if (!progress.fire) return;
  // ONCE. The flag goes down before the shutter is pulled, so a slow capture
  // cannot be re-entered by the next frame.
  steadyFiredAt = steadyReading;
  updateState({ autoShot: false });
  void takePhoto();
}

function buildSteadyShutter(): void {
  byId('v2SteadyToggle').addEventListener('click', () => {
    if (readState().autoShot) {
      steadyShutter.disarm();
      updateState({ autoShot: false });
      if (!readState().align) stopMotion('off');
      return;
    }
    void (async () => {
      if (!await ensureMotion()) return;
      steadyFiredAt = null;
      steadyShutter.arm(DEFAULT_STEADY_THRESHOLD);
      updateState({ autoShot: true });
    })();
  });
}

function renderSteadyShutter(): void {
  const { autoShot, motionStatus, deliveredFps } = readState();
  const toggle = byId<HTMLButtonElement>('v2SteadyToggle');
  toggle.textContent = autoShot ? '⏳ Waiting for a steady hold…' : '🎯 Shoot when steady';
  toggle.setAttribute('aria-pressed', autoShot ? 'true' : 'false');

  const percent = Math.round(DEFAULT_STEADY_THRESHOLD * 100);
  setText('v2SteadyNote', motionStatus === 'on'
    ? `Armed, the shutter waits until the picture is ${percent}% steady and `
      + `STAYS there for ${HOLD_MS} ms, then takes one photograph and disarms. `
      + 'A moment of stillness is not a steady hand — a phone changing '
      + 'direction is motionless for one frame — so the reading has to survive.'
    : `Takes one photograph by itself once you hold the phone ${percent}% `
      + 'steady. Needs the motion sensor, which iOS only grants to a tap.');

  if (motionStatus !== 'on') {
    setText('v2SteadyReading', motionNote(motionStatus));
    return;
  }
  const line = describeSteadiness(steadyReading, shutterSeconds(), deliveredFps > 1);
  const held = steadyProgress > 0 ? ` · holding ${Math.round(steadyProgress * 100)}%` : '';
  const fired = steadyFiredAt
    ? ` · last shot fired at ${Math.round(steadyFiredAt.steadiness * 100)}% steady`
    : '';
  setText('v2SteadyReading', `${line}${held}${fired}`);
}

/**
 * The meter OVER THE PICTURE, because that is where the eyes are.
 *
 * Reading a percentage in a panel below the viewfinder means looking away
 * from the thing being held still, which moves it. The banner sits where the
 * recording one does and turns green as the hold fills.
 */
function renderSteadyHud(): void {
  const hud = byId('v2SteadyHud');
  const { autoShot } = readState();
  hud.hidden = !autoShot;
  if (!autoShot) return;
  const percent = Math.round(steadyReading.steadiness * 100);
  const target = Math.round(DEFAULT_STEADY_THRESHOLD * 100);
  const holding = steadyProgress > 0;
  hud.dataset.holding = holding ? 'true' : 'false';
  hud.textContent = holding
    ? `🎯 Holding ${percent}% — ${Math.round(steadyProgress * 100)}%`
    : `🎯 ${percent}% steady · hold at ${target}% to shoot`;
}

/** What the SENSOR is doing, said once and shared by both features. */
function motionNote(status: V2State['motionStatus']): string {
  if (status === 'asking') return 'Asking iOS for the motion sensor…';
  if (status === 'denied') {
    return 'This phone refused the motion sensor. Safari asks once per site — '
      + 'Settings ▸ Safari ▸ Motion & Orientation Access, or reload and tap again.';
  }
  if (status === 'unsupported') {
    return 'This browser reports no orientation sensor at all. That describes '
      + 'the browser: the phone certainly has a gyroscope.';
  }
  return '';
}

/* --- Night, Milestone 1: does the gyro-aligned finite stack land? -------- */

/**
 * MILESTONE 1, AND ONLY MILESTONE 1.
 *
 * "Milestone 1's question is only: Does the ~0.25-second, gyro-aligned
 * finite stack work correctly on my actual iPhone PWA?" (Joshua, 2026-09-03,
 * after the V1/V2 audit). Deliberately not a photo: no brightness recovery,
 * no lens, no save — "If an action is presented as a photo/save while MAX is
 * selected, I don't want another exception where that saved photo is
 * knowingly below MAX." Nothing here claims to be a photo. It shows the
 * stacked result in the viewer and reports what actually happened.
 *
 * TWO OWN INSTANCES of machinery that already exists and is already verified
 * on his phone — not two implementations of it. `nightAligner` is its own
 * StackAligner so a Night capture's anchor can never be corrupted by, or
 * corrupt, the live frame-averaging feature's anchor; `nightGate` is its own
 * SteadyShutter for the same reason relative to the ordinary "Shoot When
 * Steady" button. Both classes, both formulas, both shaders: unchanged.
 */
const nightAligner = new StackAligner();
const nightGate = new SteadyShutter();

type NightPhase = 'idle' | 'countdown' | 'arming' | 'stacking' | 'complete';
let nightPhase: NightPhase = 'idle';
let nightSize: FrameSize | null = null;
let nightCountdownStartedAt = 0;
let nightStartedAt = 0;
let nightLastCandidateAt = 0;
let nightNeedsRestart = true;
let nightCounters: NightCounters = emptyNightCounters();

/**
 * THE LOG — Joshua, on the phone, after the countdown worked: "the lowest I
 * saw hand holding was about 95%... can you add a log that I can copy with a
 * button to run like 3-5 times to get a good estimation before continuing."
 * Appended, never overwritten: `nightCounters`/`nightMinSteadiness` are this
 * run's live numbers; `nightLog` is every run so far, so several attempts can
 * be compared or pasted out together.
 *
 * IT ALL LIVES HERE ON PURPOSE — the type, the formatter and the lookups.
 * The first attempt at this put the formatter in vision/night-stack.ts as a
 * new named export, and that is what took the phone down on 2026-09-03: an
 * installed PWA can boot a FRESH app.js against a CACHED OLDER copy of a
 * sibling module (or an older index.html), and both skews are fatal —
 * a missing named export fails the whole module graph before a line runs,
 * and byId() throws on markup that is not there yet. Either way every
 * control after the failure is left unwired while the page still LOOKS
 * complete: "No buttons work… it's all locked up, but everything is there."
 * Both were reproduced in a real browser before this was rewritten.
 *
 * So this feature adds NO new import edge and NO new named export: it reuses
 * describeNightCounters(), which the shipped build already has, and reaches
 * its own markup through nightLogElement() below, which returns null instead
 * of throwing. The worst a skew can now do to Night's log is not show it.
 */
interface NightLogEntry {
  /** 1-based — the order they actually happened in. */
  index: number;
  /** False when the test was cancelled before the stack finished. */
  completed: boolean;
  /**
   * The LOWEST steadiness reading seen from the moment the gate armed
   * (after the countdown) through the end of the attempt — the worst moment
   * of the hold, which is the number a threshold actually has to clear.
   * 0..1, or null if the run ended before a single reading was sampled.
   */
  minSteadiness: number | null;
  /** Wall-clock time of day the entry was recorded, e.g. "10:42:07 AM". */
  at: string;
  counters: NightCounters;
}

let nightLog: NightLogEntry[] = [];
/** Reset on every fresh tap; folded into an entry when the run ends. */
let nightMinSteadiness: number | null = null;

/**
 * The log's own markup, looked up WITHOUT byId's throw. See the note above:
 * a null here must cost the log its panel, never the rest of the app its
 * event listeners.
 */
function nightLogElement<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** One line per attempt. The counters half is describeNightCounters(), reused as-is. */
function describeNightLogEntry(entry: NightLogEntry): string {
  const mark = entry.completed ? '\u2713' : '\u2717';
  const status = entry.completed ? 'complete' : 'cancelled';
  const steadiness = entry.minSteadiness === null
    ? 'no reading'
    : `min ${Math.round(entry.minSteadiness * 100)}% steady`;
  return `#${entry.index} ${mark} ${status} \u00b7 ${entry.at} \u00b7 ${steadiness} \u00b7 `
    + describeNightCounters(entry.counters);
}

/**
 * THE LIFT THE STACK EARNED, resolved from the stacked frame's OWN reading.
 *
 * Joshua, 2026-09-03: "so I can see if the images it takes line up and
 * actually make a darker scene brighter and/or enhance daylight similar to
 * HDR." Those are two different jobs and this returns both, from one
 * measurement, with nothing chosen by taste:
 *
 * GAIN answers the dark scene. A mean of N frames is not brighter than one
 * frame — it is the same brightness with about sqrt(N) less noise — so the
 * brightening has to be done here, and the stack is what makes it affordable.
 *
 * ITS CEILING IS THE FRAME COUNT, and that is the whole of Joshua's "only
 * adding and no division" (2026-09-04). Adding N frames without dividing is
 * arithmetically identical to this mean multiplied by N — sum = mean x N — so
 * a gain of N IS the sum, reached through the numerically better-conditioned
 * form. It is not an arbitrary ceiling either: N frames collected N frames'
 * worth of light, so N is precisely the brightening the exposure actually
 * paid for, and asking for more is inventing light that was never measured.
 * It is also what makes the stack worth having: brightening by N after
 * averaging N frames is about sqrt(N) cleaner than brightening one frame by
 * N, which is why the frame count had to rise before this ceiling could.
 *
 * THE MEASURED TARGET STILL BINDS FIRST, whichever is smaller. In daylight a
 * mean of 0.3 asks for 1.4x, and handing it 109x because 109 frames were
 * stacked would wash the picture out. In the near-black room the measurement
 * asks for about 420x and only 109 were collected, so the light actually
 * gathered is the limit. Each case is answered by the smaller, honest number.
 *
 * LIFT answers daylight. It is driven by the CRUSHED share — the pixels the
 * exposure reading found at the bottom of the range with their detail already
 * gone — so a bright scene with blocked-up shadows still gets them opened
 * even though its gain comes out at exactly 1.0.
 *
 * Neither can clip or wash out: the renderer's curve is Reinhard with its
 * white point set to the gain, so an input of 1.0 lands on exactly 1.0
 * whatever the gain, and a gain of 1.0 makes the whole curve an identity.
 */
const NIGHT_TARGET_MEAN = 0.42;

/**
 * Only a guard against dividing by zero. It was 0.01 — which, against a
 * measured mean of 0.001, silently answered a question nobody asked: the
 * ratio was pinned at 42 before any cap even applied. A floor that changes
 * the answer for real scenes is not a guard, so this one sits far below
 * anything a camera can report.
 */
const NIGHT_MEAN_FLOOR = 0.0001;

/**
 * The mean below which the stack's COLOUR is treated as the sensor's rather
 * than the scene's.
 *
 * WHY THERE IS A CAST AT ALL. Each channel has its own noise floor — a Bayer
 * sensor has twice as many green photosites, and the three channels do not
 * sit at the same pedestal in the dark. At an ordinary exposure that
 * difference is invisible. Multiplied by a gain of 113, a fraction of one
 * 8-bit step becomes the dominant colour in the picture. Joshua's runs show
 * exactly that, and show it is an artefact rather than the room: the same
 * closet came back GREEN on several captures and BLUE on the next. A wall
 * does not change colour between two four-second exposures; an amplified
 * noise floor does, because the camera's own white balance settles
 * differently each time.
 *
 * 0.05 (about 13 of 255) IS A CHOSEN NUMBER, not a measured one, and it is
 * the only such number here. Below it a frame is essentially at the noise
 * floor and its colour is not evidence; by it, a dim but real scene keeps its
 * own colour untouched. The correction ramps between the two rather than
 * switching, so there is no threshold to fall either side of.
 */
const NIGHT_COLOUR_TRUST = 0.05;

/**
 * Equalise the channels toward their own average, in proportion to how little
 * the colour can be trusted. Never a fixed "make it grey": at an ordinary
 * exposure the strength is zero and this returns an exact identity, so a
 * sunset stays a sunset.
 */
function nightBalanceFor(
  rawMean: number, channels: [number, number, number]
): [number, number, number] {
  const strength = Math.max(0, Math.min(1,
    (NIGHT_COLOUR_TRUST - rawMean) / NIGHT_COLOUR_TRUST));
  const average = (channels[0] + channels[1] + channels[2]) / 3;
  if (strength <= 0 || average <= 0) return [1, 1, 1];
  // mix(1, average / c, strength), per channel.
  return channels.map((c) => (c > 0 ? 1 + strength * (average / c - 1) : 1)) as
    [number, number, number];
}

/**
 * The three channel means of what is CURRENTLY on the canvas.
 *
 * Deliberately measured from the GAINED result, not the raw stack. The raw
 * stack's mean is around 0.002 — about half of one 8-bit step — so in a
 * 64x64 sample only a handful of pixels are non-zero at all, and a colour
 * ratio drawn from that would be noise reporting on noise. After the gain the
 * same picture sits in the normal range, where 8 bits resolve it properly.
 */
function sampleNightChannels(): [number, number, number] | null {
  nightSampleCanvas ??= document.createElement('canvas');
  nightSampleCanvas.width = HISTOGRAM_SAMPLE;
  nightSampleCanvas.height = HISTOGRAM_SAMPLE;
  const context = nightSampleCanvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  try {
    context.drawImage(renderer.targetCanvas, 0, 0, HISTOGRAM_SAMPLE, HISTOGRAM_SAMPLE);
    const { data } = context.getImageData(0, 0, HISTOGRAM_SAMPLE, HISTOGRAM_SAMPLE);
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
    const pixels = data.length / 4;
    return [r / pixels / 255, g / pixels / 255, b / pixels / 255];
  } catch {
    return null;
  }
}

function nightRecoveryFor(reading: ExposureReading, frames: number): NightRecovery {
  // What the light collected pays for: one frame's worth per frame stacked.
  const collected = Math.max(1, frames);
  // What the picture asks for to reach an ordinary exposure.
  const wanted = NIGHT_TARGET_MEAN / Math.max(reading.mean, NIGHT_MEAN_FLOOR);
  const gain = Math.max(1, Math.min(collected, wanted));
  // Crushed is a share, 0..1. A frame with a tenth of itself blocked up asks
  // for a noticeable open; one with none asks for nothing.
  const lift = 1 + Math.min(0.6, reading.crushed * 3);
  return { gain, lift };
}

/**
 * Measure the FINISHED stack, through the same census the histogram panel
 * uses. It samples the rendered canvas rather than the video, because the
 * question is about the accumulation, not about the frame arriving now.
 */
function measureNightResult(): ExposureReading | null {
  nightSampleCanvas ??= document.createElement('canvas');
  nightSampleCanvas.width = HISTOGRAM_SAMPLE;
  nightSampleCanvas.height = HISTOGRAM_SAMPLE;
  const context = nightSampleCanvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  try {
    context.drawImage(renderer.targetCanvas, 0, 0, HISTOGRAM_SAMPLE, HISTOGRAM_SAMPLE);
    return buildExposure(context.getImageData(0, 0, HISTOGRAM_SAMPLE, HISTOGRAM_SAMPLE).data);
  } catch {
    return null;
  }
}
let nightSampleCanvas: HTMLCanvasElement | null = null;

/**
 * Save what the stack produced — the canvas AS IT STANDS, never a fresh
 * frame. capturePhoto is told preRendered for exactly that reason: uploading
 * the frame arriving right now would save one ordinary picture and throw away
 * the four seconds of stacking that just happened.
 *
 * MAX MEANS MAX applies unchanged: the accumulator was frozen at the photo
 * row when stacking began, so this saves at the size the chosen tier decided.
 */
async function saveNightPhoto(size: FrameSize): Promise<void> {
  const still = await capturePhoto(renderer, video, 'rgb', {
    width: size.width,
    height: size.height,
    aspect: size.width / size.height,
    reason: 'the Night stack, at the size the chosen tier resolved'
  }, { preRendered: true, label: 'night' });
  if (!still) {
    setText('v2NightTestNote', 'The stack rendered but could not be encoded.');
    return;
  }
  updateState({ lastPhoto: { width: still.width, height: still.height, bytes: still.bytes } });
  offerShare('v2SharePhoto',
    new File([still.blob], still.fileName, { type: 'image/jpeg' }), 'v2PhotoResult');
  setText('v2PhotoResult', `Saved ${still.width}×${still.height} · `
    + `${(still.bytes / 1e6).toFixed(2)} MB JPEG · ${still.reason}`);
  nightSaved = `saved ${still.width}×${still.height}, ${(still.bytes / 1e6).toFixed(2)} MB`;
}
/** What the last completed Night capture wrote, for the note. */
let nightSaved = '';

/** Appended, never truncated — comparing several runs is the whole point. */
function pushNightLogEntry(completed: boolean): void {
  nightLog = [...nightLog, {
    index: nightLog.length + 1,
    completed,
    minSteadiness: nightMinSteadiness,
    at: new Date().toLocaleTimeString(),
    counters: nightCounters
  }];
}

function buildNightTest(): void {
  byId('v2NightTestToggle').addEventListener('click', () => {
    if (nightPhase !== 'idle') {
      stopNightTest();
      return;
    }
    void (async () => {
      // The permission request MUST happen here, synchronously within the
      // tap — not later inside the countdown tick. iOS only grants motion
      // access to a call that traces back to a real user gesture; deferring
      // it past this handler risks a silent refusal.
      if (!await ensureMotion()) return;
      // Joshua, on the phone, after Milestone 1 worked: "make a 3s countdown
      // before it actually starts because if not using a tripod, as soon as
      // you tap and release your finger, your hands are going to move a
      // little." This does NOT replace the gate he asked to have reused —
      // it runs BEFORE it, so the gate still has to see an actual steady
      // hold once the countdown ends.
      nightMinSteadiness = null;
      nightSaved = '';
      nightCountdownStartedAt = performance.now();
      nightPhase = 'countdown';
    })();
  });
  // Non-fatal lookups: a stale cached index.html without this markup must
  // cost the log its buttons, never the rest of the app its wiring.
  nightLogElement('v2NightLogCopy')?.addEventListener('click', () => {
    if (nightLog.length === 0) { showToast('No Night runs logged yet.'); return; }
    const text = nightLog.map(describeNightLogEntry).join('\n');
    const clipboard = navigator.clipboard;
    if (clipboard && typeof clipboard.writeText === 'function') {
      void clipboard.writeText(text).then(
        () => showToast(`Copied ${nightLog.length} Night log ${nightLog.length === 1 ? 'entry' : 'entries'}`),
        () => showToast('This browser refused the clipboard.')
      );
      return;
    }
    showToast('This browser has no clipboard access.');
  });
  nightLogElement('v2NightLogClear')?.addEventListener('click', () => {
    if (nightLog.length === 0) return;
    nightLog = [];
    showToast('Night log cleared.');
  });
}

function stopNightTest(): void {
  // A run that got as far as measuring something is worth a line even when
  // cut short — comparing attempts is the point. A tap cancelled during the
  // countdown never armed the gate, so it has nothing to compare and is not
  // logged.
  if (nightPhase === 'arming' || nightPhase === 'stacking') pushNightLogEntry(false);
  nightGate.disarm();
  nightAligner.reset();
  nightPhase = 'idle';
  nightSize = null;
  nightCounters = emptyNightCounters();
  if (!readState().align && !readState().autoShot) stopMotion('off');
}

/**
 * The tick — run from the SAME per-frame delivery callback renderPreview and
 * updateSteadyShutter already use, so Night can never run on a clock the
 * camera itself is not keeping. `now` is that frame's own timestamp; the gate
 * below is a CEILING on the rate rather than a sampling period, so a stack
 * takes every frame the camera delivers up to about 30 a second without a
 * second timer racing the real one.
 */
function updateNightStack(now: number): void {
  if (nightPhase === 'idle' || nightPhase === 'complete') return;

  if (nightPhase === 'countdown') {
    // A fixed, VISIBLE wait — not a steadiness measurement. Its only job is
    // to put a beat between "finger leaves the screen" and "the gate starts
    // judging the hold", so the tap's own release motion cannot fail a gate
    // that only just started watching. The gate itself is unchanged below.
    if (now - nightCountdownStartedAt < NIGHT_COUNTDOWN_MS) return;
    nightGate.arm(DEFAULT_STEADY_THRESHOLD);
    nightPhase = 'arming';
    return;
  }

  if (nightPhase === 'arming') {
    // Reuses the SAME steadiness reading updateSteadyShutter already
    // computes every frame — one measurement, read by three consumers
    // (Alignment's readout, Shoot When Steady, and this gate), never
    // recomputed. The log's "worst moment of the hold" starts tracking here:
    // the gate has not fired yet, so this is already part of the hold.
    nightMinSteadiness = nightMinSteadiness === null
      ? steadyReading.steadiness
      : Math.min(nightMinSteadiness, steadyReading.steadiness);
    const progress = nightGate.update(steadyReading.steadiness, now);
    if (!progress.fire) return;
    // Held. Freeze the accumulator's size for the whole capture — the same
    // "frozen at start" pattern RECORD IN already uses, and for the same
    // reason: a size that changed mid-stack would make the running mean a
    // picture of two different rectangles.
    const { geometry, capability, source, streamTier } = readState();
    if (!geometry) { nightPhase = 'idle'; return; }
    // THE PHOTO ROW, exactly as capture/photo.ts uses for the ordinary
    // shutter — not the preview row this used to take.
    //
    // Joshua, 2026-09-03, reading the per-tier runs: "I want the output to
    // match the settings so if it's 2K, it will be a 2K output image not
    // smaller... Not all 924x1232 for anything above 720 since not all
    // devices or camera will be the same, but the sizes and aspect ratios
    // can and should be, and match." The preview row is fitted to THIS
    // viewfinder's device pixels, so it pinned every tier above 720 to one
    // arbitrary 924×1232 — a number that says more about his screen than
    // about the setting he chose, and a different number on any other phone.
    // The photo row is the negotiated stream, so the tier is what decides
    // the output: 2K in, 2K out.
    //
    // This costs nothing new to acquire. uploadFrame() already puts the
    // WHOLE video frame on the GPU at its native size every frame, and
    // render() already drives this same canvas at geometry.photo for a
    // still and at geometry.recordInput for a clip — a filtered MAX
    // recording advances a full-size averaging accumulator today. Night is
    // simply stopping throwing those pixels away. (Joshua: "if it can do
    // videos at MAX at around 30fps, NIGHT will have no issues.")
    nightSize = frameSize(geometry.photo.width, geometry.photo.height);
    if (!nightSize) { nightPhase = 'idle'; return; }
    nightAligner.reset();
    // The resolution story, recorded at the moment it is decided (Joshua,
    // 2026-09-03: "link the resolution to what the setting is"). The SETTING,
    // what the camera GRANTED under it, what Night actually STACKS, and the
    // sensor's own maximum are four different numbers, and reading one as
    // another is exactly the confusion Milestone 2 has to avoid.
    nightCounters = {
      ...emptyNightCounters(),
      tierLabel: tierById(streamTier)?.label ?? streamTier,
      streamWidth: source?.width ?? 0,
      streamHeight: source?.height ?? 0,
      stackedWidth: nightSize.width,
      stackedHeight: nightSize.height,
      sensorWidth: capability?.width ?? 0,
      sensorHeight: capability?.height ?? 0
    };
    nightStartedAt = now;
    nightLastCandidateAt = now;
    nightNeedsRestart = true;
    nightPhase = 'stacking';
    return;
  }

  // stacking
  if (!nightSize) { nightPhase = 'idle'; return; }
  nightMinSteadiness = nightMinSteadiness === null
    ? steadyReading.steadiness
    : Math.min(nightMinSteadiness, steadyReading.steadiness);
  const elapsed = now - nightStartedAt;
  if (elapsed >= NIGHT_TARGET_MS) {
    // RAW first, so there is something to measure: the stack as it stands,
    // through plain RGB with no lift at all.
    renderer.renderNightResult(nightSize);
    const reading = measureNightResult();
    // stackCount, not acceptedFrames: the gain may only claim the light that
    // is actually IN the accumulator, and a restart threw the earlier frames
    // away. Claiming a whole capture's worth after a restart would brighten
    // by light the stored picture never received.
    const recovery = reading
      ? nightRecoveryFor(reading, nightCounters.stackCount)
      : { gain: 1, lift: 1 };
    // Then again, through the lift that reading just asked for.
    renderer.renderNightResult(nightSize, recovery);
    // AND ONCE MORE for the colour, which can only be measured now: the trim
    // is read off the GAINED picture, so it has to be applied by a second
    // pass over the same accumulator rather than folded into the one above.
    // Two extra draws per capture, not per frame.
    const channels = sampleNightChannels();
    const balance = channels ? nightBalanceFor(reading?.mean ?? 1, channels) : undefined;
    if (balance) renderer.renderNightResult(nightSize, { ...recovery, balance });
    nightCounters = {
      ...nightCounters,
      elapsedMs: elapsed,
      meanBefore: reading?.mean ?? 0,
      gain: recovery.gain,
      lift: recovery.lift,
      balance: balance ?? [1, 1, 1]
    };
    pushNightLogEntry(true);
    // The phase goes to complete BEFORE the save, because renderPreview is
    // frozen on that phase — the canvas being encoded must not have a live
    // frame drawn over it while toBlob is still working.
    nightPhase = 'complete';
    nightSaved = 'saving…';
    void saveNightPhoto(nightSize);
    return;
  }
  if (now - nightLastCandidateAt < NIGHT_TICK_MS) return;

  // A genuinely new candidate. This runs on the camera's own delivery
  // callback, so what follows is one arriving frame — never a re-examination
  // of one already considered. The gate above is now only a CEILING against a
  // 60 fps stream; on a 30 fps one essentially every frame gets here.
  const orientation = latestOrientation;
  if (!orientation) return; // no reading yet; wait for the next tick rather than guessing
  const sinceLast = now - nightLastCandidateAt;
  nightLastCandidateAt = now;

  const decision = nightAligner.track(orientation, {
    focalPixels: nominalFocalPixels(nightSize.width),
    frameWidth: nightSize.width,
    frameHeight: nightSize.height,
    facing: readState().camera?.facing ?? ''
  });

  const candidates = nightCounters.candidateFrames + 1;
  const cadence = candidates > 1
    ? ((nightCounters.actualCadenceMs * (candidates - 1)) + sinceLast) / candidates
    : sinceLast;
  const maxOffset = Math.max(nightCounters.maxOffsetPixels, decision.shift.distance);

  if (decision.verdict === 'rejected') {
    nightNeedsRestart = true;
    nightCounters = {
      ...nightCounters,
      candidateFrames: candidates,
      rejectedFrames: nightCounters.rejectedFrames + 1,
      maxOffsetPixels: maxOffset,
      actualCadenceMs: cadence
    };
    return;
  }

  // Accepted (stacked or still — both are usable samples for the mean).
  // stackCount resets to 1 across a restart because the accumulator really
  // did just start over; acceptedFrames does not, because it is a total for
  // the whole capture, exactly as Joshua asked for both.
  const stackCount = nightNeedsRestart ? 1 : nightCounters.stackCount + 1;
  const weight = nightStackWeight(stackCount);
  renderer.advanceNightStack(nightSize, weight, decision.align, nightNeedsRestart);
  nightCounters = {
    ...nightCounters,
    candidateFrames: candidates,
    acceptedFrames: nightCounters.acceptedFrames + 1,
    // Read AFTER the first advance, because that is when the pair is
    // allocated and so when the format stops being a prediction. The optional
    // call is deliberate: an installed PWA can boot a fresh app.js against a
    // cached older renderer, and a missing method must cost this one readout
    // rather than the capture (2026-09-03).
    accumulatorFormat: renderer.nightAccumulatorFormat?.() ?? '',
    stackCount,
    // A RESTART is the accumulator being thrown away and started over — not
    // the first prime of a fresh capture, which is simply how a mean begins.
    // Counting the prime made every clean run report "1 restart" it never
    // had (caught in Joshua's four device runs, 2026-09-03: stack 15 with 15
    // accepted proves nothing was ever discarded).
    restarts: nightCounters.restarts
      + (nightNeedsRestart && nightCounters.acceptedFrames > 0 ? 1 : 0),
    offsetPixels: decision.shift.distance,
    maxOffsetPixels: maxOffset,
    actualCadenceMs: cadence
  };
  nightNeedsRestart = false;
}

function renderNightTest(): void {
  const toggle = byId<HTMLButtonElement>('v2NightTestToggle');
  if (nightPhase === 'stacking') {
    nightCounters = { ...nightCounters, elapsedMs: performance.now() - nightStartedAt };
  }
  const secondsLeft = nightPhase === 'countdown'
    ? nightCountdownSecondsLeft(performance.now() - nightCountdownStartedAt)
    : 0;
  const overlay = byId('v2NightCountdown');
  overlay.hidden = nightPhase !== 'countdown';
  if (nightPhase === 'countdown') overlay.textContent = String(secondsLeft);
  toggle.textContent = {
    idle: '🌙 Night — Test',
    countdown: `⏱️ Starting in ${secondsLeft}…`,
    arming: '⏳ Night — hold still…',
    stacking: `🌙 Stacking… ${nightCounters.acceptedFrames}/${NIGHT_TARGET_FRAMES}`,
    complete: '🌙 Done — tap to clear'
  }[nightPhase];
  toggle.setAttribute('aria-pressed', nightPhase === 'idle' ? 'false' : 'true');
  setText('v2NightTestNote', nightPhase === 'idle'
    ? 'MILESTONE 1 ONLY: tests whether the gyro-aligned stack lands correctly. '
      + 'No brightness recovery, no lens, and NOTHING IS SAVED — this is a '
      + 'diagnostic view, not a photo. Needs the motion sensor.'
    : motionNote(readState().motionStatus) || {
      countdown: 'Let go and get comfortable — the release wobble needs a moment '
        + 'to settle before the hold is measured.',
      arming: 'Hold the phone steady — the stack begins once it settles.',
      stacking: `Gathering every frame the camera delivers, up to about `
        + `${Math.round(1000 / NIGHT_TICK_MS)} a second, for `
        + `${(NIGHT_TARGET_MS / 1000).toFixed(0)}s.`,
      complete: nightSaved
        ? `Held on screen, and ${nightSaved}. Tap the button to clear it and try again.`
        : 'Held on screen so you can inspect it. Tap the button to clear it '
          + 'and try again.',
      idle: ''
    }[nightPhase]);
  setText('v2NightTestReading', nightPhase === 'idle' ? '' : describeNightCounters(nightCounters));
  renderNightLog();
}

function renderNightLog(): void {
  const empty = nightLog.length === 0;
  const copy = nightLogElement<HTMLButtonElement>('v2NightLogCopy');
  if (copy) copy.disabled = empty;
  const clear = nightLogElement<HTMLButtonElement>('v2NightLogClear');
  if (clear) clear.disabled = empty;
  const panel = nightLogElement('v2NightLog');
  if (panel) {
    panel.textContent = empty
      ? 'No runs logged yet \u2014 each Night attempt adds a line here.'
      : nightLog.map(describeNightLogEntry).join('\n');
  }
}

/* --- Import: a photo from this device, through the same filters --------- */

/**
 * IMPORT — a picture already on the phone, put through the SAME shader the
 * camera uses, and written out as a NEW file. The original is only ever read.
 *
 * SIDE-EFFECT FREE against the live pipeline, which is what makes it safe to
 * do while the camera is running. An import render calls render() with no
 * stateSize and no frame count, so:
 *   - advanceAverage() returns immediately (it needs frames > 1), so the live
 *     Stabilization accumulation is untouched;
 *   - the state pass is skipped entirely, so Speed's and Trails' memory is
 *     neither read into nor advanced;
 *   - snapshotHistory() is called only by renderPreview, so the frame history
 *     a temporal filter compares against is never overwritten.
 * All it touches is the frame texture and the canvas, and the delivery loop
 * rewrites both on its very next frame.
 *
 * WHICH FILTERS. A filter with a state pass or a temporal comparison builds
 * its picture from a SEQUENCE, and a single still is not one — applied to an
 * import it would composite the CAMERA's leftover memory over the imported
 * picture and look like a result. So they are refused by their own capability
 * metadata (Rule 10) rather than by a hand-kept list of names, and the note
 * says why instead of leaving a dead button.
 */
let importedImage: HTMLImageElement | null = null;
let importedClip: HTMLVideoElement | null = null;
let importedName = '';
let importedUrl = '';
/**
 * True while the imported clip is driving the shared canvas. renderPreview
 * checks it and stands the camera down — one context, one writer.
 */
let importPlaying = false;
let importFrames = 0;

/**
 * Why this filter cannot be applied to the imported media, or ''.
 *
 * The distinction that matters is STILL vs CLIP. Speed and Trails build their
 * picture from a sequence, so on a single photo they have nothing to work
 * from and would composite the camera's leftover memory over it. An imported
 * VIDEO is a real sequence, so the same filters are exactly right there and
 * are not refused — the refusal is about the material, not the filter.
 */
function importRefusal(filterId: string, isClip = false): string {
  const filter = filterById(filterId);
  if (!filter) return 'That filter is not available.';
  if (filter.unavailableReason) return filter.unavailableReason;
  if (!isClip && (filter.state || filter.temporal)) {
    return `${filter.name} builds its picture from a sequence of frames, so it `
      + 'has nothing to work from in a single imported still. Pick a filter '
      + 'that reads one frame — RGB, Ironbow, Edges, or any lens.';
  }
  return '';
}

function clearImport(): void {
  stopImportPlayback();
  if (importedClip) {
    importedClip.removeAttribute('src');
    importedClip.load();
  }
  importedClip = null;
  importedImage = null;
  importedName = '';
  importedFilter = '';
  if (importedUrl) URL.revokeObjectURL(importedUrl);
  importedUrl = '';
  byId('v2ImportCanvas').hidden = true;
  byId('v2ImportSave').hidden = true;
  byId('v2ImportClear').hidden = true;
  byId('v2ImportPlay').hidden = true;
  setText('v2ImportNote', '');
  setText('v2ImportReading', '');
}

/**
 * Draw the import at its OWN full size, then copy that into the on-screen
 * canvas. The backing store is the file's size, so what is shown and what a
 * save would write are the same render rather than two different ones.
 */
function renderImport(): boolean {
  const image = importedImage;
  if (!image) return false;
  const size = frameSize(image.naturalWidth, image.naturalHeight);
  if (!size) return false;
  const { activeFilter } = readState();
  const refusal = importRefusal(activeFilter);
  const canvas = byId<HTMLCanvasElement>('v2ImportCanvas');
  if (refusal) {
    // The picture comes OFF the screen with the refusal. Leaving the previous
    // filter's render up while the note explains a different one would show a
    // result that is not the result of what is selected.
    canvas.hidden = true;
    byId('v2ImportSave').hidden = true;
    setText('v2ImportNote', refusal);
    setText('v2ImportReading', '');
    return false;
  }
  if (!renderer.uploadStill(image) || !renderer.render(activeFilter, size)) {
    setText('v2ImportNote', 'That picture could not be rendered.');
    return false;
  }
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) return false;
  context.drawImage(renderer.targetCanvas, 0, 0);
  canvas.hidden = false;
  byId('v2ImportSave').hidden = false;
  setText('v2ImportNote', `${importedName} · through ${filterById(activeFilter)?.name ?? activeFilter}`);
  setText('v2ImportReading', `${size.width}×${size.height} · the picture's own full size, `
    + 'not a downscale · the original file is never written to');
  return true;
}

/**
 * One frame of the imported clip, through the active filter, onto the shared
 * canvas and then into the import's own.
 *
 * A clip gets the FULL treatment a camera frame gets — the analysis size is
 * passed, so Speed and Trails advance their state pass and actually work on
 * imported footage. That is the whole point of importing a video rather than
 * a still: there is a real sequence to read.
 */
function drawImportFrame(): boolean {
  const clip = importedClip;
  if (!clip) return false;
  const size = frameSize(clip.videoWidth, clip.videoHeight);
  if (!size) return false;
  const { activeFilter } = readState();
  if (importRefusal(activeFilter, true)) return false;
  const resolved = resolveGeometry(size, geometryInputs());
  if (!renderer.uploadFrame(clip)
    || !renderer.render(activeFilter, size, resolved.analysis)) return false;
  // A temporal filter compares against the PREVIOUS frame, so the clip has to
  // leave one behind exactly as the delivery loop does for the camera.
  renderer.snapshotHistory(resolved.analysis);
  const canvas = byId<HTMLCanvasElement>('v2ImportCanvas');
  if (canvas.width !== size.width || canvas.height !== size.height) {
    canvas.width = size.width;
    canvas.height = size.height;
  }
  const context = canvas.getContext('2d');
  if (!context) return false;
  context.drawImage(renderer.targetCanvas, 0, 0);
  canvas.hidden = false;
  importFrames++;
  return true;
}

function driveImport(): void {
  if (!importPlaying) return;
  drawImportFrame();
  window.requestAnimationFrame(driveImport);
}

function startImportPlayback(): void {
  if (!importedClip || importPlaying) return;
  importPlaying = true;
  byId('v2ImportPlay').textContent = '⏸ Pause';
  void importedClip.play().catch(() => { /* a refused play leaves it paused */ });
  window.requestAnimationFrame(driveImport);
}

function stopImportPlayback(): void {
  importPlaying = false;
  importedClip?.pause();
  const play = document.getElementById('v2ImportPlay');
  if (play) play.textContent = '▶︎ Play';
}

async function loadClip(file: File): Promise<void> {
  const clip = byId<HTMLVideoElement>('v2ImportVideo');
  const url = URL.createObjectURL(file);
  const ready = new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      clip.removeEventListener('loadeddata', onLoad);
      clip.removeEventListener('error', onError);
      resolve(ok);
    };
    const onLoad = () => done(true);
    const onError = () => done(false);
    clip.addEventListener('loadeddata', onLoad);
    clip.addEventListener('error', onError);
  });
  clip.src = url;
  clip.load();
  if (!await ready) {
    URL.revokeObjectURL(url);
    setText('v2ImportNote', `${file.name} could not be opened as a video.`);
    return;
  }
  importedClip = clip;
  importedUrl = url;
  importedName = file.name;
  importedFilter = readState().activeFilter;
  importFrames = 0;
  byId('v2ImportClear').hidden = false;
  byId('v2ImportPlay').hidden = false;
  byId('v2ImportSave').hidden = false;
  const size = frameSize(clip.videoWidth, clip.videoHeight);
  setText('v2ImportNote', `${file.name} · through ${filterById(readState().activeFilter)?.name ?? ''}`);
  setText('v2ImportReading', `${size?.width ?? 0}×${size?.height ?? 0} · `
    + `${clip.duration.toFixed(1)}s · every filter, including Speed and Trails, `
    + 'because a clip is a real sequence · the original file is never written to');
  startImportPlayback();
}

async function loadImport(file: File): Promise<void> {
  clearImport();
  setText('v2ImportNote', `Opening ${file.name}…`);
  if (file.type.startsWith('video/')) {
    await loadClip(file);
    return;
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    setText('v2ImportNote', `${file.name} could not be opened as a picture.`);
    return;
  }
  importedImage = image;
  importedUrl = url;
  importedName = file.name;
  importedFilter = readState().activeFilter;
  byId('v2ImportClear').hidden = false;
  renderImport();
}

/**
 * Save the imported picture as a NEW file, through capturePhoto's preRendered
 * path — the same encoder and the same naming every other still uses, so an
 * import is not a second save implementation.
 */
async function saveImport(): Promise<void> {
  const image = importedImage;
  if (!image) return;
  const size = frameSize(image.naturalWidth, image.naturalHeight);
  if (!size || !renderImport()) return;
  const still = await capturePhoto(renderer, video, readState().activeFilter, {
    width: size.width,
    height: size.height,
    aspect: size.width / size.height,
    reason: 'an imported picture at its own full size'
  }, { preRendered: true, label: `import-${readState().activeFilter}` });
  if (!still) {
    setText('v2ImportNote', 'The picture rendered but could not be encoded.');
    return;
  }
  offerShare('v2SharePhoto',
    new File([still.blob], still.fileName, { type: 'image/jpeg' }), 'v2PhotoResult');
  setText('v2ImportNote', `Saved ${still.width}×${still.height} · `
    + `${(still.bytes / 1e6).toFixed(2)} MB · ${importedName} is untouched`);
}

/**
 * Re-render the import when the FILTER changes, and only then. Rendering a
 * twelve-megapixel picture on every text tick would be pure waste; a picture
 * that is already drawn does not change until the shader does.
 */
let importedFilter = '';
function renderImportPanel(): void {
  if (!importedImage && !importedClip) { importedFilter = ''; return; }
  const { activeFilter } = readState();
  if (activeFilter === importedFilter) return;
  importedFilter = activeFilter;
  // A CLIP redraws itself every frame, so the shader change lands on its own;
  // only the note needs saying again. A STILL is drawn once and must be
  // re-rendered to show the new filter at all.
  if (importedClip) {
    setText('v2ImportNote', `${importedName} · through ${filterById(activeFilter)?.name ?? activeFilter}`);
    return;
  }
  renderImport();
}

/**
 * Save the imported clip as a NEW video: the filtered canvas, recorded.
 *
 * ITS OWN RECORDER instance, deliberately. The camera's clipRecorder carries
 * the live recording's state (readState().recording, the fed-frame counters,
 * the stopping guard), and borrowing it would make an import look like a
 * camera recording to every readout that asks.
 *
 * THREE HONEST LIMITS, said out loud rather than discovered:
 * - SILENT. A canvas stream carries no audio; the original's sound is not in
 *   the new file.
 * - REAL TIME. The frames are encoded as they play, so a one-minute clip
 *   takes a minute.
 * - THE ENCODER'S CEILING still applies, so a clip above the measured
 *   macroblock limit is recorded at the largest size that will decode — the
 *   same RECORD IN row the camera obeys, resolved by the same authority.
 */
const importRecorder = new ClipRecorder();
let importSaving = false;

async function saveImportClip(): Promise<void> {
  const clip = importedClip;
  if (!clip || importSaving) return;
  const size = frameSize(clip.videoWidth, clip.videoHeight);
  if (!size) return;
  const input = resolveGeometry(size, geometryInputs()).recordInput;
  importSaving = true;
  byId<HTMLButtonElement>('v2ImportSave').disabled = true;
  try {
    // From the top, once, with looping off so 'ended' really means ended.
    stopImportPlayback();
    const wasLooping = clip.loop;
    clip.loop = false;
    clip.currentTime = 0;
    if (!drawImportFrame()) {
      setText('v2ImportNote', 'No frame to start the recording from.');
      return;
    }
    // 30 is a BITRATE-PLANNING REQUEST, not a measurement — the recorder uses
    // it to size the encoder's budget before a single frame exists. What the
    // file actually contains is measured from the file afterwards and is what
    // the readout reports. The label carries `import-` so a filtered clip is
    // never mistaken for a camera recording in the camera roll.
    const started = importRecorder.start(renderer.targetCanvas.captureStream(),
      input, 30, `import-${readState().activeFilter}`);
    if (!started.ok) {
      setText('v2ImportNote', started.reason ?? 'The recorder refused to start.');
      return;
    }
    setText('v2ImportNote', `Recording ${clip.duration.toFixed(1)}s in real time — `
      + 'the clip plays through once. Sound is not carried over.');
    const ended = new Promise<void>((resolve) => {
      const done = () => { clip.removeEventListener('ended', done); resolve(); };
      clip.addEventListener('ended', done);
    });
    startImportPlayback();
    await ended;
    stopImportPlayback();
    clip.loop = wasLooping;
    const result = await importRecorder.stop();
    if (!result) {
      setText('v2ImportNote', 'The recording produced no file.');
      return;
    }
    // The recorder already names the file from what it measured — one naming
    // for every clip this app writes, camera or import.
    offerShare('v2SharePhoto',
      new File([result.blob], result.fileName, { type: result.blob.type }), 'v2PhotoResult');
    setText('v2ImportNote', `Saved ${result.encodedWidth}×${result.encodedHeight} · `
      + `${result.seconds.toFixed(1)}s · ${(result.blob.size / 1e6).toFixed(2)} MB · `
      + `silent · ${importedName} is untouched`);
  } finally {
    importSaving = false;
    byId<HTMLButtonElement>('v2ImportSave').disabled = false;
  }
}

function buildImport(): void {
  const input = byId<HTMLInputElement>('v2ImportFile');
  byId('v2ImportPick').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    // Cleared so choosing the SAME file twice still fires a change event.
    input.value = '';
    if (file) void loadImport(file);
  });
  byId('v2ImportPlay').addEventListener('click', () => {
    if (importPlaying) stopImportPlayback(); else startImportPlayback();
  });
  byId('v2ImportSave').addEventListener('click', () => {
    if (importedClip) void saveImportClip(); else void saveImport();
  });
  byId('v2ImportClear').addEventListener('click', () => clearImport());
}

/* --- Night diagnostics: what this device can hold, and at what size ------- */

/**
 * THE FOUR SIZES, NEVER COLLAPSED (Joshua, 2026-09-04: "Do not collapse all of
 * those into the word 'resolution'"). A Night capture has a source, an
 * accumulator, a preview and an output, each decided by a different authority,
 * and the MAX-vs-720 difference in his dark-room tests is only interpretable if
 * they are reported apart.
 *
 * Read-only. Nothing here changes what Night does.
 */
function renderNightDiagnostics(): void {
  const { source, geometry, deliveredFps, capability } = readState();
  const size = (box: { width: number; height: number } | null | undefined) =>
    (box && box.width > 0 ? `${box.width}×${box.height}` : '—');
  setText('v2NightDiagSource', size(source));
  // The accumulator is whatever a capture froze, or what one would freeze now.
  // The format is REPORTED, never predicted: before a capture allocates the
  // pair there is no measured answer, and naming one would be a guess dressed
  // as a reading.
  const nightFormat = renderer.nightAccumulatorFormat?.() ?? '';
  setText('v2NightDiagAccumulator', nightSize
    ? `${size(nightSize)} · ${nightFormat || 'not yet allocated'} (this capture)`
    : `${size(geometry?.photo)} · ${nightFormat || 'allocated on the first capture'} `
      + '(the size a capture would take)');
  setText('v2NightDiagPreview', size(geometry?.preview));
  setText('v2NightDiagPhoto', `${size(geometry?.photo)} · sensor max ${size(capability)}`);
  setText('v2NightDiagFps', deliveredFps > 0 ? `${deliveredFps.toFixed(1)} fps` : '—');

  // ADVERTISED ONLY. Requesting a longer exposure and verifying the read-back
  // is a separate change; this reports what the track claims without touching
  // it, because a capability is not a grant.
  const report = camera.capabilityReport;
  for (const [id, element] of [['exposureTime', 'v2NightDiagExposure'], ['iso', 'v2NightDiagIso']] as const) {
    const field = report?.available ? report.fields[id] : undefined;
    if (!field) { setText(element, report?.available ? 'not exposed by WebKit' : '—'); continue; }
    if (field.state !== 'supported') { setText(element, field.state); continue; }
    const current = report.settings?.[id];
    setText(element, `${field.min ?? '?'} – ${field.max ?? '?'}`
      + (field.step !== undefined ? ` step ${field.step}` : '')
      + ` · now ${current ?? 'unreported'} · advertised only, not requested`);
  }
}

/**
 * The GPU precision probe, loaded ONLY when asked.
 *
 * A DYNAMIC import on purpose. A statically imported module that a PWA serves
 * a stale copy of fails the whole module graph before a line runs, which is
 * exactly what took the app down on 2026-09-03; a dynamic one fails inside
 * this handler, where it can be caught and reported. The probe is
 * user-triggered, so it costs nothing to load it late.
 */
function buildPrecisionProbe(): void {
  const button = document.getElementById('v2PrecisionProbe');
  const out = document.getElementById('v2PrecisionProbeOut');
  if (!button || !out) return;
  button.addEventListener('click', () => void (async () => {
    const target = readState().geometry?.photo ?? readState().source;
    if (!target) { out.hidden = false; out.textContent = 'Start the camera first — the probe needs the size a Night capture would really use.'; return; }
    out.hidden = false;
    out.textContent = 'Measuring…';
    try {
      const module = await import('./render/gpu-precision.js');
      const report = module.probeGpuPrecision({ width: target.width, height: target.height });
      out.textContent = module.describeGpuPrecision(report);
    } catch (error) {
      out.textContent = `The probe could not run: ${error instanceof Error ? error.message : String(error)}`;
    }
  })());
}

let renderedAidKey = '';
function renderAids(): void {
  const { zebra, peaking, exposureShown } = readState();
  const key = `${zebra}|${peaking}|${exposureShown}`;
  if (key === renderedAidKey) return;
  renderedAidKey = key;
  for (const button of byId('v2ZebraRow').querySelectorAll<HTMLButtonElement>('[data-zebra]')) {
    button.classList.toggle('active', button.dataset.zebra === zebra);
  }
  for (const button of byId('v2PeakingRow').querySelectorAll<HTMLButtonElement>('[data-peaking]')) {
    button.classList.toggle('active', button.dataset.peaking === peaking);
  }
  setText('v2ZebraNote', zebraById(zebra)?.note ?? '');
  setText('v2PeakingNote', peakingById(peaking)?.note ?? '');
  const toggle = byId<HTMLButtonElement>('v2ExposureToggle');
  toggle.textContent = exposureShown ? '▮ Hide histogram' : '▮ Show histogram';
  toggle.setAttribute('aria-expanded', exposureShown ? 'true' : 'false');
  byId('v2ExposurePanel').hidden = !exposureShown;
}

/**
 * The histogram, drawn from the measurement — and the clipping counts under
 * it, which are the part that decides whether a shot is recoverable.
 */
function renderExposure(): void {
  if (!readState().exposureShown) return;
  const canvas = byId<HTMLCanvasElement>('v2ExposureGraph');
  const context = canvas.getContext('2d');
  if (!context) return;
  const { width, height } = canvas;
  context.clearRect(0, 0, width, height);
  const step = width / EXPOSURE_BINS;
  for (let i = 0; i < EXPOSURE_BINS; i++) {
    const share = exposure.bins[i] / 255;
    // The ends are coloured because they are the ones that mean loss: the
    // shape in the middle is information, the ends are missing information.
    context.fillStyle = i === 0 ? '#4b6b8a'
      : i === EXPOSURE_BINS - 1 ? '#ff5c5c' : '#86b7ff';
    context.fillRect(i * step, height - share * height, Math.max(1, step - 1), share * height);
  }
  setText('v2ExposureNote', describeExposure(exposure)
    + ' · a blown pixel could have been any value above the top, so nothing recovers it');
}

let renderedAverageKey = '';
function renderFrameAverage(): void {
  const { frameAverage: id, deliveredFps } = readState();
  // The note carries the MEASURED conversion, so it must re-render when the
  // rate moves — rounded to whole frames per second, which is as finely as
  // the sentence can say anything anyway.
  const key = `${id}|${Math.round(deliveredFps)}`;
  if (key === renderedAverageKey) return;
  renderedAverageKey = key;
  for (const button of byId('v2AverageRow').querySelectorAll<HTMLButtonElement>('[data-average]')) {
    button.classList.toggle('active', button.dataset.average === id);
  }
  const conversion = conversionNote(id, deliveredFps);
  setText('v2AverageNote',
    `${frameAverageById(id)?.note ?? ''}${conversion ? ` ${conversion}` : ''}`);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
let renderedGuideKey = '';
function renderGuides(): void {
  const { guide: guideId, reticle: reticleOn, viewfinder, source, camera: status } = readState();
  const guide = guideById(guideId);
  // The box's shape is the only thing a guide can need, and it comes from
  // the state's measured viewfinder — never a second display read.
  const boxAspect = viewfinder && viewfinder.height > 0 ? viewfinder.width / viewfinder.height : 1;
  const live = status?.state === 'live';
  const ring = source && viewfinder ? patchBoxPercent(viewfinder, source, PICK_PATCH) : null;
  // Armed picker or an explicit ask — never just because a guide is chosen.
  const showReticle = live && (pickerActive || reticleOn);
  const key = `${guideId}|${reticleOn}|${boxAspect.toFixed(3)}|${live}|${showReticle}|${ring ? ring.width.toFixed(3) : '-'}`;
  if (key === renderedGuideKey) return;
  renderedGuideKey = key;

  // NO `hidden` here: `hidden` is an HTML property, and on an <svg> element
  // assigning it sets a stray JS property while the attribute stays put — so
  // the switch would be silently one-way. An SVG with no lines paints
  // nothing, which is the same result with nothing to get wrong.
  const svg = byId('v2Guides');
  const lines = live && guide ? guide.lines(boxAspect) : [];
  svg.replaceChildren(...lines.map(({ x1, y1, x2, y2 }) => {
    const element = document.createElementNS(SVG_NS, 'line');
    element.setAttribute('x1', String(x1));
    element.setAttribute('y1', String(y1));
    element.setAttribute('x2', String(x2));
    element.setAttribute('y2', String(y2));
    return element;
  }));

  const reticle = byId('v2Reticle');
  reticle.hidden = !showReticle;
  const ringElement = byId('v2PatchRing');
  if (ring) {
    // The ring IS the patch: the same square, expressed on each axis.
    ringElement.style.width = `${ring.width}%`;
    ringElement.style.height = `${ring.height}%`;
    ringElement.hidden = false;
  } else {
    ringElement.hidden = true;
  }

  for (const button of byId('v2GuideRow').querySelectorAll<HTMLButtonElement>('[data-guide]')) {
    button.classList.toggle('active', button.dataset.guide === guideId);
  }
  const toggle = byId<HTMLButtonElement>('v2ReticleToggle');
  toggle.classList.toggle('active', reticleOn);
  toggle.setAttribute('aria-pressed', reticleOn ? 'true' : 'false');
  setText('v2GuideNote', guide?.note || 'composition only — captures are always the full frame');
}

/* --- Manual camera controls: only what this browser really offers -------- */

/**
 * The controls are rebuilt only when the OFFER changes, never on a broadcast.
 * The offer changes on going live and on switching camera — the front and rear
 * cameras advertise different things — and rebuilding a row under a finger is
 * how this app made its controls untouchable on iOS once already.
 */
let offeredKey = '';
let lastVerdict = '';

function renderCameraControls(): void {
  const live = readState().camera?.state === 'live';
  const report = live ? camera.capabilityReport : null;
  const offered = offeredControls(report);
  // The key is the OFFER, not the settings: a value moving must not rebuild
  // the row it moved in.
  const key = `${live}|${offered.map((c) => `${c.id}:${c.options.join('/')}:${c.min}-${c.max}`).join(',')}`;
  if (key === offeredKey) return;
  offeredKey = key;

  const holder = byId('v2ControlRows');
  holder.replaceChildren();
  if (!live) {
    setText('v2ControlNote', 'Start the camera to see what it offers.');
    return;
  }
  setText('v2ControlNote', offered.length > 0
    ? 'Every change below is applied and then READ BACK: a browser can accept a '
      + 'setting and quietly not act on it, so the result says what really happened.'
    : noControlsNote(report));

  for (const control of offered) holder.appendChild(controlRow(control));
}

function controlRow(control: OfferedControl): HTMLElement {
  const row = document.createElement('div');
  row.className = 'lens-field';
  row.dataset.control = control.id;
  const label = document.createElement('label');
  label.textContent = control.label;
  row.appendChild(label);

  const run = (value: string | number | boolean): void => {
    void applyCameraControl(control, value);
  };

  if (control.kind === 'toggle') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.dataset.controlValue = 'toggle';
    button.textContent = control.current === true ? 'On' : 'Off';
    button.addEventListener('click', () => run(control.current !== true));
    row.appendChild(button);
  } else if (control.kind === 'mode') {
    for (const option of control.options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.dataset.controlValue = option;
      button.textContent = option;
      if (control.current === option) button.classList.add('active');
      button.addEventListener('click', () => run(option));
      row.appendChild(button);
    }
  } else {
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(control.min ?? 0);
    slider.max = String(control.max ?? 1);
    slider.step = String(control.step && control.step > 0 ? control.step : 'any');
    slider.value = String(typeof control.current === 'number' ? control.current : control.min ?? 0);
    slider.dataset.controlValue = 'range';
    // `change`, not `input`: applyConstraints renegotiates the live track, and
    // firing one per pixel of a drag would queue dozens against one camera.
    slider.addEventListener('change', () => run(Number(slider.value)));
    row.appendChild(slider);
  }

  const note = document.createElement('span');
  note.className = 'hint';
  note.textContent = control.note + (control.unit ? ` Values are in ${control.unit}.` : '');
  row.appendChild(note);
  return row;
}

/**
 * Apply one control, then READ THE TRACK BACK.
 *
 * A resolved applyConstraints means the browser accepted the request, not that
 * the camera moved — WebKit will advertise a capability, accept a constraint
 * for it and leave the setting exactly where it was. Everything interesting is
 * in the difference between the two reads, which is what gets reported.
 */
async function applyCameraControl(
  control: OfferedControl, value: string | number | boolean
): Promise<void> {
  if (readState().recording) {
    setText('v2ControlVerdict',
      'Not while recording — re-constraining the live track mid-clip is how a '
      + 'file ends up with two different pictures in it.');
    return;
  }
  const before = camera.capabilityReport.settings;
  const result = await camera.applyCameraSetting(control.id, value);
  // The read has to come after the track has had a moment to settle; an
  // immediate getSettings() can still report the old value on a change that
  // did work, which would be reported as "ignored" and be a lie.
  await new Promise((resolve) => setTimeout(resolve, 220));
  const after = camera.capabilityReport.settings;
  const verdict = verifyApply(control, value, before, after, result.applied, result.reason);
  lastVerdict = verdict.message;
  setText('v2ControlVerdict', lastVerdict);
  // The offer itself can change with the setting (a manual mode unlocking a
  // range), so the rows are re-derived rather than patched.
  offeredKey = '';
  renderCameraControls();
  setText('v2ControlVerdict', lastVerdict);
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
    + `${encoderEnvelope.measured ? 'MEASURED' : 'assumed'} · ${encoderEnvelope.reason}`
    // A limit that is not being applied must not be shown as if it were.
    + (readState().forceMaxRecord
      ? ' · NOT APPLIED: recording at MAX by choice, and the finished file is decoded to say whether it held'
      : ''));
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

/**
 * The picker's state, declared HERE rather than beside the picker's own code
 * for one reason: the subscriber below calls renderers that read it, and
 * subscribe() invokes its listener synchronously — a `let` further down the
 * module is still in its temporal dead zone when that happens, which has
 * taken this module down at boot twice. The picker's behaviour lives with
 * the rest of the picker; only these two bindings are hoisted.
 */
let pickerActive = false;
let pickedColor: SampledColor | null = null;

/** Does either of a lens's fields read hue? Metadata, never a list of ids. */
function lensReadsHue(lens: CustomLens): boolean {
  return channelInfo(lens.color.channel).hueDerived === true
    || (lens.brightness ? channelInfo(lens.brightness.channel).hueDerived === true : false);
}

/**
 * Filters flipped for THIS SESSION only. Memory, never storage: a saved lens
 * means what its author saved, and a look being tried out is not an edit.
 * "Save as new" is still how a flip becomes permanent.
 */
const reversed = new Set<string>();

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
  // The revision moves when a lens's own numbers change — including the
  // reference colour the note now names — so a live edit re-renders the note
  // without the id having changed.
  const key = `${activeFilter}|${rec}|${cap}|${warning}|${readState().frameAverage}`
    + `|${isReversed(activeFilter)}`
    + `|${filterById(activeFilter)?.revision ?? ''}`
    + `|${matchingShare === null ? '-' : Math.round(matchingShare * 100)}`;
  if (key === renderedFilterKey) return;
  renderedFilterKey = key;
  for (const button of byId('v2FilterStrip').querySelectorAll<HTMLButtonElement>('[data-filter]')) {
    button.classList.toggle('active', button.dataset.filter === activeFilter);
    // Switching filters mid-clip would change the recording path or shader
    // under the encoder; the strip waits for stop, honestly disabled.
    button.disabled = rec;
  }
  // RECORD IN below SOURCE now has one cause on every path, RGB included:
  // the encoder's frame limit (measured 2026-09-01) — so the note names it
  // for every filter, and photos are exempt because JPEG has no such level.
  const capNote = cap
    ? `Clips at this stream size record at ${cap} — held under the encoder's frame limit `
      + '(RECORD IN names why). Photos stay at the full sensor.'
    : '';
  const lensFilter = filterById(activeFilter);
  const lensNote = lensFilter?.lens
    ? lensFilter.unavailableReason
      ? lensFilter.unavailableReason
      // The lens's own sentence first — what it DOES — and the measured
      // detail after it. describeLens stays the technical reading, and lives
      // in the workbench where someone is editing those very numbers.
      : `${lensFilter.lens.note ? `${lensFilter.lens.note}` : `${describeLens(lensFilter.lens)}.`}`
        + (lensFilter.needsHistogram
          ? ' Measured against the whole frame’s colours, re-counted a few times a second — point the camera elsewhere and the reading moves.'
          : '')
        // Which colour it is looking for, named — "I picked a colour but it
        // looked the same" (Joshua, 2026-09-02) is what a lens that never
        // says what it is measuring against feels like.
        + (lensFilter.lens.reference && channelInfo(lensFilter.lens.color.channel).needsReference
          ? ` Looking for ${lensFilter.lens.reference.toUpperCase()} — tap ⊕ Colour to sample a new one from the picture.`
          : '')
        + (matchingShare !== null
          ? ` Matching ${(matchingShare * 100).toFixed(0)}% of the frame right now`
            + (matchingShare < 0.005 ? ' — nothing in view is that colour yet.' : '.')
          : '')
        // Averaging is off by default because most filters do not need it.
        // The ones that do should say so where the speckle is visible, rather
        // than leaving the row to be found — but only while it IS off.
        + (readState().frameAverage === 'off' && lensReadsHue(lensFilter.lens)
          ? ' Speckle changing every frame? This one reads hue, which sensor noise '
            + 'swings hard — try Frame averaging.'
          : '')
    : '';
  setText('v2FilterNote', rec
    ? 'Recording — stop to change filters.'
    // A filter's sentence is the filter's own (registry.ts): a lookup table
    // here went stale silently and left RGB and Edges with nothing to say.
    : `${lensNote || (lensFilter?.note ?? '')} ${capNote || warning}`.trim());
  byId('v2LensActions').hidden = rec;
  byId('v2LensEdit').hidden = !lensFilter?.lens;
  // Reverse is offered only where a ramp is read — RGB and Edges paint none,
  // and a mask or swap lens keeps the camera's own colours.
  const flip = byId<HTMLButtonElement>('v2ReverseRamp');
  flip.hidden = !canReverse(lensFilter);
  flip.classList.toggle('active', isReversed(activeFilter));
  flip.textContent = isReversed(activeFilter) ? '🔄 Reversed' : '🔄 Reverse';
}

/* --- The coach: what to do with a filter that needs a step --------------- */

const COACH_MUTED_KEY = 'vss.v2.coachMuted.v1';

function mutedTips(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(COACH_MUTED_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Dismissed for this session only, unless the switch says forever. */
const closedTips = new Set<string>();
// 'unrendered' is deliberately distinct from 'none': resetting the key to
// the value that MEANS hidden makes the next render bail out and the card
// stays on screen — which is exactly what happened the first time.
let renderedCoachKey = 'unrendered';

function renderCoach(): void {
  const { activeFilter } = readState();
  const tip = tipFor(filterById(activeFilter));
  const show = tip !== null && !closedTips.has(tip.id) && !mutedTips().has(tip.id);
  // The FILTER is part of the key, not just the tip: three lenses share the
  // 'lens-histogram' tip, and keying on the tip alone left Rare Colour's
  // title above Background Subtract (Joshua, 2026-09-02). Dismissal is still
  // per tip — one "don't show again" silences the family, as it should.
  const key = show && tip ? `${activeFilter}|${tip.id}` : 'none';
  if (key === renderedCoachKey) return;
  renderedCoachKey = key;
  const card = byId('v2Coach');
  card.hidden = !show;
  if (!show || !tip) return;
  setText('v2CoachTitle', tip.title);
  byId('v2CoachSteps').replaceChildren(...tip.steps.map((step) => {
    const item = document.createElement('li');
    item.textContent = step;
    return item;
  }));
  const action = byId<HTMLButtonElement>('v2CoachAction');
  action.hidden = !tip.action;
  if (tip.action) action.textContent = tip.action.label;
  byId<HTMLInputElement>('v2CoachMute').checked = false;
}

byId('v2CoachClose').addEventListener('click', () => {
  const tip = tipFor(filterById(readState().activeFilter));
  if (!tip) return;
  closedTips.add(tip.id);
  if (byId<HTMLInputElement>('v2CoachMute').checked) {
    const muted = mutedTips();
    muted.add(tip.id);
    try {
      localStorage.setItem(COACH_MUTED_KEY, JSON.stringify([...muted]));
    } catch {
      // Storage is optional; it stays dismissed for this session either way.
    }
  }
  renderedCoachKey = 'unrendered';
  renderCoach();
});

byId('v2CoachAction').addEventListener('click', () => {
  // The tip does the thing rather than only describing it.
  setPickerActive(true);
  byId('v2PickerCard').scrollIntoView({ block: 'nearest' });
});

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
  renderGuides();
  renderCoach();
  renderDiagnostics();
  renderFrameAverage();
  renderAlignment();
  renderSteadyShutter();
  renderSteadyHud();
  renderNightTest();
  renderNightDiagnostics();
  renderImportPanel();
  renderCameraControls();
  renderAids();
  renderExposure();
  // The picker's shortcut names the ACTIVE lens, so it follows the strip.
  renderPickerLensRow();
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
    if (!renderer.uploadFrame(video)
      || !renderer.render(activeFilter, geometry.recordInput,
        undefined,
        { frames: framesForLevel(readState().frameAverage, readState().deliveredFps) })) {
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


/* --- Milestone E: the lens workbench ------------------------------------- */

/**
 * A custom lens is the legacy DATA document, compiled to a V2 filter
 * (filters/lens-shader.ts). This section owns the list of lenses (the same
 * localStorage key the legacy app uses, so lenses authored there appear
 * here), the draft being edited, and the workbench controls — every slider
 * with a paired exact-number field. The preview is the lens itself running
 * as the active filter; nothing here draws.
 */
const LENSES_SEEDED_KEY = 'vss.v2.lensesSeeded.v2';
let lenses: CustomLens[] = [];
let lensDraft: CustomLens | null = null;
let lensDraftIsNew = false;

/**
 * A lens document as a comparable string. Sanitising first is what makes it
 * comparable: a stored lens has already been through sanitiseLens, so the
 * same document always produces the same text whichever side it came from.
 */
function lensFingerprint(lens: CustomLens): string {
  return JSON.stringify(sanitiseLens(lens));
}

/** Every form of a starter this app is known to have shipped. */
function shippedForms(id: string): string[] {
  const forms: string[] = [];
  for (const lens of [...STARTER_LENSES, ...SUPERSEDED_STARTERS]) {
    if (lens.id !== id) continue;
    forms.push(lensFingerprint(lens));
    // Notes arrived after the starters did, so the note-less form shipped too.
    forms.push(lensFingerprint({ ...lens, note: undefined }));
  }
  return forms;
}

/**
 * Seeding is remembered PER STARTER, not as one flag: a device that was
 * seeded before a new starter existed still receives it, and a starter the
 * user deleted stays deleted. The record is what was OFFERED — the id and
 * the fingerprint of the document offered under it.
 *
 * The fingerprint is what lets a starter be CORRECTED after it has shipped.
 * Camouflage Breaker went out mistuned (it read as an edge map in a dim
 * room, 2026-09-02) and the id was already seeded, so nothing would ever
 * have replaced it. A saved copy that still matches what was offered is
 * untouched and gets the new version; a copy that differs is the user's own
 * work and is never overwritten — the same line "Save as new" draws.
 */
function loadLensList(): void {
  lenses = loadLenses(localStorage);
  let offered = new Map<string, string>();
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LENSES_SEEDED_KEY) ?? '[]');
    if (Array.isArray(raw)) {
      // The original record: ids only, no fingerprints. An id from here is
      // "offered, document unknown" — shippedForms decides what that means.
      for (const id of raw) if (typeof id === 'string') offered.set(id, '');
    } else if (raw && typeof raw === 'object') {
      for (const [id, mark] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof mark === 'string') offered.set(id, mark);
      }
    }
  } catch {
    offered = new Map();
  }
  for (const starter of STARTER_LENSES) {
    const mark = lensFingerprint(starter);
    const saved = lenses.find((lens) => lens.id === starter.id);
    if (!offered.has(starter.id)) {
      // Never offered: seed it, unless something already holds the id.
      if (!saved) lenses = saveLens(localStorage, lenses, starter).lenses;
    } else if (saved) {
      const was = offered.get(starter.id) ?? '';
      const savedMark = lensFingerprint(saved);
      // Untouched since it was offered — either the record says exactly what
      // was offered, or (no record) the copy matches a form this app shipped.
      const untouched = was ? savedMark === was : shippedForms(starter.id).includes(savedMark);
      if (untouched && savedMark !== mark) {
        lenses = saveLens(localStorage, lenses, starter).lenses;
      }
    }
    offered.set(starter.id, mark);
  }
  try {
    localStorage.setItem(LENSES_SEEDED_KEY, JSON.stringify(Object.fromEntries(offered)));
  } catch {
    // Storage is optional; the starters are in memory for this session.
  }
}

/** The registry's custom entries: saved lenses, with the draft standing in for its own id. */
function syncCustomFilters(): void {
  const list = lensDraft
    ? [...lenses.filter((lens) => lens.id !== lensDraft?.id), lensDraft]
    : lenses;
  setCustomFilters(list.map(compileLens));
}

function lensFromFilterId(id: string): CustomLens | null {
  return filterById(id)?.lens ?? null;
}

/** Rebuild ONLY the custom entries of the strip (list changes, not slider moves). */
function rebuildLensEntries(): void {
  const strip = byId('v2FilterStrip');
  for (const stale of strip.querySelectorAll('[data-filter^="lens:"], [data-lens-new]')) stale.remove();
  for (const filter of allFilters().filter((f) => f.lens)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'filter';
    button.dataset.filter = filter.id;
    if (filter.unavailableReason) button.classList.add('unavailable');
    if (filter.id === readState().activeFilter) button.classList.add('active');
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.style.background = rampToCss(filter.lens?.stops ?? []).replace('90deg', '135deg');
    const label = document.createElement('small');
    label.textContent = filter.name;
    button.append(thumb, label);
    button.addEventListener('click', () => {
      // An unavailable lens never looks functional: the tap explains.
      if (filter.unavailableReason) {
        showToast(filter.unavailableReason);
        return;
      }
      updateState({ activeFilter: filter.id });
      renderPreview(performance.now());
    });
    strip.appendChild(button);
  }
  const custom = document.createElement('button');
  custom.type = 'button';
  custom.className = 'filter';
  custom.dataset.lensNew = '1';
  const thumb = document.createElement('div');
  thumb.className = 'thumb custom';
  thumb.textContent = '＋';
  const label = document.createElement('small');
  label.textContent = 'Custom +';
  custom.append(thumb, label);
  custom.addEventListener('click', () => openLensWorkbench(null));
  strip.appendChild(custom);
  renderedFilterKey = '';
}

/** One binding row: a slider and a number field that always agree; the number is exact. */
function bindingField(
  holder: HTMLElement, id: string, label: string,
  range: { min: number; max: number; step: number },
  read: () => number, write: (value: number) => void
): void {
  const row = document.createElement('div');
  row.className = 'lens-field';
  const text = document.createElement('label');
  text.htmlFor = `${id}Number`;
  text.textContent = label;
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.id = `${id}Range`;
  slider.min = String(range.min);
  slider.max = String(range.max);
  slider.step = String(range.step);
  const number = document.createElement('input');
  number.type = 'number';
  number.id = `${id}Number`;
  number.inputMode = 'decimal';
  number.step = 'any';
  const show = () => {
    const value = read();
    // The number is the value; the slider must always be able to stand on
    // it. A typed value beyond the slider's span widens the span rather
    // than being clamped back to a near miss.
    if (value > Number(slider.max)) slider.max = String(value);
    if (value < Number(slider.min)) slider.min = String(value);
    slider.value = String(value);
    number.value = String(Number(value.toFixed(4)));
  };
  slider.addEventListener('input', () => {
    write(Number(slider.value));
    show();
    lensDraftChanged();
  });
  number.addEventListener('change', () => {
    const value = Number(number.value);
    if (!Number.isFinite(value)) { show(); return; }
    write(value);
    show();
    lensDraftChanged();
  });
  show();
  row.append(text, slider, number);
  holder.appendChild(row);
}

function renderLensBindings(): void {
  const draft = lensDraft;
  if (!draft) return;
  const info = channelInfo(draft.color.channel);
  const holder = byId('v2LensBindings');
  holder.replaceChildren();
  // Slider spans come from the channel's own default range with headroom;
  // the number field is unbounded, so an exact value outside the slider's
  // reach is one tap of typing away.
  const span = Math.max(info.high, Math.abs(info.low)) * 1.5 || 1;
  const step = span > 20 ? 1 : 0.001;
  bindingField(holder, 'v2LensLow', 'Low', { min: 0, max: span, step },
    () => draft.color.low, (v) => { draft.color.low = v; });
  bindingField(holder, 'v2LensHigh', 'High', { min: 0, max: span, step },
    () => draft.color.high, (v) => { draft.color.high = v; });
  bindingField(holder, 'v2LensGamma', 'Curve', { min: 0.2, max: 3, step: 0.01 },
    () => draft.color.gamma, (v) => { draft.color.gamma = v > 0 ? v : 1; });
  // The colour fields need two more things: what to measure against, and
  // (for a swap) what to become. Both are rows that appear only when the
  // lens actually uses them.
  const referenceRow = byId('v2LensReferenceRow');
  referenceRow.hidden = !info.needsReference;
  byId<HTMLInputElement>('v2LensReference').value = draft.reference ?? '#ffffff';
  byId<HTMLButtonElement>('v2LensUseSample').disabled = pickedColor === null;
  const targetRow = byId('v2LensTargetRow');
  targetRow.hidden = (draft.output ?? 'paint') !== 'swap';
  byId<HTMLInputElement>('v2LensTarget').value = draft.target ?? '#ffffff';
  byId<HTMLSelectElement>('v2LensOutput').value = draft.output ?? 'paint';
  setText('v2LensUnit', info.unit);
  setText('v2LensChannelMeaning', info.meaning + (channelAvailability(info.id).available ? '' : ` ${channelAvailability(info.id).reason}`));
  // The SECOND field. The lens document has always had one — a field driving
  // brightness while another drives colour — and until now nothing in V2
  // could reach it, so every two-field lens on the ideas list was out of
  // reach for a UI reason rather than a real one.
  const brightSelect = byId<HTMLSelectElement>('v2LensBrightChannel');
  brightSelect.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— none —';
  brightSelect.appendChild(none);
  for (const option of CHANNELS) {
    if (!channelAvailability(option.id).available) continue;
    const element = document.createElement('option');
    element.value = option.id;
    element.textContent = option.label;
    brightSelect.appendChild(element);
  }
  brightSelect.value = draft.brightness?.channel ?? '';
  const brightHolder = byId('v2LensBrightBindings');
  brightHolder.replaceChildren();
  if (draft.brightness) {
    const brightInfo = channelInfo(draft.brightness.channel);
    setText('v2LensBrightUnit', brightInfo.unit);
    const brightSpan = Math.max(brightInfo.high, Math.abs(brightInfo.low)) * 1.5 || 1;
    const brightStep = brightSpan > 20 ? 1 : 0.001;
    bindingField(brightHolder, 'v2LensBrightLow', 'Dim at',
      { min: 0, max: brightSpan, step: brightStep },
      () => draft.brightness?.low ?? 0, (v) => { if (draft.brightness) draft.brightness.low = v; });
    bindingField(brightHolder, 'v2LensBrightHigh', 'Full at',
      { min: 0, max: brightSpan, step: brightStep },
      () => draft.brightness?.high ?? 0, (v) => { if (draft.brightness) draft.brightness.high = v; });
    bindingField(brightHolder, 'v2LensBrightGamma', 'Curve', { min: 0.2, max: 3, step: 0.01 },
      () => draft.brightness?.gamma ?? 1,
      (v) => { if (draft.brightness) draft.brightness.gamma = v > 0 ? v : 1; });
    // How far down the second field may take a pixel. At 0 it multiplies to
    // black and the colour field's answer goes with it — which is how
    // Camouflage Breaker came to look like an edge map.
    bindingField(brightHolder, 'v2LensBrightFloor', 'Never below', { min: 0, max: 1, step: 0.01 },
      () => draft.brightnessFloor ?? 0,
      (v) => { draft.brightnessFloor = Math.min(1, Math.max(0, v)) || undefined; });
  } else {
    setText('v2LensBrightUnit', '');
  }

  const blend = byId('v2LensBlend');
  blend.replaceChildren();
  bindingField(blend, 'v2LensBlendField', 'Picture', { min: 0, max: 1, step: 0.01 },
    () => draft.sceneBlend, (v) => { draft.sceneBlend = Math.min(1, Math.max(0, v)); });
}

function renderLensStops(): void {
  const draft = lensDraft;
  if (!draft) return;
  const holder = byId('v2LensStops');
  holder.replaceChildren();
  draft.stops.forEach((stop, index) => {
    const row = document.createElement('div');
    row.className = 'lens-stop';
    const color = document.createElement('input');
    color.type = 'color';
    color.value = stop.color;
    color.addEventListener('input', () => { stop.color = color.value; lensDraftChanged(); });
    const at = document.createElement('input');
    at.type = 'number';
    at.inputMode = 'decimal';
    at.step = 'any';
    at.min = '0';
    at.max = '1';
    at.value = String(stop.at);
    at.addEventListener('change', () => {
      const value = Number(at.value);
      stop.at = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : stop.at;
      at.value = String(stop.at);
      lensDraftChanged();
    });
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '1';
    slider.step = '0.001';
    slider.value = String(stop.at);
    slider.addEventListener('input', () => { stop.at = Number(slider.value); at.value = slider.value; lensDraftChanged(); });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '−';
    remove.disabled = draft.stops.length <= MIN_STOPS;
    remove.addEventListener('click', () => {
      draft.stops.splice(index, 1);
      renderLensStops();
      lensDraftChanged();
    });
    row.append(color, at, slider, remove);
    holder.appendChild(row);
  });
  byId<HTMLButtonElement>('v2LensAddStop').disabled = draft.stops.length >= MAX_STOPS;
}

/** Every edit: recompile the draft's filter, refresh the swatch and the description. */
function lensDraftChanged(): void {
  const draft = lensDraft;
  if (!draft) return;
  syncCustomFilters();
  byId('v2LensSwatch').style.background = rampToCss(draft.stops);
  setText('v2LensDescribe', describeLens(draft));
  renderedFilterKey = '';
  renderFilterStrip();
  renderPreview(performance.now());
}

function openLensWorkbench(existing: CustomLens | null): void {
  if (readState().recording) return;
  lensDraftIsNew = existing === null;
  lensDraft = existing
    ? sanitiseLens(JSON.parse(JSON.stringify(existing)))
    : sanitiseLens({
      id: newLensId(), name: 'New lens',
      color: { channel: 'edges', low: 0, high: 255, gamma: 1 },
      stops: RAMP_PRESETS.find((p) => p.name === 'Mono')?.stops ?? [{ at: 0, color: '#000000' }, { at: 1, color: '#ffffff' }],
      base: 'black', sceneBlend: 0
    });
  const draft = lensDraft;
  setText('v2LensTitle', lensDraftIsNew ? 'New custom lens' : `Edit “${draft.name}”`);
  byId<HTMLInputElement>('v2LensName').value = draft.name;
  const channel = byId<HTMLSelectElement>('v2LensChannel');
  channel.replaceChildren();
  for (const info of CHANNELS) {
    const option = document.createElement('option');
    option.value = info.id;
    const availability = channelAvailability(info.id);
    option.textContent = availability.available ? info.label : `${info.label} (not in V2 yet)`;
    option.disabled = !availability.available;
    channel.appendChild(option);
  }
  channel.value = draft.color.channel;
  byId<HTMLSelectElement>('v2LensBase').value = draft.base;
  const presets = byId('v2LensPresets');
  presets.replaceChildren();
  for (const preset of RAMP_PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = preset.name;
    button.style.background = rampToCss(preset.stops);
    button.style.color = '#fff';
    button.style.textShadow = '0 0 3px #000';
    button.addEventListener('click', () => {
      draft.stops = preset.stops.map((s) => ({ ...s }));
      renderLensStops();
      lensDraftChanged();
    });
    presets.appendChild(button);
  }
  byId<HTMLButtonElement>('v2LensDelete').hidden = lensDraftIsNew;
  byId<HTMLInputElement>('v2LensNote').value = draft.note ?? '';
  // Editing one of the lenses the app ships with is fine — but say so, and
  // point at the button that keeps the original intact.
  const origin = byId('v2LensOrigin');
  const isStarter = STARTER_LENSES.some((starter) => starter.id === draft.id);
  origin.hidden = !isStarter;
  if (isStarter) {
    setText('v2LensOrigin',
      'This is one of the lenses the app ships with. “Save” changes it; “Save as new” keeps this one and starts your own copy.');
  }
  setText('v2LensStatus', '');
  renderLensBindings();
  renderLensStops();
  byId('v2LensWorkbench').hidden = false;
  renderPickedColor();
  syncCustomFilters();
  rebuildLensEntries();
  updateState({ activeFilter: lensFilterId(draft) });
  lensDraftChanged();
}

function closeLensWorkbench(): void {
  const draft = lensDraft;
  lensDraft = null;
  byId('v2LensWorkbench').hidden = true;
  renderPickedColor();
  syncCustomFilters();
  // An unsaved new lens leaves with the workbench; the strip follows.
  if (draft && !lenses.some((lens) => lens.id === draft.id) && readState().activeFilter === lensFilterId(draft)) {
    updateState({ activeFilter: 'rgb' });
  }
  rebuildLensEntries();
  renderPreview(performance.now());
}

function saveLensDraft(): void {
  const draft = lensDraft;
  if (!draft) return;
  draft.name = byId<HTMLInputElement>('v2LensName').value.trim() || draft.name;
  const result = saveLens(localStorage, lenses, draft);
  lenses = result.lenses;
  if (!result.saved) {
    setText('v2LensStatus', result.error ?? 'Could not save.');
    return;
  }
  lensDraftIsNew = false;
  byId<HTMLButtonElement>('v2LensDelete').hidden = false;
  setText('v2LensTitle', `Edit “${draft.name}”`);
  showToast(`Saved “${draft.name}”`);
  syncCustomFilters();
  rebuildLensEntries();
}

function deleteLensDraft(): void {
  const draft = lensDraft;
  if (!draft) return;
  lenses = deleteLens(localStorage, lenses, draft.id);
  lensDraft = null;
  byId('v2LensWorkbench').hidden = true;
  if (readState().activeFilter === lensFilterId(draft)) updateState({ activeFilter: 'rgb' });
  syncCustomFilters();
  rebuildLensEntries();
  showToast(`Deleted “${draft.name}”`);
  renderPreview(performance.now());
}

/** The export is the same document shape Joshua's .lens.json carries. */
function exportLensDraft(): void {
  const draft = lensDraft;
  if (!draft) return;
  const name = `${draft.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'lens'}.lens.json`;
  const file = new File([JSON.stringify({ lenses: [draft] }, null, 2)], name, { type: 'application/json' });
  const nav = navigator as Navigator & {
    canShare?: (data: { files: File[] }) => boolean;
    share?: (data: { files: File[] }) => Promise<void>;
  };
  if (typeof nav.share === 'function' && nav.canShare?.({ files: [file] }) !== false) {
    void nav.share({ files: [file] }).catch(() => undefined);
    return;
  }
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Accepts {lenses:[...]}, a bare array, or one lens — every item sanitised on the way in. */
function importLensDocuments(text: string): CustomLens[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { lenses?: unknown }).lenses)
      ? (parsed as { lenses: unknown[] }).lenses
      : [parsed];
  return items.map(sanitiseLens);
}

async function importLensFile(file: File): Promise<void> {
  const imported = importLensDocuments(await file.text());
  if (imported.length === 0) {
    showToast('That file did not contain a lens.');
    return;
  }
  for (const lens of imported) lenses = saveLens(localStorage, lenses, lens).lenses;
  syncCustomFilters();
  rebuildLensEntries();
  updateState({ activeFilter: lensFilterId(imported[0]) });
  showToast(`Imported ${imported.length === 1 ? `“${imported[0].name}”` : `${imported.length} lenses`}`);
  renderPreview(performance.now());
}

byId('v2LensName').addEventListener('input', () => {
  if (lensDraft) lensDraft.name = byId<HTMLInputElement>('v2LensName').value;
});
byId('v2LensNote').addEventListener('input', () => {
  if (!lensDraft) return;
  const text = byId<HTMLInputElement>('v2LensNote').value.trim();
  lensDraft.note = text || undefined;
  lensDraftChanged();
});
byId<HTMLSelectElement>('v2LensChannel').addEventListener('change', () => {
  const draft = lensDraft;
  if (!draft) return;
  const channel = byId<HTMLSelectElement>('v2LensChannel').value as ChannelId;
  const info = channelInfo(channel);
  draft.color = { channel, low: info.low, high: info.high, gamma: draft.color.gamma };
  renderLensBindings();
  lensDraftChanged();
});
byId<HTMLSelectElement>('v2LensBase').addEventListener('change', () => {
  if (!lensDraft) return;
  lensDraft.base = byId<HTMLSelectElement>('v2LensBase').value as CustomLens['base'];
  lensDraftChanged();
});
byId<HTMLSelectElement>('v2LensBrightChannel').addEventListener('change', () => {
  const draft = lensDraft;
  if (!draft) return;
  const chosen = byId<HTMLSelectElement>('v2LensBrightChannel').value as ChannelId | '';
  if (!chosen) {
    delete draft.brightness;
  } else {
    const info = channelInfo(chosen);
    draft.brightness = { channel: chosen, low: info.low, high: info.high, gamma: 1 };
  }
  renderLensBindings();
  lensDraftChanged();
});
byId<HTMLSelectElement>('v2LensOutput').addEventListener('change', () => {
  const draft = lensDraft;
  if (!draft) return;
  draft.output = byId<HTMLSelectElement>('v2LensOutput').value as CustomLens['output'];
  renderLensBindings();
  lensDraftChanged();
});
byId<HTMLInputElement>('v2LensReference').addEventListener('input', () => {
  if (!lensDraft) return;
  lensDraft.reference = byId<HTMLInputElement>('v2LensReference').value;
  lensDraftChanged();
});
byId<HTMLInputElement>('v2LensTarget').addEventListener('input', () => {
  if (!lensDraft) return;
  lensDraft.target = byId<HTMLInputElement>('v2LensTarget').value;
  lensDraftChanged();
});
byId('v2LensUseSample').addEventListener('click', () => {
  const colour = pickedColor;
  if (!lensDraft || !colour) return;
  // The picker's reading becomes the thing the lens measures against — the
  // two halves of the Colour Picker Lens card, joined.
  lensDraft.reference = toHex([colour.r, colour.g, colour.b]);
  renderLensBindings();
  lensDraftChanged();
  showToast(`Measuring from ${lensDraft.reference}`);
});
byId('v2LensAddStop').addEventListener('click', () => {
  const draft = lensDraft;
  if (!draft || draft.stops.length >= MAX_STOPS) return;
  draft.stops.push({ at: 0.5, color: '#ff5c37' });
  renderLensStops();
  lensDraftChanged();
});
byId('v2LensReverse').addEventListener('click', () => {
  const draft = lensDraft;
  if (!draft) return;
  // The same colours, read the other way — black→white becomes white→black.
  draft.stops = reverseStops(draft.stops);
  renderLensStops();
  lensDraftChanged();
});
byId('v2LensSave').addEventListener('click', saveLensDraft);
byId('v2LensSaveAsNew').addEventListener('click', () => {
  const draft = lensDraft;
  if (!draft) return;
  // A copy is a NEW document: its own id, so saving it can never overwrite
  // the one it came from (Joshua, 2026-09-02: "save as new to not override
  // the defaults"). The name says where it came from.
  const source = draft.name.trim() || 'Lens';
  const copy = sanitiseLens({
    ...JSON.parse(JSON.stringify(draft)),
    id: newLensId(),
    name: `${source} copy`.slice(0, 40)
  });
  const result = saveLens(localStorage, lenses, copy);
  lenses = result.lenses;
  if (!result.saved) {
    setText('v2LensStatus', result.error ?? 'Could not save.');
    return;
  }
  syncCustomFilters();
  rebuildLensEntries();
  showToast(`Saved “${copy.name}” — the original is untouched`);
  // Carry on editing the copy, which is what someone who pressed this wants.
  openLensWorkbench(copy);
});
byId('v2LensDelete').addEventListener('click', deleteLensDraft);
byId('v2LensExport').addEventListener('click', exportLensDraft);
byId('v2LensClose').addEventListener('click', closeLensWorkbench);
byId('v2LensImportButton').addEventListener('click', () => byId<HTMLInputElement>('v2LensImport').click());
byId('v2LensEdit').addEventListener('click', () => {
  const lens = lensFromFilterId(readState().activeFilter);
  if (lens) openLensWorkbench(lens);
});
byId<HTMLInputElement>('v2LensImport').addEventListener('change', () => {
  const input = byId<HTMLInputElement>('v2LensImport');
  const file = input.files?.[0];
  input.value = '';
  if (file) void importLensFile(file);
});


/* --- The colour picker: a reading from the CAMERA FRAME (Milestone E.2) --- */

/**
 * A tap on the viewfinder samples the SOURCE frame, not the filtered render:
 * under Ironbow or a lens, the pixel on screen is a colour the ramp chose, so
 * reporting it would hand the palette back to the person who picked it. The
 * cover crop is mapped by capture/color-sampler.ts — the one owner of that
 * arithmetic — and the reading is the mean of a small patch, because a single
 * pixel of a live frame is mostly sensor noise.
 */
const PICK_PATCH = 9;
let pickCanvas: HTMLCanvasElement | null = null;

function setPickerActive(on: boolean): void {
  pickerActive = on;
  renderedGuideKey = '';
  renderGuides();
  byId('v2PickerCard').hidden = !on;
  byId('v2Viewfinder').classList.toggle('picking', on);
  byId<HTMLButtonElement>('v2PickColor').classList.toggle('active', on);
  renderPickerLensRow();
  if (on) setText('v2PickerHint', readState().camera?.state === 'live'
    ? 'Tap the viewfinder to read a colour from the camera frame.'
    : 'Start the camera first — there is no frame to read yet.');
}

function renderPickedColor(): void {
  const colour = pickedColor;
  const addStop = byId<HTMLButtonElement>('v2PickerAddStop');
  const copy = byId<HTMLButtonElement>('v2PickerCopy');
  if (!colour) {
    byId('v2PickerSwatch').style.background = '';
    setText('v2PickerHex', '—');
    setText('v2PickerDetail', '');
    addStop.disabled = true;
    copy.disabled = true;
    return;
  }
  const hex = toHex([colour.r, colour.g, colour.b]);
  byId('v2PickerSwatch').style.background = hex;
  setText('v2PickerHex', hex.toUpperCase());
  setText('v2PickerDetail',
    `rgb(${colour.r}, ${colour.g}, ${colour.b}) · luma ${colour.luma} · `
    + `mean of a ${PICK_PATCH}×${PICK_PATCH} patch of camera pixels`);
  copy.disabled = false;
  addStop.disabled = !lensDraft || lensDraft.stops.length >= MAX_STOPS;
  const useSample = document.getElementById('v2LensUseSample');
  if (useSample instanceof HTMLButtonElement) useSample.disabled = lensDraft === null;
  renderPickerLensRow();
}

/**
 * The picker's shortcut into the lens that is actually running.
 *
 * "I did pick a colour, but it appeared to look the same" (Joshua,
 * 2026-09-02). Sampling a colour and CHANGING WHAT THE LENS LOOKS FOR were
 * two separate acts: the sample landed in the picker, and the reference lived
 * in the workbench, so picking a colour did nothing visible unless you went
 * and opened the editor. This is the missing half — one button, named after
 * the lens it will change, and it writes to the saved lens so the change
 * survives the session.
 */
function renderPickerLensRow(): void {
  const button = byId<HTMLButtonElement>('v2PickerUseInLens');
  const lens = filterById(readState().activeFilter)?.lens ?? null;
  const wants = lens !== null && channelInfo(lens.color.channel).needsReference;
  button.hidden = !wants;
  if (!wants || !lens) {
    setText('v2PickerLensNote', lens
      ? `“${lens.name}” does not measure against a colour — it reads the picture itself.`
      : 'Pick a lens that looks for a colour (Colour Splash, Colour Hide, Paper → Pink) '
        + 'and this reading can become the colour it looks for.');
    return;
  }
  button.textContent = `Use in “${lens.name}”`;
  button.disabled = pickedColor === null;
  setText('v2PickerLensNote',
    `“${lens.name}” is looking for ${(lens.reference ?? '#ffffff').toUpperCase()} right now.`
    + (pickedColor ? ' This button changes it to the reading above.' : ''));
}

function sampleAtSource(point: Point): void {
  const source = readState().source;
  if (!source || video.videoWidth === 0) return;
  const patch = patchRect(point, { width: source.width, height: source.height }, PICK_PATCH);
  pickCanvas ??= document.createElement('canvas');
  pickCanvas.width = patch.width;
  pickCanvas.height = patch.height;
  const context = pickCanvas.getContext('2d', { willReadFrequently: true });
  if (!context) return;
  try {
    context.drawImage(video, patch.x, patch.y, patch.width, patch.height,
      0, 0, patch.width, patch.height);
    pickedColor = averageRgb(context.getImageData(0, 0, patch.width, patch.height).data);
  } catch {
    // A mid-switch video element can refuse a draw; the next tap recovers.
    return;
  }
  renderPickedColor();
}

/** A tap: mapped through the cover crop into the frame's own pixels. */
function sampleTap(tapX: number, tapY: number, boxWidth: number, boxHeight: number): void {
  const source = readState().source;
  if (!source) return;
  const point = tapToSource({ x: tapX, y: tapY },
    { width: boxWidth, height: boxHeight },
    { width: source.width, height: source.height });
  if (point) sampleAtSource(point);
}

/**
 * The centre of the FRAME — which the cover crop always shows at the centre
 * of the box, so the reticle marks exactly the pixels this reads.
 */
function sampleCentre(): void {
  const source = readState().source;
  if (!source) return;
  sampleAtSource({ x: (source.width - 1) / 2, y: (source.height - 1) / 2 });
}

byId('v2Viewfinder').addEventListener('pointerdown', (event) => {
  if (!pickerActive) return;
  const target = event.currentTarget as HTMLElement;
  // offsetX/offsetY and the element's own client box locate a POINT inside
  // the viewfinder; they decide no size, so this is not a second geometry
  // authority (measureViewfinder remains the one display read for sizing).
  sampleTap(event.offsetX, event.offsetY, target.clientWidth, target.clientHeight);
});
byId('v2PickerCentre').addEventListener('click', sampleCentre);
byId('v2PickerUseInLens').addEventListener('click', () => {
  const colour = pickedColor;
  const active = filterById(readState().activeFilter)?.lens ?? null;
  if (!colour || !active || !channelInfo(active.color.channel).needsReference) return;
  const hex = toHex([colour.r, colour.g, colour.b]);
  // The draft, when the workbench happens to be open on this very lens, is
  // the document being rendered — write to it, or the edit would be
  // overwritten the moment the workbench next syncs.
  const target = lensDraft && lensDraft.id === active.id ? lensDraft : { ...active, reference: hex };
  target.reference = hex;
  if (target === lensDraft) {
    renderLensBindings();
    lensDraftChanged();
  } else {
    const result = saveLens(localStorage, lenses, target);
    lenses = result.lenses;
    if (!result.saved) {
      showToast(result.error ?? 'Could not save the lens.');
      return;
    }
    syncCustomFilters();
    rebuildLensEntries();
    renderFilterStrip();
    renderPreview(performance.now());
  }
  renderPickedColor();
  showToast(`“${target.name}” is now looking for ${hex.toUpperCase()}`);
});

byId('v2PickColor').addEventListener('click', () => setPickerActive(!pickerActive));
byId('v2PickerClose').addEventListener('click', () => setPickerActive(false));
byId('v2PickerCopy').addEventListener('click', () => {
  const colour = pickedColor;
  if (!colour) return;
  const hex = toHex([colour.r, colour.g, colour.b]);
  const clipboard = navigator.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    void clipboard.writeText(hex).then(() => showToast(`Copied ${hex}`),
      () => showToast(`This browser refused the clipboard — the colour is ${hex}`));
    return;
  }
  showToast(`This browser has no clipboard access — the colour is ${hex}`);
});
byId('v2PickerAddStop').addEventListener('click', () => {
  const colour = pickedColor;
  const draft = lensDraft;
  if (!colour || !draft || draft.stops.length >= MAX_STOPS) return;
  draft.stops.push({ at: 0.5, color: toHex([colour.r, colour.g, colour.b]) });
  renderLensStops();
  lensDraftChanged();
  renderPickedColor();
  showToast('Added the sampled colour as a ramp stop.');
});

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
/**
 * The MAX-recording choice. Looked up WITHOUT byId: byId throws on missing
 * markup, and a fresh app.js booting against a cached older index.html would
 * then take every control wired after this line down with it — which is
 * exactly how the app was bricked on 2026-09-03. A missing checkbox must cost
 * only the checkbox.
 */
const forceMaxToggle = document.getElementById('v2ForceMaxRecord');
if (forceMaxToggle instanceof HTMLInputElement) {
  forceMaxToggle.checked = readState().forceMaxRecord;
  forceMaxToggle.addEventListener('change', () => {
    const forceMaxRecord = forceMaxToggle.checked;
    try {
      localStorage.setItem(FORCE_MAX_STORE_KEY, forceMaxRecord ? 'yes' : 'no');
    } catch {
      // Storage is optional; the session still honours the choice.
    }
    updateState({ forceMaxRecord });
    // RECORD IN is resolved from the inputs, so the truth table has to be
    // re-read for the new answer to appear rather than waiting for a frame.
    refreshGeometry();
  });
}

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
byId('v2ReverseRamp').addEventListener('click', () => {
  const id = readState().activeFilter;
  if (!canReverse(filterById(id))) return;
  // A toggle, so a second tap is exactly where you started — reversing a ramp
  // twice restores it, and nothing was written down in between.
  if (reversed.has(id)) reversed.delete(id);
  else reversed.add(id);
  setReversedFilters(reversed);
  renderedFilterKey = '';
  renderFilterStrip();
  renderPreview(performance.now());
  showToast(reversed.has(id)
    ? 'Ramp reversed for this session — the saved lens is untouched.'
    : 'Ramp back to normal.');
});
byId('v2SwitchCamera').addEventListener('click', () => void switchCamera());

// The installed app's update path. Promoting this page to the root document
// made it the thing people INSTALL, and an installed app that cannot notice a
// new build is the worst place to test a camera from: every fix looks failed.
registerServiceWorker();
// The build stamp: which version, and whether this is the installed app or a
// tab. On a phone that is the only way to tell a pushed fix from a resumed
// stale one — see version.ts.
setText('v2Badge', `v${APP_VERSION}${isStandalone() ? ' · PWA' : ''}`);

buildGuides();
buildFrameAverage();
buildAlignment();
buildSteadyShutter();
buildNightTest();
buildAids();
buildImport();
buildPrecisionProbe();
try {
  const stored = localStorage.getItem(GUIDE_STORE_KEY);
  if (stored && guideById(stored)) updateState({ guide: stored });
  updateState({ reticle: localStorage.getItem(RETICLE_STORE_KEY) === '1' });
  const averaging = localStorage.getItem(FRAME_AVERAGE_STORE_KEY);
  if (averaging && frameAverageById(averaging)) updateState({ frameAverage: averaging });
  const stripes = localStorage.getItem(ZEBRA_STORE_KEY);
  if (stripes && zebraById(stripes)) updateState({ zebra: stripes });
  const peak = localStorage.getItem(PEAKING_STORE_KEY);
  if (peak && peakingById(peak)) updateState({ peaking: peak });
} catch {
  // Storage is optional; the state's own defaults stand (no guide, no
  // reticle, and averaging at whatever render/frame-average.ts calls
  // default).
}
buildFilterStrip();
// Custom lenses append AFTER the built-ins, then the Custom + entry.
loadLensList();
syncCustomFilters();
rebuildLensEntries();
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
