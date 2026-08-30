/**
 * Zoom preset stops for the Camera Lab quick buttons.
 *
 * The brief asks for 1x / 2x / 3x, but only "values that make sense for the
 * available zoom range" - a track that reports 1..1.6 should not offer a dead
 * 3x button, and a track that reports its range in some other unit (a few
 * devices advertise 100..400) should still get usable stops.
 */
export function zoomPresetStops(min: number, max: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];

  const stops: number[] = [min];

  if (min <= 1.0001) {
    // Conventional multiplier range: use the familiar whole-number stops.
    // 1 has to be among them when the range starts below it — an iPhone
    // reporting 0.5-10 otherwise offered 0.5, 2, 3 and no way back to 1x,
    // which is the stop people actually use most.
    for (const stop of [1, 2, 3, 5]) {
      if (stop <= max + 1e-6 && stop > min + 1e-6) stops.push(stop);
    }
  } else {
    // Non-multiplier range: two evenly spaced interior stops instead.
    stops.push(min + (max - min) / 3, min + (2 * (max - min)) / 3);
  }

  if (max > (stops[stops.length - 1] ?? min) + 1e-6) stops.push(max);

  // Four touch targets is the most that fits beside the slider on an iPhone.
  const trimmed = stops.slice(0, 4);
  return trimmed.map((value) => Math.round(value * 10) / 10);
}
