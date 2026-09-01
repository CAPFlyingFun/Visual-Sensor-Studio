# The camera workbench (v0.39.0)

A UI refactor of the Camera Lab, from the approved prototype. **HTML and CSS
only** — `src/main.ts` was not touched, and no vision, sensor, camera,
recording or encoding code changed.

## The requirement

> "While the user is working inside Camera Lab, the live camera / processed
> view should remain visible. Controls should come to the camera rather than
> forcing the user to leave the camera to find controls."

## How it is built, and one thing it deliberately is not

The prototype implies a fixed-height app shell with its own scrolling drawer.
That is a scroll container inside a scroll container, and on iOS it is where
momentum scrolling, rubber-banding and sticky elements start fighting. A
**sticky head** gets the same result from the page's own scroll: the picture,
its readouts, the shutter and the mode choice stay pinned while the controls
move underneath. One scroller, no nested-scroll chaos, no magic height
arithmetic to break on an untested device.

Measured at 430×932 after scrolling 1400px: the viewfinder is still on screen
at `top: 8px`, 391px tall — 42% of the screen, inside the 40–55% the brief
asks for.

## What made it work

`.panel { overflow: hidden }` was the blocker. `overflow: hidden` makes an
element a **scroll container**, so a sticky descendant sticks to *that* box
rather than to the viewport — and the panel never scrolls, so the head never
moved. Measured before the fix: scrolling 900px put the picture 518px above the
top of the screen. `.vision-panel { overflow: clip }` clips the same rounded
corners without becoming a scrollport.

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

## Not done in this pass

- **The five-item dock** (Camera / Sensors / World / Data / More). The existing
  six tabs are `data-tab` values that `main.ts` owns, and regrouping Rig and
  Burst under a More sheet is a navigation change, not a style change. The six
  tabs are styled as the dock instead; say the word and it can be a separate
  pass.
- **A sticky filtered preview inside the lens editor.** The main viewfinder
  stays visible while editing a lens, which is what the requirement asks for,
  and a second preview would need a second render target.
