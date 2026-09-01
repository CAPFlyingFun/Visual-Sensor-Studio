# Visual Sensor Studio V2 — Camera-First Architecture

Date: 2026-09-01
Branch: `Version2`
Status: design and agent handoff

## Purpose

Visual Sensor Studio V2 is a camera laboratory first. The current app proved many useful algorithms and browser behaviors, but the orchestration layer grew large enough that camera acquisition, analysis, preview, still capture, and recording can now make separate decisions about frame size and timing.

V2 keeps the proven camera lifecycle and vision algorithms while rebuilding the camera-facing application around explicit boundaries and one frame-geometry authority.

The first milestone intentionally excludes GPS, terrain, Rig, Burst, and the larger secondary workspaces. Navigation may show routes for Sensors, World/3D, Data, and More, but Camera is the only fully implemented workspace initially.

## Safety rules for Fable / Claude

- Work only on branch `Version2`.
- Do not change, merge into, reset, or delete `main`.
- Treat `main` as the stable reference implementation and parts catalog.
- Do not copy the existing `src/main.ts` wholesale into a second giant controller.
- Reuse proven modules where their interfaces are already clean.
- Add focused V2 modules only when they have a real responsibility.
- The V2 entry should be reachable with `?scene=v2` while the legacy app remains the default during testing.
- Show a visible `V2 · Experimental` badge so a cached legacy build cannot be mistaken for V2.

## Current repo audit

The repo already contains valuable modular work under `src/sensors/`, `src/vision/`, `src/visualization/`, and `src/terrain/`. The pressure is mainly in orchestration and presentation. At the time of this design, `src/main.ts` is roughly 376 KB, `public/index.html` roughly 84 KB, `public/styles.css` roughly 59 KB, and `public/camera-bootstrap.js` roughly 66 KB.

The existing camera boundary is worth preserving. `src/vision/frame-source.ts` separates acquisition from processing with `FrameSource` / `AnalysisFrame`, and `src/sensors/camera.ts` bridges to the persistent plain-JavaScript camera engine. V2 UI and filters should not call `getUserMedia()` directly.

The current recording history shows the architectural problem clearly. Different parts of the app have independently used or capped negotiated camera size, requested capture tier, analysis size, live lens detail, logical-screen budget, device-pixel preview budget, `visionCanvas`, `recordCanvas`, recording detail, still/sensor recording size, codec limits, save-frame size, and imported-photo size. Several recent bugs happened because one ceiling was raised while another ceiling still won.

V2 must make those relationships explicit and observable.

## Milestone-one scope

### In scope

- Camera startup, resume, switch, hard reset, and permission diagnostics.
- Rear/front routing and browser-exposed manual controls.
- True negotiated stream dimensions and measured delivered FPS.
- Zoom with camera-vs-digital labeling.
- Live preview and fullscreen preview.
- Filter/lens workbench.
- Initial modes: RGB, brightness false color, Edges, Difference/Motion, Motion Speed, Motion Trails, Custom Lens, and reusable Night/Low-Light pieces.
- Color Picker foundation: center reticle, tap-to-sample, small-patch averaging, source and target colors.
- Histogram, zebra, and focus peaking where existing modules migrate cleanly.
- Still capture.
- Filtered video recording.
- Exact diagnostics for source, analysis, preview, photo, recorder input, and final encoded output.
- Bottom route buttons for later areas.

### Deferred

GPS, terrain, Rig, Burst/super-resolution, parallax, the large Data workspace, full World features, and advanced sensor dashboards.

## UI behavior

`docs/prototypes/visual-sensor-studio-v2-camera-workbench.html` is the visual reference for V2.

The important mobile behavior is:

1. Only the live camera/viewfinder is sticky in portrait.
2. Controls below it use normal page scrolling.
3. Do not create a giant sticky block containing camera + HUD + zoom + shutter + modes.
4. Keep HUD readouts compact and preferably over the camera image.
5. Put a horizontally scrollable filter/lens strip directly below the camera/capture area.
6. Selected filter is obvious; `Custom +` is a first-class entry.
7. Mode-specific controls appear below the strip.
8. Bottom navigation must not cover controls.
9. Landscape may use camera-left / controls-right when useful.
10. Judge the layout on real iPhone geometry, not only CSS-token tests.

## Core architecture

### CameraSource

Own the live browser-camera lifecycle and expose trustworthy frames/capabilities. Reuse the persistent camera engine and `CameraController` where practical.

Inputs: camera preference, capture tier, frame-rate request, zoom/manual controls.

Outputs: MediaStream, frame-delivery notifications, negotiated dimensions, measured delivered FPS, capabilities/settings/diagnostics.

### FrameGeometryAuthority

This is the central new V2 boundary. It is the only place that decides or reports dimensions for camera-derived work.

Conceptually:

```ts
interface FrameGeometryState {
  source: { width: number; height: number; aspect: number };
  analysis: { width: number; height: number; reason: string };
  preview: { width: number; height: number; reason: string };
  photo: { width: number; height: number; reason: string };
  recordInput: { width: number; height: number; reason: string };
  encodedVideo?: { width: number; height: number };
}
```

Rules:

- Source size comes from the negotiated stream, never CSS.
- Analysis size is a performance choice.
- Preview size is a display choice and must not silently redefine photo/video quality.
- Photo and recording request explicit output policies through this authority.
- Temporal filters must report when their history resolution limits honest output detail.
- Every downgrade has a human-readable reason.
- No filter, recorder, or UI component invents its own independent pixel ceiling.

### FramePipeline

One source frame enters one pipeline and consumers request explicit products:

```text
CameraSource
    ↓
Source Frame
    ↓
FrameGeometryAuthority
    ├─ Analysis Frame → field generators
    ├─ Preview Render → viewfinder
    ├─ Photo Render   → still capture
    └─ Record Render  → recorder
```

Photo and video must use the same filter definition and rendering semantics. They may use different dimensions or cadence, but not separate implementations of the visual effect.

### Field generators

Reuse measurable fields instead of making each filter independently re-read/recompute everything: luma, edges, change/difference, motion mask, optical flow/image speed, motion age/trail state, and later background novelty.

A field generator has no UI and does not care whether its output goes to preview, photo, or video.

### Filters and lenses

Use a small registry with a consistent contract, for example:

```ts
interface CameraFilter {
  id: string;
  name: string;
  family: 'view' | 'motion' | 'time' | 'night' | 'custom';
  temporal: boolean;
  supportsPhoto: boolean;
  supportsVideo: boolean;
  render(ctx: FilterRenderContext): ImageData | RenderTarget;
}
```

Preserve the strengths of `src/vision/lens.ts`: data-driven lens documents, measured channels, and no invented measurements.

Built-in filters and Custom Lens should use the same preview/photo/video rendering contract whenever practical.

### ColorSampler

Make color sampling a reusable service rather than embedding it in one lens.

Responsibilities:

- map a preview tap correctly through letterboxing/cropping/zoom
- sample the center reticle
- average a patch such as 5×5 instead of one noisy pixel
- report RGB, hex, and HSV/HSL-style values
- hold sampled source and target replacement colors

Replace, Isolate, Hide, Boost, Color Lock, and Color Watch can later consume this service.

### CaptureService

Still capture owns file creation/sharing, not filter math:

```text
Capture
 → request photo geometry
 → render current filter at that geometry
 → encode JPEG/PNG/etc.
 → report exact dimensions/bytes
 → share/save
```

The UI must show the exact saved dimensions.

### RecordingService

Recording owns MediaRecorder/WebCodecs decisions and final-file diagnostics, not filter math.

Two legitimate paths:

- RGB/native: borrow the camera stream directly when no filter processing is required.
- Filtered: consume the pipeline's explicit record render target.

Report source dimensions, record-render dimensions, MIME/codec path, requested bitrate, measured recording FPS, final encoded dimensions, and actual file size.

Final encoded dimensions should be measured from the produced file when possible. If Safari resizes, the file is authoritative.

Do not hard-code a low H.264 profile/level merely because it is widely decodable. Probe or use browser-default behavior and measure the result.

### Diagnostics

Use one compact truth table instead of scattered labels:

```text
SOURCE       1920×1440 · 29.9 delivered fps
ANALYSIS      512×384  · 14.8 fps
PREVIEW      1020×765  · display
PHOTO        1920×1440 · JPEG
RECORD IN    1280×960  · 29.8 fps
ENCODED      1280×960  · H.264 · 8.2 Mb/s
```

If a size differs, show why.

## Resolution policy

Avoid vague labels that hide different meanings. V2 should expose actual target dimensions and use user-level policies such as Efficient, Balanced, and Maximum practical.

The camera capture tier remains separate because no downstream output can recover pixels the source stream never delivered.

Live processing may intentionally downsample. Still capture may spend much more time per frame. Filtered video must select a sustainable record resolution instead of pretending still resolution can run at video cadence. Temporal filters may keep bounded history and must state that limit honestly.

## Routing

During testing:

- Default URL → current legacy application.
- `?scene=v2` → V2 camera application.
- V2 dock may show Camera / Sensors / World / Data / More.
- Camera is implemented.
- Other routes show a lightweight planned/placeholder state or a clear legacy link. Do not pull whole legacy subsystems into the V2 camera bundle just to make the buttons appear finished.

## Suggested V2 organization

```text
src/v2/
  app.ts
  state.ts
  camera/
    camera-source.ts
    geometry.ts
    frame-pipeline.ts
    diagnostics.ts
  filters/
    registry.ts
    rgb.ts
    false-color.ts
    edges.ts
    motion.ts
    speed.ts
    trails.ts
    custom-lens.ts
    color-sampler.ts
  capture/
    photo.ts
    video.ts
  ui/
    camera-workbench.ts
    filter-strip.ts
    controls.ts
    routes.ts
```

Do not create empty files simply to match the diagram.

## Migration order

### A. Trustworthy camera shell

`?scene=v2`, V2 badge, camera start/resume/switch/zoom, negotiated dimensions, delivered FPS, sticky viewfinder, scrollable controls, RGB preview.

### B. One render contract

FrameGeometryAuthority, FramePipeline, RGB + brightness false color + Edges, shared preview/still renderer, exact photo diagnostics.

### C. Recording truth

RGB direct recording, filtered recording through the shared render path, exact record-input/final encoded dimensions, bitrate/codec diagnostics, A/B codec tests without guessing.

### D. Temporal tools

Difference/Motion, Speed, Trails, explicit history resolution, sustainable recording policies.

### E. Lens workbench

Custom Lens migration, lens carousel, ColorSampler, tap/center picker, Replace/Isolate/Hide/Boost foundation.

### F. Camera instrumentation

Histogram, zebra, focus peaking, night/low-light, camera controls WebKit actually exposes.

Only after Camera V2 is stable should Sensors/3D/GPS migration be planned.

## Testing

Automated tests should verify behavior, not just CSS strings:

- geometry policies preserve aspect ratio
- preview policy cannot silently redefine photo/video policy
- every downgrade contains a reason
- photo and video use the same filter renderer
- tap coordinates map correctly through crop/letterbox/zoom
- no duplicate IDs
- no horizontal overflow at 430×932 and 320×568
- only the viewfinder is sticky in portrait
- all controls remain reachable while scrolling
- final clip dimensions are measured from the encoded file when possible
- legacy behavior is unchanged when `scene=v2` is absent

Real-device iPhone acceptance is required for camera lifecycle, PWA behavior, capabilities, negotiated FPS/resolution, MP4 behavior, sticky layout, and sharing. Desktop CI cannot mark those verified by itself.

## First testable V2 is successful when

1. `?scene=v2` opens the camera reliably.
2. Source resolution and delivered FPS are obvious.
3. RGB, brightness false color, Edges, Motion, and Custom Lens entries work.
4. Camera stays visible while lower controls remain comfortably scrollable.
5. A filtered photo reports its exact saved dimensions.
6. A filtered clip reports source, record-input, and final encoded dimensions/FPS.
7. Low-detail analysis is never silently upscaled and called full resolution.
8. `main` remains untouched.

## Agent note

Read the existing implementations before rewriting them. Preserve behavior learned from real iPhone failures, especially persistent camera lifecycle handling and honest frame-delivery measurement. Simplify ownership and data flow rather than deleting useful diagnostics.

The V2 rule is:

> One camera source. One geometry authority. One filter definition. Multiple explicit outputs.

If a second subsystem starts inventing its own answer to “what size is this frame?”, stop and route that decision back through the geometry authority.

---

## Adopted decisions — 2026-09-01, Milestone B (Joshua, via ChatGPT review)

Recorded here per the handoff rule that design changes are documented rather
than taken as silent liberties.

**1. The render contract is GPU-first.** Point-wise and small-kernel filters
(RGB pass-through, brightness false colour, edges, and later colour
isolate/replace/threshold/zebra) are WebGL fragment shaders. One renderer, one
shader per filter, and preview/photo/record are the same shader at different
target sizes — which makes Rule 4 (one filter implementation) structural
rather than a convention. Where WebGL is unavailable the page says so; there is
no parallel CPU implementation, because a fallback would be exactly the second
code path Rule 4 forbids.

Reason, measured on main: the CPU path produced 0.40 MP filtered frames at
6.0 fps while the camera delivered 12.2 MP — the architecture, not the
recorder, was the ceiling. The GPU keeps the high-resolution image
high-resolution and hands ANALYSIS the cheap miniature instead of the other
way round.

**2. The V2 benchmark.** Measured baseline from main (v0.39.7 diagnostic
line):

```
stream 3024x4032 · render 548x731 · encoded 548x732 · 6.0 fps
```

V2 recording quality is judged against that line, not against "looks better".

**3. Safari's MediaRecorder.mimeType is not evidence.** The same diagnostic
reported `codecs=avc1.42000a` — nominally Level 1.0, which cannot describe a
conforming 548×732 stream. The string is untrustworthy in both directions;
if profile/level ever matters, inspect the MP4's AVC configuration record
instead. Encoded dimensions measured from the file remain the authoritative
diagnostic.
