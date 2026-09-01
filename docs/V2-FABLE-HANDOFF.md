# Visual Sensor Studio V2 — Fable Handoff

Work only on branch `Version2`.

Do **not** modify, merge into, reset, or delete `main` unless Joshua explicitly approves it first.

Before writing V2 code, read:

1. `docs/superpowers/specs/2026-09-01-visual-sensor-studio-v2-camera-design.md`
2. `docs/V2-DATA-DRIVEN-RULES.md`
3. `docs/prototypes/visual-sensor-studio-v2-camera-workbench.html`
4. Existing camera/vision modules that implement the behavior being migrated.

## Goal

Build a camera-first V2 designed to be reachable through:

```text
?scene=v2
```

The legacy app remains the default when that query parameter is absent.

The first V2 is Camera only. Keep route buttons for Sensors, World/3D, Data, and More, but do not migrate GPS, terrain, Rig, Burst, or the large secondary workspaces yet.

## Production / preview safety

The existing GitHub Pages workflow currently deploys only pushes to `main`.

Therefore, code that exists only on `Version2` is **not automatically available at the current live Pages URL**. Do not work around this by deploying `Version2` over the production Pages environment, because that would replace the stable live site.

Build `Version2` so the V2 route is ready for the current Pages build system, but keep production untouched until Joshua approves a preview bridge or merge strategy.

If live-device testing from the production URL becomes necessary before the full merge, stop and ask for approval for the smallest safe exposure mechanism. Do not silently change `main` or the production deployment workflow.

## Preserve what already works

The current repo is a reference implementation, not something to blindly copy.

Especially preserve the lessons in:

- `public/camera-bootstrap.js`
- `src/sensors/camera.ts`
- `src/vision/frame-source.ts`
- `src/vision/frame-rate.ts`
- `src/vision/lens.ts`
- `src/vision/motion-ironbow.ts`
- `src/vision/overlays.ts`
- current camera/recording diagnostics and real-iPhone failure handling

Do not reintroduce direct `getUserMedia()` ownership into V2 UI/filter code.

## Architectural non-negotiables

### One geometry authority

V2 gets one frame-geometry authority.

Camera source size, analysis size, preview size, photo size, recording-input size, and final encoded size are different facts, but there should be one module responsible for resolving and reporting them.

No filter, recorder, canvas, or UI panel should invent an independent resolution ceiling.

The guiding rule is:

> One camera source. One geometry authority. One filter definition. Multiple explicit outputs.

Preview, still capture, and filtered recording must use the same filter implementation. They may render at different target sizes/cadences, but not through separate visual-effect code paths.

### One owner for every shared number or state

If two parts of V2 mean the same quantity, they must read the same value from the same owner.

Do not duplicate camera dimensions, aspect ratio, analysis dimensions, preview dimensions, photo dimensions, record-input dimensions, FPS values, zoom state, active filter id, or app-wide defaults in multiple modules.

Different concepts must remain separately named even when their values happen to match. `source`, `analysis`, `preview`, `photo`, `recordInput`, and `encodedVideo` are not interchangeable aliases.

### Data-driven registries instead of repeated code

Prefer shared arrays/registries/configuration for repeated feature families such as:

```text
FILTERS[]
CAMERA_MODES[]
RESOLUTION_TIERS[]
ZOOM_STOPS[]
CAPTURE_FORMATS[]
NAV_ROUTES[]
CAMERA_CONTROL_DEFINITIONS[]
```

Where practical, the same registry should drive UI buttons, labels, support metadata, and routing.

Do not maintain separate hard-coded lists for the same filters in HTML, click handlers, recording support, photo support, and mode switches.

Extract reusable functions when multiple features perform the same real transformation, such as fitting dimensions, mapping taps through crop/letterbox/zoom, sampling a color patch, sizing a render target, or formatting diagnostics.

Read `docs/V2-DATA-DRIVEN-RULES.md` for the full rules.

## UI rule

The prototype defines the visual language.

On portrait mobile:

- only the camera/viewfinder is sticky
- the controls below scroll normally
- do not make the camera + HUD + zoom + capture + filters one giant sticky head
- put the horizontally scrollable Filters/Lenses strip near the camera
- keep `Custom +` visible as a first-class lens entry
- keep HUD measurements compact

Real iPhone usability wins over desktop-perfect geometry.

## First implementation order

1. `?scene=v2` routing + visible `V2 · Experimental` badge.
2. Camera start/resume/switch/zoom using the existing camera engine.
3. Source resolution + measured delivered FPS.
4. Sticky camera workbench with RGB only.
5. Frame geometry authority + shared V2 state.
6. Shared render contract for preview + still.
7. Data-driven filter registry used by the filter strip and capability metadata.
8. Brightness false color + Edges.
9. Exact saved-photo dimensions.
10. RGB direct video + filtered video through the shared render path.
11. Exact record-input and final encoded dimensions/FPS.
12. Difference/Motion, Speed, Trails.
13. Custom Lens and Color Picker service.

Do not start by migrating every old feature.

## Testing

Keep legacy behavior unchanged when `scene=v2` is absent.

Automated tests should verify actual geometry/data flow, not only the presence of CSS strings.

Add tests that make duplicate ownership difficult to reintroduce: output sizes should come from the geometry authority, filter support from registry metadata, and changes to source geometry should propagate through the expected dependent policies.

Real iPhone testing is required before declaring camera/PWA/MP4 behavior verified.

If a design decision conflicts with the V2 spec or the data-driven rules, stop and preserve the documentation rather than taking a new architectural liberty without asking.