/**
 * Generic moving-object detection and tracking.
 *
 * Deliberately NOT semantic recognition: this finds connected regions that
 * changed between frames and follows them over time. It has no idea what any
 * of them are, and the app must not imply otherwise.
 *
 * Two stages:
 *   1. Connected-component labelling over a thresholded motion mask, giving
 *      blobs with a bounding box, centroid and area.
 *   2. Greedy nearest-neighbour association of blobs to existing tracks, gated
 *      by a maximum plausible displacement, with velocity estimated from
 *      timestamps rather than assumed frame spacing — the analysis rate is
 *      adaptive, so frames are not evenly spaced.
 *
 * Speeds are in ANALYSIS-FRAME PIXELS PER SECOND. They are not physical
 * velocities: converting to m/s needs distance to the subject and the lens's
 * angular scale, neither of which this app has. Callers must not relabel them.
 */

export interface Blob {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  centerX: number;
  centerY: number;
  /** Pixels above threshold in this component. */
  area: number;
}

export interface TrackPoint {
  x: number;
  y: number;
  t: number;
}

export interface TrackedObject {
  id: number;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  /** Analysis-frame pixels per second. Not a physical speed. */
  speedPxPerSec: number;
  /** Degrees, 0 = +x (right), 90 = +y (down in image space). */
  directionDeg: number;
  velocityX: number;
  velocityY: number;
  /** 0..1, from how consistently the track has been matched. */
  confidence: number;
  /** Seconds since the track was created. */
  ageSec: number;
  firstSeen: number;
  lastSeen: number;
  /** Consecutive updates with no matching blob. */
  missedFrames: number;
  /** Recent positions, oldest first. Bounded. */
  trail: TrackPoint[];
}

export interface TrackerOptions {
  /** Motion-mask value at or above which a pixel counts as moving. */
  threshold?: number;
  /** Components smaller than this are noise. */
  minBlobArea?: number;
  /** Largest association distance, in pixels, at one second of separation. */
  maxMatchDistance?: number;
  /** Updates a track survives without a match before it is dropped. */
  maxMissedFrames?: number;
  /** Maximum retained trail points per track. */
  trailLength?: number;
  /** Hard cap on simultaneous tracks, newest-largest kept. */
  maxObjects?: number;
}

const DEFAULTS: Required<TrackerOptions> = {
  threshold: 26,
  minBlobArea: 6,
  maxMatchDistance: 48,
  maxMissedFrames: 6,
  trailLength: 48,
  maxObjects: 12
};

/**
 * Label connected components of a thresholded mask.
 *
 * Iterative flood fill with an explicit stack — a recursive one blows the call
 * stack on a large moving region, which is exactly when this runs. Scratch
 * buffers are supplied by the caller and reused across frames.
 */
export function findBlobs(
  mask: ArrayLike<number>,
  width: number,
  height: number,
  options: TrackerOptions = {},
  scratch?: { visited: Uint8Array; stack: Int32Array }
): Blob[] {
  const threshold = options.threshold ?? DEFAULTS.threshold;
  const minBlobArea = options.minBlobArea ?? DEFAULTS.minBlobArea;
  const count = width * height;
  if (count === 0 || mask.length < count) return [];

  const visited = scratch && scratch.visited.length === count
    ? scratch.visited
    : new Uint8Array(count);
  visited.fill(0);
  const stack = scratch && scratch.stack.length >= count
    ? scratch.stack
    : new Int32Array(count);

  const blobs: Blob[] = [];

  for (let start = 0; start < count; start++) {
    if (visited[start] || (mask[start] ?? 0) < threshold) continue;

    let top = 0;
    stack[top++] = start;
    visited[start] = 1;

    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let sumX = 0;
    let sumY = 0;
    let area = 0;

    while (top > 0) {
      const index = stack[--top];
      const x = index % width;
      const y = (index / width) | 0;

      area++;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      // Four-connectivity: cheaper than eight, and a diagonal-only join is
      // usually noise rather than one object.
      if (x > 0) {
        const n = index - 1;
        if (!visited[n] && (mask[n] ?? 0) >= threshold) { visited[n] = 1; stack[top++] = n; }
      }
      if (x < width - 1) {
        const n = index + 1;
        if (!visited[n] && (mask[n] ?? 0) >= threshold) { visited[n] = 1; stack[top++] = n; }
      }
      if (y > 0) {
        const n = index - width;
        if (!visited[n] && (mask[n] ?? 0) >= threshold) { visited[n] = 1; stack[top++] = n; }
      }
      if (y < height - 1) {
        const n = index + width;
        if (!visited[n] && (mask[n] ?? 0) >= threshold) { visited[n] = 1; stack[top++] = n; }
      }
    }

    if (area >= minBlobArea) {
      blobs.push({ minX, minY, maxX, maxY, centerX: sumX / area, centerY: sumY / area, area });
    }
  }

  return blobs;
}

export class ObjectTracker {
  private readonly options: Required<TrackerOptions>;
  private tracks: TrackedObject[] = [];
  private nextId = 1;
  private lastUpdate = 0;
  private scratch: { visited: Uint8Array; stack: Int32Array } | undefined;

  constructor(options: TrackerOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  get objects(): readonly TrackedObject[] {
    return this.tracks;
  }

  /** Fastest current track, in analysis-frame px/sec. */
  get fastestSpeed(): number {
    let fastest = 0;
    for (const track of this.tracks) {
      if (track.speedPxPerSec > fastest) fastest = track.speedPxPerSec;
    }
    return fastest;
  }

  reset(): void {
    this.tracks = [];
    this.nextId = 1;
    this.lastUpdate = 0;
  }

  /**
   * Update tracks from a motion mask. `now` is a monotonic ms clock; frames
   * are not evenly spaced, so every rate is derived from it rather than from
   * an assumed interval.
   */
  update(mask: ArrayLike<number>, width: number, height: number, now: number): readonly TrackedObject[] {
    const count = width * height;
    if (!this.scratch || this.scratch.visited.length !== count) {
      this.scratch = { visited: new Uint8Array(count), stack: new Int32Array(Math.max(1, count)) };
    }

    const blobs = findBlobs(mask, width, height, this.options, this.scratch);
    const dt = this.lastUpdate > 0 ? Math.max(1, now - this.lastUpdate) / 1000 : 0;
    this.lastUpdate = now;

    // The association gate scales with elapsed time: at 60 fps an object moves
    // a fraction of what it covers at 8 fps, and a fixed radius would either
    // merge separate objects at low rates or lose one track at high rates.
    const gate = dt > 0
      ? Math.min(this.options.maxMatchDistance, Math.max(6, this.options.maxMatchDistance * dt))
      : this.options.maxMatchDistance;

    const usedBlobs = new Set<number>();
    const survivors: TrackedObject[] = [];

    for (const track of this.tracks) {
      // Match against where the track is predicted to be, not where it was.
      const predictedX = track.centerX + track.velocityX * dt;
      const predictedY = track.centerY + track.velocityY * dt;

      let bestIndex = -1;
      let bestDistance = gate;
      for (let i = 0; i < blobs.length; i++) {
        if (usedBlobs.has(i)) continue;
        const blob = blobs[i];
        const distance = Math.hypot(blob.centerX - predictedX, blob.centerY - predictedY);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = i;
        }
      }

      if (bestIndex >= 0) {
        usedBlobs.add(bestIndex);
        this.applyMatch(track, blobs[bestIndex], dt, now);
        survivors.push(track);
        continue;
      }

      track.missedFrames++;
      track.confidence = Math.max(0, track.confidence - 0.16);
      if (track.missedFrames <= this.options.maxMissedFrames && track.confidence > 0.08) {
        // Coast on the last velocity so a brief occlusion does not restart
        // the track with a new id.
        track.centerX += track.velocityX * dt;
        track.centerY += track.velocityY * dt;
        track.lastSeen = now;
        track.ageSec = (now - track.firstSeen) / 1000;
        survivors.push(track);
      }
    }

    for (let i = 0; i < blobs.length; i++) {
      if (usedBlobs.has(i)) continue;
      survivors.push(this.createTrack(blobs[i], now));
    }

    // Bound the set so a noisy scene cannot grow it without limit; the largest
    // regions are the ones worth keeping.
    if (survivors.length > this.options.maxObjects) {
      survivors.sort((a, b) => b.width * b.height - a.width * a.height);
      survivors.length = this.options.maxObjects;
    }

    this.tracks = survivors;
    return this.tracks;
  }

  private applyMatch(track: TrackedObject, blob: Blob, dt: number, now: number): void {
    if (dt > 0) {
      const instantVx = (blob.centerX - track.centerX) / dt;
      const instantVy = (blob.centerY - track.centerY) / dt;
      // Smoothed so a single ragged mask does not spike the reported speed.
      track.velocityX = track.velocityX * 0.55 + instantVx * 0.45;
      track.velocityY = track.velocityY * 0.55 + instantVy * 0.45;
    }

    track.centerX = blob.centerX;
    track.centerY = blob.centerY;
    track.width = blob.maxX - blob.minX + 1;
    track.height = blob.maxY - blob.minY + 1;
    track.speedPxPerSec = Math.hypot(track.velocityX, track.velocityY);
    track.directionDeg = (Math.atan2(track.velocityY, track.velocityX) * 180) / Math.PI;
    track.missedFrames = 0;
    track.confidence = Math.min(1, track.confidence + 0.12);
    track.lastSeen = now;
    track.ageSec = (now - track.firstSeen) / 1000;
    this.pushTrail(track, now);
  }

  private createTrack(blob: Blob, now: number): TrackedObject {
    const track: TrackedObject = {
      id: this.nextId++,
      centerX: blob.centerX,
      centerY: blob.centerY,
      width: blob.maxX - blob.minX + 1,
      height: blob.maxY - blob.minY + 1,
      speedPxPerSec: 0,
      directionDeg: 0,
      velocityX: 0,
      velocityY: 0,
      // A brand-new track has one observation: it could be noise, and its
      // confidence has to earn its way up over subsequent matches.
      confidence: 0.25,
      ageSec: 0,
      firstSeen: now,
      lastSeen: now,
      missedFrames: 0,
      trail: []
    };
    this.pushTrail(track, now);
    return track;
  }

  private pushTrail(track: TrackedObject, now: number): void {
    track.trail.push({ x: track.centerX, y: track.centerY, t: now });
    if (track.trail.length > this.options.trailLength) track.trail.shift();
  }
}
