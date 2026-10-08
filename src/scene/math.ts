import type { Environment, Vec3 } from "./types";

export const DEG = Math.PI / 180;

export function round(value: number, places = 4): number {
  const f = 10 ** places;
  // `+ 0` turns -0 into 0 so it never shows up in JSON or exports.
  return Math.round(value * f) / f + 0;
}

export function roundVec(v: readonly number[], places = 4): Vec3 {
  return [round(v[0], places), round(v[1], places), round(v[2], places)];
}

export type Quat = [x: number, y: number, z: number, w: number];

/** Euler XYZ in degrees → quaternion, matching three.js `Euler(x, y, z, "XYZ")`. */
export function eulerToQuat(rotation: Vec3): Quat {
  const [x, y, z] = rotation.map((d) => (d * DEG) / 2);
  const c1 = Math.cos(x), c2 = Math.cos(y), c3 = Math.cos(z);
  const s1 = Math.sin(x), s2 = Math.sin(y), s3 = Math.sin(z);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

/** Unit vector pointing from the origin toward the sun. */
export function sunDirection(sun: Environment["sun"]): Vec3 {
  const az = sun.azimuth * DEG;
  const el = sun.elevation * DEG;
  return [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
}

/** "#rrggbb" → [r, g, b] in 0..1, still sRGB-encoded. */
export function hexToRgb(hex: string): Vec3 {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Shortest rotation taking unit vector `from` to unit vector `to`. */
export function quatFromTo(from: Vec3, to: Vec3): Quat {
  const dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
  if (dot < -0.999999) {
    // Opposite vectors: any axis perpendicular to `from` works.
    const axis: Vec3 = Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const perp: Vec3 = [
      from[1] * axis[2] - from[2] * axis[1],
      from[2] * axis[0] - from[0] * axis[2],
      from[0] * axis[1] - from[1] * axis[0],
    ];
    const length = Math.hypot(...perp);
    return [perp[0] / length, perp[1] / length, perp[2] / length, 0];
  }
  const q: Quat = [
    from[1] * to[2] - from[2] * to[1],
    from[2] * to[0] - from[0] * to[2],
    from[0] * to[1] - from[1] * to[0],
    1 + dot,
  ];
  const length = Math.hypot(...q);
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

/**
 * The rotation of a camera at `from` looking at `to`: its −Z points at the
 * target and its +Y is as close to straight up as that allows.
 */
export function lookAtQuat(from: Vec3, to: Vec3): Quat {
  const unit = (v: Vec3): Vec3 => {
    const length = Math.hypot(...v) || 1;
    return [v[0] / length, v[1] / length, v[2] / length];
  };
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const z = unit([from[0] - to[0], from[1] - to[1], from[2] - to[2]]);
  // Looking straight up or down leaves "up" undefined; lean on the Z axis instead.
  const up: Vec3 = Math.abs(z[1]) > 0.9999 ? [0, 0, -Math.sign(z[1])] : [0, 1, 0];
  const x = unit(cross(up, z));
  const y = cross(z, x);
  // The matrix with columns x, y, z, as a quaternion.
  const trace = x[0] + y[1] + z[2];
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return [(y[2] - z[1]) * s, (z[0] - x[2]) * s, (x[1] - y[0]) * s, 0.25 / s];
  }
  if (x[0] > y[1] && x[0] > z[2]) {
    const s = 2 * Math.sqrt(1 + x[0] - y[1] - z[2]);
    return [0.25 * s, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s];
  }
  if (y[1] > z[2]) {
    const s = 2 * Math.sqrt(1 + y[1] - x[0] - z[2]);
    return [(y[0] + x[1]) / s, 0.25 * s, (z[1] + y[2]) / s, (z[0] - x[2]) / s];
  }
  const s = 2 * Math.sqrt(1 + z[2] - x[0] - y[1]);
  return [(z[0] + x[2]) / s, (z[1] + y[2]) / s, 0.25 * s, (x[1] - y[0]) / s];
}

/** sRGB "#rrggbb" → linear RGB, which is what USD and Blender color inputs expect. */
export function hexToLinear(hex: string): Vec3 {
  return hexToRgb(hex).map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as Vec3;
}
