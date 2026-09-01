# Recording, clips and GIFs

Two capabilities with very different constraints, built together in v0.37.0 and
v0.38.0.

## Video

The browser encodes this itself, through `MediaRecorder`. Three decisions are
worth recording.

**The format is asked for, never assumed** — and asking is not the only way to
find out, so there is a fallback.

A correction first: v0.38.1 blamed `isTypeSupported` for reporting nothing on an
iPhone. That was wrong. `detectClipFormat()` was never called at all — its
startup line had been inserted inside a settings change handler, so the whole
recording subsystem only initialised if you toggled "start the camera
automatically". The badge sat on "checking…", the format stayed null, and the
app told a phone that records video perfectly well that it could not. Whether
Safari's `isTypeSupported` names a format is still unmeasured; the badge now
says which path was taken.

A MediaRecorder constructed with **no** `mimeType` uses the browser's own
default and reports it back on `.mimeType`. That is strictly better than a
support query: a browser cannot be wrong about the format it just chose for
itself. So a browser that names nothing still records, and the file is named
from what the recorder actually produced — a `.mp4` holding WebM would be the
file lying about what it is.

Where formats *are* named, MP4 is preferred — not taste: a WebM saved to an
iPhone opens in nothing the phone ships with, so recording one produces a file
its owner cannot watch.

**Thirty-second clips, cut by a stop and a start.** A MediaRecorder's container
is only finished when it stops, so an interrupted recording can leave an
unplayable file and the longer the recording the more there is to lose. Cutting
means what is already on the phone is always complete. The seam costs a frame or
two — this is not the way to record something that must not have a gap in it.

**The cut is driven from the animation loop, not a timer.** A `setTimeout` in a
backgrounded tab is throttled or deferred, and a clip that ran long because the
phone was in a pocket is exactly the oversized file the limit exists to prevent.

### Two numbers that are not what they look like

**The storage figure is the browser's allowance for one website, not the
phone's free space.** An iPhone with 192.95 GB free of 512 GB had the app
reporting "41.23 GB free on this device". `navigator.storage.estimate()` returns
the quota this browser will let this origin use — a fraction of the disk,
deliberately coarsened so a page cannot fingerprint a device — and it has
nothing to do with what Settings shows. It is described as an allowance now.

**A filter is recorded at the size it is displayed, not the size it is
computed.** A ten-second clip came out at 382 kB because several modes compute
on a 166×221 analysis frame for speed, and recording that canvas recorded the
analysis frame rather than the picture on screen. The recording now goes through
a canvas sized by the same display budget the viewer uses. Upscaling adds no
detail and the interface says so: **Live detail** is what makes the filter
itself render larger, at the cost of frame rate. The camera on its own is
recorded at its own full resolution with no scaling at all.

Clips are held in IndexedDB — they survive a reload or a discarded tab, are
never uploaded, and the browser may still evict them. When room is needed,
already-exported clips go first (a copy exists elsewhere), then the oldest, and
never the newest.

## GIF

No browser has a GIF encoder. There is no API for it on any platform, and
`canvas.toBlob('image/gif')` silently returns a PNG. So `src/vision/gif.ts`
writes the format byte by byte: median cut (Heckbert 1982) over a 15-bit
histogram, Floyd–Steinberg diffusion, GIF's variable-width LZW, and the
NETSCAPE2.0 looping extension.

### Verified against an independent decoder

A decoder written by the same hand as the encoder proves nothing — this project
has already shipped two confident wrong findings that way. So the output was
checked with **Pillow**, which has never seen this code. It read every file
correctly: dimensions, frame count, loop flag, 100 ms delays, and pixels within
the quantiser's expected error. The decoder in `tests/gif.test.mjs` is a
regression guard, not an authority.

### Three things that measurement decided

**Palette entries are averaged from the true colours, not from histogram bin
centres.** Bin centres put every colour out by up to four levels per channel: a
pure black and white image came back as `(4,4,4)` and `(252,252,252)`. Summing
the originals alongside the counts removes the bias entirely, and dropped the
error on a test gradient from 8.42 to 6.67.

**Dithering is on by default, despite being pointwise worse.** On a 128×96
gradient at 32 colours:

| | per-pixel error | 8×8 block error |
|---|---|---|
| no dithering | 6.67 | 6.22 |
| Floyd–Steinberg | 8.17 | **1.56** |

Dithering trades pointwise accuracy for local accuracy. Banding is what a person
sees on a gradient, and the block figure is the one that tracks it. The Ironbow
and relief ramps this app draws are gradients almost everywhere.

**A nearest-colour lookup table over the whole 15-bit cube is what makes it run
on a phone.** Searching 256 palette entries per pixel is ~800 million
comparisons for six seconds of 320×240 — minutes of frozen interface. The cube
has 32,768 cells, so the same search done once up front is 8 million
comparisons and every pixel afterwards is one array read. Measured: 60 frames of
320×240 encode in 770 ms on a desktop, and the block error was 1.58 against
1.56 for an exact search — the approximation costs nothing measurable.

The LZW dictionary is a flat `Int32Array` keyed arithmetically rather than a
`Map` with string keys, which allocated one short-lived string per pixel.

### Size means the long side, not the width

Choosing "480" in portrait produced a 480×640 frame — 92 MB of held frames and
a refusal. In portrait a fixed *width* makes the frame taller rather than
smaller, so the memory followed how the phone was held rather than what was
chosen. Sizing to the long side gives the same pixel count either way, and every
combination the interface offers now fits inside the memory budget.

### What a GIF costs

Roughly 4.1–4.4 bits per pixel on camera-like content — worse than PNG on the
same picture, because the palette has already thrown away the colour that would
have made it compress well. Five seconds of 320×240 at 12/s is about 2.5 MB. A
thirty-second MP4 of the same scene is smaller than that.

It is still worth having: a GIF plays inline anywhere, in any message, with no
player and no codec question.

## Why a clip's frame rate is the pipeline's rate

A seven-second lens clip came back at **7.52 fps**, and the obvious guess — that
the recorder was tied to the render loop and could be freed by compositing into
a recording canvas at a steady 30 fps — is wrong. Measured in Chromium:

| how the recording canvas was driven | recorded |
|---|---|
| redrawn 60×/s, content changing | 29.6 fps |
| redrawn 60×/s, content identical | 29.6 fps (tiny file) |
| redrawn 8×/s | 8.3 fps |
| drawn once, then never again | **no frames at all** |
| 120 ms of blocking work per frame, redraw when free | 4.4 fps |
| same, plus `track.requestFrame()` at 30 Hz | 4.3 fps |

Three things follow. The recorded rate is exactly the rate the canvas is
redrawn. A canvas that is not redrawn produces nothing — not even duplicate
frames, so "hold the last picture at 30 fps" is not something the browser will
do on its own. And on a saturated main thread there is no trick that helps:
`requestFrame()` on a fixed timer changed 4.4 fps into 4.3, because that timer
queues behind the same blocked thread.

So a low recorded rate is a **measurement of how often the app managed to draw
a filtered picture**, not a defect in the recorder. The interface now shows all
three rates while recording — delivered, analysed, recorded — and each held
clip carries the rate it was actually written at. The levers that change it are
Live detail and the vision rate preference, because they change how expensive a
picture is; nothing in the recorder can.


## Why a filtered recording is ~0.4 megapixels, and what would change it

Joshua, on v0.39.3: *"the resolution on the video isn't good as it's low
resolution/fps and quality."* Three separate limits, worth keeping apart:

**Resolution.** A filtered recording is the filter's own render, upscaled to the
display budget. That budget is the screen's *logical* pixel count — 430×932 on
his phone, so a 4:3 frame caps at 548×732 ≈ 0.4 MP. It exists because rendering
more than the screen can show is what made the preview lag, and it was added at
his request. Recording a bigger file from the same render would be empty
upscaling. **The lever is Live detail**, which raises what the filter computes
and costs frame rate. An *unfiltered* recording bypasses all of this: the camera
track is recorded directly at its own full resolution.

**Frame rate.** Main-thread bound, measured, and not fixable by any recorder —
see the table above.

**Quality at a given size.** This one was genuinely too low and is fixed in
v0.39.4: the bit rate went from 0.1 to 0.2 bits per pixel per frame. The
project's own pictures are the hard case — an Ironbow ramp or an edge map is
high-contrast, noise-like detail across the whole frame, which is the first
thing a tight rate control smears. At 548×732 that is 2.4 Mb/s nominal, about
37 kB a frame at the 8 fps a heavy filter really produces, ≈0.75 bits per pixel.
Under the old constant it was half that.

### On swapping in a recording library

VideoRecorderJS (MIT) was suggested. Reading it: it is a wrapper around a canvas
pipeline feeding MediaRecorder — the same architecture this app already has —
defaulting to 640×480 and `video/webm`, with no iOS or MP4 story. It would not
raise any of the three limits above, and its defaults are worse than the current
ones for this device.

The one API that *would* give real control is **WebCodecs** (`VideoEncoder`,
Safari 17+): explicit codec, bitrate and keyframe control, and frames pushed in
by hand rather than scraped off a canvas at whatever rate it repaints — which
would also allow holding the last picture to produce a true constant-rate file.
It needs an MP4 muxer written or vendored, and it still cannot create detail the
filter never computed.
