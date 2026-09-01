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
