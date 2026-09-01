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
}

/**
 * Plain containers only, most compatible first. Parameterised codec strings
 * are deliberately absent: the legacy app measured Chromium rejecting every
 * one of them while plain video/mp4 encoded correctly, and a pinned low
 * H.264 level is exactly the ceiling the spec forbids.
 */
const CONTAINER_LADDER = ['video/mp4', 'video/webm'] as const;

export function pickContainer(isSupported: (mime: string) => boolean): string {
  for (const mime of CONTAINER_LADDER) {
    try {
      if (isSupported(mime)) return mime;
    } catch {
      // An overzealous isTypeSupported must not take recording down.
    }
  }
  // Empty string = let the browser pick; the file is measured either way.
  return '';
}

/**
 * Decode the produced file and read its true dimensions — the legacy app's
 * own instrument, carried over: when an encoder resizes, the file is the
 * only witness that tells the truth.
 */
function measureEncodedSize(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const probe = document.createElement('video');
    let settled = false;
    const done = (width: number, height: number) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve({ width, height });
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
    label: string
  ): { ok: boolean; reason?: string } {
    if (this.recorder) return { ok: false, reason: 'already recording' };
    if (typeof MediaRecorder === 'undefined') {
      return { ok: false, reason: 'MediaRecorder is unavailable in this browser' };
    }
    const mime = pickContainer((candidate) => MediaRecorder.isTypeSupported(candidate));
    this.bitrate = suggestedBitrate(
      recordInput.width, recordInput.height, measuredFps > 0 ? measuredFps : 30);
    try {
      this.recorder = new MediaRecorder(stream, mime
        ? { mimeType: mime, videoBitsPerSecond: this.bitrate }
        : { videoBitsPerSecond: this.bitrate });
    } catch (error) {
      this.recorder = null;
      return { ok: false, reason: error instanceof Error ? error.message : 'recorder refused' };
    }
    this.mime = this.recorder.mimeType || mime;
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
    // CHUNKED delivery, one second at a time — restored after the one-blob
    // experiment failed on device. Measured: a chunked 12 MP clip decoded
    // fine even under encoder distress (fragments carry their index as they
    // go, so a dying encoder loses a second, not the clip), while one-blob
    // 12 MP clips truncated on BOTH paths — an MP4's index is written at
    // finalisation, and a killed encoder never writes it. The one-blob
    // switch had chased a Photos-import theory that turned out to be the
    // browser's download sandbox instead. If the share sheet ever refuses a
    // fragmented file, the fix is a remux, not losing crash-resilience.
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
    const fileName = clipFileName(`v2-${this.label}`, new Date(), extensionForMime(type || blob.type));
    saveBlob(blob, fileName);
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
      encoderDied: this.diedReason
    };
  }
}
