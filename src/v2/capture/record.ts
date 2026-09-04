/**
 * RecordingService — recording truth (Milestone C).
 *
 * Owns MediaRecorder decisions and final-file diagnostics, never filter math.
 * Two legitimate paths (the design spec's own split):
 *
 *   native    the camera stream borrowed directly — no render in the path,
 *             so RGB recording costs nothing and carries the SOURCE size.
 *   filtered  the pipeline's explicit RECORD IN render target, via
 *             canvas.captureStream. The legacy app measured the law this
 *             lives under: the recorded rate IS the canvas redraw rate, and
 *             a canvas that is not redrawn emits nothing at all.
 *
 * Codec policy per docs/camera_rule.md and the design spec: browser default,
 * never a hard-coded H.264 profile/level — a plain container ladder
 * (video/mp4, then video/webm), and what the file REALLY contains is
 * measured by decoding it. The recorder's reported mimeType travels along as
 * a claim; the legacy app watched Safari report a Level-1.0 codec string for
 * a stream that could not legally be one.
 */

import {
  clipFileName, extensionForMime, suggestedBitrate
} from '../../vision/clip-format.js';
import { countMp4Frames } from './mp4-frames.js';
import { describeMp4Shape, type Mp4Shape } from './mp4-shape.js';

export interface ClipResult {
  seconds: number;
  bytes: number;
  /** The finished file itself — held so a fresh tap can share it to Photos. */
  blob: Blob;
  /** Measured by decoding the file — the authoritative dimensions. */
  encodedWidth: number;
  encodedHeight: number;
  /** What the recorder claims it wrote. A claim, not a measurement. */
  mimeType: string;
  requestedBitsPerSecond: number;
  /** bytes × 8 / seconds — the rate the file actually carries. */
  measuredBitsPerSecond: number;
  fileName: string;
  /**
   * How many non-empty dataavailable deliveries built the file. The 1 s
   * timeslice is a REQUEST: a browser that holds everything until stop
   * delivers one chunk for the whole clip, and then a killed encoder still
   * loses the file — so whether chunking actually protects anything on a
   * given device is this number, not the request.
   */
  chunkCount: number;
  /** How long the encoder took to drain and write the file after stop. */
  finalizeMs: number;
  /** The guard fired before onstop — the file is likely missing its index. */
  finalizeTimedOut: boolean;
  /**
   * Non-null when the recorder died BEFORE stop was pressed — an error event,
   * a self-stop, or a recorder already inactive when asked to stop. Measured
   * on device (2026-09-01): a MAX clip reported "finalised in 0.0s" on a file
   * that would not decode, the signature of an encoder that was already dead
   * — and nothing was listening.
   */
  encoderDied: string | null;
  /**
   * Frames the file really contains, counted from its sample tables; null
   * when the container cannot be read. The encoder's KEPT rate is
   * encodedFrames / seconds — the camera's rate and the render's rate are
   * different numbers (measured: a 30 fps viewfinder, a 17 fps file).
   */
  encodedFrames: number | null;
  /** The file's own duration from its sample tables, when it carries one. */
  encodedSeconds: number | null;
  /**
   * The CONTAINER's shape, read from the bytes — codec tag, fragmented or
   * progressive, where the index sits. Null when the file is not an MP4 this
   * can parse. It is here because "the share sheet offered Save to Camera
   * Roll and nothing happened" is answerable only from the file itself.
   */
  shape: Mp4Shape | null;
}

/**
 * HEVC FIRST, then plain containers.
 *
 * WHY THIS CHANGED (Joshua, 2026-09-04: "MAX is MAX output, not half or even
 * 3/4 of MAX"). Left to itself, WebKit encodes MediaRecorder output as H.264,
 * and H.264 Level 5.2 caps a frame at 36,864 macroblocks. The encoder probe
 * measured exactly that line on this device: 2592x3456 decodes, 2688x3584
 * does not. A 3024x4032 frame is 47,628 macroblocks, so a MAX recording is
 * held down to 2656x3542 — about three quarters of MAX by area. That is not
 * a limit of the phone. It is a limit of the one codec nobody asked to
 * change: HEVC's frame ceiling is far higher, and this hardware encodes it
 * natively for its own camera app.
 *
 * SO A CODECS= PARAMETER IS NOW ALLOWED, WITH THE OLD RULE INTACT. The rule
 * this ladder was written under was "no pinned H.264 profile or level", after
 * the legacy app measured Chromium rejecting parameterised strings and a
 * pinned low level capping the encoder. Asking for HEVC is the opposite of
 * that mistake — it REMOVES a ceiling rather than imposing one — and no H.264
 * codec string appears here, so no level can ever be pinned. A test holds
 * both halves.
 *
 * hvc1 before hev1: both name HEVC in MP4 and Apple's tooling writes hvc1,
 * which is also the tag QuickTime and Photos handle without complaint.
 * Plain video/mp4 stays as the fallback that has always worked, so a device
 * that admits neither HEVC string behaves exactly as it did before.
 */
const CONTAINER_LADDER = [
  'video/mp4;codecs=hvc1',
  'video/mp4;codecs=hev1',
  'video/mp4',
  'video/webm'
] as const;

/**
 * Every candidate this browser admits, best first — not just the first one.
 *
 * isTypeSupported saying yes is not a promise the CONSTRUCTOR will accept the
 * same string, and a MediaRecorder that throws returns a failed recording
 * rather than falling back. With one candidate that was survivable, because
 * the one candidate was the plain container that always works; with HEVC in
 * front of it, a browser that admits hvc1 and then refuses to build it would
 * take recording down entirely. So start() walks this list.
 */
export function containerCandidates(isSupported: (mime: string) => boolean): string[] {
  const admitted: string[] = [];
  for (const mime of CONTAINER_LADDER) {
    try {
      if (isSupported(mime)) admitted.push(mime);
    } catch {
      // An overzealous isTypeSupported must not take recording down.
    }
  }
  return admitted;
}

/** The single best admitted container, or '' to let the browser choose. */
export function pickContainer(isSupported: (mime: string) => boolean): string {
  return containerCandidates(isSupported)[0] ?? '';
}

/**
 * Decode the produced file and read its true dimensions — the legacy app's
 * own instrument, carried over: when an encoder resizes, the file is the
 * only witness that tells the truth.
 */
function measureEncodedSize(blob: Blob): Promise<{ width: number; height: number; seconds: number | null }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const probe = document.createElement('video');
    let settled = false;
    const done = (width: number, height: number) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      // The file's OWN duration, as the decoder reads it. Measured on device
      // (2026-09-01): a clip timed 10.7 s tap-to-tap held 9.5 s of video —
      // the encoder's spin-up is not in the file — so dividing frames by the
      // wall clock understated the kept rate (26.8 vs the file's true 29.97).
      const seconds = Number.isFinite(probe.duration) && probe.duration > 0 ? probe.duration : null;
      resolve({ width, height, seconds });
    };
    probe.preload = 'metadata';
    probe.muted = true;
    probe.onloadedmetadata = () => done(probe.videoWidth, probe.videoHeight);
    probe.onerror = () => done(0, 0);
    // A file that never reports metadata must not hold up the app.
    window.setTimeout(() => done(probe.videoWidth, probe.videoHeight), 3000);
    probe.src = url;
  });
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export class ClipRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private mime = '';
  private bitrate = 0;
  private label = 'clip';
  private diedReason: string | null = null;
  /** False for instruments (the encoder probe) that measure and discard. */
  private save = true;

  get active(): boolean {
    return this.recorder !== null;
  }

  private markDied(reason: string): void {
    if (this.diedReason) return;
    const at = Math.max(0, (performance.now() - this.startedAt) / 1000);
    this.diedReason = `${reason} at ${at.toFixed(1)}s`;
  }

  /**
   * Start recording the given stream. The RECORD IN dimensions and cadence
   * come from the caller (the authority and the measured delivered rate) —
   * this class sets a bitrate to aim at and never decides a size.
   */
  start(
    stream: MediaStream,
    recordInput: { width: number; height: number },
    measuredFps: number,
    label: string,
    options: { save?: boolean } = {}
  ): { ok: boolean; reason?: string } {
    if (this.recorder) return { ok: false, reason: 'already recording' };
    this.save = options.save ?? true;
    if (typeof MediaRecorder === 'undefined') {
      return { ok: false, reason: 'MediaRecorder is unavailable in this browser' };
    }
    this.bitrate = suggestedBitrate(
      recordInput.width, recordInput.height, measuredFps > 0 ? measuredFps : 30);
    // Walk the admitted containers, then the browser's own default. A
    // constructor that refuses a string isTypeSupported admitted costs one
    // step down the ladder instead of the whole recording.
    const candidates: (string | null)[] = [
      ...containerCandidates((candidate) => MediaRecorder.isTypeSupported(candidate)),
      null
    ];
    let chosen = '';
    let refused: unknown = null;
    for (const candidate of candidates) {
      try {
        this.recorder = new MediaRecorder(stream, candidate
          ? { mimeType: candidate, videoBitsPerSecond: this.bitrate }
          : { videoBitsPerSecond: this.bitrate });
        chosen = candidate ?? '';
        break;
      } catch (error) {
        refused = error;
        this.recorder = null;
      }
    }
    if (!this.recorder) {
      return {
        ok: false,
        reason: refused instanceof Error ? refused.message : 'recorder refused'
      };
    }
    // The recorder's OWN answer wins over what was asked for: a browser may
    // accept hvc1 and encode something else, and the file is what matters.
    this.mime = this.recorder.mimeType || chosen;
    this.label = label;
    this.chunks = [];
    this.diedReason = null;
    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };
    // A dying encoder announces itself — listen, so a dead recorder at stop
    // time is a measured fact with a timestamp instead of a mystery.
    this.recorder.onerror = (event) => {
      const error = (event as Event & { error?: DOMException }).error;
      this.markDied(`recorder error (${error?.name ?? 'unnamed'})`);
    };
    this.recorder.onstop = () => {
      // stop() replaces this handler; reaching it here means the recorder
      // stopped ITSELF while we still considered the clip live.
      this.markDied('the recorder stopped itself');
    };
    // CHUNKED delivery, one second at a time. HONEST STATUS (2026-09-01,
    // superseding an earlier, too-confident note here): chunking has NOT
    // been demonstrated to protect a 12 MP recording on the reference
    // iPhone. Latest device evidence — MAX clips arrived as 1 and as 3
    // chunks and neither file decoded; 2K clips arrive as 3-4 chunks and
    // decode. This WebKit's chunks are byte slices of one MP4 whose index is
    // written at finalisation, so a dead encoder loses the clip regardless
    // of how many chunks it emitted first. One 12 MP clip did finalise and
    // decode earlier in the day, so the encoder is unreliable above that
    // size, not provably incapable — the encoder probe (encoder-probe.ts)
    // exists to settle which. Chunking stays because it costs nothing and
    // helps on browsers that write fragmented MP4; `chunkCount` on every
    // result is the measurement, not this comment.
    this.recorder.start(1000);
    this.startedAt = performance.now();
    return { ok: true };
  }

  /** Stop, assemble, MEASURE, save. Null when nothing was recorded. */
  async stop(): Promise<ClipResult | null> {
    const recorder = this.recorder;
    if (!recorder) return null;
    this.recorder = null;
    const seconds = Math.max(0, (performance.now() - this.startedAt) / 1000);
    // FINALISATION IS PART OF THE RECORDING. After stop() the encoder drains
    // its backlog and writes the MP4 index, and at very large frame sizes
    // that drain can take many seconds. Measured on device (2026-09-01): a
    // 12 MP clip arrived as ONE chunk — the browser held everything to the
    // end — and the old 3 s guard here walked away before the index was
    // written, assembling a truncated file that read as "killed mid-encode".
    // The guard now exists only for a genuinely hung recorder, waits far
    // longer than any plausible drain, and confesses when it fires instead
    // of letting the truncation masquerade as an encoder crash.
    const finalizeStart = performance.now();
    let finalizeTimedOut = false;
    if (recorder.state === 'inactive') this.markDied('the recorder was already inactive');
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      recorder.onstop = finish;
      window.setTimeout(() => {
        finalizeTimedOut = !settled;
        finish();
      }, 60000);
      try {
        recorder.stop();
      } catch {
        finish();
      }
    });
    const finalizeMs = performance.now() - finalizeStart;
    const type = this.mime || this.chunks[0]?.type || '';
    const blob = new Blob(this.chunks, type ? { type } : undefined);
    const chunkCount = this.chunks.length;
    this.chunks = [];
    if (blob.size === 0) return null;

    const encoded = await measureEncodedSize(blob);
    let counted: { frames: number; seconds: number | null } | null = null;
    let shape: Mp4Shape | null = null;
    try {
      // One read of the bytes serves both: the frame count and the shape.
      const raw = new Uint8Array(await blob.arrayBuffer());
      counted = countMp4Frames(raw);
      shape = describeMp4Shape(raw);
    } catch {
      counted = null;
    }
    const fileName = clipFileName(`v2-${this.label}`, new Date(), extensionForMime(type || blob.type));
    if (this.save) saveBlob(blob, fileName);
    return {
      seconds,
      bytes: blob.size,
      blob,
      encodedWidth: encoded.width,
      encodedHeight: encoded.height,
      mimeType: type || blob.type,
      requestedBitsPerSecond: this.bitrate,
      measuredBitsPerSecond: seconds > 0 ? (blob.size * 8) / seconds : 0,
      fileName,
      chunkCount,
      finalizeMs,
      finalizeTimedOut,
      encoderDied: this.diedReason,
      encodedFrames: counted?.frames ?? null,
      // The decoder's duration first (it reads fragmented files too), the
      // sample tables' second, the wall clock only as the caller's fallback.
      encodedSeconds: encoded.seconds ?? counted?.seconds ?? null,
      shape
    };
  }
}
