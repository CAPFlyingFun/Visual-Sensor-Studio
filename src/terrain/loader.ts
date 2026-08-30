/**
 * Fetching and assembling elevation tiles.
 *
 * Separated from the maths so the network shape is visible in one place: what
 * leaves the device is a zoom and a pair of integer tile indices, nothing else.
 * No coordinate, no accuracy, no timestamp, no identifier.
 */

import {
  NO_DATA,
  decodeTerrarium,
  metresPerPixel,
  tileToLonLat,
  type Heightfield,
  type TileWindow
} from './tiles.js';

const TILE_SIZE = 256;

/** How long one tile may take before it is treated as missing. */
const TILE_TIMEOUT_MS = 12_000;

/** Public, keyless, global. Terrarium-encoded PNG elevation. */
export const TILE_HOST = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

export function tileUrl(z: number, x: number, y: number): string {
  return `${TILE_HOST}/${z}/${x}/${y}.png`;
}

export interface LoadProgress {
  loaded: number;
  total: number;
  failed: number;
}

/**
 * Load a window of tiles into one heightfield.
 *
 * A tile that fails leaves its area as no-data rather than failing the whole
 * load: a missing corner is a hole in the map, but a rejected load over one
 * 404 is no map at all. Ocean tiles legitimately do not exist in this set.
 */
export async function loadHeightfield(
  window: TileWindow,
  onProgress?: (progress: LoadProgress) => void,
  fetchImpl: typeof fetch = fetch
): Promise<{ field: Heightfield; progress: LoadProgress }> {
  const across = window.maxX - window.minX + 1;
  const down = window.maxY - window.minY + 1;
  const width = across * TILE_SIZE;
  const height = down * TILE_SIZE;

  const data = new Float32Array(width * height);
  data.fill(NO_DATA);

  const progress: LoadProgress = { loaded: 0, total: window.tiles.length, failed: 0 };

  const canvas = document.createElement('canvas');
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser cannot decode elevation tiles.');

  for (const tile of window.tiles) {
    // A tile that never answers would otherwise stall the whole load with no
    // feedback and no way out — worse than a missing tile, which is only a hole
    // in the map.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TILE_TIMEOUT_MS);
    try {
      const response = await fetchImpl(tileUrl(tile.z, tile.x, tile.y), {
        signal: abort.signal,
        // No credentials and no referrer: the request carries the tile indices
        // and nothing that could tie them to this device or session.
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'force-cache'
      });
      if (!response.ok) throw new Error(String(response.status));

      const bitmap = await createImageBitmap(await response.blob());
      context.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
      context.drawImage(bitmap, 0, 0, TILE_SIZE, TILE_SIZE);
      bitmap.close?.();
      const pixels = context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;

      const originX = (tile.x - window.minX) * TILE_SIZE;
      const originY = (tile.y - window.minY) * TILE_SIZE;
      for (let y = 0; y < TILE_SIZE; y++) {
        const row = (originY + y) * width + originX;
        for (let x = 0; x < TILE_SIZE; x++) {
          const p = (y * TILE_SIZE + x) * 4;
          data[row + x] = decodeTerrarium(pixels[p], pixels[p + 1], pixels[p + 2]);
        }
      }
      progress.loaded++;
    } catch {
      // Left as no-data. Ocean tiles genuinely do not exist in this set, so a
      // failure here is often the correct answer rather than an error.
      progress.failed++;
    } finally {
      clearTimeout(timer);
    }
    onProgress?.(progress);
  }

  const centreLat = tileToLonLat(window.minX, (window.minY + window.maxY + 1) / 2, window.zoom).lat;

  return {
    field: {
      data,
      width,
      height,
      west: window.west,
      east: window.east,
      north: window.north,
      south: window.south,
      zoom: window.zoom,
      metresPerPixel: metresPerPixel(centreLat, window.zoom)
    },
    progress
  };
}
