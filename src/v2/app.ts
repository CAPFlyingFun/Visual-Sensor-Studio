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

/* --- Camera events flow INTO the state; the UI renders FROM it (Rule 7). -- */

camera.subscribe((status: CameraStatus) => {
  const d = camera.diagnostics;
  updateState({
    camera: status,
    zoom: status.zoom,
    source: frameSize(d.videoWidth, d.videoHeight)
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
    updateState({
      deliveredFps: meter.report.deliveredFps,
      // The negotiated size can settle a beat after `live`; re-read it on
      // frames so SOURCE is the stream's own answer, not a stale one.
      source: frameSize(camera.diagnostics.videoWidth, camera.diagnostics.videoHeight)
    });
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

function renderZoomStops(): void {
  const holder = byId('v2ZoomStops');
  const zoom = readState().zoom;
  holder.replaceChildren();
  if (!zoom || zoom.kind === 'none') return;
  // zoomPresetStops is the legacy app's own arithmetic, reused rather than
  // re-derived (Rule 6): the stops come from the range the engine reports.
  for (const stop of zoomPresetStops(zoom.min, zoom.max)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${stop}×`;
    button.dataset.zoomStop = String(stop);
    if (Math.abs(stop - zoom.value) < 0.05) button.classList.add('active');
    button.addEventListener('click', () => { void camera.setZoom(stop); });
    holder.appendChild(button);
  }
}

/* --- Rendering: everything below reads the state, never the engine ------- */

function renderHud(): void {
  const { camera: status, source, deliveredFps, zoom } = readState();
  const live = status?.state === 'live';
  byId('v2HudDot').dataset.state = status?.state ?? 'idle';
  setText('v2HudState', live ? 'LIVE' : (status?.state ?? 'idle').toUpperCase());
  setText('v2HudSource', source ? `${source.width}×${source.height}` : '—');
  setText('v2HudFps', deliveredFps > 0 ? `${deliveredFps.toFixed(1)} fps` : '— fps');
  setText('v2HudZoom', zoom && zoom.kind !== 'none'
    ? `${zoom.value.toFixed(1)}× ${zoom.kind}`
    : '—');
}

function renderDiagnostics(): void {
  const { camera: status, source, deliveredFps } = readState();
  const d = camera.diagnostics;
  // The compact truth table starts with its first row. ANALYSIS, PREVIEW,
  // PHOTO, RECORD IN and ENCODED join it in later milestones, each from the
  // geometry authority — SOURCE is deliberately the only row A can claim.
  setText('v2DiagSource', source
    ? `${source.width}×${source.height} · ${deliveredFps > 0 ? deliveredFps.toFixed(1) : '—'} delivered fps`
    : 'not started');
  setText('v2DiagState', status ? `${status.state} · ${status.stage}` : 'idle');
  setText('v2DiagTrack', d.trackLabel
    ? `${d.trackLabel}${d.trackMuted ? ' · muted' : ''}`
    : '—');
}

function renderControls(): void {
  const { camera: status } = readState();
  const state = status?.state ?? 'idle';
  const enable = byId<HTMLButtonElement>('v2EnableCamera');
  enable.hidden = state === 'live' || state === 'requesting';
  enable.textContent = state === 'suspended' ? 'Resume Camera' : 'Enable Camera';
  byId<HTMLButtonElement>('v2SwitchCamera').disabled = state !== 'live';
  if (status && state === 'error') setText('v2Stage', status.reason || 'Camera error.');
  else if (state === 'live') setText('v2Stage', '');
  else if (state === 'suspended') {
    setText('v2Stage', 'The camera was released (backgrounding or a system takeover). Resuming needs a tap.');
  }
}

subscribe(() => {
  renderHud();
  renderDiagnostics();
  renderControls();
  renderZoomStops();
});

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
byId('v2SwitchCamera').addEventListener('click', () => void switchCamera());
byId('v2LegacyLink').addEventListener('click', () => {
  const back = new URL(location.href);
  back.searchParams.delete('scene');
  back.pathname = back.pathname.replace(/v2\.html$/, 'index.html');
  location.href = back.toString();
});

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
