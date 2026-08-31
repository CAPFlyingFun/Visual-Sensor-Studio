/**
 * How a saved frame is encoded.
 *
 * Joshua, on the first full-resolution saves: "both are literally full
 * resolution at 22-23MB each. Maybe add a compression option (zip) or save as
 * different formats."
 *
 * ZIP IS NOT THE ANSWER, and it is worth saying why rather than building it.
 * PNG is already DEFLATE-compressed — the same algorithm a .zip uses — so
 * zipping one re-runs a pass that has already been run and typically saves a
 * percent or two. The file is 22MB because it is twelve megapixels of
 * LOSSLESS photographic data, and no container changes that. Choosing a codec
 * that is allowed to discard what the eye does not miss changes it by an order
 * of magnitude.
 *
 * So: a format choice, with quality where the format has one.
 */
export type SaveFormat = 'png' | 'jpeg' | 'webp';

export interface FormatInfo {
  id: SaveFormat;
  mime: string;
  extension: string;
  label: string;
  /** Whether a quality setting means anything for this format. */
  lossy: boolean;
}

export const SAVE_FORMATS: readonly FormatInfo[] = [
  {
    id: 'png', mime: 'image/png', extension: 'png', lossy: false,
    label: 'PNG — lossless, largest'
  },
  {
    id: 'jpeg', mime: 'image/jpeg', extension: 'jpg', lossy: true,
    label: 'JPEG — smallest, universal'
  },
  {
    id: 'webp', mime: 'image/webp', extension: 'webp', lossy: true,
    label: 'WebP — smaller than JPEG'
  }
];

export function formatInfo(id: SaveFormat): FormatInfo {
  return SAVE_FORMATS.find((f) => f.id === id) ?? SAVE_FORMATS[0];
}

/**
 * Which formats this browser can actually ENCODE.
 *
 * Not a version table. Safari added canvas WebP encoding late and a table
 * would be one more thing claiming a capability the device may not have —
 * and when a browser cannot encode the type it is asked for, it does not
 * throw, it silently returns a PNG. A save that quietly writes 22MB under a
 * .webp name is worse than one that never offered the option.
 *
 * `probe` returns what `canvas.toDataURL(mime)` produced; the type is
 * supported only if the result actually carries it back.
 */
export function supportedFormats(probe: (mime: string) => string): SaveFormat[] {
  return SAVE_FORMATS.filter((f) => {
    // PNG is the canvas baseline and is required by the specification.
    if (f.id === 'png') return true;
    try {
      return probe(f.mime).startsWith(`data:${f.mime}`);
    } catch {
      return false;
    }
  }).map((f) => f.id);
}

/** Fall back to PNG rather than to a silent re-encode as something else. */
export function resolveFormat(wanted: SaveFormat, supported: readonly SaveFormat[]): SaveFormat {
  return supported.includes(wanted) ? wanted : 'png';
}

export const DEFAULT_QUALITY = 0.92;

export function clampQuality(quality: number): number {
  if (!Number.isFinite(quality)) return DEFAULT_QUALITY;
  return Math.min(1, Math.max(0.3, quality));
}

/** Human-readable byte count, so a 22MB surprise is visible before the share sheet. */
export function describeBytes(bytes: number): string {
  if (!(bytes > 0)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The saved file's name, carrying the format it actually is. */
export function fileName(mode: string, format: SaveFormat, when: Date): string {
  const stamp = when.toISOString().replace(/[:.]/g, '-');
  return `visual-sensor-${mode}-${stamp}.${formatInfo(format).extension}`;
}
