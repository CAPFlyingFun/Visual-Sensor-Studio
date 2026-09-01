# The camera workbench (v0.39.2)

A UI refactor of the Camera Lab, from the approved prototype. **HTML and CSS
only** — `src/main.ts` was not touched, and no vision, sensor, camera,
recording or encoding code changed.

## The requirement

> "While the user is working inside Camera Lab, the live camera / processed
> view should remain visible. Controls should come to the camera rather than
> forcing the user to leave the camera to find controls."

## How it is built

A fixed app workspace, as the mockup specifies:

    compact top bar
    live camera / filter        always visible, never scrolled
    zoom + photo + record
    family + submode controls
    TOOL DRAWER                 the only thing that scrolls
    bottom navigation

The shell is `100dvh`, the workspace is a grid, and `minmax(0, 1fr)` gives the
drawer whatever height is left. The page itself does not scroll while Camera
Lab is open, so there is no scroller inside an active scroller.

`.workbench-head` is `display: contents`, so its three rows *are* rows of the
workspace grid. That makes "not sticky" structural rather than a declaration
someone could re-add.

### What v0.39.0 got wrong

v0.39.0 substituted a sticky head over a scrolling page. On the device that did
exactly what a sticky overlay does: the controls slid behind a large fixed
block and left a small usable window to hunt in. Rejected and removed — this is
the approved layout, not an interpretation of it.

### Four things that were quietly eating the workspace

Measured at 430×932, each found by reading rectangles rather than CSS:

| | before | after |
|---|---|---|
| top bar (title, subtitle, four chips, button — stacked) | 120px | 50px |
| footer inside the shell | 33px, below a 110px gap | one 20px line |
| shell padding reserved for the dock | 96px guessed | 64px measured |
| tool drawer | **36px** | **232px** |

## Mapping

| Existing element | New location | Behaviour |
|---|---|---|
| `#visionStage`, `#cameraVideo`, `#visionCanvas`, `#cameraOverlayButton`, `#horizonLine`, reticle | sticky `.workbench-head` | same elements, one camera stream |
| `#metricFps`, `#metricZoom`, `#metricDelivered`, `#metricObjects`, `#visionModeLabel` | `.view-hud` over the picture | moved, not copied — the app writes to the same ids |
| `#zoomPresets`, `#zoomSlider`, `#zoomValue` | `.command-strip` | unchanged |
| `#captureStillButton`, `#recordButton`, `#recordElapsed`, `#expandViewButton` | `.capture-cluster`, beside the viewfinder | unchanged; record is the only red control |
| 14 `[data-vision-mode]` buttons | 5 `.mode-row`s inside `.mode-strip` | same buttons, same attributes, same `.active` handling |
| `#displayDetailRow`, `#motionPanel`, `#layerPanel`, `#nightPanel`, `#lensPanel` | `.tool-drawer` | the app already hides the ones that do not match the mode — no new show/hide logic |
| `#lensRow`, `#manualRow`, `.observe-row`, `#histogramCanvas`, both metric strips, `#cameraButton` row, `#recordPanel`, `#cameraMessage` | `.tool-drawer` | unchanged |
| `.tabbar` | fixed bottom dock | same nav, same `data-tab` |

Every id survived, no id is duplicated, and all 14 modes, 104 buttons and 25
selects are the same elements as before.

## Families are CSS, with a one-way mirror

Five radios and `:checked` decide which mode row is visible. No script chooses,
so nothing can fall out of step.

The app does change modes on its own, though — it restores the remembered mode
at startup, and a shared lens link switches to Lens — so a small script **in the
page** watches for the `.active` class the existing code already applies and
checks the matching family. It reads; it never sets a mode. It lives in
`index.html` rather than `main.ts` so that the redesign changed no application
logic at all. Verified: with the person browsing the Time family, the app
setting Lens moved the selection to Custom.

## Measured geometry

Rectangles at 430×932, none overlapping, in the order the design specifies:

| row | top | bottom | height |
|---|---|---|---|
| top bar | 18 | 68 | 50 |
| camera | 77 | 376 | 299 |
| command strip | 384 | 485 | 101 |
| mode controls | 493 | 593 | 100 |
| tool drawer | 593 | 825 | 232 |
| bottom dock | 877 | 932 | 55 |

The camera is 39% of the usable height (viewport less top bar and dock), inside
the 35–45% asked for. At 320×568 the same layout gives a 101px camera and a
107px drawer — the picture gives up height first so the drawer stays usable.

`tests/layout-geometry.test.mjs` drives a real browser and asserts on those
rectangles: nothing sticky, no overlaps, the drawer scrolls while the camera
does not move, the page does not scroll, no horizontal overflow, 14 modes, no
duplicate ids. It skips loudly where no browser is available rather than
passing silently.

## Not done in this pass