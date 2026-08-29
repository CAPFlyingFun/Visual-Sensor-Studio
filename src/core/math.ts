export interface GeoPoint {
  latitude: number;
  longitude: number;
  altitude?: number | null;
}

export interface LocalPoint {
  x: number;
  y: number;
  z: number;
}

const EARTH_RADIUS_M = 6_371_000;
const DEG2RAD = Math.PI / 180;

export function gpsToLocalMeters(point: GeoPoint, origin: GeoPoint): LocalPoint {
  const lat0 = origin.latitude * DEG2RAD;
  const dLat = (point.latitude - origin.latitude) * DEG2RAD;
  const dLon = (point.longitude - origin.longitude) * DEG2RAD;
  const east = dLon * Math.cos(lat0) * EARTH_RADIUS_M;
  const north = dLat * EARTH_RADIUS_M;
  const up = (point.altitude ?? origin.altitude ?? 0) - (origin.altitude ?? 0);
  return { x: east, y: up, z: -north };
}

export function median(values: Iterable<number>): number {
  const finite = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return Number.NaN;
  const mid = Math.floor(finite.length / 2);
  return finite.length % 2 === 0 ? (finite[mid - 1] + finite[mid]) / 2 : finite[mid];
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface QuaternionLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

function multiplyQuaternion(a: QuaternionLike, b: QuaternionLike): QuaternionLike {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  };
}

function axisAngle(x: number, y: number, z: number, angle: number): QuaternionLike {
  const half = angle / 2;
  const s = Math.sin(half);
  return { x: x * s, y: y * s, z: z * s, w: Math.cos(half) };
}

export function deviceOrientationToQuaternion(
  alphaDeg: number | null,
  betaDeg: number | null,
  gammaDeg: number | null,
  screenAngleDeg = 0
): QuaternionLike {
  const alpha = (alphaDeg ?? 0) * DEG2RAD;
  const beta = (betaDeg ?? 0) * DEG2RAD;
  const gamma = (gammaDeg ?? 0) * DEG2RAD;
  const screen = screenAngleDeg * DEG2RAD;

  // Equivalent to Three.js' historical DeviceOrientationControls convention:
  // intrinsic YXZ device Euler, camera correction, then screen rotation.
  const qY = axisAngle(0, 1, 0, alpha);
  const qX = axisAngle(1, 0, 0, beta);
  const qZ = axisAngle(0, 0, 1, -gamma);
  const device = multiplyQuaternion(multiplyQuaternion(qY, qX), qZ);
  const cameraCorrection = axisAngle(1, 0, 0, -Math.PI / 2);
  const screenCorrection = axisAngle(0, 0, 1, -screen);
  const corrected = multiplyQuaternion(multiplyQuaternion(device, cameraCorrection), screenCorrection);

  const length = Math.hypot(corrected.x, corrected.y, corrected.z, corrected.w) || 1;
  return {
    x: corrected.x / length,
    y: corrected.y / length,
    z: corrected.z / length,
    w: corrected.w / length
  };
}
