/** Photo edits on the rendered output. No AI, no change to the live camera. */
export interface Enhancement {
  smoothing: number;
  sharpness: number;
  /** Share of original texture retained by the smoothing pass. */
  detail: number;
}
export const ENHANCEMENT_PRESETS = [
  { id: 'off', label: 'Off', smoothing: 0, sharpness: 0, detail: 1 },
  { id: 'natural', label: 'Natural', smoothing: 0.25, sharpness: 0.45, detail: 0.65 },
  { id: 'crisp', label: 'Crisp', smoothing: 0.55, sharpness: 0.85, detail: 0.35 },
  { id: 'smooth', label: 'Smooth', smoothing: 0.9, sharpness: 0.6, detail: 0.1 }
] as const;
export function normaliseEnhancement(value: Partial<Enhancement>): Enhancement {
  const clamp = (n: number | undefined, fallback: number, max = 1) =>
    typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : fallback;
  return { smoothing: clamp(value.smoothing, 0), sharpness: clamp(value.sharpness, 0, 2), detail: clamp(value.detail, 1) };
}
