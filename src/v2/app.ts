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
        previewBoxShortSide: viewfinder.shortSide
      })
      : null
  });
}
window.addEventListener('resize', refreshGeometry);

/* --- The pipeline: one frame in, explicit products out -------------------- */

const previewMeter = new FrameRateMeter();

function renderPreview(now: number): void {
  const { source, geometry, activeFilter } = readState();
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
  if (renderer.render(activeFilter, resolved.preview)) {
    byId('v2PreviewCanvas').hidden = false;
    previewMeter.recordProcessed(now, 0);
    updateState({ previewFps: previewMeter.report.processingFps });
  }
}

/* --- Camera events flow INTO the state; the UI renders FROM it (Rule 7). -- */

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
    source: frameSize(d.videoWidth, d.videoHeight),
    capability: frameSize(d.capabilityWidth, d.capabilityHeight)
  });
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
      // frames so SOURCE is the stream's own answer, not a stale one. The
      // capability rides along — WebKit fills it in once the track is real.
      source: frameSize(d.videoWidth, d.videoHeight),
      capability: frameSize(d.capabilityWidth, d.capabilityHeight)
    });
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
  const { camera: status, source, deliveredFps, zoom } = readState();
  const live = status?.state === 'live';
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
      + (captureActive ? 'maximum stream for this shot' : 'responsive live stream')
    : 'not started');
  setText('v2DiagCapability', capability
    ? `${capability.width}×${capability.height} · the track's advertised maximum`
    : 'not exposed by this browser');
  setText('v2DiagViewfinder', viewfinder
    ? `${viewfinder.width}×${viewfinder.height} device px · display geometry, PREVIEW’s only input`
    : '—');
  const row = (entry: { width: number; height: number } | null | undefined) =>
    entry ? `${entry.width}×${entry.height}` : '—';
  setText('v2DiagAnalysis', geometry
    ? `${row(geometry.analysis)} · independent vision buffer (unused until Milestone D)`
    : '—');
  setText('v2DiagPreview', geometry
    ? `${row(geometry.preview)} · ${live && previewFps > 0 ? previewFps.toFixed(1) : '—'} rendered fps · sized for the viewfinder`
    : '—');
  setText('v2DiagPhotoPolicy', 'maximum available stream on shutter');
  setText('v2DiagLastPhoto', lastPhoto
    ? `${lastPhoto.width}×${lastPhoto.height} · ${(lastPhoto.bytes / 1e6).toFixed(2)} MB JPEG · as saved`
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
  const { camera: status, captureActive } = readState();
  const state = status?.state ?? 'idle';
  const key = `${state}|${status?.stage ?? ''}|${status?.reason ?? ''}|${captureActive}|${renderer.unavailableReason}`;
  if (key === renderedControlsKey) return;
  renderedControlsKey = key;
  const enable = byId<HTMLButtonElement>('v2EnableCamera');
  enable.hidden = state === 'live' || state === 'requesting';
  enable.textContent = state === 'suspended' ? 'Resume Camera' : 'Enable Camera';
  byId<HTMLButtonElement>('v2SwitchCamera').disabled = state !== 'live' || captureActive;
  byId<HTMLButtonElement>('v2PhotoButton').disabled =
    state !== 'live' || captureActive || Boolean(renderer.unavailableReason);
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

let renderedFilter = '';
function renderFilterStrip(): void {
  const { activeFilter } = readState();
  if (activeFilter === renderedFilter) return;
  renderedFilter = activeFilter;
  for (const button of byId('v2FilterStrip').querySelectorAll<HTMLButtonElement>('[data-filter]')) {
    button.classList.toggle('active', button.dataset.filter === activeFilter);
  }
  const filter = filterById(activeFilter);
  setText('v2FilterNote', filter?.id === 'ironbow'
    ? 'False colour: visible-light brightness through the Ironbow ramp — not thermal.'
    : '');
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
function shutterStream(): ShutterStream {
  const withFrames = video as HTMLVideoElement & {
    requestVideoFrameCallback?: (callback: () => void) => number;
  };
  return {
    measure: () => ({ width: video.videoWidth, height: video.videoHeight }),
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

const CAPTURE_REASONS: Record<Escalation, string> = {
  granted: 'the largest stream the camera granted for this shot',
  unchanged: 'the camera kept its current mode',
  declined: 'the camera declined a larger mode'
};

let capturing = false;
async function takePhoto(): Promise<void> {
  const { camera: status } = readState();
  if (capturing || !camera.active || status?.state !== 'live') return;
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
  restoration: string;
  timing: {
    maxFrameReadyMs: number; stillDoneMs: number;
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
  const placeholder = byId('v2RoutePlaceholder');
  placeholder.hidden = id === 'camera';
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
byId('v2SwitchCamera').addEventListener('click', () => void switchCamera());
byId('v2LegacyLink').addEventListener('click', () => {
  const back = new URL(location.href);
  back.searchParams.delete('scene');
  back.pathname = back.pathname.replace(/v2\.html$/, 'index.html');
  location.href = back.toString();
});

buildFilterStrip();
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
