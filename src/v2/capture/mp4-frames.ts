/**
 * Count the video frames an MP4 file REALLY contains — the encoder's kept
 * frame rate, measured from the file rather than inferred from the feed.
 *
 * Measured on device (2026-09-01): a MAX clip whose viewfinder ran at ~30
 * delivered fps played back at 17 fps. The camera's rate, the render's
 * rate and the encoder's rate are three different numbers, and only the
 * file can testify to the last one. So: walk the box tree, sum the sample
 * counts of the video track (stts for a flat MP4, trun for a fragmented
 * one), and take the duration from the same tables where they carry it.
 *
 * Pure: bytes in, numbers out. Returns null when the bytes are not an MP4
 * we can read (WebM, a truncated file with no index) — "unmeasured", never
 * a guess.
 */

export interface Mp4FrameCount {
  frames: number;
  /** From the sample tables' own timescale; null for a fragmented file. */
  seconds: number | null;
}

const ascii = (view: DataView, offset: number): string =>
  String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1),
    view.getUint8(offset + 2), view.getUint8(offset + 3));

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf']);

export function countMp4Frames(bytes: Uint8Array): Mp4FrameCount | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sawMoov = false;
  let sawMoof = false;
  let inVideoTrack = false;
  let trackIsVideo = false;
  /** The CURRENT track's mdhd timescale; adopted only when its samples are video. */
  let trackTimescale = 0;
  let mediaTimescale = 0;
  let frames = 0;
  let mediaDuration = 0;

  const walk = (start: number, end: number): void => {
    let offset = start;
    while (offset + 8 <= end) {
      let size = view.getUint32(offset);
      const type = ascii(view, offset + 4);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) return;
        // 64-bit size: high word must be zero for anything we can index.
        if (view.getUint32(offset + 8) !== 0) return;
        size = view.getUint32(offset + 12);
        header = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < header || offset + size > end) return;
      const body = offset + header;
      const bodyEnd = offset + size;

      if (type === 'moov') sawMoov = true;
      if (type === 'moof') sawMoof = true;

      if (type === 'trak') {
        trackIsVideo = false;
        inVideoTrack = false;
        trackTimescale = 0;
        walk(body, bodyEnd);
        inVideoTrack = false;
      } else if (CONTAINERS.has(type)) {
        walk(body, bodyEnd);
      } else if (type === 'hdlr' && body + 12 <= bodyEnd) {
        // fullbox(4) + pre_defined(4) + handler_type(4)
        trackIsVideo = ascii(view, body + 8) === 'vide';
        inVideoTrack = trackIsVideo;
      } else if (type === 'mdhd' && body + 4 <= bodyEnd) {
        const version = view.getUint8(body);
        const at = version === 1 ? body + 4 + 16 : body + 4 + 8;
        if (at + 4 <= bodyEnd) trackTimescale = view.getUint32(at);
      } else if (type === 'stts' && body + 8 <= bodyEnd) {
        // Only the video track's samples are frames. hdlr precedes stbl in
        // every muxer we have met; a track without hdlr is not counted.
        if (!inVideoTrack && !trackIsVideo) { offset = bodyEnd; continue; }
        // An audio track's timescale (48000) beside a video track's (600)
        // must never divide the video's duration — bind it here, per track.
        mediaTimescale = trackTimescale;
        const entries = view.getUint32(body + 4);
        let at = body + 8;
        for (let i = 0; i < entries && at + 8 <= bodyEnd; i++, at += 8) {
          const count = view.getUint32(at);
          const delta = view.getUint32(at + 4);
          frames += count;
          mediaDuration += count * delta;
        }
      } else if (type === 'trun' && body + 8 <= bodyEnd) {
        // Fragmented: each run carries its sample count. Video-only files are
        // what V2 records, so every run is frames.
        frames += view.getUint32(body + 4);
      }
      offset = bodyEnd;
    }
  };

  try {
    walk(0, bytes.byteLength);
  } catch {
    return null;
  }
  if (!sawMoov && !sawMoof) return null;
  if (frames === 0) return null;
  const seconds = !sawMoof && mediaTimescale > 0 && mediaDuration > 0
    ? mediaDuration / mediaTimescale
    : null;
  return { frames, seconds };
}
