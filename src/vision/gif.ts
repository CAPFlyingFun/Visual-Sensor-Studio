/**
 * A GIF89a encoder, written here because no browser has one.
 *
 * Joshua: "Is it possible to make GIF and videos?" Video the browser encodes
 * itself through MediaRecorder. GIF it does not — there is no encoder for it in
 * any browser, in any API, on any platform. `canvas.toBlob('image/gif')`
 * silently returns a PNG. So the format has to be written byte by byte, and
 * that is what this is.
 *
 * WHAT A GIF COSTS, stated plainly because it decides what this is good for:
 *
 *   - 256 colours per frame, maximum, from a palette this code has to choose.
 *     A photograph has tens of thousands. Every GIF of a camera frame is a
 *     lossy approximation and the banding is the format, not a bug.
 *   - No inter-frame compression worth the name. LZW compresses each frame
 *     against itself; a video codec compresses each frame against the one
 *     before. That is why a two-second GIF can outweigh a thirty-second MP4.
 *   - Delays are stored in hundredths of a second, and most decoders quietly
 *     clamp anything under 2 to 10 — so a "50fps GIF" plays at ten.
 *
 * It is still worth having: a GIF plays inline everywhere, in any message, with
 * no player and no codec question. That is the whole reason to make one, and
 * the reason to keep them short and small.
 *
 * The colour reduction is median cut (Heckbert 1982) over a 15-bit histogram,
 * with optional Floyd-Steinberg error diffusion. Both are chosen for being
 * measurable rather than clever: the tests decode what this writes with an
 * independent decoder and compare pixels.
 */

export interface GifFrame {
  /** RGBA, as an ImageData's data. */
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  /** Hundredths of a second this frame is shown for. */
  delayCentiseconds: number;
}

export interface GifOptions {
  /** Diffuse the quantisation error into neighbouring pixels. */
  dither?: boolean;
  /** 0 loops forever; otherwise the number of extra plays. */
  loops?: number;
  /** Palette size, 2..256. */
  colors?: number;
}

/**
 * Under this, most decoders substitute 10 — so a faster GIF is not merely
 * unreliable, it plays at a completely different speed from the one asked for.
 */
export const MIN_DELAY_CENTISECONDS = 2;

/* --- Colour reduction ---------------------------------------------------- */

/**
 * 15-bit histogram: 5 bits per channel, which is where median cut operates.
 *
 * The TRUE colours are summed alongside the counts, not just the bin they fell
 * in. Reconstructing a palette entry from bin centres alone puts every colour
 * out by up to four levels in each channel — measured: a pure black and white
 * image came back as (4,4,4) and (252,252,252), a bias on every flat colour in
 * every picture. Summing the originals costs three arrays and removes it
 * entirely.
 */
interface Histogram {
  counts: Uint32Array;
  sums: Float64Array;
}

function histogram(frames: ReadonlyArray<GifFrame>): Histogram {
  const counts = new Uint32Array(32768);
  const sums = new Float64Array(32768 * 3);
  for (const frame of frames) {
    const { data } = frame;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      counts[key] += 1;
      sums[key * 3] += r;
      sums[key * 3 + 1] += g;
      sums[key * 3 + 2] += b;
    }
  }
  return { counts, sums };
}

interface Box {
  bins: number[];
  count: number;
}

function channelOf(bin: number, channel: number): number {
  return (bin >> (10 - channel * 5)) & 31;
}

function boxRange(box: Box, channel: number): number {
  let low = 31;
  let high = 0;
  for (const bin of box.bins) {
    const value = channelOf(bin, channel);
    if (value < low) low = value;
    if (value > high) high = value;
  }
  return high - low;
}

/**
 * Median cut: split the box with the widest spread, at the population median.
 *
 * The median rather than the midpoint is the whole idea — it puts the same
 * number of PIXELS either side of the cut, so colours get palette entries in
 * proportion to how much of the picture they are. Splitting at the midpoint
 * would give an empty half of the colour cube as many entries as a face.
 */
function medianCut({ counts, sums }: Histogram, wanted: number): number[][] {
  const populated: number[] = [];
  for (let bin = 0; bin < counts.length; bin++) if (counts[bin] > 0) populated.push(bin);
  if (populated.length === 0) return [[0, 0, 0]];

  let boxes: Box[] = [{
    bins: populated,
    count: populated.reduce((total, bin) => total + counts[bin], 0)
  }];

  while (boxes.length < wanted) {
    // The box with the most pixels AND something to split. A box of one colour
    // cannot be split however heavy it is.
    let target = -1;
    let best = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].bins.length < 2) continue;
      if (boxes[i].count > best) { best = boxes[i].count; target = i; }
    }
    if (target < 0) break;

    const box = boxes[target];
    let channel = 0;
    let widest = -1;
    for (let c = 0; c < 3; c++) {
      const range = boxRange(box, c);
      if (range > widest) { widest = range; channel = c; }
    }
    if (widest <= 0) break;

    const sorted = [...box.bins].sort((a, b) => channelOf(a, channel) - channelOf(b, channel));
    const half = box.count / 2;
    let running = 0;
    let split = 0;
    for (; split < sorted.length - 1; split++) {
      running += counts[sorted[split]];
      if (running >= half) break;
    }
    const lower = sorted.slice(0, split + 1);
    const upper = sorted.slice(split + 1);
    if (lower.length === 0 || upper.length === 0) break;

    const weigh = (bins: number[]) => bins.reduce((total, bin) => total + counts[bin], 0);
    boxes[target] = { bins: lower, count: weigh(lower) };
    boxes.push({ bins: upper, count: weigh(upper) });
  }

  // The average of a box, weighted by how many pixels each colour has. The
  // centre of the box would be a colour nothing in the picture is.
  return boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let total = 0;
    for (const bin of box.bins) {
      r += sums[bin * 3];
      g += sums[bin * 3 + 1];
      b += sums[bin * 3 + 2];
      total += counts[bin];
    }
    if (total === 0) return [0, 0, 0];
    return [Math.round(r / total), Math.round(g / total), Math.round(b / total)];
  });
}

/** Palette for a whole animation, so every frame shares one colour table. */
export function buildPalette(
  frames: ReadonlyArray<GifFrame>,
  colors = 256
): number[][] {
  const wanted = Math.max(2, Math.min(256, Math.floor(colors)));
  return medianCut(histogram(frames), wanted);
}

function nearest(palette: ReadonlyArray<ReadonlyArray<number>>, r: number, g: number, b: number): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const dr = r - palette[i][0];
    const dg = g - palette[i][1];
    const db = b - palette[i][2];
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) { bestDistance = distance; best = i; }
  }
  return best;
}

/**
 * Nearest-colour for the whole 15-bit cube, computed once.
 *
 * THIS IS WHAT MAKES IT RUN ON A PHONE. Searching 256 palette entries per pixel
 * is eight hundred million comparisons for six seconds of 320x240 — minutes of
 * a frozen interface. The cube has only 32,768 cells, so the same search done
 * once up front is eight million comparisons total and every pixel afterwards
 * is one array read.
 *
 * The cost is that the choice is made at eight-level granularity per channel.
 * Palette entries in a 256-colour photographic palette sit further apart than
 * that almost everywhere, so the table picks the same entry an exact search
 * would — measured on a gradient, dithering through the table still cut the
 * block error by the same factor it did with an exact search.
 */
function nearestTable(palette: ReadonlyArray<ReadonlyArray<number>>): Uint8Array {
  const table = new Uint8Array(32768);
  for (let key = 0; key < 32768; key++) {
    const r = ((key >> 10) & 31) << 3 | 4;
    const g = ((key >> 5) & 31) << 3 | 4;
    const b = (key & 31) << 3 | 4;
    table[key] = nearest(palette, r, g, b);
  }
  return table;
}

/**
 * RGBA to palette indices.
 *
 * Dithering trades a visible artefact for a less visible one: banding across a
 * gradient becomes fine noise. On the Ironbow and relief ramps this app draws,
 * banding is the worse of the two by a wide margin — they are gradients almost
 * everywhere.
 */
export function quantiseFrame(
  frame: GifFrame,
  palette: ReadonlyArray<ReadonlyArray<number>>,
  dither: boolean,
  table: Uint8Array = nearestTable(palette)
): Uint8Array {
  const { width, height, data } = frame;
  const indices = new Uint8Array(width * height);
  const key = (r: number, g: number, b: number) =>
    ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

  if (!dither) {
    for (let p = 0, i = 0; p < indices.length; p++, i += 4) {
      indices[p] = table[key(data[i], data[i + 1], data[i + 2])];
    }
    return indices;
  }

  // Error carried in floats across the frame, Floyd-Steinberg weights. The
  // error is measured against the palette entry actually chosen, so the
  // diffusion stays correct even though the CHOICE came from the table.
  const error = new Float32Array(width * height * 3);
  const clamp255 = (value: number) => value < 0 ? 0 : value > 255 ? 255 : value;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = p * 4;
      const e = p * 3;
      const r = clamp255(data[i] + error[e]);
      const g = clamp255(data[i + 1] + error[e + 1]);
      const b = clamp255(data[i + 2] + error[e + 2]);
      const index = table[key(r, g, b)];
      indices[p] = index;

      const dr = r - palette[index][0];
      const dg = g - palette[index][1];
      const db = b - palette[index][2];
      const spread = (nx: number, ny: number, weight: number) => {
        if (nx < 0 || nx >= width || ny >= height) return;
        const target = (ny * width + nx) * 3;
        error[target] += dr * weight;
        error[target + 1] += dg * weight;
        error[target + 2] += db * weight;
      };
      spread(x + 1, y, 7 / 16);
      spread(x - 1, y + 1, 3 / 16);
      spread(x, y + 1, 5 / 16);
      spread(x + 1, y + 1, 1 / 16);
    }
  }
  return indices;
}

/* --- LZW ----------------------------------------------------------------- */

/**
 * GIF's variable-width LZW, which is not quite anybody else's LZW.
 *
 * The dictionary starts at the palette's code size, grows a bit at a time, and
 * is reset with an explicit clear code when it fills at 4096. Codes are packed
 * least-significant-bit first, and the byte stream is then cut into sub-blocks
 * of at most 255 bytes each with a length prefix. Every one of those details is
 * load-bearing: get any of them wrong and the file is a valid-looking GIF that
 * decodes to noise.
 */
export function lzwEncode(indices: Uint8Array, minimumCodeSize: number): Uint8Array {
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minimumCodeSize + 1;
  let next = endCode + 1;

  const out: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  const emit = (code: number) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  };

  // A flat Int32Array keyed by prefix*256+symbol, not a Map with string keys.
  // The string version allocated one key per pixel — five million short-lived
  // strings for a six-second GIF, which is most of the encoding time and all of
  // the garbage. Codes cannot exceed 4096 and symbols cannot exceed 256, so the
  // whole dictionary is one four-megabyte table indexed arithmetically.
  const dictionary = new Int32Array(4096 * 256);
  const resetDictionary = () => {
    dictionary.fill(0);
    codeSize = minimumCodeSize + 1;
    next = endCode + 1;
  };

  emit(clearCode);
  resetDictionary();

  let prefix = indices.length > 0 ? indices[0] : -1;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const slot = prefix * 256 + k;
    const found = dictionary[slot];
    if (found !== 0) {
      prefix = found;
      continue;
    }
    emit(prefix);
    dictionary[slot] = next;
    if (next === (1 << codeSize) && codeSize < 12) codeSize += 1;
    next += 1;
    if (next >= 4096) {
      emit(clearCode);
      resetDictionary();
    }
    prefix = k;
  }
  if (prefix >= 0) emit(prefix);
  emit(endCode);
  if (bitCount > 0) out.push(bitBuffer & 0xff);

  return Uint8Array.from(out);
}

/* --- The file ------------------------------------------------------------ */

class ByteWriter {
  private bytes: number[] = [];
  byte(value: number): void { this.bytes.push(value & 0xff); }
  short(value: number): void { this.byte(value); this.byte(value >> 8); }
  string(text: string): void { for (const ch of text) this.byte(ch.charCodeAt(0)); }
  raw(values: ArrayLike<number>): void {
    for (let i = 0; i < values.length; i++) this.byte(values[i]);
  }
  /** LZW output goes out in sub-blocks of at most 255 bytes. */
  subBlocks(values: Uint8Array): void {
    let offset = 0;
    while (offset < values.length) {
      const size = Math.min(255, values.length - offset);
      this.byte(size);
      for (let i = 0; i < size; i++) this.byte(values[offset + i]);
      offset += size;
    }
    this.byte(0);
  }
  toBytes(): Uint8Array { return Uint8Array.from(this.bytes); }
}

/** Palettes are padded to a power of two — the format has no other size. */
function paletteBits(size: number): number {
  let bits = 1;
  while ((1 << bits) < size) bits += 1;
  return Math.max(1, Math.min(8, bits));
}

interface Prepared {
  width: number;
  height: number;
  palette: number[][];
  table: Uint8Array;
  bits: number;
  codeSize: number;
  dither: boolean;
  loops: number;
}

function prepare(frames: ReadonlyArray<GifFrame>, options: GifOptions): Prepared {
  if (frames.length === 0) throw new Error('a GIF needs at least one frame');
  const { width, height } = frames[0];
  for (const frame of frames) {
    if (frame.width !== width || frame.height !== height) {
      // Not a limitation worth working around silently: a frame of a different
      // size would have to be scaled or offset, and either choice would change
      // the picture without saying so.
      throw new Error('every frame of a GIF must be the same size');
    }
  }
  const palette = buildPalette(frames, options.colors ?? 256);
  const bits = paletteBits(palette.length);
  return {
    width, height, palette, bits,
    table: nearestTable(palette),
    codeSize: Math.max(2, bits),
    dither: options.dither ?? true,
    loops: options.loops ?? 0
  };
}

function framePayload(frame: GifFrame, prep: Prepared): Uint8Array {
  return lzwEncode(
    quantiseFrame(frame, prep.palette, prep.dither, prep.table),
    prep.codeSize
  );
}

function assemble(
  prep: Prepared,
  payloads: ReadonlyArray<Uint8Array>,
  delays: ReadonlyArray<number>
): Uint8Array {
  const tableSize = 1 << prep.bits;
  const w = new ByteWriter();
  w.string('GIF89a');
  // Logical screen descriptor: global colour table, 8 bits per channel claimed.
  w.short(prep.width);
  w.short(prep.height);
  w.byte(0x80 | ((8 - 1) << 4) | (prep.bits - 1));
  w.byte(0);  // background colour index
  w.byte(0);  // pixel aspect ratio: none stated

  for (let i = 0; i < tableSize; i++) {
    const entry = prep.palette[i] ?? [0, 0, 0];
    w.byte(entry[0]);
    w.byte(entry[1]);
    w.byte(entry[2]);
  }

  // NETSCAPE2.0: the de facto looping extension. Not in the GIF specification
  // at all — it is an application extension every decoder learned to read, and
  // without it an animation plays once.
  w.byte(0x21); w.byte(0xff); w.byte(11);
  w.string('NETSCAPE2.0');
  w.byte(3); w.byte(1); w.short(prep.loops); w.byte(0);

  payloads.forEach((payload, index) => {
    const delay = Math.max(MIN_DELAY_CENTISECONDS, Math.round(delays[index]));
    // Graphic control extension: disposal 1 (leave in place), no transparency.
    w.byte(0x21); w.byte(0xf9); w.byte(4);
    w.byte(0x04);
    w.short(delay);
    w.byte(0);
    w.byte(0);

    w.byte(0x2c);            // image descriptor
    w.short(0); w.short(0);  // at the origin
    w.short(prep.width); w.short(prep.height);
    w.byte(0);               // no local table, not interlaced

    w.byte(prep.codeSize);
    w.subBlocks(payload);
  });

  w.byte(0x3b);  // trailer
  return w.toBytes();
}

export function encodeGif(
  frames: ReadonlyArray<GifFrame>,
  options: GifOptions = {}
): Uint8Array {
  const prep = prepare(frames, options);
  return assemble(
    prep,
    frames.map((frame) => framePayload(frame, prep)),
    frames.map((frame) => frame.delayCentiseconds)
  );
}

/**
 * The same encoder, yielding between frames.
 *
 * Encoding a six-second GIF is a second on a laptop and several on a phone.
 * Run as one synchronous block that is an interface frozen with no sign of
 * life, which reads as a crash rather than as work — the same reason the burst
 * merge is staged. The arithmetic is identical; only the pauses are new.
 */
export async function encodeGifAsync(
  frames: ReadonlyArray<GifFrame>,
  options: GifOptions = {},
  onProgress: (done: number, total: number) => Promise<void> | void = () => {}
): Promise<Uint8Array> {
  const prep = prepare(frames, options);
  const payloads: Uint8Array[] = [];
  for (let i = 0; i < frames.length; i++) {
    payloads.push(framePayload(frames[i], prep));
    await onProgress(i + 1, frames.length);
  }
  return assemble(prep, payloads, frames.map((frame) => frame.delayCentiseconds));
}

/**
 * What a GIF of this shape will roughly weigh, before making one.
 *
 * LZW on photographic frames lands near four bits a pixel — worse than PNG on
 * the same picture, because the palette has already thrown away the colour that
 * would have made it compress well. It is an estimate to size a control by, not
 * a promise: the encoder's real output is what the interface reports afterwards.
 */
export function estimateGifBytes(width: number, height: number, frames: number): number {
  return Math.round(width * height * frames * 0.5) + 1024;
}
