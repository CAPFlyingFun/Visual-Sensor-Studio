/**
 * Saving, sharing and loading custom lenses.
 *
 * Three places a lens can live, and they are genuinely different things:
 *
 *  LOCAL   — this browser, this device. Survives reloads and works offline,
 *            which is what a PWA is for. Nothing leaves the phone.
 *  SHARED  — a share code: the whole lens packed into a string that can be put
 *            in a link, a message or a note. There is no server in this path,
 *            so "sending someone a lens" is really just sending them text.
 *  GALLERY — lenses that ship WITH the site, read from `lenses/index.json`.
 *
 * WHY THERE IS NO "PUBLISH TO EVERYONE" BUTTON. This app is a static site on
 * GitHub Pages. A static site can be read by anyone and written by no one: to
 * push a file into the repository a page would need a token with write access
 * to it, and a token shipped inside a public web app is a token given to
 * everybody who opens it. So the gallery is curated — a lens joins it by being
 * added to the repository — and the share code is the path that lets one
 * person hand a lens to another with no account, no server and no upload.
 *
 * Everything arriving from outside this device goes through `sanitiseLens`.
 * A lens is data, but it is data from a stranger.
 */

import { clamp } from '../core/math.js';
import {
  CHANNELS,
  MAX_STOPS,
  MIN_STOPS,
  type ChannelId,
  type CustomLens,
  type LensBase, type LensOutput,
  type LensBinding,
  type LensStop
} from './lens.js';

export const LENS_STORAGE_KEY = 'vss.lenses.v1';

/** Names are shown in a list, so an enormous one would break the layout. */
const MAX_NAME = 40;
// A note has to have room to say WHY a lens differs from the one beside it,
// not just what it reads: two colour lenses that looked identical in a dull
// room could not be told apart in 140 characters (Joshua, 2026-09-02).
const MAX_NOTE = 280;

const CHANNEL_IDS = new Set<string>(CHANNELS.map((c) => c.id));
const BASES = new Set<string>(['black', 'grey', 'scene']);

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function text(value: unknown, max: number, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.replace(/\s+/g, ' ').trim().slice(0, max);
  return trimmed || fallback;
}

function sanitiseBinding(raw: unknown, fallback: ChannelId): LensBinding {
  const source = (raw ?? {}) as Record<string, unknown>;
  const channel = CHANNEL_IDS.has(String(source.channel))
    ? (source.channel as ChannelId)
    : fallback;
  return {
    channel,
    low: finite(source.low, 0),
    high: finite(source.high, 1),
    // A gamma of zero or a negative one is not a curve, it is a division by
    // zero waiting to happen further down.
    gamma: clamp(finite(source.gamma, 1), 0.1, 6)
  };
}

function sanitiseStops(raw: unknown): LensStop[] {
  const list = Array.isArray(raw) ? raw : [];
  const stops: LensStop[] = [];
  for (const entry of list.slice(0, MAX_STOPS)) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const color = typeof item.color === 'string' && /^#?[0-9a-f]{6}$/i.test(item.color.trim())
      ? `#${item.color.trim().replace('#', '').toLowerCase()}`
      : '#000000';
    stops.push({ at: clamp(finite(item.at, 0), 0, 1), color });
  }
  while (stops.length < MIN_STOPS) {
    stops.push({ at: stops.length ? 1 : 0, color: stops.length ? '#ffffff' : '#000000' });
  }
  return stops.sort((a, b) => a.at - b.at);
}

const OUTPUTS = new Set(['paint', 'mask', 'swap']);

/** A colour or nothing — never a half-parsed string reaching a shader. */
function hexOrUndefined(raw: unknown): string | undefined {
  const text = typeof raw === 'string' ? raw.trim() : '';
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : undefined;
}

export function newLensId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `lens-${Date.now().toString(36)}-${random}`;
}

/**
 * Coerce anything at all into a lens that is safe to render.
 *
 * This never throws and never returns a partial document. An import that is
 * nonsense produces a dull but working lens rather than an error, because a
 * half-validated lens reaching the renderer is how a stranger's file turns
 * into a crash in the camera loop.
 */
export function sanitiseLens(raw: unknown): CustomLens {
  const source = (raw ?? {}) as Record<string, unknown>;
  const color = sanitiseBinding(source.color, 'speed');
  const hasBrightness = source.brightness && typeof source.brightness === 'object';
  return {
    version: 1,
    id: text(source.id, 64, newLensId()),
    name: text(source.name, MAX_NAME, 'Untitled lens'),
    note: typeof source.note === 'string' ? text(source.note, MAX_NOTE, '') || undefined : undefined,
    color,
    stops: sanitiseStops(source.stops),
    brightness: hasBrightness ? sanitiseBinding(source.brightness, 'luma') : undefined,
    // 0 is the historical behaviour, so it is stored as absent — a lens
    // written before the floor existed and one that deliberately asks for no
    // floor are the same document, and stay the same document.
    brightnessFloor: hasBrightness && clamp(finite(source.brightnessFloor, 0), 0, 1) > 0
      ? clamp(finite(source.brightnessFloor, 0), 0, 1)
      : undefined,
    base: BASES.has(String(source.base)) ? (source.base as LensBase) : 'black',
    sceneBlend: clamp(finite(source.sceneBlend, 0), 0, 1),
    output: OUTPUTS.has(String(source.output)) ? (source.output as LensOutput) : undefined,
    reference: hexOrUndefined(source.reference),
    target: hexOrUndefined(source.target)
  };
}

/* ------------------------------------------------------------------ *
 * Local storage
 * ------------------------------------------------------------------ */

export interface LensStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadLenses(storage: LensStorage): CustomLens[] {
  try {
    const raw = storage.getItem(LENS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitiseLens);
  } catch {
    // A corrupt store must not stop the app from opening. Losing saved lenses
    // is bad; refusing to start the camera is worse.
    return [];
  }
}

export interface SaveResult {
  lenses: CustomLens[];
  saved: boolean;
  /** Set when the write failed, for a message rather than a silent loss. */
  error?: string;
}

/**
 * Insert or replace a lens and persist the list.
 *
 * There is no slot limit. A lens is a few hundred bytes and the browser gives
 * this origin megabytes, so a cap would be a rule invented for its own sake;
 * the real limit is the quota, and that is reported when it is actually hit
 * rather than guessed at in advance.
 */
export function saveLens(storage: LensStorage, existing: readonly CustomLens[], lens: CustomLens): SaveResult {
  const clean = sanitiseLens(lens);
  const next = [...existing];
  const at = next.findIndex((item) => item.id === clean.id);
  if (at >= 0) next[at] = clean;
  else next.push(clean);
  try {
    storage.setItem(LENS_STORAGE_KEY, JSON.stringify(next));
    return { lenses: next, saved: true };
  } catch (error) {
    return {
      lenses: existing as CustomLens[],
      saved: false,
      error: error instanceof Error && /quota/i.test(error.message)
        ? 'This browser is out of local storage. Delete a lens or export it first.'
        : 'Could not save to this browser.'
    };
  }
}

export function deleteLens(storage: LensStorage, existing: readonly CustomLens[], id: string): CustomLens[] {
  const next = existing.filter((item) => item.id !== id);
  try {
    storage.setItem(LENS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Nothing useful to do; the in-memory list is still correct.
  }
  return next;
}

/* ------------------------------------------------------------------ *
 * Share codes
 * ------------------------------------------------------------------ */

function toBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Pack a lens into a string.
 *
 * The id is dropped: an imported lens is a NEW lens on the receiving device,
 * not the same object in two places, and keeping the id would make importing a
 * friend's lens silently overwrite your own edit of it.
 */
export function encodeLensShare(lens: CustomLens): string {
  const { id: _id, ...rest } = sanitiseLens(lens);
  return toBase64Url(JSON.stringify(rest));
}

export function decodeLensShare(code: string): CustomLens | null {
  const trimmed = code.trim().replace(/^.*#lens=/, '').replace(/^.*[?&]lens=/, '');
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(trimmed));
    if (!parsed || typeof parsed !== 'object') return null;
    return sanitiseLens({ ...(parsed as object), id: newLensId() });
  } catch {
    return null;
  }
}

/** A link that opens this app with the lens ready to import. */
export function shareLink(lens: CustomLens, origin: string): string {
  const base = origin.split('#')[0];
  return `${base}#lens=${encodeLensShare(lens)}`;
}

/** Pull a share code out of a location hash or query, if there is one. */
export function lensFromLocation(hash: string, search: string): CustomLens | null {
  const fromHash = /[#&]lens=([^&]+)/.exec(hash);
  if (fromHash) return decodeLensShare(fromHash[1]);
  const fromQuery = /[?&]lens=([^&]+)/.exec(search);
  if (fromQuery) return decodeLensShare(fromQuery[1]);
  return null;
}

/* ------------------------------------------------------------------ *
 * Gallery
 * ------------------------------------------------------------------ */

export interface GalleryEntry {
  lens: CustomLens;
  /** Who made it, as recorded in the repository. */
  author?: string;
}

/**
 * Read the lenses that ship with the site.
 *
 * A failure here is not an error worth showing: the gallery is a convenience,
 * and the app is fully usable offline without it.
 */
export async function loadGallery(
  fetcher: (url: string) => Promise<Response>,
  url = 'lenses/index.json'
): Promise<GalleryEntry[]> {
  try {
    const response = await fetcher(url);
    if (!response.ok) return [];
    const parsed: unknown = await response.json();
    const list = Array.isArray(parsed) ? parsed : (parsed as { lenses?: unknown })?.lenses;
    if (!Array.isArray(list)) return [];
    return list.map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      return {
        lens: sanitiseLens(item),
        author: typeof item.author === 'string' ? item.author.slice(0, 40) : undefined
      };
    });
  } catch {
    return [];
  }
}
