# Visual Sensor Studio V2 — Fable Handoff

Work only on branch `Version2`.

Do **not** modify, merge into, reset, or delete `main`.

Before writing V2 code, read:

1. `docs/superpowers/specs/2026-09-01-visual-sensor-studio-v2-camera-design.md`
2. `docs/prototypes/visual-sensor-studio-v2-camera-workbench.html`
3. Existing camera/vision modules that implement the behavior being migrated.

## Goal

Build a camera-first V2 reachable through:

```text
?scene=v2
```

The legacy app remains the default when that query parameter is absent.

The first V2 is Camera only. Keep route buttons for Sensors, World/3D, Data, and More, but do not migrate GPS, terrain, Rig, Burst, or the large secondary workspaces yet.

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

## Architectural non-negotiable

V2 gets one frame-geometry authority.

Camera source size, analysis size, preview size, photo size, recording-input size, and final encoded size are different facts, but there should be one module responsible for resolving and reporting them.

No filter, recorder, canvas, or UI panel should invent an independent resolution ceiling.

The guiding rule is:

> One camera source. One geometry authority. One filter definition. Multiple explicit outputs.

Preview, still capture, and filtered recording must use the same filter implementation. They may render at different target sizes/cadences, but not through separate visual-effect code paths.

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
5. Frame geometry authority.
6. Shared render contract for preview + still.
7. Brightness false color + Edges.
8. Exact saved-photo dimensions.
9. RGB direct video + filtered video through the shared render path.
10. Exact record-input and final encoded dimensions/FPS.
11. Difference/Motion, Speed, Trails.
12. Custom Lens and Color Picker service.

Do not start by migrating every old feature.

## Testing

Keep `main` behavior unchanged when `scene=v2` is absent.

Automated tests should verify actual geometry/data flow, not only the presence of CSS strings. Real iPhone testing is required before declaring camera/PWA/MP4 behavior verified.

If a design decision conflicts with the V2 spec, stop and preserve the spec rather than taking a new architectural liberty without asking.
