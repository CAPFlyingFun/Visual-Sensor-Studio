/**
 * IMPORTED PICTURES — running the same filters over a file instead of the
 * camera, and being straight about what that file already lost.
 *
 * Joshua: "The import option, is that for both video or pictures to apply
 * custom filters on existing video? Not the same as live, but still good to
 * have." V2 arrived with no media import at all — only lens JSON — so this is
 * the first half: a still in, any filter over it, at its own full size.
 *
 * WHY AN IMPORT IS INTERESTING BEYOND CONVENIENCE. Every resolution limit the
 * live path fights exists because frames arrive thirty times a second and
 * must be kept up with. A file has no such clock: it can be decoded once and
 * rendered as slowly as it likes, at its own full size, with nothing waiting.
 * So an imported still is the one path where the filter runs at the picture's
 * real resolution without a budget argument.
 *
 * TWO HONESTY RULES, and they are the whole reason this is a module rather
 * than a file input wired straight to the renderer.
 *
 * FIRST: AN IMPORTED FILE HAS ALREADY LOST INFORMATION. A JPEG carries
 * blocking and ringing that the camera's own frame did not, and an edge or
 * rarity filter will amplify exactly those artefacts and present them as
 * structure. That is not a reason to refuse the import; it is a reason to say
 * so, because the picture will look like a measurement either way.
 *
 * SECOND: A SINGLE STILL HAS NO PAST. Speed, Trails, Age and Novelty measure
 * how the picture CHANGED, and one imported frame gives them nothing to
 * compare against — they would render from an empty memory and produce a
 * confident-looking field measuring nothing. ChatGPT put the distinction
 * exactly right (2026-09-02) and Joshua kept it: "Relief can honestly render
 * from a single still because it's per-pixel. Age and Novelty are
 * fundamentally temporal, so their meaning depends on live history. That
 * distinction should stay visible in the app/docs so a saved still never
 * pretends it generated temporal information from nowhere."
 *
 * So a temporal filter is DECLINED for an imported still, with its reason —
 * which is a different answer from the live path, where the same filter has a
 * real history behind it and may photograph freely. The situation changed;
 * the honest answer changed with it.
 */

import type { FilterDefinition } from '../filters/registry.js';

/** What the browser will decode. HEIC is Safari-only and worth trying anyway. */
export const IMPORT_ACCEPT = 'image/*';

/**
 * Beyond this, a decode is likely to fail on a phone rather than merely be
 * slow — and failing after a long wait is worse than declining at once.
 *
 * A generous ceiling on purpose: a 48 MP phone photo is about 8000 x 6000 and
 * must go through, so this only catches the genuinely enormous.
 */
export const MAX_IMPORT_PIXELS = 80e6;

export interface ImportedStill {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  /** The file's own name and weight, so the readout describes what was opened. */
  fileName: string;
  bytes: number;
  /** The file's own type, which is what decides whether it was already lossy. */
  type: string;
}

export interface ImportFailure {
  reason: string;
}

export type ImportOutcome = ImportedStill | ImportFailure;

export function importFailed(outcome: ImportOutcome): outcome is ImportFailure {
  return 'reason' in outcome;
}

/**
 * Decode the file, or say why not.
 *
 * createImageBitmap rather than an <img> element: it decodes off the main
 * thread, reports the picture's true pixel size rather than a CSS one, and
 * hands back something texImage2D takes directly — no intermediate canvas,
 * so nothing resamples the picture on the way in.
 */
export async function importStill(file: File): Promise<ImportOutcome> {
  if (!file.type.startsWith('image/')) {
    return {
      reason: `${file.name || 'That file'} is ${file.type || 'of an unknown type'}, `
        + 'not a picture. Video import is a separate step and is not built yet.'
    };
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // HEIC is the expected failure outside Safari, and a decoder that cannot
    // read a format is a fact about the BROWSER, not about the file.
    return {
      reason: `This browser could not decode ${file.name || 'that file'}`
        + (/heic|heif/i.test(file.type) ? ' — HEIC is decoded by Safari and few others' : '')
        + '. The file is probably fine; the decoder is what is missing.'
    };
  }
  if (bitmap.width * bitmap.height > MAX_IMPORT_PIXELS) {
    const megapixels = (bitmap.width * bitmap.height / 1e6).toFixed(0);
    bitmap.close();
    return {
      reason: `${bitmap.width}×${bitmap.height} is ${megapixels} megapixels, past what `
        + 'this can render in one piece. Nothing is wrong with the file.'
    };
  }
  return {
    bitmap,
    width: bitmap.width,
    height: bitmap.height,
    fileName: file.name || 'imported picture',
    bytes: file.size,
    type: file.type
  };
}

/**
 * Whether a filter can honestly render from ONE imported frame.
 *
 * `temporal` and `state` are the registry's own metadata for "this reads the
 * previous frame" and "this keeps a memory across frames" — so this is a
 * question asked of the filter's declared nature, not an allow-list that
 * would drift the moment a filter was added (Rule 10).
 */
export function stillCapable(filter: FilterDefinition): { ok: boolean; reason: string } {
  if (filter.unavailableReason) return { ok: false, reason: filter.unavailableReason };
  if (filter.temporal || filter.state) {
    return {
      ok: false,
      reason: `${filter.name} measures how the picture CHANGES, and one imported `
        + 'frame has nothing before it. It would render a field that looks like a '
        + 'measurement of movement while measuring nothing at all. Point the live '
        + 'camera at something instead — there it has a real history behind it.'
    };
  }
  return { ok: true, reason: '' };
}

/**
 * What the file already lost, before any filter touched it.
 *
 * Said plainly rather than hidden, because a filter cannot tell a JPEG's
 * ringing from an edge that was really there — and neither can the picture it
 * draws.
 */
export function describeImport(still: ImportedStill): string {
  const megapixels = (still.width * still.height / 1e6).toFixed(1);
  const lossy = !/png|webp|bmp|tif/i.test(still.type);
  return `${still.width}×${still.height} · ${megapixels} MP · `
    + `${(still.bytes / 1e6).toFixed(2)} MB ${still.type || 'unknown type'}`
    + (lossy
      ? ' · already compressed: the blocking and ringing a JPEG carries were not '
        + 'in the camera\'s own frame, and an edge or rarity filter will amplify '
        + 'them exactly as readily as real detail'
      : ' · a lossless format, so what the filter reads is what was stored')
    + ' · rendered at the picture\'s own full size, with no live frame rate to keep up with';
}
