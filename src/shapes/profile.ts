/**
 * Shapes made from an outline: a lathe spins one around the Y axis (bottles,
 * wheels, domes, nozzles), an extrude gives a flat one thickness along Y
 * (brackets, gears, beams, tool heads).
 *
 * Outlines are stored fitted to the unit box, like every other primitive, so a
 * node's scale is still its size. Corners sharper than SMOOTH_TURN stay crisp;
 * gentler ones shade as one curved surface.
 */

import type { Outline, Vec3 } from "@/scene/types";
import type { MeshData } from "./mesh";

const SPIN = 48;
const SMOOTH_TURN = Math.cos((35 * Math.PI) / 180);
const TINY = 1e-9;

type Point = [number, number];
const unit = ([x, y]: Point): Point => {
  const length = Math.hypot(x, y) || 1;
  return [x / length, y / length];
};

/** What an outline's two numbers mean for each shape. */
export const OUTLINE_INFO = {
  lathe: "[radius, height] pairs, from one end of the shape to the other",
  extrude: "[x, z] corners of a flat polygon, in order around it",
} as const;
export type Outlined = keyof typeof OUTLINE_INFO;
export const isOutlined = (primitive: string): primitive is Outlined => primitive in OUTLINE_INFO;

/** Used when a lathe or extrude has no outline of its own: a bollard and a hexagon. */
export const DEFAULT_OUTLINE: Record<Outlined, Outline> = {
  lathe: [[0.34, -0.5], [0.5, -0.32], [0.5, 0.12], [0.3, 0.5]],
  extrude: Array.from({ length: 6 }, (_, i): Point => {
    const angle = (Math.PI * 2 * i) / 6;
    return [0.5 * Math.cos(angle), (0.5 * Math.sin(angle)) / Math.sin(Math.PI / 3)];
  }),
};

/** Drops points that repeat the one before them. */
function distinct(points: readonly Point[], closed: boolean): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-7) out.push([p[0], p[1]]);
  }
  if (closed && out.length > 1) {
    const [first, last] = [out[0], out[out.length - 1]];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) <= 1e-7) out.pop();
  }
  return out;
}

const signedArea = (points: readonly Point[]) =>
  points.reduce((sum, p, i) => {
    const q = points[(i + 1) % points.length];
    return sum + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2;

/**
 * Fits an outline drawn in any units to the unit box.
 * @throws Error with a message for whoever drew the outline
 */
export function fitOutline(primitive: Outlined, points: readonly (readonly number[])[]): Outline {
  const given = distinct(points.map((p): Point => [p[0], p[1]]), primitive === "extrude");
  const [as, bs] = [given.map((p) => p[0]), given.map((p) => p[1])];
  const [bMin, bMax] = [Math.min(...bs), Math.max(...bs)];

  if (primitive === "lathe") {
    if (given.length < 2) throw new Error("A lathe outline needs at least 2 different points.");
    if (as.some((radius) => radius < 0)) throw new Error("A lathe outline's radii can't be negative.");
    const widest = Math.max(...as);
    if (widest < TINY || bMax - bMin < TINY) {
      throw new Error("A lathe outline needs some width and some height.");
    }
    return given.map(([radius, height]): Point => [radius / (2 * widest), (height - (bMin + bMax) / 2) / (bMax - bMin)]);
  }

  if (given.length < 3) throw new Error("An extrude outline needs at least 3 different corners.");
  const [aMin, aMax] = [Math.min(...as), Math.max(...as)];
  if (aMax - aMin < TINY || bMax - bMin < TINY || Math.abs(signedArea(given)) < TINY) {
    throw new Error("An extrude outline has to enclose some area.");
  }
  return given.map(([x, z]): Point => [(x - (aMin + aMax) / 2) / (aMax - aMin), (z - (bMin + bMax) / 2) / (bMax - bMin)]);
}

/**
 * The normal at each end of each stretch of a path: shared with the neighbour
 * across a gentle corner, the stretch's own across a sharp one.
 */
function cornerNormals(flat: readonly Point[], closed: boolean): { start: Point; end: Point }[] {
  const count = flat.length;
  const neighbour = (i: number) => (closed ? (i + count) % count : i);
  return flat.map((normal, i) => {
    const blend = (other: number): Point => {
      const n = flat[neighbour(other)];
      if (!n || n === normal) return normal;
      return normal[0] * n[0] + normal[1] * n[1] >= SMOOTH_TURN ? unit([normal[0] + n[0], normal[1] + n[1]]) : normal;
    };
    return { start: blend(i - 1), end: blend(i + 1) };
  });
}

/** An outline of [radius, height] points spun around the Y axis. */
export function latheMesh(outline: Outline): MeshData {
  let profile = distinct(outline, false);
  // Travelling up the outside of a shape, the surface faces away from the axis.
  const outward = profile.slice(1).reduce((sum, p, i) => sum + (p[0] + profile[i][0]) * (p[1] - profile[i][1]), 0);
  if (outward < 0) profile = profile.reverse();

  const flat = profile.slice(1).map((p, i) => unit([p[1] - profile[i][1], -(p[0] - profile[i][0])]));
  const corners = cornerNormals(flat, false);
  const points: Vec3[] = [];
  const normals: Vec3[] = [];
  const faces: number[][] = [];
  const ring = ([radius, y]: Point, [nr, ny]: Point) => {
    const first = points.length;
    for (let j = 0; j < SPIN; j++) {
      const angle = (Math.PI * 2 * j) / SPIN;
      points.push([radius * Math.cos(angle), y, -radius * Math.sin(angle)]);
      normals.push([nr * Math.cos(angle), ny, -nr * Math.sin(angle)]);
    }
    return first;
  };

  profile.slice(1).forEach((to, i) => {
    const from = profile[i];
    const [a, b] = [ring(from, corners[i].start), ring(to, corners[i].end)];
    for (let j = 0; j < SPIN; j++) {
      const k = (j + 1) % SPIN;
      // On the axis a ring is a single point, so the quad there is a triangle.
      if (from[0] < TINY) faces.push([a + j, b + k, b + j]);
      else if (to[0] < TINY) faces.push([a + j, a + k, b + j]);
      else faces.push([a + j, a + k, b + k, b + j]);
    }
  });
  // An end that isn't on the axis is closed with a flat disc.
  const [bottom, top] = [profile[0], profile[profile.length - 1]];
  if (bottom[0] > TINY) {
    const first = ring(bottom, [0, -1]);
    faces.push(Array.from({ length: SPIN }, (_, j) => first + SPIN - 1 - j));
  }
  if (top[0] > TINY) {
    const first = ring(top, [0, 1]);
    faces.push(Array.from({ length: SPIN }, (_, j) => first + j));
  }
  return { points, faces, smooth: true, normals };
}

/** Cuts a simple polygon, wound clockwise in (x, z), into triangles by clipping ears. */
function triangulate(polygon: readonly Point[]): number[][] {
  const turn = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
  const inside = (p: Point, a: Point, b: Point, c: Point) =>
    turn(a, b, p) <= 0 && turn(b, c, p) <= 0 && turn(c, a, p) <= 0;
  const left = polygon.map((_, i) => i);
  const triangles: number[][] = [];
  let guard = polygon.length * polygon.length;
  while (left.length > 3 && guard-- > 0) {
    const ear = left.findIndex((b, at) => {
      const a = left[(at + left.length - 1) % left.length];
      const c = left[(at + 1) % left.length];
      if (turn(polygon[a], polygon[b], polygon[c]) >= 0) return false;
      return !left.some((p) => p !== a && p !== b && p !== c && inside(polygon[p], polygon[a], polygon[b], polygon[c]));
    });
    // A degenerate outline has no clean ear; take any corner so the loop still ends.
    const at = ear === -1 ? 0 : ear;
    triangles.push([left[(at + left.length - 1) % left.length], left[at], left[(at + 1) % left.length]]);
    left.splice(at, 1);
  }
  triangles.push([left[0], left[1], left[2]]);
  return triangles;
}

/** A flat outline of [x, z] corners, given thickness from y = −0.5 to 0.5. */
export function extrudeMesh(outline: Outline): MeshData {
  let polygon = distinct(outline, true);
  // Counter-clockwise seen from above (+Y), which is clockwise in (x, z).
  if (signedArea(polygon) > 0) polygon = polygon.reverse();
  const count = polygon.length;

  const flat = polygon.map((p, i) => {
    const q = polygon[(i + 1) % count];
    return unit([-(q[1] - p[1]), q[0] - p[0]]);
  });
  const corners = cornerNormals(flat, true);
  const points: Vec3[] = [];
  const normals: Vec3[] = [];
  const faces: number[][] = [];

  // Sides: each edge is a quad with its own points, so sharp corners stay sharp.
  polygon.forEach((p, i) => {
    const q = polygon[(i + 1) % count];
    const first = points.length;
    for (const [corner, normal] of [[p, corners[i].start], [q, corners[i].end]] as const) {
      for (const y of [-0.5, 0.5]) {
        points.push([corner[0], y, corner[1]]);
        normals.push([normal[0], 0, normal[1]]);
      }
    }
    faces.push([first, first + 2, first + 3, first + 1]);
  });
  // Caps.
  const triangles = triangulate(polygon);
  for (const [y, up] of [[0.5, 1], [-0.5, -1]] as const) {
    const first = points.length;
    for (const corner of polygon) {
      points.push([corner[0], y, corner[1]]);
      normals.push([0, up, 0]);
    }
    for (const [a, b, c] of triangles) faces.push(up > 0 ? [first + a, first + b, first + c] : [first + c, first + b, first + a]);
  }
  return { points, faces, smooth: true, normals };
}

export function outlineMesh(primitive: Outlined, outline: Outline | null): MeshData {
  const drawn = outline ?? DEFAULT_OUTLINE[primitive];
  return primitive === "lathe" ? latheMesh(drawn) : extrudeMesh(drawn);
}
