/**
 * How long clips stay on the phone, and which one goes when they cannot all
 * stay.
 *
 * Joshua: "temporary hold on the user's phone until you save it or all
 * depending on how many videos you have."
 *
 * TEMPORARY IS THE HONEST WORD, and the browser makes it so whether or not the
 * app agrees. Origin storage on iOS is evictable: it can be cleared when the
 * device is short of space, and Safari discards a site's storage after weeks
 * without a visit. So a clip held here is a convenience, not a place to keep
 * something — anything worth keeping has to be exported to Photos or Files,
 * and the interface says that rather than implying an archive.
 *
 * WHAT GETS EVICTED FIRST is the part worth thinking about. A clip already
 * exported has a copy somewhere the phone will not delete on its own, so
 * losing this one costs nothing. A clip that has never been exported exists
 * only here, and dropping it destroys the only copy. So exports go first,
 * oldest first, and only then the unexported ones — and the newest clip is
 * never dropped, because that is the one just recorded and the reason the
 * camera was pointed at anything.
 */

export interface ClipRecord {
  id: string;
  /** Wall clock at the start of the clip. */
  startedAt: number;
  seconds: number;
  bytes: number;
  /** What was on screen — the camera, or a named filter. */
  label: string;
  /** When it was exported, or null while this is the only copy. */
  savedAt: number | null;
  /**
   * Frames a second the clip actually contains.
   *
   * Measured rather than requested: the recorded rate is the rate the app
   * managed to redraw a picture, which is not the camera's rate and not the
   * analysis rate either. Optional because clips recorded before this was
   * measured do not carry it.
   */
  fps?: number;
  /**
   * What the encoder ACTUALLY wrote, read back by decoding the file.
   *
   * Not the canvas size and not what was asked for: an encoder may downscale
   * to fit the level it was given, and nothing else in the app would notice.
   * Absent on clips recorded before this was measured.
   */
  encodedWidth?: number;
  encodedHeight?: number;
  /** The mimeType the recorder chose, which may not be the one requested. */
  recorderMime?: string;
}

export interface RetentionLimits {
  maxClips: number;
  maxBytes: number;
}

export interface RetentionPlan {
  keep: ClipRecord[];
  evict: ClipRecord[];
  bytes: number;
  reason: string;
}

/** Below this there is no point offering to record at all. */
export const MIN_BUDGET_BYTES = 40 * 1024 * 1024;

/**
 * Never fill the phone. A quarter of what is free, and never more than this.
 *
 * The app is a camera toy and the phone is a phone: taking a gigabyte of a
 * stranger's storage for held clips would be rude even where the quota allows
 * it. The share is deliberately modest and the ceiling is absolute.
 */
export const MAX_BUDGET_BYTES = 600e6;
export const BUDGET_SHARE = 0.25;

/**
 * Turn what the browser reports about storage into a budget.
 *
 * THIS IS NOT THE PHONE'S FREE SPACE, and calling it that was wrong. Joshua's
 * iPhone had 192.95GB free of 512GB while the app reported "41.23GB free on
 * this device" — because `navigator.storage.estimate()` reports the QUOTA this
 * browser will allow this one website, which is a fraction of the disk and has
 * nothing to do with what Settings shows. It is also deliberately coarsened, so
 * a page cannot fingerprint a device by its exact free space.
 *
 * So it is an allowance, not an accounting, and it is described as one.
 */
export function budgetFromQuota(quotaBytes: number, usedBytes: number): RetentionLimits {
  const free = Math.max(0, (Number.isFinite(quotaBytes) ? quotaBytes : 0) - Math.max(0, usedBytes));
  const maxBytes = Math.min(MAX_BUDGET_BYTES, Math.floor(free * BUDGET_SHARE));
  // Thirty seconds at a middling bit rate is about 20MB, so the clip count
  // follows the byte budget rather than being a second, independent limit that
  // could contradict it.
  const maxClips = Math.max(0, Math.floor(maxBytes / 20e6));
  return { maxBytes, maxClips };
}

function bytesOf(clips: ReadonlyArray<ClipRecord>): number {
  return clips.reduce((total, clip) => total + Math.max(0, clip.bytes), 0);
}

/**
 * Which clips stay and which go, given the budget.
 *
 * Newest first in `keep`, because that is the order they are looked at.
 */
export function planRetention(
  clips: ReadonlyArray<ClipRecord>,
  limits: RetentionLimits
): RetentionPlan {
  const newestFirst = [...clips].sort((a, b) => b.startedAt - a.startedAt);
  if (newestFirst.length === 0) {
    return { keep: [], evict: [], bytes: 0, reason: 'Nothing held.' };
  }

  // Exported first, then oldest — see the note at the top of the file.
  const droppable = newestFirst.slice(1).sort((a, b) => {
    const exported = Number(b.savedAt !== null) - Number(a.savedAt !== null);
    return exported !== 0 ? exported : a.startedAt - b.startedAt;
  });

  const evict: ClipRecord[] = [];
  const doomed = new Set<string>();
  const over = () =>
    bytesOf(newestFirst.filter((c) => !doomed.has(c.id))) > limits.maxBytes
    || newestFirst.filter((c) => !doomed.has(c.id)).length > limits.maxClips;

  for (const clip of droppable) {
    if (!over()) break;
    doomed.add(clip.id);
    evict.push(clip);
  }

  const keep = newestFirst.filter((c) => !doomed.has(c.id));
  const bytes = bytesOf(keep);

  let reason: string;
  if (evict.length === 0) {
    reason = `${keep.length} held · ${describeSize(bytes)}`;
  } else {
    const unsaved = evict.filter((c) => c.savedAt === null).length;
    reason = `${keep.length} held · ${describeSize(bytes)} · dropped ${evict.length} oldest`
      + (unsaved > 0
        ? ` (${unsaved} that had never been exported — export sooner to keep them)`
        : ' (all already exported)');
  }
  return { keep, evict, bytes, reason };
}

/** Bytes as a person reads them. Powers of ten, like a phone's storage screen. */
export function describeSize(bytes: number): string {
  if (!(bytes > 0)) return '0 MB';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${bytes} B`;
}

export function describeClip(clip: ClipRecord): string {
  const when = new Date(clip.startedAt);
  const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const held = clip.savedAt === null ? 'held only here' : 'exported';
  const rate = clip.fps && clip.fps > 0 ? ` · ${clip.fps.toFixed(1)} fps` : '';
  return `${time} · ${clip.seconds.toFixed(1)}s${rate} · ${describeSize(clip.bytes)} · ${clip.label} · ${held}`;
}

/**
 * How much recording the budget is worth, in seconds.
 *
 * A number of megabytes means nothing while pointing a camera at something.
 * Minutes do.
 */
export function budgetSeconds(limits: RetentionLimits, bitsPerSecond: number): number {
  if (!(bitsPerSecond > 0)) return 0;
  return Math.floor(limits.maxBytes / (bitsPerSecond / 8));
}
