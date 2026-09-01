# The camera workbench (v0.39.2)

A UI refactor of the Camera Lab, from the approved prototype. **HTML and CSS
only** — `src/main.ts` was not touched, and no vision, sensor, camera,
recording or encoding code changed.

## The requirement

> "While the user is working inside Camera Lab, the live camera / processed
> view should remain visible. Controls should come to the camera rather than
> forcing the user to leave the camera to find controls."

## How it is built

The ordinary scrolling page, with **one** sticky element: the viewfinder.

    compact top bar          scrolls away
    live camera / filter     PINNED
    zoom + photo + record    scroll under it
    family + submode controls
    tool drawer
    bottom navigation        fixed

### Two rejected layouts, and the reason was the same both times

**v0.39.0** pinned the whole head — picture, zoom, shutter, families and
submodes, about 500px of it — and the controls slid behind it.

**v0.39.2** built the fixed-height workspace the mockup implies, with its own
scrolling drawer. Joshua: *"That looks bad as there is a small window to
scroll, and can't see a thing in the small preview."* At 430×932 the drawer was
232px and the preview 299px, and both were too small, because everything above
the drawer is a fixed cost and on a phone that cost is most of the screen.

Pinning only the picture spends the fixed budget on the one thing that has to
stay: the preview is 373px (40%), and the zoom, shutter, mode rows and every
control below use the **whole** rest of the page rather than a 232px window
carved out of it — 504px of room, and as much scroll as the controls need.

### The line it depends on

A sticky element is confined to its containing block. While `.workbench-head`
was a real box, the picture pinned only until that box had scrolled past —
measured, it left the screen 342px up. `display: contents` removes the wrapper's
box so the containing block becomes the whole camera panel. And
`.vision-panel { overflow: clip }` matters for the same reason as before:
`overflow: hidden` (which `.panel` sets) would make the panel a scroll container
and pin the picture to a box that never scrolls.

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

At 430×932, scrolled to the end of the page:

| | |
|---|---|
| viewfinder | pinned at top 0, 373px tall (40% of the screen) |
| room for controls below it | 504px |
| page scrolls | yes, and it is the only scrolling surface |
| document width | 430 = viewport, no horizontal overflow |
| sticky elements in the stylesheet | 1 (`.vision-stage`) |

At 320×568: preview 227px, 286px of room below. At 393×852: 341px and 456px.

`tests/layout-geometry.test.mjs` drives a real browser and asserts on those
rectangles — exactly one sticky rule, the picture still on screen after
scrolling to the end and still clear of the dock, rows in order and not
overlapping, a preview between 25% and 50% of the screen, a floor on the room
left for controls, no horizontal overflow, 14 modes, no duplicate ids. It skips
loudly where no browser is available rather than passing silently.

## Not done in this pass