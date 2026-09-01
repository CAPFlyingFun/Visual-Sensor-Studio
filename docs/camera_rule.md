# Camera terminology and resolution architecture

Authoritative reference for all V2 camera work. When code, comments,
diagnostics or cards disagree with this document, flag it — do not invent a
compromise. Adopted 2026-09-01 from Joshua's terminology correction, with the
two device screenshots of that date as the measured baseline.

## The terms

| TERM | MEANS |
| --- | --- |
| Camera Capability | Maximum stream size WebKit advertises through track capabilities |
| Camera Stream / Source | Actual negotiated live video dimensions, measured from the stream |
| Viewfinder | Visible UI rectangle in CSS/device pixels — display geometry, not camera |
| Preview Render | GPU render used to fill the viewfinder |
| Analysis | Independent computer-vision working resolution |
| Photo Output | Render/save dimensions for a still photo |
| Recording Render | Future processed video render dimensions |
| Encoded Output | Actual dimensions written into saved media, measured from the file |
| Encoder Capability | Largest frame (in 16×16 macroblocks) the device's video encoder can write — measured by the encoder probe, assumed at the H.264 Level 5.2 line (36,864) until then. A bound on Recording Render, separate from Camera Capability |

Do not call all of these "camera resolution". Each is a separate fact with a
separate owner, and several of them being equal today is never a reason to
merge them (V2 data-driven Rule 2).

## The core rule

**MAXIMUM SAVED OUTPUT DOES NOT MEAN MAXIMUM LIVE CAMERA STREAM.**

The live stream is a **performance decision**: responsive, smooth, sized for
real-time delivery. The photo is a **quality decision**: the most genuine
detail the camera will grant, fetched only for the shot.

```text
NORMAL:
  camera stream (responsive)
      ├── preview render → viewfinder
      └── analysis (independent, downsampled)

SHUTTER:
  remember current stream mode
  temporarily request the maximum STREAM through the EXISTING track
  wait for a confirmed decoded frame AFTER the request, then use the
    dimensions that actually arrived (a stream already at maximum has no
    change to wait for — that is a normal case, not a failure)
  render the active shader once at that measured size
  save the JPEG, report exact saved dimensions
  restore the responsive stream, confirm a decoded frame again
```

Maximum-resolution stream modes are NORMALLY requested temporarily for
high-quality capture. That is the default policy, not a universal law: a
future deliberate mode (a "Detail Live" that holds the full sensor at its
lower rate, eyes open) is allowed — what is forbidden is the maximum
arriving by accident, inheritance, or a shutter that forgot to walk back.

Reference measurements on the test iPhone (device measurements, not
universal constants): responsive live ≈ 720×960 at ~60 delivered fps;
maximum stream ≈ 3024×4032 (~12.2 MP) at ~30 delivered fps when held
continuously.

## No silent inheritance

**No downstream output may silently inherit its resolution policy from
another layer.**

- Viewfinder size may determine PREVIEW render size.
- Viewfinder size must NEVER determine PHOTO output size.
- Analysis size must NEVER determine PHOTO output size.
- Photo output policy must NEVER force the ordinary live stream to stay at
  maximum resolution.
- A SOURCE smaller than CAPABILITY is not an error; it is usually the
  intentional responsive configuration.
- Recording output must eventually have its own policy as well (Milestone C).

## Every downgrade names its reason

Never "quality was reduced" or "resolution was lowered". Say WHICH layer
changed and why:

- "preview fitted to display pixels"
- "analysis downsampled for real-time processing"
- "live stream kept responsive for delivered fps"
- "max capture unavailable — WebKit kept the negotiated mode"

## Measured facts vs explanations

Comments and diagnostics state what was measured; explanations of WebKit
behaviour are labelled as explanations unless the before/after of the exact
operation was measured. Known measured behaviours worth respecting:

- WebKit negotiates a live track DOWN readily and routinely ignores a request
  to RAISE it; the reliable place to ask for a large stream is the opening
  getUserMedia call. Anything raising a live stream must verify the result
  with a decoded frame — a resolved `applyConstraints` promise proves
  nothing.
- Stream size and frame rate are properties of one camera mode; a second
  constraint can renegotiate the mode. Auto never re-constrains a live track.
- Requested dimensions are never delivered dimensions. Report what arrived.

## Where the terms live in code

- Engine (`public/camera-bootstrap.js`): owns the CAMERA STREAM request and
  the CAPABILITY read. Its `setPreferredCaptureHeight` / `setCaptureHeight` /
  `preferMaxCaptureSize` / `applyMaxCaptureSize` names are kept for
  compatibility; all of them alter the STREAM request only.
- `src/v2/camera/geometry.ts`: the one authority resolving ANALYSIS, PREVIEW
  and PHOTO against a given SOURCE, each with its reason.
- `src/v2/capture/shutter.ts`: the shutter's temporary maximum-stream window
  — escalate, confirm with a decoded frame, render, restore, confirm again.
- `src/v2/state.ts`: SOURCE, CAPABILITY, VIEWFINDER, LAST PHOTO as separate
  facts; the Source-truth panel renders them one row each.


## The encoder has its own ceiling (measured 2026-09-01)

The camera terminology hydra grew a head that none of the layers above
predicted. On the reference iPhone:

- the camera DELIVERS 3024×4032 (Camera Stream, measured);
- the GPU RENDERS it (Preview Render / Photo Output, measured);
- the JPEG SAVES it (Encoded Output for stills, measured);
- and every H.264 file above **36,864 macroblocks** comes back
  undecodable — at 5 fps as surely as at 30.

The encoder probe (Recording card → "Probe encoder envelope") recorded a
synthetic moving-noise canvas through the same recorder the clips use:
2160×2880 (24,300 MBs) and 2592×3456 (34,992) decode; 2688×3584 (37,632)
and 3024×4032 (47,628) do not, at any fed rate. That is the H.264 Level
5.2 frame-size limit, a property of the ENCODER — not the camera, the GPU,
the container, the bitrate, or the frame rate. No frame rate fixes it and
no recorder restart fixes it: each frame itself violates the level.

So **Encoder Capability** is a capability fact of its own, and Recording
Render is held under it with the reason named in the RECORD IN row.
The rule for the video ceiling: **the largest frame the encoder can
write, at the stream's aspect, never upscaled** — assumed at Level 5.2
until the probe measures the device, and a measurement overrides the
assumption in either direction. A device that encodes 47,628 gets its
MAX clips; one that fails lower gets a lower, honest ceiling. RGB clips
borrow the camera stream directly only while the stream fits the
envelope; above it even RGB goes through the render, because that is the
only way to hand the encoder a frame it can write.

Photos are untouched by any of this: JPEG has no such level, and the
shutter still saves the sensor's full 3024×4032.
