/**
 * Encoder envelope probe — where does THIS device's MediaRecorder stop
 * producing a decodable file?
 *
 * The camera terminology hydra grew another head on 2026-09-01. Measured on
 * the reference iPhone: the camera DELIVERS 3024×4032, the GPU RENDERS it,
 * the JPEG SAVES it — and every MAX clip comes back as an MP4 with no index,
 * while 2160×2880 clips encode at a healthy measured 29.7 Mb/s. Whether the
 * H.264 encoder can REPRESENT a 12 MP frame is a separate limit from all of
 * those, so this instrument asks that question alone: a synthetic canvas
 * (moving noise, so the encoder does real work) is recorded through the
 * SAME ClipRecorder path the app uses, and each trial's file is decoded.
 *
 * Two hypotheses, and the ladder is built to tell them apart:
 *
 *   FRAME SIZE  H.264 Level 5.2 caps a frame at 36,864 macroblocks (16×16).
 *               2160×2880 = 24,300 (decodes). 3024×4032 = 47,628 (dies).
 *               Two 4:3 sizes bracket the line: 2592×3456 = 34,992 just
 *               below, 2688×3584 = 37,632 just above. If the file dies
 *               exactly at that step, no frame rate will save MAX — the
 *               individual frame violates the level.
 *   THROUGHPUT  the encoder is starving on 12 MP × fps. Then MAX at lower
 *               fed rates should survive where 30 fps dies.
 *
 * Every size here is a multiple of 16 on both edges, so the macroblock
 * count is exact and no partial-block rounding blurs the boundary.
 * (ChatGPT relay via Joshua, 2026-09-01, ordered this ahead of segmented
 * recording: killing a fresh encoder every three seconds with frames it
 * cannot represent would fix nothing.)
 */

import { ClipRecorder } from './record.js';

/** H.264 Level 5.2 maximum frame size in macroblocks (MaxFS, ITU-T H.264 Table A-1). */
export const H264_LEVEL_5_2_MACROBLOCKS = 36_864;

export function macroblocks(width: number, height: number): number {
  return Math.ceil(width / 16) * Math.ceil(height / 16);
}

export interface ProbeTrial {
  width: number;
  height: number;
  /** Frames fed to the encoder per second — the canvas redraw rate. */
  fps: number;
  seconds: number;
  note: string;
}

export const ENCODER_PROBE_LADDER: readonly ProbeTrial[] = [
  { width: 2160, height: 2880, fps: 15, seconds: 2.5, note: 'control — the proven 2K tier' },
  { width: 2592, height: 3456, fps: 15, seconds: 2.5, note: 'just BELOW Level 5.2' },
  { width: 2688, height: 3584, fps: 15, seconds: 2.5, note: 'just ABOVE Level 5.2' },
  { width: 3024, height: 4032, fps: 15, seconds: 2.5, note: 'MAX at 15 fps' },
  { width: 3024, height: 4032, fps: 30, seconds: 2.5, note: 'MAX at full rate' },
  { width: 3024, height: 4032, fps: 10, seconds: 2.5, note: 'MAX, lighter diet' },
  { width: 3024, height: 4032, fps: 5, seconds: 2.5, note: 'MAX, lightest diet' }
];

export interface ProbeRow {
  trial: ProbeTrial;
  macroblocks: number;
  aboveLevel52: boolean;
  decoded: boolean;
  encodedWidth: number;
  encodedHeight: number;
  bytes: number;
  measuredMbps: number;
  chunkCount: number;
  finalizeMs: number;
  encoderDied: string | null;
  /** The recorder refused to start, or the browser cannot run the trial. */
  error: string | null;
}

export function describeRow(row: ProbeRow): string {
  const { trial } = row;
  const head = `${trial.width}×${trial.height} @${trial.fps}fps · `
    + `${row.macroblocks.toLocaleString('en-US')} MBs (${row.aboveLevel52 ? 'ABOVE' : 'below'} L5.2) · ${trial.note}`;
  if (row.error) return `${head}\n   ✗ ${row.error}`;
  const body = row.decoded
    ? `✓ DECODED ${row.encodedWidth}×${row.encodedHeight}`
    : '✗ DID NOT DECODE';
  return `${head}\n   ${body} · ${(row.bytes / 1e6).toFixed(2)} MB · ${row.measuredMbps.toFixed(1)} Mb/s · `
    + `${row.chunkCount} chunk${row.chunkCount === 1 ? '' : 's'} · finalised ${(row.finalizeMs / 1000).toFixed(1)}s`
    + (row.encoderDied ? ` · ENCODER DIED: ${row.encoderDied}` : '');
}

/** Moving noise + moving blocks: real entropy, so the encoder cannot coast. */
function makePainter(canvas: HTMLCanvasElement): ((frame: number) => void) | null {
  const context = canvas.getContext('2d');
  if (!context) return null;
  const tile = document.createElement('canvas');
  tile.width = 256;
  tile.height = 256;
  const tileContext = tile.getContext('2d');
  if (!tileContext) return null;
  const image = tileContext.createImageData(256, 256);
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = Math.random() * 255;
    image.data[i + 1] = Math.random() * 255;
    image.data[i + 2] = Math.random() * 255;
    image.data[i + 3] = 255;
  }
  tileContext.putImageData(image, 0, 0);
  const pattern = context.createPattern(tile, 'repeat');
  const { width, height } = canvas;
  return (frame: number) => {
    const shift = (frame * 37) % 256;
    context.save();
    context.translate(shift, shift);
    context.fillStyle = pattern ?? '#333';
    context.fillRect(-256, -256, width + 512, height + 512);
    context.restore();
    for (let i = 0; i < 6; i++) {
      const size = Math.round(Math.min(width, height) / 5);
      const x = ((frame * (11 + i * 7)) + i * 313) % Math.max(1, width - size);
      const y = ((frame * (5 + i * 3)) + i * 197) % Math.max(1, height - size);
      context.fillStyle = `hsl(${(i * 60 + frame * 4) % 360} 90% 55%)`;
      context.fillRect(x, y, size, size);
    }
    context.fillStyle = '#fff';
    context.font = `${Math.round(height / 20)}px sans-serif`;
    context.fillText(`frame ${frame}`, Math.round(width * 0.05), Math.round(height * 0.12));
  };
}

async function runTrial(trial: ProbeTrial): Promise<ProbeRow> {
  const base = {
    trial,
    macroblocks: macroblocks(trial.width, trial.height),
    aboveLevel52: macroblocks(trial.width, trial.height) > H264_LEVEL_5_2_MACROBLOCKS,
    decoded: false,
    encodedWidth: 0,
    encodedHeight: 0,
    bytes: 0,
    measuredMbps: 0,
    chunkCount: 0,
    finalizeMs: 0,
    encoderDied: null as string | null,
    error: null as string | null
  };
  const canvas = document.createElement('canvas');
  canvas.width = trial.width;
  canvas.height = trial.height;
  const paint = makePainter(canvas);
  const capture = canvas as HTMLCanvasElement & { captureStream?: () => MediaStream };
  if (!paint || typeof capture.captureStream !== 'function') {
    return { ...base, error: 'canvas capture is unavailable in this browser' };
  }
  paint(0);
  const stream = capture.captureStream();
  const recorder = new ClipRecorder();
  const started = recorder.start(stream, { width: trial.width, height: trial.height }, trial.fps,
    `probe-${trial.width}x${trial.height}`, { save: false });
  if (!started.ok) {
    stream.getTracks().forEach((track) => track.stop());
    return { ...base, error: started.reason ?? 'recorder refused' };
  }
  let frame = 0;
  const ticker = window.setInterval(() => paint(++frame), Math.round(1000 / trial.fps));
  await new Promise((resolve) => window.setTimeout(resolve, trial.seconds * 1000));
  window.clearInterval(ticker);
  const result = await recorder.stop();
  stream.getTracks().forEach((track) => track.stop());
  // Release the 12 MP surface before the next trial claims one.
  canvas.width = 1;
  canvas.height = 1;
  if (!result) return { ...base, error: 'the recording produced no data' };
  return {
    ...base,
    decoded: result.encodedWidth > 0,
    encodedWidth: result.encodedWidth,
    encodedHeight: result.encodedHeight,
    bytes: result.bytes,
    measuredMbps: result.measuredBitsPerSecond / 1e6,
    chunkCount: result.chunkCount,
    finalizeMs: result.finalizeMs,
    encoderDied: result.encoderDied
  };
}

/**
 * Run the trials in order, one at a time, reporting each row as it lands.
 * A short breath between trials lets the previous encoder release before the
 * next one is created — the question is the encoder's envelope, not whether
 * two of them fit at once.
 */
export async function runEncoderProbe(
  trials: readonly ProbeTrial[],
  onRow: (row: ProbeRow, text: string) => void
): Promise<ProbeRow[]> {
  const rows: ProbeRow[] = [];
  for (const trial of trials) {
    const row = await runTrial(trial);
    rows.push(row);
    onRow(row, describeRow(row));
    await new Promise((resolve) => window.setTimeout(resolve, 400));
  }
  return rows;
}
