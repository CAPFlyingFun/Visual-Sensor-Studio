/**
 * What this browser can actually RECORD — asked, never assumed.
 *
 * MediaRecorder support is the most version-dependent thing in the app.
 * Safari added it late, supports a different container from every other
 * browser, and `MediaRecorder.isTypeSupported` is the only honest way to find
 * out what a given phone will produce. A version table would be one more thing
 * claiming a capability the device may not have — the same mistake the save
 * formats already refuse to make.
 *
 * ORDER IS NOT PREFERENCE, IT IS USABILITY. MP4 comes first because on iOS it
 * is the only one that reaches Photos: a WebM saved to an iPhone opens in
 * nothing the phone ships with, so a recording in that container is a file the
 * owner cannot watch. Where a browser offers both, MP4 is the one that leaves
 * the app usefully.
 */

export interface ClipFormat {
  id: string;
  mime: string;
  extension: string;
  label: string;
}

export const CLIP_CANDIDATES: readonly ClipFormat[] = [
  // avc1.42E01E is baseline H.264 at level 3 — the profile every phone decodes.
  { id: 'mp4-h264', mime: 'video/mp4;codecs=avc1.42E01E', extension: 'mp4', label: 'MP4 · H.264' },
  { id: 'mp4', mime: 'video/mp4', extension: 'mp4', label: 'MP4' },
  { id: 'webm-vp9', mime: 'video/webm;codecs=vp9', extension: 'webm', label: 'WebM · VP9' },
  { id: 'webm-vp8', mime: 'video/webm;codecs=vp8', extension: 'webm', label: 'WebM · VP8' },
  { id: 'webm', mime: 'video/webm', extension: 'webm', label: 'WebM' }
];

/** Every candidate this browser says it can encode, in usability order. */
export function supportedClipFormats(isTypeSupported: (mime: string) => boolean): ClipFormat[] {
  return CLIP_CANDIDATES.filter((format) => {
    try {
      return isTypeSupported(format.mime);
    } catch {
      // A browser without MediaRecorder at all throws here rather than
      // answering. That is a "no", not a crash.
      return false;
    }
  });
}

/**
 * The format to ASK for when the browser is willing to name one.
 *
 * Null does not mean the browser cannot record — see BROWSER_DEFAULT.
 */
export function preferredClipFormat(available: ReadonlyArray<ClipFormat>): ClipFormat | null {
  return available.length > 0 ? available[0] : null;
}

/**
 * ASKING IS NOT THE ONLY WAY TO FIND OUT, and on Joshua's iPhone it was the
 * wrong one: `isTypeSupported` matched nothing at all and the app concluded
 * "this browser cannot record video from a web page" on a phone that records
 * video perfectly well.
 *
 * A MediaRecorder constructed with NO mimeType uses the browser's own default
 * and then reports it back on `.mimeType`. That is the same principle the save
 * formats already work on — check what actually came back rather than what a
 * table claims — and it is strictly better here, because a browser cannot be
 * wrong about the format it just chose for itself.
 *
 * So this is the fallback: record with no request, read the answer, name the
 * file from it.
 */
export const BROWSER_DEFAULT: ClipFormat = {
  id: 'default',
  mime: '',
  extension: 'mp4',
  label: 'the browser’s own format'
};

/** The file extension a container should carry, from what the recorder said. */
export function extensionForMime(mime: string): string {
  const base = (mime || '').split(';')[0].trim().toLowerCase();
  if (base.includes('mp4')) return 'mp4';
  if (base.includes('webm')) return 'webm';
  if (base.includes('quicktime')) return 'mov';
  if (base.includes('matroska')) return 'mkv';
  // Fall back to the subtype itself — `video/ogg` is a .ogg — rather than to a
  // generic extension, which would produce a file nothing offers to open.
  const subtype = base.split('/')[1]?.replace(/^x-/, '') ?? '';
  return /^[a-z0-9]{2,5}$/.test(subtype) ? subtype : 'mp4';
}

/** What a recorder actually produced, as a format record. */
export function formatFromMime(mime: string): ClipFormat {
  const base = (mime || '').split(';')[0].trim().toLowerCase();
  const known = CLIP_CANDIDATES.find((c) => c.mime.split(';')[0] === base);
  if (known) return { ...known, mime: mime || known.mime };
  return {
    id: 'reported',
    mime,
    extension: extensionForMime(mime),
    label: mime || BROWSER_DEFAULT.label
  };
}

/**
 * Video is a RATE, and this is the number that decides whether a phone can
 * hold what it records.
 *
 * Stated per second rather than per clip because that is the part a person can
 * reason about: at 6 Mb/s a thirty-second clip is about 22 MB, so ten of them
 * is a fifth of a gigabyte. A recorder that does not say this fills a phone
 * quietly.
 */
export function estimateClipBytes(bitsPerSecond: number, seconds: number): number {
  if (!(bitsPerSecond > 0) || !(seconds > 0)) return 0;
  return Math.round((bitsPerSecond / 8) * seconds);
}

/**
 * A bit rate that suits the frame size, rather than one constant for everything.
 *
 * Roughly 0.1 bits per pixel per frame, which is a conventional starting point
 * for H.264 at ordinary motion — about 6 Mb/s for 1080p30 and 2.6 Mb/s for
 * 720p30. It is a starting point and not a measurement; the encoder's own rate
 * control is what actually decides, and this only tells it where to aim.
 */
export function suggestedBitrate(width: number, height: number, fps: number): number {
  const pixels = Math.max(1, width * height);
  const rate = Math.round(pixels * Math.max(1, fps) * 0.1);
  return Math.min(12_000_000, Math.max(800_000, rate));
}

export function clipFileName(label: string, when: Date, extension: string): string {
  const stamp = when.toISOString().replace(/[:.]/g, '-');
  const safe = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '');
  return `visual-sensor-${safe || 'clip'}-${stamp}.${extension}`;
}

/**
 * Fit a frame to a LONG SIDE rather than to a width.
 *
 * Joshua chose "480" in portrait and got 480x640 — 92MB of held frames and a
 * refusal, because in portrait a fixed WIDTH makes the frame taller rather than
 * smaller. The long side means the same number of pixels whichever way the
 * phone is held, so memory and file size follow the choice instead of the grip.
 *
 * Both dimensions are rounded to even numbers: odd sizes upset some players,
 * and the rounding costs at most one row.
 */
export function fitLongSide(
  sourceWidth: number,
  sourceHeight: number,
  longSide: number
): { width: number; height: number } {
  const w = Math.max(1, sourceWidth);
  const h = Math.max(1, sourceHeight);
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  const long = even(longSide);
  const short = even((long * Math.min(w, h)) / Math.max(w, h));
  return w >= h ? { width: long, height: short } : { width: short, height: long };
}
