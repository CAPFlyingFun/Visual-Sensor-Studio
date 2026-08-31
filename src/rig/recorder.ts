/**
 * Recording bone motion in layers, and getting more channels than you performed.
 *
 * Two ideas do the work here.
 *
 * LAYERING. A rig with thirteen moving parts is not thirteen things to
 * coordinate at once — it is thirteen easy takes. Set a loop length, record one
 * bone while everything already recorded plays back, commit, move on. This is
 * how multitrack audio has always worked and it is why one person can play a
 * band.
 *
 * PHASE. A walking hexapod's legs are not six independent channels: they are one
 * cycle at six offsets. Tripod gait puts legs 1-4-5 together and 2-3-6 exactly
 * half a cycle behind. So you perform ONE leg and the gait distributes it, which
 * is the difference between an afternoon and a minute.
 */

import type { QuaternionLike } from './one-euro.js';

export interface Keyframe {
  /** Position within the loop, in seconds. */
  time: number;
  rotation: QuaternionLike;
}

export interface Channel {
  bone: string;
  keys: Keyframe[];
  /**
   * Fraction of the loop this channel is shifted by, 0..1.
   *
   * How one recorded leg becomes six.
   */
  phase: number;
  muted: boolean;
}

const IDENTITY: QuaternionLike = { x: 0, y: 0, z: 0, w: 1 };

/** Shortest-path spherical interpolation between two rotations. */
export function slerp(a: QuaternionLike, b: QuaternionLike, t: number): QuaternionLike {
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;

  // q and -q are the same rotation, so the negative branch is taken to keep
  // the path short. Without this, half of all interpolations take the long way
  // round and the bone spins to reach a pose next to where it started.
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }

  // Nearly parallel: slerp's sine terms lose all precision, and a straight
  // lerp is both accurate and stable there.
  if (dot > 0.9995) {
    const x = a.x + (bx - a.x) * t;
    const y = a.y + (by - a.y) * t;
    const z = a.z + (bz - a.z) * t;
    const w = a.w + (bw - a.w) * t;
    const length = Math.hypot(x, y, z, w) || 1;
    return { x: x / length, y: y / length, z: z / length, w: w / length };
  }

  const theta = Math.acos(Math.min(1, dot));
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  return {
    x: a.x * wa + bx * wb,
    y: a.y * wa + by * wb,
    z: a.z * wa + bz * wb,
    w: a.w * wa + bw * wb
  };
}

export interface GaitLeg {
  bone: string;
  /** Fraction of the cycle this leg trails the recorded one, 0..1. */
  phase: number;
}

/**
 * Tripod gait: the walk almost every six-legged insect uses.
 *
 * Front-left, middle-right and rear-left swing together while the other three
 * hold the ground, then they swap. Three points of contact at all times, which
 * is why it is stable enough to run with.
 *
 * Legs are named in the order front-left, middle-left, rear-left, front-right,
 * middle-right, rear-right.
 */
export function tripodGait(bones: readonly string[]): GaitLeg[] {
  const offsets = [0, 0.5, 0, 0.5, 0, 0.5];
  return bones.slice(0, 6).map((bone, index) => ({ bone, phase: offsets[index] ?? 0 }));
}

/**
 * Wave gait: one leg at a time, the slow careful walk.
 *
 * Five legs down at every instant. Insects use it when moving precisely or over
 * difficult ground, and it reads as deliberate rather than scurrying.
 */
export function waveGait(bones: readonly string[]): GaitLeg[] {
  return bones.slice(0, 6).map((bone, index) => ({ bone, phase: index / 6 }));
}

export class RigRecorder {
  private channels = new Map<string, Channel>();
  private recording: { bone: string; keys: Array<Keyframe & { order: number }> } | null = null;
  private recordCounter = 0;

  /** Loop length in seconds. Everything is stored as a position within it. */
  loopSeconds = 2;

  get isRecording(): boolean {
    return this.recording !== null;
  }

  get recordingBone(): string | null {
    return this.recording?.bone ?? null;
  }

  get boneNames(): string[] {
    return [...this.channels.keys()];
  }

  channel(bone: string): Channel | undefined {
    return this.channels.get(bone);
  }

  clear(): void {
    this.channels.clear();
    this.recording = null;
  }

  removeChannel(bone: string): void {
    this.channels.delete(bone);
  }

  setPhase(bone: string, phase: number): void {
    const channel = this.channels.get(bone);
    // Wrapped rather than clamped: a phase is a position on a circle, so 1.25
    // is a quarter cycle, not an error.
    if (channel) channel.phase = ((phase % 1) + 1) % 1;
  }

  setMuted(bone: string, muted: boolean): void {
    const channel = this.channels.get(bone);
    if (channel) channel.muted = muted;
  }

  /**
   * Begin a take on one bone. Everything else keeps playing.
   *
   * The take is held aside rather than written into the channel as it goes, so
   * abandoning it leaves the previous performance intact.
   */
  startRecording(bone: string): void {
    this.recording = { bone, keys: [] };
  }

  /** @param time position within the loop, in seconds */
  record(time: number, rotation: QuaternionLike): void {
    if (!this.recording) return;
    // Stored in arrival order and sorted once at the end. Discarding earlier
    // keys the moment the clock wrapped seemed like the way to handle a take
    // that crosses the loop point, and it threw away every take that ran
    // exactly one full loop — the last sample lands on the loop length, wraps
    // to zero, and looks like a restart.
    this.recording.keys.push({
      time: this.wrap(time),
      rotation: { ...rotation },
      order: this.recordCounter++
    });
  }

  /** Commit the take, replacing whatever that bone was doing. */
  stopRecording(): Channel | null {
    const take = this.recording;
    this.recording = null;
    if (!take || take.keys.length < 2) return null;

    // Sorted into loop order, and where a second pass covered the same instant
    // the LATER take wins — which is what overdubbing onto a loop means.
    const sorted = [...take.keys].sort((a, b) => a.time - b.time || a.order - b.order);
    const keys: Keyframe[] = [];
    let lastOrder = -1;
    for (const key of sorted) {
      const previous = keys[keys.length - 1];
      if (previous && key.time - previous.time < 1e-4) {
        // Same instant, later pass: replace. Carrying the order alongside
        // rather than searching for it keeps this linear in the take length.
        if (key.order > lastOrder) {
          keys[keys.length - 1] = { time: key.time, rotation: key.rotation };
          lastOrder = key.order;
        }
        continue;
      }
      keys.push({ time: key.time, rotation: key.rotation });
      lastOrder = key.order;
    }
    if (keys.length < 2) return null;

    const existing = this.channels.get(take.bone);
    const channel: Channel = {
      bone: take.bone,
      keys,
      // Phase and mute belong to the slot, not the take, so re-recording a leg
      // does not silently move it back into step with the others.
      phase: existing?.phase ?? 0,
      muted: existing?.muted ?? false
    };
    this.channels.set(take.bone, channel);
    return channel;
  }

  cancelRecording(): void {
    this.recording = null;
  }

  /** The pose for one bone at a moment in the loop. */
  sample(bone: string, time: number): QuaternionLike | null {
    const channel = this.channels.get(bone);
    if (!channel || channel.muted || channel.keys.length === 0) return null;
    return sampleKeys(channel.keys, this.wrap(time - channel.phase * this.loopSeconds), this.loopSeconds);
  }

  /**
   * Every bone's pose at one moment, including legs driven from another
   * channel's recording by a gait.
   */
  pose(time: number, gait: readonly GaitLeg[] = [], source?: string): Map<string, QuaternionLike> {
    const result = new Map<string, QuaternionLike>();
    for (const bone of this.channels.keys()) {
      const rotation = this.sample(bone, time);
      if (rotation) result.set(bone, rotation);
    }

    if (source && this.channels.has(source)) {
      for (const leg of gait) {
        // A leg with its own recording keeps it; the gait fills the rest.
        if (this.channels.has(leg.bone)) continue;
        const rotation = this.sample(source, time - leg.phase * this.loopSeconds);
        if (rotation) result.set(leg.bone, rotation);
      }
    }
    return result;
  }

  private wrap(time: number): number {
    const loop = Math.max(0.05, this.loopSeconds);
    return ((time % loop) + loop) % loop;
  }
}

/**
 * Interpolate a key list at a position in the loop.
 *
 * The list wraps: the last key leads back to the first across the loop
 * boundary, so a cycle joins to itself instead of snapping at the seam.
 */
export function sampleKeys(
  keys: readonly Keyframe[],
  time: number,
  loopSeconds: number
): QuaternionLike {
  if (keys.length === 0) return IDENTITY;
  if (keys.length === 1) return keys[0].rotation;

  const first = keys[0];
  const last = keys[keys.length - 1];

  if (time <= first.time || time >= last.time) {
    // Across the wrap, from the last key back round to the first.
    const gap = loopSeconds - last.time + first.time;
    if (gap <= 1e-6) return first.rotation;
    const into = time >= last.time ? time - last.time : loopSeconds - last.time + time;
    return slerp(last.rotation, first.rotation, into / gap);
  }

  let low = 0;
  let high = keys.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (keys[mid].time <= time) low = mid;
    else high = mid;
  }
  const a = keys[low];
  const b = keys[high];
  const span = b.time - a.time;
  return span > 1e-9 ? slerp(a.rotation, b.rotation, (time - a.time) / span) : a.rotation;
}
