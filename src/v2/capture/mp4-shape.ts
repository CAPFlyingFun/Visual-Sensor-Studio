/**
 * WHY WILL PHOTOS NOT IMPORT THIS CLIP? — read from the file itself.
 *
 * Joshua, 2026-09-04, on a MAX recording that plays perfectly: "It also
 * didn't save it to the camera roll. It did give me the option, but nothing
 * happened." The share sheet offered Save to Camera Roll and Photos then
 * silently declined the asset. A silent refusal cannot be diagnosed by
 * guessing, and it was already guessed at twice — the MIME was one guess and
 * it was wrong. So this reads the bytes.
 *
 * TWO PROPERTIES OF AN MP4 DECIDE THIS ON APPLE PLATFORMS, and MediaRecorder
 * output can fail either:
 *
 * 1. THE HEVC SAMPLE ENTRY MUST BE `hvc1`, NOT `hev1`. They are the same
 *    codec; they differ in where the parameter sets live — hvc1 keeps them
 *    out-of-band in the sample description, hev1 allows them inline in the
 *    stream. AVFoundation reads hvc1 and refuses hev1, which is why Apple's
 *    own tools always write hvc1. A browser that hands back hev1 produces a
 *    file that plays fine in that browser and cannot enter Photos.
 *
 * 2. THE FILE MUST BE PROGRESSIVE, NOT FRAGMENTED. A fragmented MP4 carries
 *    its sample tables in `moof` boxes spread through the file, which is
 *    right for streaming and wrong for an importer that wants one `moov`
 *    with complete `stbl` tables up front. MediaRecorder writes fragmented
 *    MP4 by design, because it must be able to stop at any moment.
 *
 * Neither needs re-encoding to fix — both are container structure, so a
 * remux rewrites them losslessly. Knowing WHICH one is wrong is the
 * difference between a cheap fix and a pointless transcode, and that is what
 * this module exists to answer.
 *
 * Pure: bytes in, facts out. Null when the bytes are not an MP4 at all
 * (a WebM, a truncated file) — "unreadable", never a guess.
 */

export interface Mp4Shape {
  /** The `ftyp` major brand, e.g. 'iso5', 'mp42', 'qt  '. Empty when absent. */
  majorBrand: string;
  /** Every brand the file claims compatibility with. */
  compatibleBrands: readonly string[];
  /** Video sample-entry four-character codes found, e.g. ['hvc1'] or ['avc1']. */
  videoCodecs: readonly string[];
  /** True when the file carries `moof` boxes — a fragmented MP4. */
  fragmented: boolean;
  /** True when a `moov` box exists at all. */
  hasMoov: boolean;
  /** True when `moov` appears BEFORE the first `mdat` — the progressive layout. */
  moovBeforeMdat: boolean;
}

/** One reason an importer would refuse, in the words a person can act on. */
export interface ImportBlocker {
  id: string;
  detail: string;
  /** True when a remux fixes it — no pixels re-encoded. */
  remuxable: boolean;
}

const ascii = (view: DataView, offset: number): string =>
  String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1),
    view.getUint8(offset + 2), view.getUint8(offset + 3));

/**
 * Boxes whose children must be walked to reach a video sample entry. `stsd`
 * is deliberately absent: it is a FULL box with a count before its children,
 * so it is handled on its own below rather than walked as a plain container.
 */
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf']);

/** Sample entries that name a video codec, in the four-char form a file uses. */
const VIDEO_ENTRIES = new Set([
  'hvc1', 'hev1', 'avc1', 'avc3', 'av01', 'vp09', 'vp08', 'mp4v', 'dvh1', 'dvhe'
]);

export function describeMp4Shape(bytes: Uint8Array): Mp4Shape | null {
  if (bytes.byteLength < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let majorBrand = '';
  const compatibleBrands: string[] = [];
  const videoCodecs: string[] = [];
  let fragmented = false;
  let hasMoov = false;
  let moovOffset = -1;
  let mdatOffset = -1;
  let sawFtyp = false;

  const walk = (start: number, end: number, depth: number): void => {
    // A malformed file must not be able to spin this forever; real MP4 box
    // nesting is shallow, so a generous depth cap costs nothing real.
    if (depth > 12) return;
    let offset = start;
    while (offset + 8 <= end) {
      let size = view.getUint32(offset);
      const type = ascii(view, offset + 4);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) return;
        // 64-bit size: a high word we cannot index means we cannot walk on.
        if (view.getUint32(offset + 8) !== 0) return;
        size = view.getUint32(offset + 12);
        header = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < header || offset + size > end) return;
      const body = offset + header;
      const bodyEnd = offset + size;

      if (type === 'ftyp' && body + 8 <= bodyEnd) {
        sawFtyp = true;
        majorBrand = ascii(view, body);
        // major(4) + minor_version(4), then compatible brands to the end.
        for (let b = body + 8; b + 4 <= bodyEnd; b += 4) compatibleBrands.push(ascii(view, b));
      } else if (type === 'moov') {
        hasMoov = true;
        if (moovOffset < 0) moovOffset = offset;
        walk(body, bodyEnd, depth + 1);
      } else if (type === 'mdat') {
        if (mdatOffset < 0) mdatOffset = offset;
      } else if (type === 'moof') {
        fragmented = true;
        walk(body, bodyEnd, depth + 1);
      } else if (type === 'stsd' && body + 8 <= bodyEnd) {
        // FullBox: version+flags(4) then entry_count(4), then the entries,
        // each of which begins with its own size and four-char format.
        walk(body + 8, bodyEnd, depth + 1);
      } else if (CONTAINERS.has(type)) {
        walk(body, bodyEnd, depth + 1);
      } else if (VIDEO_ENTRIES.has(type) && !videoCodecs.includes(type)) {
        videoCodecs.push(type);
      }

      offset = bodyEnd;
    }
  };

  walk(0, bytes.byteLength, 0);
  if (!sawFtyp && !hasMoov) return null;

  return {
    majorBrand,
    compatibleBrands,
    videoCodecs,
    fragmented,
    hasMoov,
    // Only meaningful when both exist; a file with no mdat has nothing to be
    // before, and reporting "true" there would be an answer to no question.
    moovBeforeMdat: moovOffset >= 0 && mdatOffset >= 0 && moovOffset < mdatOffset
  };
}

/**
 * What, in this shape, an Apple importer would refuse — and whether a remux
 * would be enough to fix it.
 *
 * Deliberately silent about anything it cannot see in the bytes. A file this
 * reports no blockers for may still fail for a reason outside the container,
 * and saying "this will import" would be a promise the bytes cannot make.
 */
export function importBlockers(shape: Mp4Shape): ImportBlocker[] {
  const blockers: ImportBlocker[] = [];

  if (shape.videoCodecs.includes('hev1') && !shape.videoCodecs.includes('hvc1')) {
    blockers.push({
      id: 'hev1',
      detail: 'the HEVC track is tagged hev1, which AVFoundation does not read — '
        + 'the same codec tagged hvc1 imports normally',
      remuxable: true
    });
  }

  if (shape.fragmented) {
    blockers.push({
      id: 'fragmented',
      detail: 'the file is a FRAGMENTED MP4 (moof boxes rather than one complete '
        + 'moov) — right for streaming, and not what an importer reads',
      remuxable: true
    });
  }

  if (!shape.hasMoov) {
    blockers.push({
      id: 'no-moov',
      detail: 'there is no moov box at all — the file has no index to import from',
      remuxable: false
    });
  } else if (!shape.fragmented && !shape.moovBeforeMdat) {
    blockers.push({
      id: 'moov-last',
      detail: 'the moov index sits after the media data; some importers give up '
        + 'before finding it',
      remuxable: true
    });
  }

  return blockers;
}

/** The whole diagnosis in one line, for the readout. */
export function describeImportability(shape: Mp4Shape | null): string {
  if (!shape) return 'not an MP4 this can read — nothing to diagnose';
  const brands = shape.compatibleBrands.length > 0
    ? shape.compatibleBrands.join('/')
    : 'none listed';
  const codecs = shape.videoCodecs.length > 0 ? shape.videoCodecs.join('/') : 'no video entry found';
  const layout = shape.fragmented
    ? 'fragmented'
    : shape.hasMoov
      ? (shape.moovBeforeMdat ? 'progressive, moov first' : 'progressive, moov last')
      : 'no moov';
  const blockers = importBlockers(shape);
  const verdict = blockers.length === 0
    ? 'nothing here would stop an import'
    : blockers.map((b) => b.detail).join(' · ');
  const fix = blockers.length > 0 && blockers.every((b) => b.remuxable)
    ? ' · all of it is container structure, so a remux fixes it without re-encoding'
    : '';
  return `brand ${shape.majorBrand || 'none'} (${brands}) · ${codecs} · ${layout} · ${verdict}${fix}`;
}
