# Visual Sensor Studio V2 — Shared State and Data-Driven Rules

This document is normative for the `Version2` rebuild. Read it with `docs/V2-FABLE-HANDOFF.md` and the V2 camera design spec before implementation.

## Why this exists

The legacy app accumulated several independent answers to the same questions: camera size, analysis size, preview size, recording size, still size, canvas size, filter availability, button lists, labels, and capability exceptions. That made it possible to fix one ceiling while another hidden ceiling still won.

V2 should remove that class of bug by giving every concept one owner and generating repeated UI/behavior from shared data instead of duplicating constants and switch statements.

## Rule 1 — One owner for every shared number

If two pieces of code mean the same physical or logical quantity, they must read the same value from the same owner.

Examples of values that must not be independently re-created in filters, recorders, canvases, or UI panels:

- negotiated camera source width/height
- source aspect ratio/orientation
- analysis target width/height
- preview render width/height
- photo render width/height
- recording-input width/height
- final encoded width/height
- delivered FPS
- analysis FPS
- recording FPS
- zoom state
- active filter id

A consumer may cache a derived value for performance, but the derivation must come from the central state/geometry authority and be invalidated when its inputs change.

Do not scatter magic values such as `1080`, `720`, `0.4 MP`, device-pixel ratios, canvas sizes, or frame-rate caps through unrelated modules.

## Rule 2 — Different concepts stay different

Centralization does not mean pretending every output has the same resolution.

These are intentionally different facts:

```text
SOURCE       what the camera actually negotiated
ANALYSIS     what vision algorithms can sustainably process
PREVIEW      what the current display needs
PHOTO        what a still render requests
RECORD IN    what the video encoder receives
ENCODED      what the finished file actually contains
```

They should all be resolved/reported through the same authority, but they must retain distinct names and diagnostics. Never reuse one variable merely because two dimensions happen to match today.

## Rule 3 — One frame geometry state

Prefer one typed state object along these lines:

```ts
interface FrameSize {
  width: number;
  height: number;
  aspect: number;
}

interface FrameGeometryState {
  source: FrameSize;
  analysis: FrameSize & { reason: string };
  preview: FrameSize & { reason: string };
  photo: FrameSize & { reason: string };
  recordInput: FrameSize & { reason: string };
  encodedVideo?: FrameSize;
}
```

Every canvas or renderer asks for the appropriate geometry. A canvas does not decide its own quality tier.

If a filter cannot honestly render at the requested output resolution because its temporal history exists at analysis resolution, report that restriction through geometry/diagnostics rather than silently substituting another size.

## Rule 4 — Reuse the same filter definition everywhere

A filter is defined once. Preview, still capture, fullscreen, and filtered recording call the same filter renderer with different explicit render contexts.

Do not create separate `previewIronbow`, `photoIronbow`, and `recordIronbow` implementations.

A render context may differ in size, cadence, history availability, and output destination. The visual mapping itself should not fork.

## Rule 5 — Prefer registries/arrays over repeated markup and switches

Repeated families of controls should be represented as data and rendered/wired from that data.

Good candidates include:

```text
FILTERS[]
CAMERA_MODES[]
RESOLUTION_TIERS[]
ZOOM_STOPS[]
CAPTURE_FORMATS[]
NAV_ROUTES[]
CAMERA_CONTROL_DEFINITIONS[]
```

Example:

```ts
const FILTERS: readonly CameraFilterDefinition[] = [
  {
    id: 'rgb',
    name: 'RGB',
    family: 'view',
    temporal: false,
    supportsPhoto: true,
    supportsVideo: true
  },
  {
    id: 'intensity',
    name: 'Intensity',
    family: 'view',
    temporal: false,
    supportsPhoto: true,
    supportsVideo: true
  },
  {
    id: 'trails',
    name: 'Trails',
    family: 'motion',
    temporal: true,
    supportsPhoto: false,
    supportsVideo: true
  }
];
```

The same registry should drive the filter strip, labels, capability checks, and routing where practical.

Do not maintain one list of filters in HTML, another in a mode switch, another for recording support, and another for photo support.

## Rule 6 — Reusable functions own repeated transformations

If more than one feature performs the same transformation, extract one reusable function/service instead of copying the arithmetic.

Examples:

- fit a size to an aspect ratio
- convert short-side target into width/height
- map preview taps through crop/letterbox/zoom
- calculate a bitrate recommendation
- calculate canvas/render target dimensions
- sample a color patch
- format diagnostics

The goal is not abstraction for its own sake. Extract only when the concept is genuinely the same.

## Rule 7 — State changes flow in one direction

Prefer:

```text
camera/capability event
        ↓
central V2 state
        ↓
geometry + filter registry + services
        ↓
renderers / capture / recording / UI readouts
```

Avoid UI widgets directly mutating canvases or recorder internals and avoid filters reaching backward into camera acquisition.

## Rule 8 — Diagnostics expose the master values

The compact V2 diagnostics should make accidental divergence visible immediately:

```text
SOURCE       1920×1440 · 29.9 delivered fps
ANALYSIS      512×384  · 14.8 fps
PREVIEW      1020×765
PHOTO        1920×1440 · JPEG
RECORD IN    1280×960  · 29.8 fps
ENCODED      1280×960  · H.264 · 8.2 Mb/s
```

If `RECORD IN` and `ENCODED` differ, flag the encoder resize. If PHOTO or RECORD IN is lower than SOURCE, state why.

## Rule 9 — No duplicated defaults hidden in multiple modules

User-facing defaults should live in one typed configuration/state definition. Feature modules may define their own algorithm-specific defaults, but they should not redefine app-wide camera, resolution, recording, navigation, or filter defaults.

## Rule 10 — Tests should catch duplicate ownership

Where practical, tests should verify:

- all output geometry comes from the geometry authority
- no filter creates an independent quality/resolution ceiling
- registry entries generate the expected filter controls
- photo/video support is read from filter metadata rather than duplicate allow/deny lists
- changing one source geometry updates every dependent output policy
- exact source/analysis/preview/photo/record/encoded values stay observable

## Summary

The V2 implementation rule is:

> One owner per concept. One geometry authority. One filter registry. One filter implementation. Reuse data and functions instead of copying numbers, buttons, lists, or routing logic.

When code starts needing a second copy of a shared number or a second list describing the same feature set, stop and route it back through the existing owner.