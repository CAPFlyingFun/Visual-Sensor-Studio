import { gpsToLocalMeters, type GeoPoint } from '../core/math.js';
import type { GpsSample } from '../core/types.js';

export class GpsController {
  private watchId: number | null = null;
  private origin: GeoPoint | null = null;
  private points: GpsSample[] = [];

  get active(): boolean {
    return this.watchId !== null;
  }

  get track(): readonly GpsSample[] {
    return this.points;
  }

  start(
    onSample: (sample: GpsSample, track: readonly GpsSample[]) => void,
    onError: (message: string) => void,
    highAccuracy = true
  ): void {
    if (!navigator.geolocation) {
      onError('Geolocation is not available in this browser.');
      return;
    }
    if (this.watchId !== null) return;

    this.watchId = navigator.geolocation.watchPosition(
      (position) => {
        const coords = position.coords;
        const geo: GeoPoint = {
          latitude: coords.latitude,
          longitude: coords.longitude,
          altitude: coords.altitude
        };
        this.origin ??= geo;
        const sample: GpsSample = {
          latitude: coords.latitude,
          longitude: coords.longitude,
          altitude: coords.altitude,
          accuracy: coords.accuracy,
          altitudeAccuracy: coords.altitudeAccuracy,
          heading: coords.heading,
          speed: coords.speed,
          timestamp: position.timestamp,
          local: gpsToLocalMeters(geo, this.origin)
        };

        const last = this.points.at(-1);
        const moved = !last || Math.hypot(
          sample.local.x - last.local.x,
          sample.local.y - last.local.y,
          sample.local.z - last.local.z
        ) > 0.35;
        const timeElapsed = !last || sample.timestamp - last.timestamp > 5000;
        if (moved || timeElapsed) {
          this.points.push(sample);
          if (this.points.length > 500) this.points.shift();
        }
        onSample(sample, this.points);
      },
      (error) => onError(error.message || 'Unable to read location.'),
      {
        enableHighAccuracy: highAccuracy,
        maximumAge: highAccuracy ? 1000 : 5000,
        timeout: highAccuracy ? 15000 : 10000
      }
    );
  }

  stop(): void {
    if (this.watchId === null) return;
    navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  reset(): void {
    this.points = [];
    this.origin = null;
  }
}