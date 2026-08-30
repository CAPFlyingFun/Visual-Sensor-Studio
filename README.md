# Visual Sensor Studio

A mobile-first Progressive Web App for experimenting with an iPhone's browser-accessible camera, motion/orientation sensors, GPS, image processing, parallax depth cues, and interactive 3D data visualization.

The first release is intentionally an **instrument playground**, not a fake LiDAR app. It separates measured data from inferred/visualized data and labels experimental outputs clearly.

## What the app does

- **Live camera lab** with rear/front switching and six view modes: RGB,
  Relief, Edges, Motion, Optical Flow and Frame Difference.
- **Camera zoom** — real MediaTrack zoom where the browser exposes it,
  otherwise a clearly labelled digital centre crop. Slider, quick stops and
  pinch-to-zoom all drive the same value.
- **Live instrument readout**: Brightness, Contrast, Detail, Motion, actual
  processed-frame FPS, and the zoom value with its type.
- **Device orientation + motion** with iOS permission handling.
- **Interactive Three.js sensor scene** showing the phone orientation and acceleration vector.
- **Optional GPS breadcrumb track** rendered in the same 3D scene, using approximately one scene unit per meter from the first GPS point.
- **Two-frame parallax depth experiment**: capture frame A, move the phone sideways, capture B, then estimate relative disparity with block matching.
- **Sensor JSON export** for the latest motion/GPS/parallax/vision summary.
- **PWA installability and offline shell caching** after the app has loaded once.
- **Camera diagnostics and recovery**, including a hard reset and an attempt
  log that survives reloads.
- **Observation tools** for fast or short-lived events: measured frame
  delivery, an adaptive analysis rate, generic moving-object tracking with
  trails, a frame-rate benchmark, and a computational Night/Low Light lab.
- **GitHub Pages deployment** through GitHub Actions.

## The iOS standalone-PWA camera problem

The camera works in a normal Safari tab and from a browser-style Home Screen
shortcut, but can fail when the site is installed as a standalone PWA — often
without the permission prompt you would expect.

**In the case this app was actually debugged against, the cause was an iOS
setting, not a WebKit bug.** `Settings > Apps > Safari > Camera` was set to
**Deny**. On Deny, `getUserMedia()` is refused in a couple of milliseconds
with `NotAllowedError` and no prompt is ever shown — and because an installed
web app does not inherit a per-site grant given to the same site in a Safari
tab, it falls back to that global default. That is the whole of "works in the
browser, fails in the installed app", with no exotic bug required.

So check the settings first. The diagnostics below are built to tell you when
that is what you are looking at: a refusal that returns in milliseconds cannot
have involved a prompt anybody dismissed.

The WebKit bugs below are real and the mitigations for them are worth having,
but they are the second thing to suspect, not the first.

| WebKit behaviour | What the app does |
| --- | --- |
| A capture grant is bound to the top frame document's current URL, and a URL change can tear down the media environment mid-capture ([215884](https://bugs.webkit.org/show_bug.cgi?id=215884), [212040](https://bugs.webkit.org/show_bug.cgi?id=212040)) | The app never changes its own URL while running, and strips its `refresh` cache-buster once at startup, before any camera request |
| `getUserMedia()` resolves with a track reporting `readyState: "live"` while the video element never receives a decoded frame ([252465](https://bugs.webkit.org/show_bug.cgi?id=252465)) | Liveness is proved by an actual decoded frame — `requestVideoFrameCallback`, or an advancing `currentTime` — never by `readyState` or `videoWidth`, both of which the broken state satisfies. No frame means a reported failure, not "Camera Live" |
| Calling `getUserMedia()` again can kill the previous stream's video ([179363](https://bugs.webkit.org/show_bug.cgi?id=179363)), and standalone mode does not persist the grant, so each call may re-prompt ([185448](https://bugs.webkit.org/show_bug.cgi?id=185448)) | Constraint fallbacks are tried only for genuine constraint errors. A no-frames failure ends in a hard reset and a user-driven retry. There is no automatic camera-request loop |
| Tracks mute across a background/foreground transition and never unmute | Backgrounding fully releases the camera and enters a `suspended` state. Returning shows **Resume Camera**; a brand-new stream starts from that tap |

**What remains broken.** If WebKit refuses to deliver frames in standalone
mode on a given device or OS build, no amount of application code fixes that.
The honest outcome is a clear failure with diagnostics, plus the suggestion to
use Safari — which is what the app does. A full device restart has sometimes
cleared the condition, which is itself a sign the fault is below the web
layer. **None of these mitigations is a guaranteed fix.**

### Reading a camera failure

In-memory camera state is wiped by any reload, so diagnostics read after a
restart show `idle` no matter what failed beforehand. The **Last camera
attempt** row is therefore backed by a log that outlives the page, and it
distinguishes three failures that otherwise look identical:

| Reading | Meaning |
| --- | --- |
| `NotAllowedError at stage "getUserMedia"` after a few ms | Refused with no prompt shown — an iOS-level block. Check `Settings > Apps > Safari > Camera` first, then Screen Time |
| `NotAllowedError at stage "getUserMedia"` after a second or more | A prompt was probably shown and dismissed |
| `NotReadableError at stage "first-frame" … track live` | The WebKit fake-success: the track is live, the video has dimensions, and no frame ever arrived |
| `getUserMedia never settled — no prompt, no resolve, no reject` | The call was entered and never came back. No live state can show this after a reload |

A live `stage:` trace also appears under the camera controls during a request,
so a stalled call is visible without opening Settings. **Copy Diagnostics**
puts the whole report, including the attempt log, on the clipboard.

Settings → Diagnostics also reports camera state and request stage, track
readyState/muted, the video element's state, **time to first decoded frame**
and how it was detected, hardware-zoom support and range, processing FPS,
display mode, secure context, and storage usage. **Hard Reset Camera** tears
the media element fully down (stop tracks → pause → clear `srcObject` →
`load()` → restore `playsinline`/`autoplay`/`muted`) for a clean restart.

## Four different frame rates

These get conflated constantly, and the app keeps them apart because only one
of them is a measurement:

| Rate | What it is |
| --- | --- |
| **Camera capture** | What the sensor is configured to run at. Not observable from the web platform — only the track's *claim* is. |
| **Delivered** | Video frames the page actually receives. Counted from `requestVideoFrameCallback` and de-duplicated by `mediaTime`. **This is the honest number.** |
| **Vision processing** | Frames the pipeline actually analysed. |
| **Display** | `requestAnimationFrame` — the screen's refresh rate, which has nothing to do with the camera. |

A 30 fps camera on a 60 Hz screen presents every frame twice. Counting
callbacks reports 60; counting *distinct* `mediaTime` values reports 30. The
old loop was driven by `requestAnimationFrame` and could not tell the
difference, so analysis was capped by the display and a repeated frame was
indistinguishable from a new one. Analysis is now driven by frame delivery.

**Camera Frame Rate** offers Auto Max / 30 / 60 / 120 / 240. A rate is
requested with `ideal`+`max`, never `exact` — on WebKit an unsatisfiable
`exact` fails the whole `getUserMedia` call, which would take the camera down
instead of falling back. Rate changes use `applyConstraints` on the live
track, so they cannot re-prompt for permission or drop the stream.

**Run the benchmark** (Settings → Camera Performance) to find out what this
device really does. It applies 30/60/120/240 to the live track, counts
presented frames for each, and reports `accepted`, `negotiated`, `unsupported`
or `unstable` from the *measured* rate rather than the requested one. If
WebKit only gives 60, it will say 60.

## Adaptive analysis

The camera stream stays at a stable rate; only the expensive analysis varies.
Renegotiating camera constraints on every movement is slow, visible, and on
WebKit can drop the stream.

The rate comes from how far the fastest tracked object moves **between
analyses**, not from a motion percentage — 30 fps is useless if the subject
crosses 40 px per frame, and wasteful if it crosses a fraction of one. Rise is
roughly 11× faster than fall: arriving at the right rate after the event has
passed is the same as missing it, while falling slowly costs only power.
Hysteresis stops a steady scene oscillating. The target is capped by measured
delivery and by what the device can actually process.

## Object tracking

Connected regions of the motion mask, followed over time by predicted-position
association. This is **not** semantic recognition — the tracker has no idea
what anything is, and the app does not guess. It observes movement; it does
not decide what caused it.

Speeds are in **analysis-frame pixels per second** and stay that way.
Converting to m/s or mph needs distance to the subject and the lens's angular
scale, neither of which this app has.

## Night / Low Light

Computational low-light enhancement — **not** infrared. The camera does not
become an IR sensor, and the Green palette is a colour scheme, not night
vision.

WebKit exposes no hardware shutter, so a 30-second exposure is assembled from
the frames that arrive during those 30 seconds: each is folded into a fixed
accumulator and discarded, so memory is constant in exposure length.

| Stack mode | What it does |
| --- | --- |
| **Clean** | Averages frames. Random noise falls away, stationary detail survives. Best on a tripod. |
| **Brighten** | Accumulates and tone-maps, so dim signal climbs out of the noise floor. |
| **Light Trails** | Keeps the brightest value each pixel ever showed — headlights, torches, moving lights. |

Stability is measured from the IMU rather than assumed, so a stack disturbed
by a knock is flagged instead of silently blurred.

## Important limits

- The iPhone 15 Plus does **not** have Apple's rear LiDAR scanner.
- Safari does not expose Apple's raw TrueDepth/AVDepthData stream to ordinary web pages, so this app does not claim to read TrueDepth depth maps.
- The **Relief** view is image-derived and is not physical depth.
- The **Parallax** view is relative disparity, not calibrated range. It works best on textured, static scenes when the phone is moved sideways with little rotation.
- **Digital zoom is a centre crop, not optical zoom**, and is labelled Digital wherever it is shown. Real camera zoom is used only when a `MediaStreamTrack` actually advertises the `zoom` capability, which iOS Safari currently does not — so on an iPhone expect the digital fallback.
- The **Optical Flow** view is relative image motion. It cannot separate camera motion from subject motion, and like all block matching it can only see motion along axes the scene actually has structure on — a plain wall or a set of vertical stripes yields no vertical flow.
- **Brightness, Contrast, Detail and Motion are normalised indicators, not photometric measurements.** They are computed from the downsampled analysis frame, so their absolute values shift with the processing preset.
- Simultaneous multi-lens capture (0.5x + 1x fusion) is **not** attempted in the browser; WebKit does not expose it. The `FrameSource` interface exists so a future native provider could supply it without rewriting the processing modes.
- **Object tracking is motion-based, not recognition.** It follows regions that changed. It cannot identify anything, and an unexplained moving region is exactly that — the app stays neutral about what any object is.
- **Reported frame rates are measurements, not requests.** If a rate was asked for and not delivered, the panel shows what arrived.
- Manual camera controls are reported straight from `getCapabilities()`. **Not exposed** means WebKit reports nothing for that control, which is not the same as reporting that it is unsupported.
- GPS and phone IMU data are not survey-grade. GPS can be noisy indoors, and accelerometer integration drifts too quickly to use as trustworthy position, so v0.1 visualizes acceleration rather than pretending it can reconstruct a stable inertial path.

## iPhone use

1. Open the GitHub Pages site in Safari over HTTPS.
2. Tap **Enable Camera** and allow camera access.
3. Tap **Enable Motion Sensors** and allow motion/orientation access.
4. Optionally tap **Start GPS Track** and allow location access.
5. Pinch the preview, or use the zoom slider and quick stops, to zoom.
6. For a parallax scan, capture A, slide the phone roughly 5–10 cm sideways while keeping the same scene framed, then tap **Analyze B**.
7. Use Safari's Share sheet → **Add to Home Screen** for the installed PWA experience. If the camera then fails in the installed app, see the WebKit notes above — and expect to tap **Resume Camera** after the app has been backgrounded.

## Development

The app is written in TypeScript and compiled to browser-native ES modules. Three.js is loaded with an import map so the runtime stays simple and GitHub Pages can host the app as static files.

```bash
npm install
npm test
npm run build
```

Then serve `public/` from localhost, for example:

```bash
python3 -m http.server 8080 --directory public
```

Open `http://localhost:8080`. Camera APIs work on localhost as a secure-context exception; motion behavior is best tested on the actual iPhone over HTTPS.

## Project layout

```text
src/
  core/             shared math and data types
  sensors/          camera, motion/orientation, GPS
  vision/           frame source interface, image processing, flow, parallax
  visualization/    Three.js 3D sensor viewer
public/
  index.html        mobile UI shell
  styles.css        responsive visual design
  sw.js             PWA service worker
  manifest.webmanifest
  app/              generated JavaScript after `npm run build`
tests/              Node test suite for pure sensor/vision math
```

## Privacy

Visual Sensor Studio has no application backend. Camera frames and image-processing work stay in the browser. The app does not upload camera images, GPS coordinates, or motion data. Three.js is fetched from jsDelivr and cached by the service worker after first use.

## Architecture

The data flow is one-directional, and deliberately so:

```text
camera acquisition -> FrameSource -> vision processing -> sensor state -> optional Three.js
```

- `public/camera-bootstrap.js` is plain JavaScript, loads before the compiled
  app, and owns the `<video>` element, every `getUserMedia` call and the whole
  camera lifecycle. A TypeScript or Three.js failure cannot take the camera
  down with it. `src/sensors/camera.ts` is only a typed bridge to it.
- `src/vision/frame-source.ts` defines the acquisition boundary. Processing
  modes consume generic `AnalysisFrame`s and never touch `getUserMedia`, a
  `<video>` element or a `MediaStreamTrack`, so a future native provider is a
  new `FrameSource` rather than a rewrite.
- Three.js is a visualization consumer only. It never captures anything.

Vision work runs on a downsampled analysis frame (~176/256/384 px wide for
Battery Saver / Balanced / Fast), into buffers allocated once per frame
geometry and reused. Tracking, integration and the overlays all consume
analysis output rather than the camera, so a future native provider is a new
`FrameSource` and nothing downstream changes.

Measured per-frame cost at 256x144: tracking 0.13 ms, night integration
0.11 ms, histogram 0.20 ms, optical flow 0.16 ms. In the browser the dominant
cost is not any of these — it is capturing the frame at all (`drawImage` plus
`getImageData`, a GPU-to-CPU readback), which is most of the ~10 ms measured
per analysed frame. Optimising the algorithms further would not move that.

## Next experiments

Potential follow-ons include feeding flow and parallax summaries into the 3D
sensor scene, guided panorama capture, improved parallax confidence filtering,
point-cloud reconstruction, exportable height/disparity maps, and a native iOS
camera provider for multi-lens capture.
