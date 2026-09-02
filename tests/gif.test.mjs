import test from 'node:test';
import assert from 'node:assert/strict';
import * as gif from '../.test-build/vision/gif.js';

/*
 * HOW THIS IS VERIFIED, and what these tests are and are not.
 *
 * No browser has a GIF encoder, so this one is written byte by byte, and a
 * decoder written by the same hand agreeing with it proves nothing — this
 * project has already shipped two confident wrong findings that way. So the
 * encoder was checked against PILLOW, an independent decoder that has never
 * seen this code, and it read every file correctly: size, frame count, loop
 * flag, 100ms delays, and pixels within the quantiser's expected error. That
 * measurement is the verification.
 *
 * The decoder below is a REGRESSION GUARD, not an authority. It catches a
 * change that breaks the byte stream; it cannot certify the format is right,
 * because it shares this file's assumptions about what right means.
 */

function decodeGif(bytes) {
  let at = 0;
  const byte = () => bytes[at++];
  const short = () => { const v = bytes[at] | (bytes[at + 1] << 8); at += 2; return v; };
  const signature = String.fromCharCode(...bytes.slice(0, 6));
  at = 6;
  const width = short();
  const height = short();
  const packed = byte();
  byte(); byte();
  const tableSize = 1 << ((packed & 7) + 1);
  const palette = [];
  for (let i = 0; i < tableSize; i++) palette.push([byte(), byte(), byte()]);

  const frames = [];
  let loops = null;
  let delay = 0;
  for (;;) {
    const marker = byte();
    if (marker === 0x3b || marker === undefined) break;
    if (marker === 0x21) {
      const label = byte();
      if (label === 0xf9) {
        byte(); byte();
        delay = short();
        byte(); byte();
      } else if (label === 0xff) {
        const size = byte();
        const name = String.fromCharCode(...bytes.slice(at, at + size));
        at += size;
        let block = byte();
        while (block !== 0) {
          if (name === 'NETSCAPE2.0' && block === 3) loops = bytes[at + 1] | (bytes[at + 2] << 8);
          at += block;
          block = byte();
        }
      } else {
        let block = byte();
        while (block !== 0) { at += block; block = byte(); }
      }
      continue;
    }
    if (marker !== 0x2c) throw new Error(`unknown block 0x${marker.toString(16)}`);
    short(); short();
    const fw = short();
    const fh = short();
    byte();
    const minimumCodeSize = byte();
    const data = [];
    let block = byte();
    while (block !== 0) { for (let i = 0; i < block; i++) data.push(bytes[at++]); block = byte(); }
    frames.push({ width: fw, height: fh, delay, indices: lzwDecode(data, minimumCodeSize, fw * fh) });
  }
  return { signature, width, height, palette, frames, loops };
}

function lzwDecode(bytes, minimumCodeSize, pixels) {
  const clear = 1 << minimumCodeSize;
  const end = clear + 1;
  let codeSize = minimumCodeSize + 1;
  let dictionary = [];
  const reset = () => {
    dictionary = [];
    for (let i = 0; i < clear; i++) dictionary.push([i]);
    dictionary.push([], []);
    codeSize = minimumCodeSize + 1;
  };
  reset();

  const out = [];
  let bitBuffer = 0;
  let bitCount = 0;
  let at = 0;
  let previous = null;
  while (out.length < pixels) {
    while (bitCount < codeSize) {
      if (at >= bytes.length) return Uint8Array.from(out);
      bitBuffer |= bytes[at++] << bitCount;
      bitCount += 8;
    }
    const code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>= codeSize;
    bitCount -= codeSize;

    if (code === clear) { reset(); previous = null; continue; }
    if (code === end) break;

    let entry;
    if (code < dictionary.length && dictionary[code].length > 0) entry = dictionary[code];
    else if (previous) entry = [...previous, previous[0]];
    else throw new Error('bad LZW stream');

    out.push(...entry);
    if (previous) {
      dictionary.push([...previous, entry[0]]);
      if (dictionary.length === (1 << codeSize) && codeSize < 12) codeSize += 1;
    }
    previous = entry;
  }
  return Uint8Array.from(out);
}

function makeFrame(width, height, paint, delayCentiseconds = 10) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { data, width, height, delayCentiseconds };
}

function decodedPixels(file) {
  const parsed = decodeGif(file);
  return parsed.frames.map((frame) =>
    Array.from(frame.indices, (index) => parsed.palette[index]));
}

test('the file is a GIF89a with a global palette and a loop flag', () => {
  // NETSCAPE2.0 is not in the GIF specification at all — it is an application
  // extension every decoder learned to read, and without it an animation plays
  // once and stops.
  const file = gif.encodeGif([makeFrame(8, 6, (x, y) => [x * 30, y * 40, 0])]);
  const parsed = decodeGif(file);
  assert.equal(parsed.signature, 'GIF89a');
  assert.equal(parsed.width, 8);
  assert.equal(parsed.height, 6);
  assert.equal(parsed.loops, 0, 'zero means loop forever');
  assert.equal(file[file.length - 1], 0x3b, 'the trailer must close the file');
});

test('every frame decodes back to the picture that went in', () => {
  const frames = [
    makeFrame(32, 24, (x, y) => [x * 8, y * 10, 60]),
    makeFrame(32, 24, (x, y) => [60, x * 8, y * 10])
  ];
  const parsed = decodeGif(gif.encodeGif(frames, { dither: false }));
  assert.equal(parsed.frames.length, 2);

  const pixels = decodedPixels(gif.encodeGif(frames, { dither: false }));
  for (let f = 0; f < frames.length; f++) {
    assert.equal(pixels[f].length, 32 * 24, 'every pixel must be accounted for');
    let worst = 0;
    for (let p = 0; p < pixels[f].length; p++) {
      for (let c = 0; c < 3; c++) {
        worst = Math.max(worst, Math.abs(pixels[f][p][c] - frames[f].data[p * 4 + c]));
      }
    }
    // 256 colours over two frames of gradient: small, bounded error.
    assert.ok(worst <= 24, `frame ${f} came back ${worst} levels out`);
  }
});

test('a flat colour survives exactly', () => {
  // Reconstructing palette entries from histogram bin CENTRES put every colour
  // out by up to four levels: pure black came back as (4,4,4). Summing the true
  // colours removes the bias, and a two-colour image is where it showed.
  const file = gif.encodeGif(
    [makeFrame(16, 16, (x) => (x < 8 ? [0, 0, 0] : [255, 255, 255]))],
    { colors: 2, dither: false }
  );
  const seen = new Set(decodedPixels(file)[0].map((c) => c.join(',')));
  assert.deepEqual([...seen].sort(), ['0,0,0', '255,255,255']);
});

test('dithering is locally accurate, which is the point of it', () => {
  // Measured against Pillow on a 128x96 gradient at 32 colours: dithering
  // raised the per-pixel error from 6.67 to 8.17 and cut the error of an 8x8
  // BLOCK from 6.22 to 1.56. Banding is what a person sees on a gradient, and
  // the block figure is the one that tracks it — so dithering is on by default
  // despite being pointwise worse.
  // The same scene the Pillow measurement used: a gradient in two channels at
  // once, which is where sixteen colours visibly band.
  const W = 128;
  const H = 96;
  const frame = makeFrame(W, H, (x, y) => [x * 2, y * 2, 128]);
  const block = (pixels) => {
    let total = 0;
    let count = 0;
    for (let by = 0; by + 8 <= H; by += 8) {
      for (let bx = 0; bx + 8 <= W; bx += 8) {
        for (let c = 0; c < 3; c++) {
          let got = 0;
          let want = 0;
          for (let y = by; y < by + 8; y++) {
            for (let x = bx; x < bx + 8; x++) {
              const p = y * W + x;
              got += pixels[p][c];
              want += frame.data[p * 4 + c];
            }
          }
          total += Math.abs(got - want) / 64;
          count += 1;
        }
      }
    }
    return total / count;
  };
  const plain = block(decodedPixels(gif.encodeGif([frame], { colors: 32, dither: false }))[0]);
  const dithered = block(decodedPixels(gif.encodeGif([frame], { colors: 32, dither: true }))[0]);
  assert.ok(dithered < plain / 2,
    `dithering should more than halve the block error: ${dithered.toFixed(2)} vs ${plain.toFixed(2)}`);
});

test('the dictionary resets when it fills, and the stream stays readable', () => {
  // 160,000 pixels of noise pushes LZW well past its 4096-code ceiling. Getting
  // the reset wrong produces a valid-LOOKING GIF that decodes to garbage from
  // that point on, which is why the whole frame is checked rather than a corner.
  let seed = 1;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const frame = makeFrame(400, 400, () => [random() * 255, random() * 255, random() * 255]);
  const pixels = decodedPixels(gif.encodeGif([frame], { dither: false }))[0];
  assert.equal(pixels.length, 400 * 400, 'the decoded frame must be complete');
  let worst = 0;
  for (let p = 0; p < pixels.length; p++) {
    for (let c = 0; c < 3; c++) {
      worst = Math.max(worst, Math.abs(pixels[p][c] - frame.data[p * 4 + c]));
    }
  }
  assert.ok(worst <= 64, `noise came back ${worst} levels out — the stream desynchronised`);
});

test('delays below the decoders’ floor are raised, not written as asked', () => {
  // Most decoders silently substitute 10 for anything under 2, so a "50fps GIF"
  // plays at ten. Writing the number as asked would make the file lie.
  const parsed = decodeGif(gif.encodeGif(
    [makeFrame(4, 4, () => [10, 20, 30], 1), makeFrame(4, 4, () => [30, 20, 10], 25)]
  ));
  assert.equal(parsed.frames[0].delay, gif.MIN_DELAY_CENTISECONDS);
  assert.equal(parsed.frames[1].delay, 25);
});

test('mismatched frame sizes are refused rather than fudged', () => {
  // Scaling or offsetting one would change the picture without saying so.
  assert.throws(
    () => gif.encodeGif([makeFrame(8, 8, () => [0, 0, 0]), makeFrame(8, 9, () => [0, 0, 0])]),
    /same size/
  );
  assert.throws(() => gif.encodeGif([]), /at least one frame/);
});

test('a GIF is sized before one is made, because it is big', () => {
  // A two-second GIF can outweigh a thirty-second MP4: LZW compresses each
  // frame against itself, a video codec compresses it against the one before.
  const estimate = gif.estimateGifBytes(320, 240, 40);
  const real = gif.encodeGif(
    Array.from({ length: 8 }, (_, i) => makeFrame(160, 120, (x, y) => [x + i * 4, y, 90]))
  ).length;
  assert.ok(estimate > 1e6, 'forty frames of 320x240 is megabytes, and should say so');
  assert.ok(real > 0);
});

/* --- The wiring ---------------------------------------------------------- */

import { readFileSync } from 'node:fs';
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/legacy.html', import.meta.url), 'utf8');

test('frames are grabbed live, not decoded back out of a recorded clip', () => {
  // Decoding would mean playing the video through and reading it frame by
  // frame, which depends on seek accuracy and autoplay rules that differ
  // between browsers — a lot of machinery to arrive at pictures the camera can
  // simply be asked for.
  const fn = main.slice(main.indexOf('function grabGifFrame'), main.indexOf('async function captureGif'));
  assert.match(fn, /visionCanvas : video/);
  assert.match(fn, /getImageData/);
});

test('the capture interval comes from the delay that will be written', () => {
  // Delays are hundredths of a second, so 12.5 a second is 8 exactly while 30
  // would be 3.33 and cannot be written at all. Grabbing at one rate and
  // writing another would produce a GIF that plays at the wrong speed.
  const fn = main.slice(main.indexOf('async function captureGif'), main.indexOf('async function exportGif'));
  assert.match(fn, /const intervalMs = delay \* 10;/);
  assert.match(fn, /MIN_DELAY_CENTISECONDS/);
});

test('memory is bounded, and an impossible choice is refused with the reason', () => {
  // Frames are raw RGBA while capturing: 320x240 is 300kB each. Quietly
  // shortening the capture would produce a GIF that is not what was asked for
  // without saying so.
  const fn = main.slice(main.indexOf('async function captureGif'), main.indexOf('async function exportGif'));
  assert.match(fn, /GIF_MEMORY_BUDGET/);
  assert.match(fn, /more memory than is safe to hold/);
  // And the frames are released as soon as the file exists — they are the
  // largest thing the app ever holds.
  assert.match(fn, /finally \{[\s\S]{0,300}gifFrames = \[\];/);
});

test('the encode yields, so the page does not look like it crashed', () => {
  assert.match(main, /encodeGifAsync\(gifFrames/);
  assert.match(main, /Encoding \$\{done\} of \$\{total\} frames…/);
});

test('what a GIF costs is said before one is made', () => {
  // 256 colours and no inter-frame compression: a few seconds of camera can
  // outweigh a thirty-second video. Finding that out after the file exists is
  // the wrong order.
  assert.match(html, /256 colours/);
  assert.match(main, /roughly \$\{describeSize\(bytes\)\}/);
  assert.match(main, /of memory while capturing/);
});
